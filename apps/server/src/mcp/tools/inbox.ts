import { PlayerKindSchema } from '@chess-goat/shared';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { listBots, resolveOwnBot, touchBotActivity } from '../../domain/bots';
import { INBOX_PAGE, loadInbox, type InboxEntry } from '../../domain/botInbox';
import { DomainError } from '../../domain/errors';
import { OwnerGate } from '../gate';
import { registerTool } from '../tool';
import { botRef, READ_ONLY } from './manage';

export const INBOX_MAX_WAIT_SECONDS = 45;
export const INBOX_WAITS_PER_OWNER = 2;
const REREAD_MS = 2_000;
const PROGRESS_MS = 5_000;

/** Open get_inbox waits per owner, process-wide (one token's agent may hold two at a time). */
const waits = new OwnerGate(INBOX_WAITS_PER_OWNER);

const person = z.object({ name: z.string(), kind: PlayerKindSchema });
const bot = z.object({ id: z.number().int(), name: z.string() });
const entrySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('challenge'),
    bot,
    challengeId: z.string(),
    from: person,
    group: z.object({ groupId: z.string(), title: z.string() }),
    timePerMove: z.number().nullable(),
    rated: z.boolean(),
    colour: z.enum(['white', 'black', 'random']),
    expiresAt: z.string(),
  }),
  z.object({
    kind: z.literal('your_move'),
    bot,
    gameId: z.string(),
    opponent: person,
    ply: z.number().int(),
    deadlineAt: z.string().nullable(),
    drawOffer: z.enum(['none', 'from_you', 'from_opponent']),
    premoveFailed: z.object({ opponentMove: z.string(), reply: z.string() }).optional(),
  }),
  z.object({
    kind: z.literal('draw_offer'),
    bot,
    gameId: z.string(),
    opponent: person,
    ply: z.number().int(),
  }),
]);

type Inbox = { entries: InboxEntry[]; more: boolean; waitedSeconds: number };

/** The answers given to an owner with no bots: same shape as an empty inbox, different text. */
const noBotsAnswers = new WeakSet<Inbox>();

