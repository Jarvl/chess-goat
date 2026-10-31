import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { challenges, dmMessages, games, jobs, users } from '../../src/db/schema';
import {
  acceptChallenge,
  cancelChallenge,
  createChallenge,
  createRematch,
  declineChallenge,
  expireChallenges,
  setChallengeMessage,
} from '../../src/domain/challenges';
import { updateGroupSettings } from '../../src/domain/groups';
import { blockUser } from '../../src/domain/members';
import { challengeCardView } from '../../src/telegram/views';
import { requireGroup } from '../../src/domain/groups';
import { testConfig } from '../helpers/config';
import { openTestDb, testDeps, truncateAll } from '../helpers/db';
import { insertChallenge, insertGame, insertUser, world } from '../helpers/fixtures';

const { db, close } = openTestDb();
const deps = testDeps(db);

beforeEach(() => truncateAll(db));
afterAll(() => close());

const direct = (groupId: number, challengerId: number, opponentId: number | null) =>
  createChallenge(deps, {
    groupId,
    challengerId,
    opponentId,
    opponentUsername: null,
    timePerMove: 86400,
    colour: 'random',
    rated: true,
    threadId: null,
  });

const jobRows = () => db.select().from(jobs).orderBy(jobs.id);
const secondsUntil = async (table: 'games' | 'challenges', column: string, id: number) => {
  const [row] = await db.execute(
    sql`select extract(epoch from (${sql.raw(column)} - now())) as seconds from ${sql.raw(table)} where id = ${id}`,
  );
  return Number(row?.seconds);
};

describe('createChallenge', () => {
  it('creates a direct challenge with a 24 h expiry and enqueues the card and the DM', async () => {
    const { group, alice, bob } = await world(db, { game: false });
    const challenge = await direct(group.id, alice.id, bob.id);
    expect(challenge).toMatchObject({
      status: 'pending',
      challengerId: alice.id,
      opponentId: bob.id,
    });
    expect(challenge.publicId).toHaveLength(10);
    expect(await secondsUntil('challenges', 'expires_at', challenge.id)).toBeGreaterThan(86_000);
    const all = await jobRows();
    expect(all.map((job) => [job.kind, job.dedupKey])).toEqual([
      ['send_challenge_card', `card:send:${challenge.publicId}`],
      ['send_dm', `dm:${bob.id}:ch:${challenge.publicId}`],
    ]);
    expect(all[1]?.payload).toEqual({
      userId: bob.id,
      template: 'challenge',
      challengeId: challenge.id,
    });
  });

  it('refuses a self-challenge', async () => {
    const { group, alice } = await world(db, { game: false });
    await expect(direct(group.id, alice.id, alice.id)).rejects.toMatchObject({
      code: 'validation',
      details: { reason: 'self' },
    });
  });

  it('enforces three pending challenges per user per group', async () => {
    const { group, alice, bob, carol } = await world(db, { game: false });
    const dave = await insertUser(db);
    const erin = await insertUser(db);
    await direct(group.id, alice.id, bob.id);
    await direct(group.id, alice.id, carol.id);
    await direct(group.id, alice.id, dave.id);
    await expect(direct(group.id, alice.id, erin.id)).rejects.toMatchObject({
      code: 'limit_exceeded',
      details: { reason: 'pending_limit', count: 3 },
    });
  });

  it('caps nobody: a challenge is fine however many games either player already has', async () => {
    const { group, alice, bob, carol } = await world(db, { game: false });
    // Well past every limit this project used to impose (5 per player, 2 per pair).
    for (let i = 0; i < 6; i += 1) {
      await insertGame(db, group.id, bob.id, carol.id);
      await insertGame(db, group.id, alice.id, bob.id);
    }
    await expect(direct(group.id, alice.id, bob.id)).resolves.toBeDefined();
  });

  it('refuses a blocked challenger', async () => {
    const { group, alice, bob } = await world(db, { game: false });
    await blockUser(db, group.id, alice.id, bob.id);
    await expect(direct(group.id, alice.id, bob.id)).rejects.toMatchObject({
      code: 'forbidden',
      details: { reason: 'blocked' },
    });
  });

  it('allows open challenges only when the group allows them', async () => {
    const { group, alice } = await world(db, { game: false });
    const open = await direct(group.id, alice.id, null);
    expect(open.opponentId).toBeNull();
    expect((await jobRows()).map((job) => job.kind)).toEqual(['send_challenge_card']);
    await updateGroupSettings(db, group.id, { allowOpenChallenges: false });
    await expect(direct(group.id, alice.id, null)).rejects.toMatchObject({
      code: 'forbidden',
      details: { reason: 'open_disabled' },
    });
  });
});

