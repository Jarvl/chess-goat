import { encodeStartParam } from '@chess-goat/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { jobs, ratings, type GameRow, type UserRow } from '../../src/db/schema';
import { buildRoundup } from '../../src/domain/botRoundup';
import { updateGroupSettings } from '../../src/domain/groups';
import { touchMember } from '../../src/domain/members';
import {
  botRoundupJobHandlers,
  ensureBotRoundupScheduled,
  secondsUntilNextRoundup,
} from '../../src/jobs/handlers/botRoundup';
import type { JobWorker } from '../../src/jobs/worker';
import { openTestDb, testDeps, truncateAll } from '../helpers/db';
import type { FakeTelegram } from '../helpers/fakeTelegram';
import { insertBot, insertGame, insertGroup, insertUser } from '../helpers/fixtures';
import { jobWorker } from '../helpers/worker';

const { db, close } = openTestDb();
const deps = testDeps(db);
let fake: FakeTelegram;
let worker: JobWorker;

beforeAll(async () => {
  ({ fake, worker } = await jobWorker(deps, botRoundupJobHandlers));
});
beforeEach(async () => {
  await truncateAll(db);
  fake.reset();
});
afterAll(async () => {
  await fake.stop();
  await close();
});

const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);

async function rate(groupId: number, user: UserRow, rating: number, wins = 1) {
  await db
    .insert(ratings)
    .values({ groupId, userId: user.id, rating, rd: 80, volatility: 0.06, gamesPlayed: 5, wins });
}

async function world() {
  const group = await insertGroup(db, { title: 'Chess Club', botStatus: 'administrator' });
  const owner = await insertUser(db, { username: 'owner' });
  await touchMember(db, group.id, owner.id, { verified: true });
  const human = await insertUser(db, { username: 'hana' });
  await touchMember(db, group.id, human.id);
  const rook = await insertBot(db, owner, { firstName: 'Rook', username: 'owner' });
  const pawn = await insertBot(db, owner, { firstName: 'Pawn', username: 'owner' });
  for (const bot of [rook, pawn]) await touchMember(db, group.id, bot.id);
  await rate(group.id, rook, 1800);
  await rate(group.id, pawn, 1400);
  await rate(group.id, human, 1700);
  return { group, owner, human, rook, pawn };
}

type Over = Partial<GameRow>;
const finished = (
  groupId: number,
  white: UserRow,
  black: UserRow,
  botPlayers: number,
  over: Over = {},
) =>
  insertGame(db, groupId, white.id, black.id, {
    botPlayers,
    status: 'finished',
    result: '1-0',
    endReason: 'checkmate',
    finishedAt: daysAgo(1),
    plyCount: 30,
    ...over,
  });

describe('buildRoundup', () => {
  it('summarises the finished bot games of the window', async () => {
    const { group, human, rook, pawn } = await world();
    // Pawn (1400) beats Rook (1800) bot-vs-bot: a 400 point upset.
    await finished(group.id, pawn, rook, 2, {
      whiteRatingBefore: 1400,
      blackRatingBefore: 1800,
    });
    // Rook beats the human; the human's snapshot is null, so the ratings row (1700) is used.
    await finished(group.id, rook, human, 1, { whiteRatingBefore: 1800 });
    // Pawn (1400) beats the human (1700 from the ratings row): a 300 point upset, smaller.
    await finished(group.id, human, pawn, 1, { result: '0-1', blackRatingBefore: 1400 });
    // Noise: human-only game, an old game, a voided game, an unfinished one.
    await finished(group.id, human, human, 0);
    await finished(group.id, pawn, rook, 2, { finishedAt: daysAgo(9) });
    await finished(group.id, pawn, rook, 2, { voidedAt: new Date() });
    await insertGame(db, group.id, pawn.id, rook.id, { botPlayers: 2 });

    const roundup = await buildRoundup(db, group.id, daysAgo(7));
    expect(roundup).toEqual({
      games: 3,
      topBot: { label: '🤖 Rook (@owner)', rating: 1800 },
      mostWins: { label: '🤖 Pawn (@owner)', wins: 2 },
      upset: { winner: '🤖 Pawn (@owner)', loser: '🤖 Rook (@owner)', gap: 400 },
    });
  });

  it('is null when no bot game finished in the window', async () => {
    const { group, human, rook, pawn } = await world();
    await finished(group.id, human, human, 0);
    await finished(group.id, pawn, rook, 2, { finishedAt: daysAgo(8) });
    expect(await buildRoundup(db, group.id, daysAgo(7))).toBeNull();
  });

  it('leaves out upset and most wins when every game was drawn or the favourite won', async () => {
    const { group, rook, pawn } = await world();
    await finished(group.id, rook, pawn, 2, {
      whiteRatingBefore: 1800,
      blackRatingBefore: 1400,
    });
    await finished(group.id, rook, pawn, 2, {
      result: '1/2-1/2',
      whiteRatingBefore: 1800,
      blackRatingBefore: 1400,
    });
    const roundup = await buildRoundup(db, group.id, daysAgo(7));
    expect(roundup?.upset).toBeNull();
    expect(roundup?.mostWins).toEqual({ label: '🤖 Rook (@owner)', wins: 1 });
    expect(roundup?.games).toBe(2);
  });
});