/** Resolves after `ms`, or as soon as `signal` fires. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

const entryLine = (entry: InboxEntry): string => {
  const who = entry.bot.name;
  switch (entry.kind) {
    case 'challenge':
      return `${who}: challenge ${entry.challengeId} from ${entry.from.name} in ${entry.group.title} (${entry.timePerMove === null ? 'no time limit' : `${entry.timePerMove} s per move`}, ${entry.rated ? 'rated' : 'unrated'}, ${who} plays ${entry.colour}), expires ${entry.expiresAt}. Answer with respond_to_challenge.`;
    case 'your_move': {
      const draw =
        entry.drawOffer === 'from_opponent'
          ? ` ${entry.opponent.name} offers a draw.`
          : entry.drawOffer === 'from_you'
            ? ' Your draw offer stands.'
            : '';
      const deadline = entry.deadlineAt ? `, deadline ${entry.deadlineAt}` : '';
      const failed = entry.premoveFailed
        ? ` Your premove reply ${entry.premoveFailed.reply} to ${entry.premoveFailed.opponentMove} was illegal, so your premoves were dropped.`
        : '';
      return `${who}: your move in game ${entry.gameId} vs ${entry.opponent.name}, ply ${entry.ply}${deadline}.${failed}${draw} Call get_game, then make_move.`;
    }
    case 'draw_offer':
      return `${who}: ${entry.opponent.name} offers a draw in game ${entry.gameId} (ply ${entry.ply}). Answer with game_action accept_draw or decline_draw.`;
  }
};

const inboxText = (inbox: Inbox): string => {
  const { entries, more, waitedSeconds } = inbox;
  if (noBotsAnswers.has(inbox)) return 'You have no bots yet. Call create_bot.';
  if (entries.length === 0) {
    return `Nothing to do${waitedSeconds > 0 ? ` after waiting ${waitedSeconds} s` : ''}. Call get_inbox again with wait_seconds up to ${INBOX_MAX_WAIT_SECONDS}.`;
  }
  const lines = entries.map(entryLine).join('\n');
  return more ? `${lines}\nThere are more; act on these, then call get_inbox again.` : lines;
};

function registerGetInbox(server: McpServer): void {
  registerTool(server, {
    name: 'get_inbox',
    description: `What your bots must act on: challenges to answer, games where it is their move, and draw offers. Soonest deadline first, at most ${INBOX_PAGE} entries (more: true when there are others). Without bot it covers all your bots. With wait_seconds (up to ${INBOX_MAX_WAIT_SECONDS}) and nothing to do, it waits and returns as soon as something arrives. Call it in a loop; keep at most ${INBOX_WAITS_PER_OWNER} waits open at once.`,
    input: z.object({
      bot: botRef.optional(),
      wait_seconds: z
        .number()
        .int()
        .min(0)
        .max(INBOX_MAX_WAIT_SECONDS)
        .optional()
        .describe(`Seconds to wait when the inbox is empty, 0–${INBOX_MAX_WAIT_SECONDS}.`),
    }),
    output: z.object({
      entries: z.array(entrySchema),
      more: z.boolean().describe(`True when there were more than ${INBOX_PAGE} entries.`),
      waitedSeconds: z.number().int(),
    }),
    annotations: READ_ONLY,
    run: async ({ deps, owner, progress, signal }, input) => {
      const started = Date.now();
      // Recorded in its own transaction, before anything that could fail.
      const botIds = await deps.db.transaction(async (tx) => {
        const bots =
          input.bot === undefined
            ? await listBots(tx, owner.id)
            : [await resolveOwnBot(tx, owner.id, input.bot)];
        for (const { id } of bots) await touchBotActivity(tx, id);
        return bots.map(({ id }) => id);
      });
      const elapsed = () => Date.now() - started;
      const waitMs = (input.wait_seconds ?? 0) * 1000;
      // A wait that ran its course reports the time asked for, not the few ms over it; an early
      // return reports whole seconds actually waited.
      const result = ({ entries, more }: { entries: InboxEntry[]; more: boolean }): Inbox => {
        const spent = elapsed();
        const timedOut = entries.length === 0 && !signal.aborted && waitMs > 0 && spent >= waitMs;
        return {
          entries,
          more,
          waitedSeconds: timedOut ? waitMs / 1000 : Math.floor(spent / 1000),
        };
      };
      // Nothing could ever arrive, so there is nothing to wait for.
      if (botIds.length === 0) {
        const none: Inbox = { entries: [], more: false, waitedSeconds: 0 };
        noBotsAnswers.add(none);
        return none;
      }
      const read = () => loadInbox(deps.db, botIds);

      // A wait slot is taken only for an actual wait: when the first read finds nothing.
      let inbox = await read();
      if (inbox.entries.length > 0 || waitMs === 0) return result(inbox);
      const release = waits.acquire(owner.id);
      if (!release) {
        throw new DomainError('limit_exceeded', 'too many inbox waits', {
          reason: 'too_many_inbox_waits',
        });
      }
      try {
        let lastRead = elapsed();
        let nextProgress = PROGRESS_MS;
        while (inbox.entries.length === 0 && !signal.aborted && elapsed() < waitMs) {
          const now = elapsed();
          await pause(Math.min(lastRead + REREAD_MS, nextProgress, waitMs) - now, signal);
          if (signal.aborted) break;
          const at = elapsed();
          if (at >= nextProgress && at < waitMs) {
            nextProgress += PROGRESS_MS;
            // A lost notification is no reason to end the wait; an abort ends it.
            await progress(
              `Waited ${Math.round(at / 1000)} of ${waitMs / 1000} s; nothing to do yet.`,
            ).catch(() => {});
          }
          if (at >= lastRead + REREAD_MS || at >= waitMs) {
            lastRead = at;
            inbox = await read();
          }
        }
        return result(inbox);
      } finally {
        release();
      }
    },
    text: inboxText,
  });
}

export const registerInboxTools = (server: McpServer): void => {
  registerGetInbox(server);
};
