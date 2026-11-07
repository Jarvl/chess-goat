import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { challenges, games, groupMembers, jobs } from '../../src/db/schema';
import { adminBlock, adminUnblock, groupSettingsDto } from '../../src/domain/admin';
import { addBotToGroup, listGroupBots, removeBotFromGroup } from '../../src/domain/botGroups';
import { blockUser, isBlocked, markLeft, touchMember } from '../../src/domain/members';
import { mayPlay } from '../../src/domain/pairing';
import { openTestDb, testDeps, truncateAll } from '../helpers/db';
import {
  insertBot,
  insertChallenge,
  insertGame,
  insertGroup,
  insertUser,
} from '../helpers/fixtures';

const { db, close } = openTestDb();
const deps = testDeps(db);

beforeEach(() => truncateAll(db));
afterAll(() => close());

async function setup() {
  const group = await insertGroup(db);
  const owner = await insertUser(db);
  const admin = await insertUser(db);
  const bot = await insertBot(db, owner);
  await touchMember(db, group.id, owner.id);
  return { group, owner, admin, bot };
}

const reason = async (p: Promise<unknown>) => {
  const error = await p.then(
    () => null,
    (e: unknown) => e as { code: string; details?: { reason?: string } },
  );
  expect(error).not.toBeNull();
  return error!.details?.reason;
};

describe('bots in groups', () => {
  it("an owner adds their bot to a group they're in", async () => {
    const { group, owner, bot } = await setup();
    await addBotToGroup(db, owner.id, bot.id, group.id);
    await addBotToGroup(db, owner.id, bot.id, group.id);
    expect((await listGroupBots(db, group.id)).map((b) => b.id)).toEqual([bot.id]);
    await mayPlay(db, group.id, bot);
  });

  it("refuses when the owner isn't a member", async () => {
    const { group, owner, bot } = await setup();
    await markLeft(db, group.id, owner.id);
    expect(await reason(addBotToGroup(db, owner.id, bot.id, group.id))).toBe('owner_not_member');
  });

  it('refuses when the owner is blocked, and when the bot is blocked', async () => {
    const { group, owner, admin, bot } = await setup();
    await blockUser(db, group.id, owner.id, admin.id);
    expect(await reason(addBotToGroup(db, owner.id, bot.id, group.id))).toBe('blocked');
    await db.delete(groupMembers);
    await touchMember(db, group.id, owner.id);
    await blockUser(db, group.id, bot.id, admin.id);
    expect(await reason(addBotToGroup(db, owner.id, bot.id, group.id))).toBe('blocked');
  });

  it("refuses someone else's bot", async () => {
    const { group, bot } = await setup();
    const other = await insertUser(db);
    await touchMember(db, group.id, other.id);
    expect(await reason(addBotToGroup(db, other.id, bot.id, group.id))).toBe('bot_not_found');
  });

  it('blocking the owner blocks their bots', async () => {
    const { group, owner, admin, bot } = await setup();
    await addBotToGroup(db, owner.id, bot.id, group.id);
    expect(await isBlocked(db, group.id, bot.id)).toBe(false);
    await adminBlock(deps, group, admin.id, owner.id);
    expect(await isBlocked(db, group.id, bot.id)).toBe(true);
    expect(await reason(mayPlay(db, group.id, bot))).toBe('blocked');
    await adminUnblock(deps, group, admin.id, owner.id);
    expect(await isBlocked(db, group.id, bot.id)).toBe(false);
  });

  it("blocking cancels the bots' pending challenges but not live games", async () => {
    const { group, owner, admin, bot } = await setup();
    const human = await insertUser(db);
    const bot2 = await insertBot(db, await insertUser(db));
    await addBotToGroup(db, owner.id, bot.id, group.id);
    const toBot = await insertChallenge(db, group.id, human.id, bot.id, { botPlayers: 1 });
    const botToBot = await insertChallenge(db, group.id, bot.id, bot2.id, { botPlayers: 2 });
    const game = await insertGame(db, group.id, bot.id, bot2.id, { botPlayers: 2 });
    await db.delete(jobs);
    await adminBlock(deps, group, admin.id, owner.id);
    const status = async (id: number) =>
      (await db.select().from(challenges).where(eq(challenges.id, id)))[0]!.status;
    expect(await status(toBot.id)).toBe('declined');
    expect(await status(botToBot.id)).toBe('cancelled');
    const edits = (await db.select().from(jobs)).filter((j) => j.kind === 'edit_card');
    expect(edits.map((j) => j.payload)).toEqual([{ challengeId: toBot.id }]);
    expect((await db.select().from(games).where(eq(games.id, game.id)))[0]!.status).toBe('active');
  });

  it('removing a bot from a group cancels its challenges there', async () => {
    const { group, owner, bot } = await setup();
    const human = await insertUser(db);
    await addBotToGroup(db, owner.id, bot.id, group.id);
    const incoming = await insertChallenge(db, group.id, human.id, bot.id, { botPlayers: 1 });
    const outgoing = await insertChallenge(db, group.id, bot.id, await botOf(), { botPlayers: 2 });
    await removeBotFromGroup(db, owner.id, bot.id, group.id);
    const status = async (id: number) =>
      (await db.select().from(challenges).where(eq(challenges.id, id)))[0]!.status;
    expect(await status(incoming.id)).toBe('declined');
    expect(await status(outgoing.id)).toBe('cancelled');
    expect(await listGroupBots(db, group.id)).toEqual([]);
    async function botOf() {
      return (await insertBot(db, await insertUser(db))).id;
    }
  });

  it("groupSettingsDto lists the group's bots with their blocked state", async () => {
    const { group, owner, admin, bot } = await setup();
    const second = await insertBot(db, owner, { firstName: 'Zed' });
    await addBotToGroup(db, owner.id, bot.id, group.id);
    await addBotToGroup(db, owner.id, second.id, group.id);
    await blockUser(db, group.id, second.id, admin.id);
    const dto = await groupSettingsDto(db, group);
    expect(dto.bots.map((b) => [b.id, b.blocked, b.blockedViaOwner])).toEqual([
      [String(bot.id), false, false],
      [String(second.id), true, false],
    ]);
  });

  it('keeps a blocked bot listed after it leaves, and marks bots blocked via their owner', async () => {
    const { group, owner, admin, bot } = await setup();
    await addBotToGroup(db, owner.id, bot.id, group.id);
    await adminBlock(deps, group, admin.id, bot.id);
    await removeBotFromGroup(db, owner.id, bot.id, group.id);
    const dto = await groupSettingsDto(db, group);
    expect(dto.bots.map((b) => [b.id, b.blocked])).toEqual([[String(bot.id), true]]);
    await adminUnblock(deps, group, admin.id, bot.id);
    await adminBlock(deps, group, admin.id, owner.id);
    await touchMember(db, group.id, bot.id);
    const via = await groupSettingsDto(db, group);
    expect(via.bots.map((b) => [b.blocked, b.blockedViaOwner])).toEqual([[true, true]]);
  });
});
