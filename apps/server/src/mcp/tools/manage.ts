import { z } from 'zod';
import type { DbOrTx } from '../../db/client';
import type { UserRow } from '../../db/schema';
import {
  botViews,
  createBot,
  deleteBot,
  listBots,
  resolveOwnBot,
  updateBot,
} from '../../domain/bots';
import { addBotToGroup, ownerGroups, removeBotFromGroup } from '../../domain/botGroups';
import { PERSONA_MAX } from '../../domain/botNotes';
import { requireGroupByPublicId } from '../../domain/groups';
import { quoted, quoteNote } from '../../domain/quoting';
import { listRunners, onlineBotIds } from '../../domain/runners';
import { pendingTurns } from '../../domain/turns';
import { failingTurns } from '../../domain/turnLeases';
import type { McpServer } from '@modelcontextprotocol/server';
import { registerTool, resolveAndTouch } from '../tool';

/** A bot by name (case-insensitive) or numeric id. */
export const botRef = z
  .union([z.string().min(1).max(64), z.number().int()])
  .describe(
    'The bot: a string is always its name (case-insensitive); a number is its id. Pass an id as a number, not a string.',
  );
const groupRef = z.string().min(1).max(64).describe("The group's id, from list_my_groups.");

const botGroupSchema = z.object({
  groupId: z.string(),
  title: z.string(),
  rating: z.number(),
  gamesPlayed: z.number().int(),
});
export const botSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  label: z.string(),
  tagline: z.string().nullable(),
  lastActiveAt: z.string().nullable(),
  groups: z.array(botGroupSchema),
  liveGames: z.number().int(),
  online: z.boolean(),
  failingTurns: z.number().int(),
  pendingChallenges: z.number().int(),
});
type BotOut = z.infer<typeof botSchema>;

/**
 * Text the schema publishes with `maxLength: max`. It isn't enforced here: `.max` would count UTF-16
 * units; the domain counts code points and says by how much a persona is over.
 */
export const personaInput = (description: string) =>
  z.string().meta({ maxLength: PERSONA_MAX }).describe(description);

/** The bots' views with runner status: three batched reads, whatever the number of bots. */
export async function botsWithStatus(tx: DbOrTx, bots: readonly UserRow[]): Promise<BotOut[]> {
  const views = await botViews(tx, bots);
  const ids = views.map((view) => view.id);
  const [online, failing, pending] = await Promise.all([
    onlineBotIds(tx, ids, new Date()),
    failingTurns(tx, ids),
    pendingTurns(tx, ids),
  ]);
  return views.map((view) => ({
    ...view,
    online: online.has(view.id),
    failingTurns: failing.get(view.id) ?? 0,
    pendingChallenges: pending.filter((t) => t.botId === view.id && t.kind === 'challenge').length,
  }));
}

const botLine = (bot: BotOut): string => {
  const where =
    bot.groups.length === 0
      ? 'in no group'
      : `in ${bot.groups.map((g) => `${g.title} (${g.rating})`).join(', ')}`;
  const tagline = bot.tagline ? ` "${bot.tagline}"` : '';
  const games = bot.liveGames === 1 ? '1 live game' : `${bot.liveGames} live games`;
  const status = [
    bot.online ? 'online' : 'offline',
    bot.failingTurns > 0 &&
      `${bot.failingTurns} ${bot.failingTurns === 1 ? 'turn' : 'turns'} failing`,
    bot.pendingChallenges > 0 &&
      `${bot.pendingChallenges} ${bot.pendingChallenges === 1 ? 'challenge' : 'challenges'} waiting`,
  ].filter(Boolean);
  return `${bot.label}${tagline}, ${where}, ${games}, ${status.join(', ')}`;
};

/** Follows text that quotes a runner's label or harness: whoever ran the link command chose them. */
export const RUNNER_NOTE = quoteNote('Runner labels and harness names');

const NO_RUNNER =
  'No runner is connected, so your bots are not playing. If one is linked, start it on its machine with `goat-runner start`; otherwise call link_runner.';

export const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

function registerListBots(server: McpServer): void {
  registerTool(server, {
    name: 'list_bots',
    description:
      'List your bots with the groups each is in (and its rating there), how many games it is playing now, whether a runner is online for it, and any turns failing or challenges waiting.',
    input: z.object({}),
    output: z.object({ bots: z.array(botSchema) }),
    annotations: READ_ONLY,
    run: async ({ deps, owner }) => ({
      bots: await deps.db.transaction(async (tx) =>
        botsWithStatus(tx, await listBots(tx, owner.id)),
      ),
    }),
    text: ({ bots }) =>
      bots.length === 0
        ? 'You have no bots yet. Call create_bot to make one.'
        : bots.map(botLine).join('\n') + (bots.some((b) => b.online) ? '' : `\n${NO_RUNNER}`),
  });
}

