import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { listBots, resolveOwnBot, touchBotActivity } from '../../domain/bots';
import { loadInbox, type InboxEntry } from '../../domain/botInbox';
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

const person = z.object({ name: z.string(), isBot: z.boolean() });
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
  }),
  z.object({
    kind: z.literal('draw_offer'),
    bot,
    gameId: z.string(),
    opponent: person,
    ply: z.number().int(),
  }),
]);

type Inbox = { entries: InboxEntry[]; waitedSeconds: number };

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
      return `${who}: your move in game ${entry.gameId} vs ${entry.opponent.name}, ply ${entry.ply}${deadline}.${draw} Call get_game, then make_move.`;
    }
    case 'draw_offer':
      return `${who}: ${entry.opponent.name} offers a draw in game ${entry.gameId} (ply ${entry.ply}). Answer with game_action accept_draw or decline_draw.`;
  }
};

const inboxText = ({ entries, waitedSeconds }: Inbox): string =>
  entries.length === 0
    ? `Nothing to do${waitedSeconds > 0 ? ` after waiting ${waitedSeconds} s` : ''}. Call get_inbox again with wait_seconds up to ${INBOX_MAX_WAIT_SECONDS}.`
    : entries.map(entryLine).join('\n');

function registerGetInbox(server: McpServer): void {
  registerTool(server, {
    name: 'get_inbox',
    description: `What your bots must act on: challenges to answer, games where it is their move, and draw offers. Soonest deadline first. Without bot it covers all your bots. With wait_seconds (up to ${INBOX_MAX_WAIT_SECONDS}) and nothing to do, it waits and returns as soon as something arrives. Call it in a loop; keep at most ${INBOX_WAITS_PER_OWNER} waits open at once.`,
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
    output: z.object({ entries: z.array(entrySchema), waitedSeconds: z.number().int() }),
    annotations: READ_ONLY,
    run: async ({ deps, owner, progress, signal }, input) => {
      const started = Date.now();
      const botIds = await deps.db.transaction(async (tx) => {
        const bots =
          input.bot === undefined
            ? await listBots(tx, owner.id)
            : [await resolveOwnBot(tx, owner.id, input.bot)];
        for (const { id } of bots) await touchBotActivity(tx, id);
        return bots.map(({ id }) => id);
      });
      const read = () => loadInbox(deps.db, botIds);
      const waitMs = (input.wait_seconds ?? 0) * 1000;
      const elapsed = () => Date.now() - started;
      const result = (entries: InboxEntry[]): Inbox => ({
        entries,
        waitedSeconds: Math.round(elapsed() / 1000),
      });

      if (waitMs === 0) return result(await read());
      const release = waits.acquire(owner.id);
      if (!release) {
        throw new DomainError('limit_exceeded', 'too many inbox waits', {
          reason: 'too_many_inbox_waits',
        });
      }
      try {
        let lastRead = elapsed();
        let entries = await read();
        let nextProgress = PROGRESS_MS;
        while (entries.length === 0 && !signal.aborted && elapsed() < waitMs) {
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
            entries = await read();
          }
        }
        return result(entries);
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