describe('secondsUntilNextRoundup', () => {
  const at = (iso: string) => new Date(iso);
  it('counts to the following Monday 17:00 UTC', () => {
    // 2026-11-08 is a Sunday; 2026-11-09 a Monday.
    expect(secondsUntilNextRoundup(at('2026-11-08T12:00:00Z'))).toBe(29 * 3600);
    expect(secondsUntilNextRoundup(at('2026-11-09T16:59:00Z'))).toBe(60);
    expect(secondsUntilNextRoundup(at('2026-11-09T17:01:00Z'))).toBe(7 * 86_400 - 60);
    expect(secondsUntilNextRoundup(at('2026-11-09T17:00:00Z'))).toBe(7 * 86_400);
  });
});

describe('bot_roundup job', () => {
  const pending = () =>
    db
      .select()
      .from(jobs)
      .where(and(eq(jobs.kind, 'bot_roundup'), isNull(jobs.doneAt)));

  async function due() {
    await ensureBotRoundupScheduled(db);
    await db
      .update(jobs)
      .set({ runAt: new Date(Date.now() - 1000) })
      .where(eq(jobs.kind, 'bot_roundup'));
  }

  it('arms one job at a time', async () => {
    await ensureBotRoundupScheduled(db);
    await ensureBotRoundupScheduled(db);
    const rows = await pending();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.dedupKey).toBe('bot_roundup');
    const wait = rows[0]!.runAt.getTime() - Date.now();
    expect(rows[0]!.runAt.getUTCDay()).toBe(1);
    expect(rows[0]!.runAt.getUTCHours()).toBe(17);
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(7 * 86_400_000);
  });

  it('posts only to groups with the setting on and activity, and schedules the next run', async () => {
    const { group, human, rook, pawn } = await world();
    await updateGroupSettings(db, group.id, { botRoundup: true });
    await finished(group.id, pawn, rook, 2, { whiteRatingBefore: 1400, blackRatingBefore: 1800 });
    // Active but off.
    const off = await insertGroup(db, { botStatus: 'member' });
    await touchMember(db, off.id, rook.id);
    await finished(off.id, pawn, rook, 2);
    // On but quiet.
    const quiet = await insertGroup(db, { botStatus: 'member' });
    await updateGroupSettings(db, quiet.id, { botRoundup: true });
    await finished(quiet.id, human, human, 0);
    // On and active but the bot left.
    const left = await insertGroup(db, { botStatus: 'left' });
    await updateGroupSettings(db, left.id, { botRoundup: true });
    await finished(left.id, pawn, rook, 2);

    await due();
    await worker.runOnce();

    const sent = fake.callsTo('sendMessage');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toMatchObject({
      chat_id: group.telegramChatId,
      text: [
        "🤖 This week's bots in Chess Club",
        '1 bot games played.',
        'Top bot: 🤖 Rook (@owner) (1800)',
        'Most wins: 🤖 Pawn (@owner) (1)',
        'Upset of the week: 🤖 Pawn (@owner) beat 🤖 Rook (@owner) (400 points lower)',
      ].join('\n'),
    });
    const link = (p: Parameters<typeof encodeStartParam>[0]) =>
      `https://t.me/TestChessBot/chess?startapp=${encodeStartParam(p)}`;
    expect(sent[0]?.body.reply_markup).toEqual({
      inline_keyboard: [
        [{ text: 'Bots', url: link({ kind: 'bots', groupId: group.publicId }) }],
        [{ text: '♟ Group lobby', url: link({ kind: 'lobby', groupId: group.publicId }) }],
      ],
    });
    const next = await pending();
    expect(next).toHaveLength(1);
    expect(next[0]?.runAt.getUTCDay()).toBe(1);
    expect(next[0]?.runAt.getUTCHours()).toBe(17);
    expect(next[0]!.runAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('posts nothing with no activity, and still schedules the next run', async () => {
    const { group } = await world();
    await updateGroupSettings(db, group.id, { botRoundup: true });
    await due();
    await worker.runOnce();
    expect(fake.callsTo('sendMessage')).toHaveLength(0);
    expect(await pending()).toHaveLength(1);
  });
});
