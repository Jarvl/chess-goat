import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { matchNotes, turnLeases, users, type UserRow } from '../../src/db/schema';
import { touchMember } from '../../src/domain/members';
import type { TestApi } from '../helpers/api';
import { openTestDb, truncateAll } from '../helpers/db';
import {
  insertBot,
  insertChallenge,
  insertGame,
  insertGroup,
  insertUser,
} from '../helpers/fixtures';
import { callTool, claimFor, mcpCall, resultText, startTestMcp } from '../helpers/mcp';

const { db, close } = openTestDb();
let api: TestApi;
let owner: UserRow;

beforeEach(async () => {
  if (api) await api.stop();
  await truncateAll(db);
  api = await startTestMcp(db);
  owner = await insertUser(db, { username: 'alice' });
});
afterAll(async () => {
  await api?.stop();
  await close();
});

type Saved = {
  botNotes?: { length: number; limit: number };
  matchNotes?: { length: number; limit: number };
};

async function moveTurn() {
  const group = await insertGroup(db);
  await touchMember(db, group.id, owner.id);
  const bot = await insertBot(db, owner, { firstName: 'Rook' });
  const human = await insertUser(db, { username: 'bob' });
  await touchMember(db, group.id, human.id);
  const game = await insertGame(db, group.id, bot.id, human.id);
  return { group, bot, human, game };
}

const botNotesOf = async (id: number) =>
  (await db.select().from(users).where(eq(users.id, id)))[0]!.botNotes;

