import { TimePerMoveSchema } from '@chess-goat/shared';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { isFindableBot, searchGroupBots, type BotSort } from '../../domain/botGroups';
import { createChallenge } from '../../domain/challenges';
import { DomainError } from '../../domain/errors';
import { requireGroupByPublicId } from '../../domain/groups';
import { getMember } from '../../domain/members';
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
});

/** Opaque keyset cursor: the sort key and id of the last bot on the page, plus the sort it is for. */
const encodeCursor = (sort: BotSort, key: number, id: number): string =>
  Buffer.from(JSON.stringify([sort, key, id])).toString('base64url');

function decodeCursor(sort: BotSort, cursor: string): { key: number; id: number } {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      Array.isArray(parsed) &&
      parsed.length === 3 &&
      parsed[0] === sort &&
      typeof parsed[1] === 'number' &&
      Number.isFinite(parsed[1]) &&
      Number.isInteger(parsed[2])
    ) {
      return { key: parsed[1], id: parsed[2] as number };
    }
  } catch {
    // Falls through to the error below.
  }
  throw new DomainError('validation', 'that cursor is not valid', { reason: 'invalid_cursor' });
}

function registerFindBots(server: McpServer): void {
  registerTool(server, {
    name: 'find_bots',
    description:
      "Finds other bots to challenge: live bots in a group you're in, optionally by a part of their name. sort is 'rating' (default, highest first), 'active' (most recently active) or 'newest'. Pass nextCursor back as cursor for the next page. Use a bot's id with challenge_bot.",
    input: z.object({
      group: groupRef,
      query: z.string().min(1).max(64).optional().describe('Part of the name, any case.'),
      sort: z.enum(['rating', 'active', 'newest']).optional(),
      limit: z.number().int().min(1).max(50).optional(),
      cursor: z.string().min(1).max(200).optional(),
    }),
    output: z.object({ bots: z.array(foundBot), nextCursor: z.string().nullable() }),
    annotations: READ_ONLY,
    run: ({ deps, owner }, input) =>
      deps.db.transaction(async (tx) => {
        const group = await requireGroupByPublicId(tx, input.group);
        const member = await getMember(tx, group.id, owner.id);
        if (member?.status !== 'member' || member.blockedAt !== null) {
          throw new DomainError('forbidden', 'you are not a member of that group', {
            reason: 'owner_not_member',
          });
        }
        const sort = input.sort ?? 'rating';
        const page = await searchGroupBots(tx, group.id, {
          query: input.query,
          sort,
          limit: input.limit ?? 20,
          cursor: input.cursor ? decodeCursor(sort, input.cursor) : undefined,
        });
        return {
          bots: page.rows.map(({ bot, rating }) => ({
            id: bot.id,
            name: bot.firstName,
            label: displayName(bot),
            owner: bot.ownerName ?? 'Unknown',
            tagline: bot.tagline,
            rating: Math.round(rating),
            lastActiveAt: bot.lastActiveAt?.toISOString() ?? null,
          })),
          nextCursor: page.next ? encodeCursor(sort, page.next.key, page.next.id) : null,
        };
      }),
    text: ({ bots, nextCursor }) =>
      (bots.length === 0
        ? 'No bots found.'
        : bots
            .map(
              (b) =>
                `${b.name} (id ${b.id}, ${b.rating}) by ${b.owner}${b.tagline ? ` - ${b.tagline}` : ''}`,
            )
            .join('\n')) + (nextCursor ? `\nMore: pass cursor ${nextCursor}` : ''),
  });
}

function registerChallengeBot(server: McpServer): void {
  registerTool(server, {
    name: 'challenge_bot',
    description:
      "Challenges another bot (an id from find_bots) on behalf of one of your bots. The challenge goes to that bot's inbox and expires in 24 hours. Bots can't challenge people. Games between two bots may have no clock (time_per_move null, the default). Challenges between your own bots are always casual.",
    input: z.object({
      bot: botRef,
      opponent_bot: z.number().int().describe("The opponent bot's id, from find_bots."),
      group: groupRef,
      time_per_move: TimePerMoveSchema.optional().describe(
        'Seconds per move: 3600, 28800, 86400, 259200, 604800, or null for no clock.',
      ),
      colour: z.enum(['white', 'black', 'random']).optional(),
      rated: z.boolean().optional(),
    }),
    output: z.object({ challengeId: z.string(), expiresAt: z.string() }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    run: async (call, input) => {
      const { deps } = call;
      const bot = await resolveAndTouch(call, input.bot);
      const group = await deps.db.transaction(async (tx) => {
        const group = await requireGroupByPublicId(tx, input.group);
        if (input.opponent_bot === bot.id) {
          throw new DomainError('validation', 'cannot challenge yourself', { reason: 'self' });
        }
        // A person, an unknown id and a bot find_bots wouldn't show all look the same.
        if (!(await isFindableBot(tx, group.id, input.opponent_bot))) {
          throw new DomainError('not_found', 'opponent bot not found', {
            reason: 'opponent_not_found',
          });
        }
        return group;
      });
      const challenge = await createChallenge(deps, {
        groupId: group.id,
        challengerId: bot.id,
        opponentId: input.opponent_bot,
        opponentUsername: null,
        timePerMove: input.time_per_move ?? null,
        colour: input.colour ?? 'random',
        rated: input.rated ?? true,
        threadId: null,
      });
      return { challengeId: challenge.publicId, expiresAt: challenge.expiresAt.toISOString() };
    },
    text: ({ challengeId, expiresAt }) =>
      `Challenge ${challengeId} sent. It expires at ${expiresAt}. Watch get_inbox for the game.`,
  });
}

export const registerChallengeTools = (server: McpServer): void => {
  registerFindBots(server);
  registerChallengeBot(server);
};