const PERSONA_GUIDE =
  'The persona is the system prompt for every session that plays this bot. Write it in the second person and settle: how the bot plays; which challenges it accepts; when it offers, accepts or declines a draw; whether it challenges other bots after a game ends; what it keeps in its notes. A bot cannot challenge people, only other bots.';

/** Who runs the new bot: a connected runner, a linked one that is not connected, or none. */
export type RunnerState =
  { kind: 'connected'; label: string } | { kind: 'offline' } | { kind: 'none' };

/** The next-step lines of a created bot: where it is, who runs it, and what it lacks. */
export function createdLines(
  added: readonly { title: string }[],
  ownerGroupCount: number,
  runner: RunnerState,
  hasPersona: boolean,
): string {
  const where =
    added.length > 0
      ? `It is in ${added.map((g) => g.title).join(', ')}.`
      : ownerGroupCount > 0
        ? 'It is in no group yet. Ask your owner which group, then call add_bot_to_group.'
        : 'It is in no group yet: your owner is in no group with Chess Goat. They must add Chess Goat to a Telegram group first.';
  const who =
    runner.kind === 'connected'
      ? `Served by runner ${quoted(runner.label)}, connected. Next: call test_runner.\n${RUNNER_NOTE}`
      : runner.kind === 'offline'
        ? 'A runner is linked but not connected. Start it on its machine with `goat-runner start`, then call test_runner; or call link_runner to link another.'
        : 'No runner serves this bot yet. Next: call link_runner.';
  return [
    where,
    who,
    hasPersona
      ? null
      : 'It has no persona yet, so its sessions will play with no instructions. Call update_bot with a persona.',
  ]
    .filter((line) => line !== null)
    .join('\n');
}

function registerCreateBot(server: McpServer): void {
  registerTool(server, {
    name: 'create_bot',
    description: `Create a bot of yours (up to 20). Names are unique across Chess Goat, case-insensitive: letters, digits, spaces, dots, dashes and underscores, up to 32 characters. The tagline is optional, up to 80 characters. ${PERSONA_GUIDE} Pass \`groups\` (ids from list_my_groups) to put the bot where people can challenge it; with none given and exactly one group, that group is used.`,
    input: z.object({
      name: z.string().max(100),
      tagline: z.string().max(200).optional(),
      persona: personaInput(
        "Optional. What the bot's agent is told it is: its character and style. At most 4,000 characters.",
      ).optional(),
      groups: z
        .array(groupRef)
        .min(1)
        .max(20)
        .optional()
        .describe('Groups to put the bot in, as list_my_groups gives their ids.'),
    }),
    output: z.object({
      bot: botSchema,
      groups: z.array(z.object({ groupId: z.string(), title: z.string() })),
      runner: z.enum(['connected', 'offline', 'none']),
      nextSteps: z.string(),
    }),
    annotations: WRITE,
    // One transaction: a bad group id creates nothing. `bot_name_taken` aborts it and propagates.
    run: ({ deps, owner }, input) =>
      deps.db.transaction(async (tx) => {
        const { groups: given, ...fields } = input;
        const bot = await createBot(tx, owner.id, fields);
        const mine = await ownerGroups(tx, owner.id);
        const wanted = given ?? (mine.length === 1 ? [mine[0]!.groupId] : []);
        const added = new Map<number, { groupId: string; title: string }>();
        for (const groupId of wanted) {
          const group = await requireGroupByPublicId(tx, groupId);
          if (added.has(group.id)) continue;
          await addBotToGroup(tx, owner.id, bot.id, group.id);
          added.set(group.id, { groupId: group.publicId, title: group.title });
        }
        const linked = await listRunners(tx, owner.id, new Date());
        const serving = linked.find(
          (r) => r.connected && (r.bots === 'all' || r.bots.includes(bot.firstName)),
        );
        // A runner scoped to named bots can't serve a bot created just now, so only 'all' counts.
        const runner: RunnerState = serving
          ? { kind: 'connected', label: serving.label }
          : linked.some((r) => r.bots === 'all')
            ? { kind: 'offline' }
            : { kind: 'none' };
        return {
          bot: (await botsWithStatus(tx, [bot]))[0]!,
          groups: [...added.values()],
          runner: runner.kind,
          nextSteps: createdLines([...added.values()], mine.length, runner, bot.persona !== null),
        };
      }),
    text: ({ bot, nextSteps }) => `Created ${bot.label}.\n${nextSteps}`,
  });
}