describe('acceptChallenge', () => {
  it('creates the game with the chosen colours, White’s clock and the card and DM jobs', async () => {
    const { group, alice, bob } = await world(db, { game: false });
    await db.update(users).set({ dmAllowed: true }).where(eq(users.id, bob.id));
    const challenge = await createChallenge(deps, {
      groupId: group.id,
      challengerId: alice.id,
      opponentId: bob.id,
      opponentUsername: null,
      timePerMove: 86400,
      colour: 'black',
      rated: true,
      threadId: 55,
    });
    await db.update(challenges).set({ messageId: 777 }).where(eq(challenges.id, challenge.id));
    await db.delete(jobs);

    const { game, challenge: accepted } = await acceptChallenge(deps, {
      challengeId: challenge.id,
      userId: bob.id,
    });

    expect(game).toMatchObject({
      whiteId: bob.id,
      blackId: alice.id,
      status: 'active',
      plyCount: 0,
      rated: true,
      timePerMove: 86400,
      cardMessageId: 777,
      cardThreadId: 55,
    });
    expect(await secondsUntil('games', 'deadline_at', game.id)).toBeGreaterThan(86_390);
    expect(await secondsUntil('games', 'reminder_at', game.id)).toBeGreaterThan(77_750);
    expect(accepted).toMatchObject({ status: 'accepted', gameId: game.id });
    expect((await jobRows()).map((job) => [job.kind, job.dedupKey])).toEqual([
      ['edit_card', `card:g:${game.publicId}`],
      ['send_dm', `dm:${bob.id}:g:${game.publicId}`],
    ]);
  });

  it('hands a late card message id to the game that was accepted before the card was sent', async () => {
    const { group, alice, bob } = await world(db, { game: false });
    const challenge = await direct(group.id, alice.id, bob.id);
    const { game } = await acceptChallenge(deps, { challengeId: challenge.id, userId: bob.id });
    expect(game.cardMessageId).toBeNull();

    await setChallengeMessage(db, challenge.id, 901);
    await setChallengeMessage(db, challenge.id, 902);

    const [storedChallenge] = await db.select().from(challenges);
    const [storedGame] = await db.select().from(games);
    expect(storedChallenge?.messageId).toBe(902);
    expect(storedGame?.cardMessageId).toBe(901);
  });

  it('sets no reminder when White has not allowed DMs', async () => {
    const { group, alice, bob } = await world(db, { game: false });
    const challenge = await direct(group.id, alice.id, bob.id);
    const { game } = await acceptChallenge(deps, { challengeId: challenge.id, userId: bob.id });
    expect(game.reminderAt).toBeNull();
  });

  it('lets only the challenged player accept a direct challenge', async () => {
    const { group, alice, bob, carol } = await world(db, { game: false });
    const challenge = await direct(group.id, alice.id, bob.id);
    await expect(
      acceptChallenge(deps, { challengeId: challenge.id, userId: carol.id }),
    ).rejects.toMatchObject({
      code: 'forbidden',
      details: { reason: 'not_your_challenge', opponentId: bob.id },
    });
  });

  it('refuses the challenger of an open challenge', async () => {
    const { group, alice } = await world(db, { game: false });
    const challenge = await direct(group.id, alice.id, null);
    await expect(
      acceptChallenge(deps, { challengeId: challenge.id, userId: alice.id }),
    ).rejects.toMatchObject({
      code: 'forbidden',
      details: { reason: 'own_challenge' },
    });
  });

  it('lets exactly one of two concurrent acceptances win an open challenge', async () => {
    const { group, alice, bob, carol } = await world(db, { game: false });
    const challenge = await direct(group.id, alice.id, null);
    const results = await Promise.allSettled([
      acceptChallenge(deps, { challengeId: challenge.id, userId: bob.id }),
      acceptChallenge(deps, { challengeId: challenge.id, userId: carol.id }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'stale_state',
      details: { reason: 'accepted_first' },
    });
    expect(await db.select().from(games)).toHaveLength(1);
  });

  it('refuses a challenge past its expiry even before the scanner ran', async () => {
    const { group, alice, bob } = await world(db, { game: false });
    const challenge = await insertChallenge(db, group.id, alice.id, bob.id, {
      expiresInSeconds: -5,
    });
    await expect(
      acceptChallenge(deps, { challengeId: challenge.id, userId: bob.id }),
    ).rejects.toMatchObject({
      code: 'expired',
    });
  });
});

describe('decline, cancel, expire', () => {
  it('lets the opponent decline and the challenger cancel, each editing the card', async () => {
    const { group, alice, bob } = await world(db, { game: false });
    const first = await direct(group.id, alice.id, bob.id);
    await expect(
      declineChallenge(deps, { challengeId: first.id, userId: alice.id }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect((await declineChallenge(deps, { challengeId: first.id, userId: bob.id })).status).toBe(
      'declined',
    );
    const second = await direct(group.id, alice.id, bob.id);
    await expect(
      cancelChallenge(deps, { challengeId: second.id, userId: bob.id }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect((await cancelChallenge(deps, { challengeId: second.id, userId: alice.id })).status).toBe(
      'cancelled',
    );
    const edits = (await jobRows())
      .filter((job) => job.kind === 'edit_card')
      .map((job) => job.dedupKey);
    expect(edits).toEqual([`card:ch:${first.publicId}`, `card:ch:${second.publicId}`]);
  });

  it('points a bystander at the challenger when they tap Cancel on an open challenge', async () => {
    const { group, alice, bob } = await world(db, { game: false });
    const open = await direct(group.id, alice.id, null);
    await expect(
      declineChallenge(deps, { challengeId: open.id, userId: bob.id }),
    ).rejects.toMatchObject({
      code: 'forbidden',
      details: { reason: 'not_the_challenger', challengerId: alice.id },
    });
    expect((await cancelChallenge(deps, { challengeId: open.id, userId: alice.id })).status).toBe(
      'cancelled',
    );
  });

  it('names the challenger when someone else tries to withdraw a direct challenge', async () => {
    const { group, alice, bob } = await world(db, { game: false });
    const challenge = await direct(group.id, alice.id, bob.id);
    await expect(
      cancelChallenge(deps, { challengeId: challenge.id, userId: bob.id }),
    ).rejects.toMatchObject({
      code: 'forbidden',
      details: { reason: 'not_the_challenger', challengerId: alice.id },
    });
  });

  it('refuses to act on a challenge that is no longer pending', async () => {
    const { group, alice, bob } = await world(db, { game: false });
    const challenge = await direct(group.id, alice.id, bob.id);
    await declineChallenge(deps, { challengeId: challenge.id, userId: bob.id });
    await expect(
      acceptChallenge(deps, { challengeId: challenge.id, userId: bob.id }),
    ).rejects.toMatchObject({
      code: 'expired',
      details: { reason: 'challenge_gone' },
    });
  });

  it('expires only the pending challenges that are past due', async () => {
    const { group, alice, bob, carol } = await world(db, { game: false });
    const overdue = await insertChallenge(db, group.id, alice.id, bob.id, { expiresInSeconds: -1 });
    const fresh = await insertChallenge(db, group.id, alice.id, carol.id, {
      expiresInSeconds: 3600,
    });
    expect(await expireChallenges(deps)).toBe(1);
    const rows = await db.select().from(challenges).orderBy(challenges.id);
    expect(rows.map((row) => [row.id, row.status])).toEqual([
      [overdue.id, 'expired'],
      [fresh.id, 'pending'],
    ]);
    expect((await jobRows()).map((job) => job.dedupKey)).toEqual([`card:ch:${overdue.publicId}`]);
  });
});

describe('createRematch', () => {
  it('reverses the colours and copies the terms of a finished game', async () => {
    const { group, alice, bob } = await world(db, { game: false });
    const game = await insertGame(db, group.id, alice.id, bob.id, {
      timePerMove: 3600,
      rated: false,
      status: 'finished',
      result: '1-0',
      endReason: 'resignation',
      finishedAt: new Date(),
      cardThreadId: 9,
    });
    const rematch = await createRematch(deps, { gameId: game.id, userId: bob.id });
    expect(rematch).toMatchObject({
      challengerId: bob.id,
      opponentId: alice.id,
      challengerColour: 'white',
      timePerMove: 3600,
      rated: false,
      threadId: 9,
      status: 'pending',
    });
  });

  it('refuses a rematch from a spectator or on a running game', async () => {
    const { group, alice, bob, carol } = await world(db, { game: false });
    const running = await insertGame(db, group.id, alice.id, bob.id);
    await expect(
      createRematch(deps, { gameId: running.id, userId: alice.id }),
    ).rejects.toMatchObject({ code: 'stale_state' });
    const done = await insertGame(db, group.id, alice.id, bob.id, {
      status: 'finished',
      result: '0-1',
      endReason: 'checkmate',
      finishedAt: new Date(),
    });
    await expect(createRematch(deps, { gameId: done.id, userId: carol.id })).rejects.toMatchObject({
      code: 'forbidden',
    });
  });
});

describe('challenge DMs', () => {
  async function withLiveDm() {
    const { group, alice, bob } = await world(db, { game: false });
    const challenge = await insertChallenge(db, group.id, alice.id, bob.id);
    await db.insert(dmMessages).values({
      userId: bob.id,
      chatId: 22,
      challengeId: challenge.id,
      telegramMessageId: 101,
      kind: 'challenge',
      stub: 'Challenge from Alice expired',
      sentAt: new Date(),
    });
    return { alice, bob, challenge };
  }
  const retired = async () => ({
    rows: await db.select().from(dmMessages),
    texts: (await jobRows())
      .filter((job) => job.kind === 'retire_dm')
      .map((job) => job.payload.text),
  });

  it('retires the challenge DM on accept', async () => {
    const { bob, challenge } = await withLiveDm();
    await acceptChallenge(deps, { challengeId: challenge.id, userId: bob.id });
    expect(await retired()).toEqual({ rows: [], texts: ['Challenge from Alice accepted'] });
  });

  it('retires the challenge DM on decline', async () => {
    const { bob, challenge } = await withLiveDm();
    await declineChallenge(deps, { challengeId: challenge.id, userId: bob.id });
    expect(await retired()).toEqual({ rows: [], texts: ['Challenge from Alice declined'] });
  });

  it('retires the challenge DM on cancel', async () => {
    const { alice, challenge } = await withLiveDm();
    await cancelChallenge(deps, { challengeId: challenge.id, userId: alice.id });
    expect(await retired()).toEqual({ rows: [], texts: ['Challenge from Alice cancelled'] });
  });

  it('retires the challenge DM on expiry', async () => {
    const { challenge } = await withLiveDm();
    await db
      .update(challenges)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(challenges.id, challenge.id));
    await expireChallenges(deps);
    expect(await retired()).toEqual({ rows: [], texts: ['Challenge from Alice expired'] });
  });
});

describe('challenges by username', () => {
  const byUsername = (groupId: number, challengerId: number, opponentUsername: string) =>
    createChallenge(deps, {
      groupId,
      challengerId,
      opponentId: null,
      opponentUsername,
      timePerMove: 86400,
      colour: 'random',
      rated: true,
      threadId: null,
    });

  it('lets only the named username accept, whatever its case, and fills in the opponent', async () => {
    const { group, alice, bob } = await world(db, { game: false });
    const challenge = await byUsername(group.id, alice.id, '@Bob');
    expect(challenge).toMatchObject({ opponentId: null, opponentUsername: 'bob' });
    await db.update(users).set({ username: 'BOB' }).where(eq(users.id, bob.id));
    const { challenge: accepted } = await acceptChallenge(deps, {
      challengeId: challenge.id,
      userId: bob.id,
    });
    expect(accepted).toMatchObject({
      status: 'accepted',
      opponentId: bob.id,
      opponentUsername: null,
    });
  });

  it('refuses an accepter whose username differs or who has none, naming @bob', async () => {
    const { group, alice, bob } = await world(db, { game: false });
    const challenge = await byUsername(group.id, alice.id, 'bob');
    const details = { reason: 'not_your_challenge', opponentUsername: 'bob' };
    await db.update(users).set({ username: 'robert' }).where(eq(users.id, bob.id));
    await expect(
      acceptChallenge(deps, { challengeId: challenge.id, userId: bob.id }),
    ).rejects.toMatchObject({ code: 'forbidden', details });
    await db.update(users).set({ username: null }).where(eq(users.id, bob.id));
    await expect(
      acceptChallenge(deps, { challengeId: challenge.id, userId: bob.id }),
    ).rejects.toMatchObject({ code: 'forbidden', details });
    await expect(
      declineChallenge(deps, { challengeId: challenge.id, userId: bob.id }),
    ).rejects.toMatchObject({ code: 'forbidden', details });
    await expect(
      acceptChallenge(deps, { challengeId: challenge.id, userId: alice.id }),
    ).rejects.toMatchObject({ code: 'forbidden', details });
  });

  it('lets the named username decline and the challenger withdraw', async () => {
    const { group, alice, bob } = await world(db, { game: false });
    await db.update(users).set({ username: 'bob' }).where(eq(users.id, bob.id));
    const first = await byUsername(group.id, alice.id, 'bob');
    expect((await declineChallenge(deps, { challengeId: first.id, userId: bob.id })).status).toBe(
      'declined',
    );
    const second = await byUsername(group.id, alice.id, 'bob');
    expect((await cancelChallenge(deps, { challengeId: second.id, userId: alice.id })).status).toBe(
      'cancelled',
    );
  });

  it('refuses a challenge to the challenger’s own username, whatever its case', async () => {
    const { group, alice } = await world(db, { game: false });
    await db.update(users).set({ username: 'Alice' }).where(eq(users.id, alice.id));
    await expect(byUsername(group.id, alice.id, '@alice')).rejects.toMatchObject({
      code: 'validation',
      details: { reason: 'self' },
    });
  });

  it('rejects both an id and a username', async () => {
    const { group, alice, bob } = await world(db, { game: false });
    await expect(
      createChallenge(deps, {
        groupId: group.id,
        challengerId: alice.id,
        opponentId: bob.id,
        opponentUsername: 'bob',
        timePerMove: 86400,
        colour: 'random',
        rated: true,
        threadId: null,
      }),
    ).rejects.toMatchObject({ code: 'validation' });
  });

  it('sends no challenge DM for a username challenge and renders @bob on the card', async () => {
    const { group, alice } = await world(db, { game: false });
    const challenge = await byUsername(group.id, alice.id, 'Bob');
    expect((await jobRows()).map((job) => job.kind)).toEqual(['send_challenge_card']);
    const view = await challengeCardView(
      db,
      challenge,
      await requireGroup(db, group.id),
      testConfig(),
    );
    expect(view.opponent).toEqual({
      name: '@bob',
      username: 'bob',
      telegramUserId: null,
      flair: '',
    });
  });
});
