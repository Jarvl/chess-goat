import { TimePerMoveSchema, type ColourChoice, type TimePerMove } from '@chess-goat/shared';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { DbOrTx } from '../../db/client';
import {
  decodeBotCursor,
  encodeBotCursor,
  searchGroupBots,
  type BotSort,
} from '../../domain/botGroups';
import { createChallenge } from '../../domain/challenges';
import type { Deps } from '../../domain/deps';
import { DomainError } from '../../domain/errors';
import { requireGroupByPublicId } from '../../domain/groups';
import { isActiveMember } from '../../domain/members';
import { onlineBotIds } from '../../domain/runners';
import { displayName } from '../../domain/users';
import { registerTool, resolveAndTouch } from '../tool';
import { botRef, READ_ONLY } from './manage';

const groupRef = z.string().min(1).max(64).describe("The group's id, from list_my_groups.");

const foundBot = z.object({
  id: z.number().int(),
  name: z.string(),
  label: z.string(),
  owner: z.string(),
  tagline: z.string().nullable(),
  rating: z.number(),
  lastActiveAt: z.string().nullable(),
  online: z.boolean(),
});

/** What `find_bots` returns, on either surface. */
export const foundBotsOutput = z.object({
  bots: z.array(foundBot),
  nextCursor: z.string().nullable(),
});
type FoundBots = z.infer<typeof foundBotsOutput>;

/** What `challenge_bot` returns, on either surface. */
export const challengeSentOutput = z.object({ challengeId: z.string(), expiresAt: z.string() });

/** The `find_bots` filters both surfaces take. */
export const findBotsFilters = {
  query: z.string().min(1).max(64).optional().describe('Part of the name, any case.'),
  sort: z.enum(['rating', 'active', 'newest']).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  cursor: z.string().min(1).max(200).optional(),
};

/** The `challenge_bot` settings both surfaces take. */
export const challengeSettings = {
  opponent_bot: z.number().int().describe("The opponent bot's id, from find_bots."),
  time_per_move: TimePerMoveSchema.optional().describe(
    'Seconds per move: 3600, 28800, 86400, 259200, 604800, or null for no clock.',
  ),
  colour: z.enum(['white', 'black', 'random']).optional(),
  rated: z.boolean().optional(),
};

/** The end of both `find_bots` descriptions, after what group they search. */
export const FIND_BOTS_HOW =
  "optionally by a part of their name. sort is 'rating' (default, highest first), 'active' (most recently active) or 'newest'. Pass nextCursor back as cursor for the next page. Use a bot's id with challenge_bot. Online bots, those whose runner is connected, are listed first within each page and will answer a challenge; an offline bot may let it expire.";

export const findBotsText = ({ bots, nextCursor }: FoundBots): string =>
  (bots.length === 0
    ? 'No other bots in this group yet. People can still challenge yours.'
    : bots
        .map(
          (b) =>
            `${b.name} (id ${b.id}, ${b.rating}) by ${b.owner}${b.online ? ' (online)' : ' (offline)'}${b.tagline ? ` - ${b.tagline}` : ''}`,
        )
        .join('\n')) + (nextCursor ? `\nMore: pass cursor ${nextCursor}` : '');

/** One page of the findable bots of a group (not `excludeId`), as both surfaces' `find_bots` show it. */
export async function findBotsIn(
  tx: DbOrTx,
  groupId: number,
  opts: {
    query?: string;
    sort?: BotSort;
    limit?: number;
    cursor?: string;
    excludeId?: number;
  },
): Promise<FoundBots> {
  const sort = opts.sort ?? 'rating';
  const page = await searchGroupBots(tx, groupId, {
    query: opts.query,
    sort,
    excludeId: opts.excludeId,
    limit: opts.limit ?? 20,
    cursor: opts.cursor ? decodeBotCursor(sort, opts.cursor) : undefined,
  });
  const online = await onlineBotIds(
    tx,
    page.rows.map(({ bot }) => bot.id),
    new Date(),
  );
  const bots = page.rows.map(({ bot, rating }) => ({
    id: bot.id,
    name: bot.firstName,
    label: displayName(bot),
    owner: bot.ownerName ?? 'Unknown',
    tagline: bot.tagline,
    rating: Math.round(rating),
    lastActiveAt: bot.lastActiveAt?.toISOString() ?? null,
    online: online.has(bot.id),
  }));
  return {
    // Within the page only: the cursor follows the database order.
    bots: [...bots.filter((b) => b.online), ...bots.filter((b) => !b.online)],
    nextCursor: page.next ? encodeBotCursor(sort, page.next.key, page.next.id) : null,
  };
}

/**
 * A challenge from `challengerId` to a bot, for both surfaces. Pairing refuses a person, an unknown
 * id or an unfindable bot; the tool error translator makes those read alike ("opponent bot not
 * found"), so a challenge can't probe who exists.
 */
export async function challengeBot(
  deps: Deps,
  input: {
    challengerId: number;
    groupId: number;
    opponent_bot: number;
    time_per_move?: TimePerMove | null;
    colour?: ColourChoice;
    rated?: boolean;
  },
): Promise<z.infer<typeof challengeSentOutput>> {
  const challenge = await createChallenge(deps, {
    groupId: input.groupId,
    challengerId: input.challengerId,
    opponentId: input.opponent_bot,
    opponentUsername: null,
    timePerMove: input.time_per_move ?? null,
    colour: input.colour ?? 'random',
    rated: input.rated ?? true,
    threadId: null,
  });
  return { challengeId: challenge.publicId, expiresAt: challenge.expiresAt.toISOString() };
}

function registerFindBots(server: McpServer): void {
  registerTool(server, {
    name: 'find_bots',
    description: `Finds other bots to challenge: live bots in a group you're in, ${FIND_BOTS_HOW}`,
    input: z.object({ group: groupRef, ...findBotsFilters }),
    output: foundBotsOutput,
    annotations: READ_ONLY,
    run: ({ deps, owner }, { group: groupPublicId, ...filters }) =>
      deps.db.transaction(async (tx) => {
        const group = await requireGroupByPublicId(tx, groupPublicId);
        if (!(await isActiveMember(tx, group.id, owner.id))) {
          throw new DomainError('forbidden', 'you are not a member of that group', {
            reason: 'owner_not_member',
          });
        }
        return findBotsIn(tx, group.id, filters);
      }),
    text: findBotsText,
  });
}

function registerChallengeBot(server: McpServer): void {
  registerTool(server, {
    name: 'challenge_bot',
    description:
      "Challenges another bot (an id from find_bots) on behalf of one of your bots. The challenge goes to that bot's runner and expires in 24 hours. Bots can't challenge people. Games between two bots may have no clock (time_per_move null, the default). Challenges between your own bots are always casual.",
    input: z.object({ bot: botRef, group: groupRef, ...challengeSettings }),
    output: challengeSentOutput,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    run: async (call, { bot: botArg, group: groupPublicId, ...settings }) => {
      const { deps } = call;
      const bot = await resolveAndTouch(call, botArg);
      const group = await requireGroupByPublicId(deps.db, groupPublicId);
      return challengeBot(deps, { challengerId: bot.id, groupId: group.id, ...settings });
    },
    text: ({ challengeId, expiresAt }) =>
      `Challenge ${challengeId} sent. It expires at ${expiresAt}. Your bot's runner plays the game once the other bot accepts.`,
  });
}

export const registerChallengeTools = (server: McpServer): void => {
  registerFindBots(server);
  registerChallengeBot(server);
};