function registerUpdateBot(server: McpServer): void {
  registerTool(server, {
    name: 'update_bot',
    description:
      "Rename a bot, change its tagline or persona, or wipe its notes. An empty tagline or persona clears it. clear_notes erases the notes the bot wrote to itself; it can't be undone.",
    input: z.object({
      bot: botRef,
      name: z.string().max(100).optional(),
      tagline: z.string().max(200).optional(),
      persona: personaInput(
        "What the bot's agent is told it is. An empty string clears it. At most 4,000 characters.",
      ).optional(),
      clear_notes: z.boolean().optional().describe("Erase the bot's own notes."),
    }),
    output: z.object({ bot: botSchema }),
    annotations: { ...WRITE, idempotentHint: true },
    run: async (call, input) => {
      const { deps, owner } = call;
      const own = await resolveAndTouch(call, input.bot);
      return {
        bot: await deps.db.transaction(async (tx) => {
          const patch: Parameters<typeof updateBot>[3] = {};
          if (input.name !== undefined) patch.name = input.name;
          if (input.tagline !== undefined) patch.tagline = input.tagline;
          if (input.persona !== undefined) patch.persona = input.persona;
          if (input.clear_notes) patch.clearNotes = true;
          const updated = await updateBot(tx, owner.id, own.id, patch);
          return (await botsWithStatus(tx, [updated]))[0]!;
        }),
      };
    },
    text: ({ bot }) => `Updated. ${botLine(bot)}`,
  });
}

function registerDeleteBot(server: McpServer): void {
  registerTool(server, {
    name: 'delete_bot',
    description:
      'Delete a bot for good. It resigns every game it is playing, cancels its challenges and frees its name. This cannot be undone.',
    input: z.object({ bot: botRef }),
    output: z.object({ deleted: z.string(), resignedGames: z.number().int() }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    run: async ({ deps, owner }, input) => {
      // No touchBotActivity: deleting anonymises the row and clears lastActiveAt.
      const bot = await deps.db.transaction((tx) => resolveOwnBot(tx, owner.id, input.bot));
      const resignedGames = await deleteBot(deps, owner.id, bot.id);
      return { deleted: bot.firstName, resignedGames };
    },
    text: ({ deleted, resignedGames }) =>
      `Deleted ${deleted}; it resigned ${resignedGames} ${resignedGames === 1 ? 'game' : 'games'}.`,
  });
}

function registerListMyGroups(server: McpServer): void {
  registerTool(server, {
    name: 'list_my_groups',
    description:
      'List the groups you are in, with which of your bots are in each. Use the groupId with add_bot_to_group.',
    input: z.object({}),
    output: z.object({
      groups: z.array(
        z.object({ groupId: z.string(), title: z.string(), myBots: z.array(z.string()) }),
      ),
    }),
    annotations: READ_ONLY,
    run: async ({ deps, owner }) => ({
      groups: await deps.db.transaction((tx) => ownerGroups(tx, owner.id)),
    }),
    text: ({ groups: list }) =>
      list.length === 0
        ? "You aren't in any group yet. Open Chess Goat in a Telegram group first."
        : list
            .map(
              (g) =>
                `${g.title} (${g.groupId}): ${g.myBots.length === 0 ? 'none of your bots' : g.myBots.join(', ')}`,
            )
            .join('\n'),
  });
}

function registerMembership(
  server: McpServer,
  name: 'add_bot_to_group' | 'remove_bot_from_group',
): void {
  const adding = name === 'add_bot_to_group';
  registerTool(server, {
    name,
    description: adding
      ? 'Put one of your bots into a group you are in, so people there can challenge it. Doing it again is harmless.'
      : 'Take one of your bots out of a group. Its pending challenges there are settled; games in progress are not touched.',
    input: z.object({ bot: botRef, group: groupRef }),
    output: z.object({ ok: z.literal(true) }),
    annotations: { ...WRITE, idempotentHint: true },
    run: async (call, input) => {
      const { deps, owner } = call;
      const bot = await resolveAndTouch(call, input.bot);
      await deps.db.transaction(async (tx) => {
        const group = await requireGroupByPublicId(tx, input.group);
        await (adding ? addBotToGroup : removeBotFromGroup)(tx, owner.id, bot.id, group.id);
      });
      return { ok: true as const };
    },
    text: () => (adding ? 'The bot is in the group.' : 'The bot is out of the group.'),
  });
}

export const registerManageTools = (server: McpServer): void => {
  registerListBots(server);
  registerCreateBot(server);
  registerUpdateBot(server);
  registerDeleteBot(server);
  registerListMyGroups(server);
  registerMembership(server, 'add_bot_to_group');
  registerMembership(server, 'remove_bot_from_group');
};
