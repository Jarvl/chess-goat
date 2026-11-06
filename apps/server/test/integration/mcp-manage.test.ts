import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { groupMembers, users, type UserRow } from '../../src/db/schema';
import { createBot } from '../../src/domain/bots';
import { createOwnerToken } from '../../src/domain/ownerTokens';
import { touchMember } from '../../src/domain/members';
import type { TestApi } from '../helpers/api';
import { openTestDb, truncateAll } from '../helpers/db';
import { insertBot, insertGame, insertGroup, insertUser } from '../helpers/fixtures';
import { callTool, resultText, startTestMcp } from '../helpers/mcp';

const { db, close } = openTestDb();
let api: TestApi;
let owner: UserRow;
let token: string;

beforeEach(async () => {
  if (api) await api.stop();
  await truncateAll(db);
  api = await startTestMcp(db);
  owner = await insertUser(db, { username: 'alice' });
  token = await db.transaction((tx) => createOwnerToken(tx, owner.id));
});
afterAll(async () => {
  await api?.stop();
  await close();
});

type BotOut = {
  id: number;
  name: string;
  label: string;
  tagline: string | null;
  lastActiveAt: string | null;
  groups: { groupId: string; title: string; rating: number; gamesPlayed: number }[];
  liveGames: number;
};

const call = <O = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}) =>
  callTool<O>(api.app, token, name, args);
const listed = async () => (await call<{ bots: BotOut[] }>('list_bots')).structuredContent!.bots;

describe('create_bot and list_bots', () => {
  it('creates a bot and lists it, with the exact next steps', async () => {
    const created = await call<{ bot: BotOut; nextSteps: string }>('create_bot', {
      name: '  Rook   Roller ',
      tagline: 'Pushes pawns',
    });
    expect(created.isError).toBeFalsy();
    expect(created.structuredContent!.nextSteps).toBe(
      "Your bot exists but isn't in any group yet. Call list_my_groups, then add_bot_to_group. Then loop on get_inbox (wait_seconds up to 45) to answer challenges and moves. People challenge bots from the group; bots can challenge other bots with find_bots and challenge_bot.",
    );
    expect(created.structuredContent!.bot).toMatchObject({
      name: 'Rook Roller',
      label: '🤖 Rook Roller (@alice)',
      tagline: 'Pushes pawns',
      groups: [],
      liveGames: 0,
    });
    expect(resultText(created)).toContain('Rook Roller');
    const bots = await listed();
    expect(bots).toHaveLength(1);
    expect(bots[0]).toEqual(created.structuredContent!.bot);
  });

  it('turns refusals into readable tool errors', async () => {
    await call('create_bot', { name: 'Taken' });
    const taken = await call('create_bot', { name: 'taken' });
    expect(taken.isError).toBe(true);
    expect(resultText(taken)).toMatch(/name taken/i);
    const invalid = await call('create_bot', { name: '!!!' });
    expect(invalid.isError).toBe(true);
    expect(resultText(invalid)).toMatch(/invalid bot name/i);
    for (let i = 1; i < 20; i += 1) await call('create_bot', { name: `Bot ${i}` });
    const over = await call('create_bot', { name: 'One too many' });
    expect(over.isError).toBe(true);
    expect(resultText(over)).toMatch(/too many bots/i);
    expect(await listed()).toHaveLength(20);
  });

  it('leaves exactly 20 after two concurrent creates at 19', async () => {
    for (let i = 0; i < 19; i += 1) {
      await db.transaction((tx) => createBot(tx, owner.id, { name: `Seed ${i}` }));
    }
    const results = await Promise.all([
      call('create_bot', { name: 'Racer A' }),
      call('create_bot', { name: 'Racer B' }),
    ]);
    expect(results.filter((r) => r.isError)).toHaveLength(1);
    expect(await listed()).toHaveLength(20);
  });

  it('shows groups with ratings and live games', async () => {
    const bot = await insertBot(db, owner);
    const group = await insertGroup(db, { title: 'Chess Club' });
    await touchMember(db, group.id, owner.id);
    await call('add_bot_to_group', { bot: bot.firstName, group: group.publicId });
    const other = await insertUser(db, { username: 'bob' });
    await insertGame(db, group.id, bot.id, other.id);
    const [view] = await listed();
    expect(view!.liveGames).toBe(1);
    expect(view!.groups).toEqual([
      { groupId: group.publicId, title: 'Chess Club', rating: 1500, gamesPlayed: 0 },
    ]);
  });
});

