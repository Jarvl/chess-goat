import { decodeCallbackData, type TimePerMove } from '@chess-goat/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { challenges, jobs } from '../../src/db/schema';
import { addBotToGroup } from '../../src/domain/botGroups';
import {
  acceptChallenge,
  cancelChallenge,
  createChallenge,
  createRematch,
  declineChallenge,
  expireChallenges,
} from '../../src/domain/challenges';
import { requireGroup } from '../../src/domain/groups';
import { markLeft, touchMember } from '../../src/domain/members';
import { renderChallengeCard } from '../../src/telegram/cards';
import { challengeCardView } from '../../src/telegram/views';
import { testConfig } from '../helpers/config';
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

/** A group with a human, an owner with two bots in it, and a second owner with one bot in it. */
async function setup() {
  const group = await insertGroup(db);
  const human = await insertUser(db, { username: 'human' });
  const owner = await insertUser(db);
  const otherOwner = await insertUser(db);
  const bot = await insertBot(db, owner);
  const sibling = await insertBot(db, owner);
  const rival = await insertBot(db, otherOwner);
  for (const user of [human, owner, otherOwner]) await touchMember(db, group.id, user.id);
  await addBotToGroup(db, owner.id, bot.id, group.id);
  await addBotToGroup(db, owner.id, sibling.id, group.id);
  await addBotToGroup(db, otherOwner.id, rival.id, group.id);
  return { group, human, owner, otherOwner, bot, sibling, rival };
}

const challenge = (
  groupId: number,
  challengerId: number,
  opponentId: number | null,
  over: { timePerMove?: TimePerMove; rated?: boolean; opponentUsername?: string | null } = {},
) =>
  createChallenge(deps, {
    groupId,
    challengerId,
    opponentId,
    opponentUsername: over.opponentUsername ?? null,
    timePerMove: over.timePerMove === undefined ? 86400 : over.timePerMove,
    colour: 'random',
    rated: over.rated ?? true,
    threadId: null,
  });

const reason = async (p: Promise<unknown>) => {
  const error = await p.then(
    () => null,
    (e: unknown) => e as { code: string; details?: { reason?: string } },
  );
  expect(error).not.toBeNull();
  return error!.details?.reason;
};

const jobKinds = async () => (await db.select().from(jobs).orderBy(jobs.id)).map((j) => j.kind);

describe('bot challenges', () => {
  it('a human challenges a bot', async () => {
    const { group, human, bot } = await setup();
    const created = await challenge(group.id, human.id, bot.id);
    expect(created.botPlayers).toBe(1);
    expect(await jobKinds()).toEqual(['send_challenge_card']);
  });

  it('a bot challenges a bot silently', async () => {
    const { group, bot, rival } = await setup();
    const created = await challenge(group.id, bot.id, rival.id, { timePerMove: null });
    expect(created.botPlayers).toBe(2);
    expect(created.timePerMove).toBeNull();
    expect(await jobKinds()).toEqual([]);
  });

  it('bots never challenge humans', async () => {
    const { group, human, bot } = await setup();
    expect(await reason(challenge(group.id, bot.id, human.id))).toBe('bots_challenge_bots_only');
    expect(await reason(challenge(group.id, bot.id, null))).toBe('bots_challenge_bots_only');
    expect(await reason(challenge(group.id, bot.id, null, { opponentUsername: 'human' }))).toBe(
      'bots_challenge_bots_only',
    );
    await expect(challenge(group.id, bot.id, human.id)).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(await db.select().from(challenges)).toEqual([]);
  });

  // The Pairing rules themselves are in pairing.test.ts; this checks the challenge stores them.
  it('same-owner games are stored casual', async () => {
    const { group, owner, bot } = await setup();
    expect((await challenge(group.id, owner.id, bot.id, { rated: true })).rated).toBe(false);
  });

  it('accept is refused when the owner left after the challenge was made', async () => {
    const { group, human, owner, bot } = await setup();
    const created = await challenge(group.id, human.id, bot.id);
    await markLeft(db, group.id, owner.id);
    expect(await reason(acceptChallenge(deps, { challengeId: created.id, userId: bot.id }))).toBe(
      'owner_not_member',
    );
    const [row] = await db.select().from(challenges).where(eq(challenges.id, created.id));
    expect(row?.status).toBe('pending');
  });

  it('a bot accepts a human’s challenge', async () => {
    const { group, human, bot, rival } = await setup();
    const created = await challenge(group.id, human.id, bot.id);
    const { game } = await acceptChallenge(deps, { challengeId: created.id, userId: bot.id });
    expect(game.botPlayers).toBe(created.botPlayers);
    expect(game.botPlayers).toBe(1);
    expect([game.whiteId, game.blackId].sort()).toEqual([human.id, bot.id].sort());

    const silent = await challenge(group.id, bot.id, rival.id, { timePerMove: null });
    const second = await acceptChallenge(deps, { challengeId: silent.id, userId: rival.id });
    expect(second.game.botPlayers).toBe(2);
    expect(second.game.timePerMove).toBeNull();
  });

  it('bot-vs-bot decline, cancel and expiry enqueue no card or DM jobs', async () => {
    const { group, bot, sibling, rival } = await setup();
    const declined = await challenge(group.id, bot.id, rival.id);
    await declineChallenge(deps, { challengeId: declined.id, userId: rival.id });
    const cancelled = await challenge(group.id, bot.id, sibling.id);
    await cancelChallenge(deps, { challengeId: cancelled.id, userId: bot.id });
    await insertChallenge(db, group.id, rival.id, bot.id, {
      botPlayers: 2,
      expiresInSeconds: -60,
    });
    expect(await expireChallenges(deps)).toBe(1);
    expect(await jobKinds()).toEqual([]);
  });

  it('a rematch keeps working for human-vs-bot, and a bot never rematches a human', async () => {
    const { group, human, bot } = await setup();
    const game = await insertGame(db, group.id, human.id, bot.id, {
      status: 'finished',
      botPlayers: 1,
    });
    const rematch = await createRematch(deps, { gameId: game.id, userId: human.id });
    expect(rematch).toMatchObject({ opponentId: bot.id, botPlayers: 1 });
    expect(await reason(createRematch(deps, { gameId: game.id, userId: bot.id }))).toBe(
      'bots_challenge_bots_only',
    );
  });

  it('the challenge card for a bot opponent has no Accept or Decline', async () => {
    const { group, human, bot } = await setup();
    const created = await challenge(group.id, human.id, bot.id);
    const view = await challengeCardView(
      db,
      created,
      await requireGroup(db, group.id),
      testConfig(),
    );
    const card = renderChallengeCard(view);
    const buttons = card.reply_markup?.inline_keyboard.flat() ?? [];
    const actions = buttons.flatMap((b) =>
      'callback_data' in b && b.callback_data ? [decodeCallbackData(b.callback_data)] : [],
    );
    expect(actions).toEqual([{ action: 'decline_challenge', challengeId: created.publicId }]);
    expect(buttons.map((b) => b.text)).toEqual(['Cancel', '♟ Group lobby']);
    expect(buttons.filter((b) => 'url' in b && b.url === view.lobbyLink)).toHaveLength(1);
    expect(card.text.split('\n')[0]).toContain('challenges');
  });
});
