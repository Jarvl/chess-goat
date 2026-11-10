import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { challenges, groupMembers, matchNotes, users, type UserRow } from '../../src/db/schema';
import { resign } from '../../src/domain/games';
import { touchMember } from '../../src/domain/members';
import { loadTurnView, renderTurnPrompt } from '../../src/domain/turnPrompt';
import { releaseTurn } from '../../src/domain/turnLeases';
import { pendingTurns } from '../../src/domain/turns';
import type { TestApi } from '../helpers/api';
import { openTestDb, truncateAll } from '../helpers/db';
import { insertBot, insertGame, insertGroup, insertUser, played } from '../helpers/fixtures';
import { callTool, claimFor, mcpCall, resultText, startTestMcp } from '../helpers/mcp';

const { db, close } = openTestDb();
let api: TestApi;
let owner: UserRow;
let other: UserRow;

beforeEach(async () => {
  if (api) await api.stop();
  await truncateAll(db);
  api = await startTestMcp(db);
  owner = await insertUser(db, { username: 'alice' });
  other = await insertUser(db, { username: 'bob' });
});
afterAll(async () => {
  await api?.stop();
  await close();
});

type Found = { bots: { id: number; name: string; online?: boolean }[]; nextCursor: string | null };

async function botIn(groupId: number, ownerRow: UserRow, firstName: string) {
  const bot = await insertBot(db, ownerRow, { firstName });
  await touchMember(db, groupId, ownerRow.id);
  await touchMember(db, groupId, bot.id);
  return bot;
}

/** Rook (alice's) resigned its game against a person in a group: one game-over turn for Rook. */
async function gameOverTurn() {
  const group = await insertGroup(db);
  const bot = await botIn(group.id, owner, 'Rook');
  const human = await insertUser(db, { username: 'carol' });
  await touchMember(db, group.id, human.id);
  const game = await insertGame(db, group.id, bot.id, human.id);
  await played(db, game, ['e2e4', 'e7e5']);
  await resign(api.deps, { gameId: game.publicId, userId: bot.id });
  return { group, bot, human, game };
}

const toolNames = async (token: string) =>
  (
    ((await mcpCall(api.app, token, 'tools/list')).response?.result?.tools ?? []) as {
      name: string;
    }[]
  ).map((t) => t.name);

