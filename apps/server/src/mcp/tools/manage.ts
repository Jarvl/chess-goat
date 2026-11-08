import { z } from 'zod';
import {
  botViews,
  createBot,
  deleteBot,
  listBots,
  resolveOwnBot,
  updateBot,
  type BotView,
} from '../../domain/bots';
import { addBotToGroup, ownerGroups, removeBotFromGroup } from '../../domain/botGroups';
import { requireGroupByPublicId } from '../../domain/groups';
import type { McpServer } from '@modelcontextprotocol/server';
import { BOT_DOCS_URL } from '../../links';
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
});

const botLine = (bot: BotView): string => {
  const where =
    bot.groups.length === 0
      ? 'in no group'
      : `in ${bot.groups.map((g) => `${g.title} (${g.rating})`).join(', ')}`;
  const tagline = bot.tagline ? ` "${bot.tagline}"` : '';
  const games = bot.liveGames === 1 ? '1 live game' : `${bot.liveGames} live games`;
  return `${bot.label}${tagline}, ${where}, ${games}`;
};

const NEXT_STEPS =
  "Your bot exists but isn't in any group yet. Call list_my_groups, then add_bot_to_group. Then loop on get_inbox (wait_seconds up to 45) to answer challenges and moves. People challenge bots from the group; bots can challenge other bots with find_bots and challenge_bot." +
  ` Docs: ${BOT_DOCS_URL}.`;

export const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

function registerListBots(server: McpServer): void {
  registerTool(server, {
    name: 'list_bots',
    description:
      'List your bots with the groups each is in (and its rating there) and how many games it is playing now.',
    input: z.object({}),
    output: z.object({ bots: z.array(botSchema) }),
    annotations: READ_ONLY,
    run: async ({ deps, owner }) => ({
      bots: await deps.db.transaction(async (tx) => botViews(tx, await listBots(tx, owner.id))),
    }),
    text: ({ bots }) =>
      bots.length === 0
        ? 'You have no bots yet. Call create_bot to make one.'
        : bots.map(botLine).join('\n'),
  });
}

function registerCreateBot(server: McpServer): void {
  registerTool(server, {
    name: 'create_bot',
    description:
      'Create a bot of yours (up to 20). Names are unique across Chess Goat, case-insensitive: letters, digits, spaces, dots, dashes and underscores, up to 32 characters. The tagline is optional, up to 80 characters.',
    input: z.object({
      name: z.string().max(100),
      tagline: z.string().max(200).optional(),
    }),
    output: z.object({ bot: botSchema, nextSteps: z.string() }),
    annotations: WRITE,
    run: async ({ deps, owner }, input) => ({
      // `bot_name_taken` aborts the transaction and propagates; it is never caught inside it.
      bot: await deps.db.transaction(async (tx) => {
        const bot = await createBot(tx, owner.id, input);
        return (await botViews(tx, [bot]))[0]!;
      }),
      nextSteps: NEXT_STEPS,
    }),
    text: ({ bot, nextSteps }) => `Created ${bot.label}. ${nextSteps}`,
  });
}

function registerUpdateBot(server: McpServer): void {
  registerTool(server, {
    name: 'update_bot',
    description: 'Rename a bot or change its tagline. An empty tagline clears it.',
    input: z.object({
      bot: botRef,
      name: z.string().max(100).optional(),
      tagline: z.string().max(200).optional(),
    }),
    output: z.object({ bot: botSchema }),
    annotations: { ...WRITE, idempotentHint: true },
    run: async (call, input) => {
      const { deps, owner } = call;
      const own = await resolveAndTouch(call, input.bot);
      return {
        bot: await deps.db.transaction(async (tx) => {
          const patch: { name?: string; tagline?: string } = {};
          if (input.name !== undefined) patch.name = input.name;
          if (input.tagline !== undefined) patch.tagline = input.tagline;
          const updated = await updateBot(tx, owner.id, own.id, patch);
          return (await botViews(tx, [updated]))[0]!;
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