describe('update_bot and delete_bot', () => {
  it('updates a bot by name and by id', async () => {
    const created = await call<{ bot: BotOut }>('create_bot', { name: 'First' });
    const id = created.structuredContent!.bot.id;
    const byName = await call<{ bot: BotOut }>('update_bot', {
      bot: 'FIRST',
      name: 'Second',
      tagline: 'hello',
    });
    expect(byName.structuredContent!.bot).toMatchObject({ id, name: 'Second', tagline: 'hello' });
    const byId = await call<{ bot: BotOut }>('update_bot', { bot: id, name: 'Third' });
    expect(byId.structuredContent!.bot).toMatchObject({ id, name: 'Third', tagline: 'hello' });
  });

  it('refuses a rename to a taken name', async () => {
    await call('create_bot', { name: 'One' });
    await call('create_bot', { name: 'Two' });
    const result = await call('update_bot', { bot: 'Two', name: 'one' });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/name taken/i);
  });

  it('deletes a bot, resigning its live games', async () => {
    const bot = await insertBot(db, owner);
    const group = await insertGroup(db);
    const other = await insertUser(db, { username: 'bob' });
    await insertGame(db, group.id, bot.id, other.id);
    const result = await call<{ deleted: string; resignedGames: number }>('delete_bot', {
      bot: bot.firstName,
    });
    expect(result.structuredContent).toEqual({ deleted: bot.firstName, resignedGames: 1 });
    expect(await listed()).toEqual([]);
  });
});

describe('list_my_groups, add_bot_to_group and remove_bot_from_group', () => {
  it("shows only the owner's groups", async () => {
    const mine = await insertGroup(db, { title: 'Mine' });
    const left = await insertGroup(db, { title: 'Left' });
    const blocked = await insertGroup(db, { title: 'Blocked' });
    const elsewhere = await insertGroup(db, { title: 'Elsewhere' });
    const stranger = await insertUser(db, { username: 'bob' });
    await touchMember(db, mine.id, owner.id);
    await touchMember(db, left.id, owner.id);
    await db.update(groupMembers).set({ status: 'left' }).where(eq(groupMembers.groupId, left.id));
    await touchMember(db, blocked.id, owner.id);
    await db
      .update(groupMembers)
      .set({ blockedAt: new Date() })
      .where(eq(groupMembers.groupId, blocked.id));
    await touchMember(db, elsewhere.id, stranger.id);
    const bot = await insertBot(db, owner);
    await call('add_bot_to_group', { bot: bot.id, group: mine.publicId });
    const result = await call<{
      groups: { groupId: string; title: string; myBots: string[] }[];
    }>('list_my_groups');
    expect(result.structuredContent!.groups).toEqual([
      { groupId: mine.publicId, title: 'Mine', myBots: [bot.firstName] },
    ]);
  });

  it('adds a bot to a group and removes it again', async () => {
    const bot = await insertBot(db, owner);
    const group = await insertGroup(db);
    await touchMember(db, group.id, owner.id);
    const added = await call('add_bot_to_group', { bot: bot.firstName, group: group.publicId });
    expect(added.structuredContent).toEqual({ ok: true });
    expect((await listed())[0]!.groups.map((g) => g.groupId)).toEqual([group.publicId]);
    const removed = await call('remove_bot_from_group', {
      bot: bot.firstName.toUpperCase(),
      group: group.publicId,
    });
    expect(removed.structuredContent).toEqual({ ok: true });
    expect((await listed())[0]!.groups).toEqual([]);
  });

  it('refuses a group the owner is not in, and an unknown group', async () => {
    const bot = await insertBot(db, owner);
    const group = await insertGroup(db);
    const notIn = await call('add_bot_to_group', { bot: bot.id, group: group.publicId });
    expect(notIn.isError).toBe(true);
    const unknown = await call('add_bot_to_group', { bot: bot.id, group: 'nope' });
    expect(unknown.isError).toBe(true);
    expect(resultText(unknown)).toMatch(/group not found/i);
  });
});

describe("bot arguments never reach anyone else's bot, a deleted bot or the owner", () => {
  it('refuses with bot_not_found on every tool that takes a bot', async () => {
    const stranger = await insertUser(db, { username: 'bob' });
    const theirs = await insertBot(db, stranger);
    const deleted = await insertBot(db, owner);
    await db
      .update(users)
      .set({ firstName: 'Deleted bot', deletedAt: new Date() })
      .where(eq(users.id, deleted.id));
    const group = await insertGroup(db);
    await touchMember(db, group.id, owner.id);
    const refs: (string | number)[] = [theirs.firstName, theirs.id, deleted.id, owner.id, 'Nobody'];
    const tools: [string, Record<string, unknown>][] = [
      ['update_bot', { name: 'Renamed' }],
      ['delete_bot', {}],
      ['add_bot_to_group', { group: group.publicId }],
      ['remove_bot_from_group', { group: group.publicId }],
    ];
    for (const [name, extra] of tools) {
      for (const bot of refs) {
        const result = await call(name, { bot, ...extra });
        expect(result.isError, `${name} ${bot}`).toBe(true);
        expect(resultText(result), `${name} ${bot}`).toBe('Bot not found.');
      }
    }
    const [row] = await db.select().from(users).where(eq(users.id, theirs.id));
    expect(row!.deletedAt).toBeNull();
    expect(row!.firstName).toBe(theirs.firstName);
  });
});