describe('game-over turn', () => {
  it('offers find_bots, challenge_bot and set_notes', async () => {
    const { bot } = await gameOverTurn();
    const { token, lease } = await claimFor(api, bot);
    expect(lease.kind).toBe('game_over');
    expect(await toolNames(token)).toEqual(['find_bots', 'challenge_bot', 'set_notes']);
  });

  it('find_bots lists the group’s other bots, not the caller and not another group’s', async () => {
    const { group, bot } = await gameOverTurn();
    const pawn = await botIn(group.id, other, 'Pawn');
    const elsewhere = await insertGroup(db);
    await botIn(elsewhere.id, other, 'Elsewhere');
    const { token } = await claimFor(api, bot);
    const out = await callTool<Found>(api.app, token, 'find_bots', {});
    expect(out.isError).toBeFalsy();
    expect(out.structuredContent!.bots.map((b) => b.id)).toEqual([pawn.id]);
    expect(out.structuredContent!.bots[0]!.online).toBe(false);
    expect(resultText(out)).not.toContain('get_inbox');
    const named = await callTool<Found>(api.app, token, 'find_bots', { query: 'ELSE' });
    expect(named.structuredContent!.bots).toEqual([]);
  });

  it('challenge_bot starts a challenge turn for the opponent bot', async () => {
    const { group, bot } = await gameOverTurn();
    const pawn = await botIn(group.id, other, 'Pawn');
    const { token } = await claimFor(api, bot);
    const out = await callTool<{ challengeId: string; expiresAt: string }>(
      api.app,
      token,
      'challenge_bot',
      { opponent_bot: pawn.id, time_per_move: 86400 },
    );
    expect(out.isError).toBeFalsy();
    const [row] = await db.select().from(challenges);
    expect(row).toMatchObject({
      challengerId: bot.id,
      opponentId: pawn.id,
      groupId: group.id,
      timePerMove: 86400,
    });
    expect(out.structuredContent).toEqual({
      challengeId: row!.publicId,
      expiresAt: row!.expiresAt.toISOString(),
    });
    expect(resultText(out)).not.toContain('get_inbox');
    expect(await pendingTurns(db, [pawn.id])).toMatchObject([
      { botId: pawn.id, kind: 'challenge', challengeId: row!.id },
    ]);
  });

  it('challenge_bot reads alike for a person and a bot of another group', async () => {
    const { human, bot } = await gameOverTurn();
    const elsewhere = await insertGroup(db);
    const outside = await botIn(elsewhere.id, other, 'Elsewhere');
    const { token } = await claimFor(api, bot);
    const texts: string[] = [];
    for (const opponent_bot of [human.id, outside.id]) {
      const out = await callTool(api.app, token, 'challenge_bot', { opponent_bot });
      expect(out.isError).toBe(true);
      texts.push(resultText(out));
    }
    expect(new Set(texts).size).toBe(1);
    expect(await db.select().from(challenges)).toHaveLength(0);
  });

  it('set_notes writes the finished game’s match notes, read in the prompt and gone after the lease', async () => {
    const { bot, game } = await gameOverTurn();
    const { token, lease, runner } = await claimFor(api, bot);
    const out = await callTool(api.app, token, 'set_notes', {
      match_notes: 'they resign early',
      bot_notes: 'be patient',
    });
    expect(out.isError).toBeFalsy();
    const [row] = await db.select().from(matchNotes).where(eq(matchNotes.gameId, game.id));
    expect(row!.body).toBe('they resign early');

    const view = await loadTurnView(db, lease, bot);
    expect(renderTurnPrompt(view)).toContain('they resign early');

    await releaseTurn(db, runner.id, lease.id, lease.claimSeq, new Date());
    expect(await db.select().from(matchNotes)).toEqual([]);
  });

  describe('a calling bot that can no longer play in the group', () => {
    const STOP =
      'Your bot can no longer play in this group, so it cannot challenge anyone here. Stop.';

    const leave = (groupId: number, userId: number) =>
      db
        .update(groupMembers)
        .set({ status: 'left' })
        .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId)));

    async function refused(
      leaver: (t: Awaited<ReturnType<typeof gameOverTurn>>) => Promise<unknown>,
    ) {
      const t = await gameOverTurn();
      const pawn = await botIn(t.group.id, other, 'Pawn');
      const { token } = await claimFor(api, t.bot);
      await leaver(t);
      const find = await callTool(api.app, token, 'find_bots', {});
      const challenge = await callTool(api.app, token, 'challenge_bot', { opponent_bot: pawn.id });
      return { find, challenge };
    }

    it('is told so by find_bots and challenge_bot once removed from the group', async () => {
      const { find, challenge } = await refused((t) => leave(t.group.id, t.bot.id));
      for (const out of [find, challenge]) {
        expect(out.isError).toBe(true);
        expect(resultText(out)).toBe(STOP);
      }
      expect(await db.select().from(challenges)).toHaveLength(0);
    });

    it('is told so when its owner is no longer a member', async () => {
      const { find, challenge } = await refused((t) => leave(t.group.id, owner.id));
      for (const out of [find, challenge]) expect(resultText(out)).toBe(STOP);
    });

    it('is told so when it is blocked', async () => {
      const { find, challenge } = await refused((t) =>
        db
          .update(groupMembers)
          .set({ blockedAt: new Date() })
          .where(and(eq(groupMembers.groupId, t.group.id), eq(groupMembers.userId, t.bot.id))),
      );
      for (const out of [find, challenge]) expect(resultText(out)).toBe(STOP);
    });
  });

  it('reads a deleted opponent bot as not found', async () => {
    const { group, bot } = await gameOverTurn();
    const pawn = await botIn(group.id, other, 'Pawn');
    await db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, pawn.id));
    const { token } = await claimFor(api, bot);
    const out = await callTool(api.app, token, 'challenge_bot', { opponent_bot: pawn.id });
    expect(out.isError).toBe(true);
    expect(resultText(out)).toBe(
      'Opponent bot not found. Use a bot id from find_bots for that group.',
    );
  });
});