describe('set_notes', () => {
  it('advertises maxLength 4000 and 2000 in its input schema', async () => {
    const { bot } = await moveTurn();
    const { token } = await claimFor(api, bot);
    const tools = (await mcpCall(api.app, token, 'tools/list')).response?.result?.tools as {
      name: string;
      inputSchema: { properties: Record<string, { maxLength?: number; description?: string }> };
    }[];
    const { properties } = tools.find((t) => t.name === 'set_notes')!.inputSchema;
    expect(properties.bot_notes!.maxLength).toBe(4000);
    expect(properties.match_notes!.maxLength).toBe(2000);
    expect(properties.bot_notes!.description).toBe(
      'Replaces the whole text. At most 4,000 characters.',
    );
    expect(properties.match_notes!.description).toBe(
      'Replaces the whole text. At most 2,000 characters.',
    );
  });

  it('saves bot notes and match notes, and says which', async () => {
    const { bot, game } = await moveTurn();
    const { token } = await claimFor(api, bot);
    const both = await callTool<Saved>(api.app, token, 'set_notes', {
      bot_notes: 'x'.repeat(1240),
      match_notes: 'plays the Sicilian',
    });
    expect(both.isError).toBeFalsy();
    expect(both.structuredContent).toEqual({
      botNotes: { length: 1240, limit: 4000 },
      matchNotes: { length: 18, limit: 2000 },
    });
    expect(resultText(both)).toBe(
      'Bot notes saved (1,240 of 4,000 characters). Match notes saved (18 of 2,000 characters).',
    );
    expect(await botNotesOf(bot.id)).toBe('x'.repeat(1240));
    const [row] = await db.select().from(matchNotes).where(eq(matchNotes.gameId, game.id));
    expect(row!.body).toBe('plays the Sicilian');
  });

  it('needs at least one of the two', async () => {
    const { bot } = await moveTurn();
    const { token } = await claimFor(api, bot);
    const out = await callTool(api.app, token, 'set_notes', {});
    expect(out.isError).toBe(true);
    expect(resultText(out)).toBe('Give bot_notes, match_notes or both.');
  });

  it('still works after the move, until the lease ends', async () => {
    const { bot } = await moveTurn();
    const { token, lease } = await claimFor(api, bot);
    expect((await callTool(api.app, token, 'make_move', { move: 'e4' })).isError).toBeFalsy();
    const out = await callTool(api.app, token, 'set_notes', { bot_notes: 'after the move' });
    expect(out.isError).toBeFalsy();
    expect(await botNotesOf(bot.id)).toBe('after the move');
    await db
      .update(turnLeases)
      .set({ leasedUntil: new Date(Date.now() - 1000) })
      .where(eq(turnLeases.id, lease.id));
    // Past the lease the token is no longer accepted at all.
    await expect(callTool(api.app, token, 'set_notes', { bot_notes: 'too late' })).rejects.toThrow(
      /HTTP 401/,
    );
    expect(await botNotesOf(bot.id)).toBe('after the move');
  });

  it('says how many characters to cut', async () => {
    const { bot } = await moveTurn();
    const { token } = await claimFor(api, bot);
    const out = await callTool(api.app, token, 'set_notes', { bot_notes: 'x'.repeat(4010) });
    expect(out.isError).toBe(true);
    expect(resultText(out)).toBe('Too long by 10 characters; shorten and call set_notes again.');
    const match = await callTool(api.app, token, 'set_notes', { match_notes: 'x'.repeat(2003) });
    expect(resultText(match)).toContain('Too long by 3 characters');
  });

  it('counts code points: 2,500 emoji fit in bot notes', async () => {
    const { bot } = await moveTurn();
    const { token } = await claimFor(api, bot);
    const out = await callTool<Saved>(api.app, token, 'set_notes', {
      bot_notes: '😀'.repeat(2500),
    });
    expect(out.isError).toBeFalsy();
    expect(out.structuredContent!.botNotes).toEqual({ length: 2500, limit: 4000 });
  });

  it('refuses match notes on a challenge turn but saves bot notes', async () => {
    const group = await insertGroup(db);
    const bot = await insertBot(db, owner, { firstName: 'Rook' });
    const human = await insertUser(db, { username: 'bob' });
    await touchMember(db, group.id, bot.id);
    await insertChallenge(db, group.id, human.id, bot.id);
    const { token } = await claimFor(api, bot);
    const refused = await callTool(api.app, token, 'set_notes', { match_notes: 'hi' });
    expect(refused.isError).toBe(true);
    expect(resultText(refused)).toBe(
      'There is no match yet, so there are no match notes. Use bot_notes.',
    );
    const ok = await callTool(api.app, token, 'set_notes', { bot_notes: 'hi' });
    expect(ok.isError).toBeFalsy();
  });

  it('writes match notes to the game of the token’s own lease', async () => {
    const { group, bot, game } = await moveTurn();
    const second = await insertUser(db, { username: 'carol' });
    await touchMember(db, group.id, second.id);
    const secondGame = await insertGame(db, group.id, bot.id, second.id);
    const first = await claimFor(api, bot);
    const later = await claimFor(api, bot);
    expect(first.lease.gameId).not.toBe(later.lease.gameId);
    await callTool(api.app, first.token, 'set_notes', { match_notes: 'first' });
    await callTool(api.app, later.token, 'set_notes', { match_notes: 'second' });
    const byGame = new Map(
      (await db.select().from(matchNotes)).map((r) => [r.gameId, r.body] as const),
    );
    expect(byGame.size).toBe(2);
    expect(byGame.get(first.lease.gameId!)).toBe('first');
    expect(byGame.get(later.lease.gameId!)).toBe('second');
    expect([...byGame.keys()].sort()).toEqual([game.id, secondGame.id].sort());
  });

  it('after another game changed bot notes returns them, and the retry succeeds', async () => {
    const { group, bot } = await moveTurn();
    const second = await insertUser(db, { username: 'carol' });
    await touchMember(db, group.id, second.id);
    await insertGame(db, group.id, bot.id, second.id);
    const first = await claimFor(api, bot);
    const other = await claimFor(api, bot);
    expect(other.lease.id).not.toBe(first.lease.id);
    expect(
      (await callTool(api.app, first.token, 'set_notes', { bot_notes: 'from game one' })).isError,
    ).toBeFalsy();
    const clash = await callTool(api.app, other.token, 'set_notes', { bot_notes: 'from game two' });
    expect(clash.isError).toBe(true);
    expect(resultText(clash)).toContain('from game one');
    expect(await botNotesOf(bot.id)).toBe('from game one');
    const retry = await callTool(api.app, other.token, 'set_notes', {
      bot_notes: 'from game one and two',
    });
    expect(retry.isError).toBeFalsy();
    expect(await botNotesOf(bot.id)).toBe('from game one and two');
  });

  it('keeps the match notes when the bot notes are refused', async () => {
    const { group, bot } = await moveTurn();
    const second = await insertUser(db, { username: 'carol' });
    await touchMember(db, group.id, second.id);
    await insertGame(db, group.id, bot.id, second.id);
    const first = await claimFor(api, bot);
    const later = await claimFor(api, bot);
    await callTool(api.app, first.token, 'set_notes', { bot_notes: 'one' });
    const clash = await callTool(api.app, later.token, 'set_notes', {
      bot_notes: 'two',
      match_notes: 'kept',
    });
    expect(clash.isError).toBe(true);
    const rows = await db.select().from(matchNotes);
    expect(rows.map((r) => r.body)).toEqual(['kept']);
  });
});
