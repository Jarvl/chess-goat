import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  games,
  matchNotes,
  runners,
  turnLeases,
  users,
  type GameRow,
  type RunnerRow,
  type UserRow,
} from '../../src/db/schema';
import { setMatchNotes } from '../../src/domain/botNotes';
import { abortGame, playMove, resign } from '../../src/domain/games';
import {
  claimTurn,
  failingTurns,
  offerGameOverTurns,
  releaseTurn,
  reportPractice,
  startPractice,
  requireLiveLease,
  spendCall,
  unclaimTurn,
} from '../../src/domain/turnLeases';
import { openTestDb, testDeps, truncateAll } from '../helpers/db';
import { insertBot, insertGame, insertGroup, insertUser } from '../helpers/fixtures';

const { db, close } = openTestDb();
const deps = testDeps(db);
beforeEach(() => truncateAll(db));
afterAll(close);

// Real time, whole seconds: rows the database stamps with now() must be claimable at T0.
const T0 = new Date(Math.ceil(Date.now() / 1000) * 1000 + 1000);
const at = (seconds: number): Date => new Date(T0.getTime() + seconds * 1000);

async function insertRunner(
  owner: Pick<UserRow, 'id'>,
  botIds: number[] | null = null,
): Promise<RunnerRow> {
  const [row] = await db
    .insert(runners)
    .values({ ownerId: owner.id, label: 'laptop', botIds, credentialHash: randomBytes(32) })
    .returning();
  return row!;
}

/** An owner's bot on the move (White) against a person, and a runner serving all its bots. */
async function setup() {
  const group = await insertGroup(db);
  const owner = await insertUser(db);
  const bot = await insertBot(db, owner);
  const human = await insertUser(db);
  const game = await insertGame(db, group.id, bot.id, human.id);
  const runner = await insertRunner(owner);
  return { group, owner, bot, human, game, runner };
}

const leaseRows = () => db.select().from(turnLeases);

describe('claimTurn', () => {
  it('gives a turn to exactly one of two simultaneous claims', async () => {
    const { owner, runner: runnerA } = await setup();
    const runnerB = await insertRunner(owner);
    const [a, b] = await Promise.all([claimTurn(deps, runnerA, {}), claimTurn(deps, runnerB, {})]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await leaseRows()).toHaveLength(1);
  });

  it('leases the move turn with its bot and the notes revision it saw', async () => {
    const { bot, game, runner } = await setup();
    await db.update(users).set({ botNotesRevision: 4 }).where(eq(users.id, bot.id));
    const claimed = await claimTurn(deps, runner, { now: T0 });
    expect(claimed?.bot.id).toBe(bot.id);
    expect(claimed?.lease).toMatchObject({
      botId: bot.id,
      kind: 'move',
      gameId: game.id,
      challengeId: null,
      ply: 0,
      runnerId: runner.id,
      callsUsed: 0,
      notesRevisionSeen: 4,
    });
  });

  it('clamps a requested lease to 900 s and defaults to 300 s', async () => {
    const { group, bot, human, runner } = await setup();
    await insertGame(db, group.id, bot.id, human.id);
    const first = await claimTurn(deps, runner, { now: T0 });
    expect(first?.lease.leasedUntil).toEqual(at(300));
    const second = await claimTurn(deps, runner, { now: T0, leaseSeconds: 3600 });
    expect(second?.lease.leasedUntil).toEqual(at(900));
    expect(second?.lease.id).not.toBe(first?.lease.id);
  });

  it('a released turn waits 60 s, then 300 s, then 1800 s, and stays at 1800 s', async () => {
    const { runner } = await setup();
    let now = T0;
    for (const delay of [60, 300, 1800, 1800]) {
      const claimed = await claimTurn(deps, runner, { now });
      expect(claimed).not.toBeNull();
      await releaseTurn(db, runner.id, claimed!.lease.id, claimed!.lease.claimSeq, now);
      expect(
        await claimTurn(deps, runner, { now: new Date(now.getTime() + (delay - 1) * 1000) }),
      ).toBeNull();
      now = new Date(now.getTime() + delay * 1000);
    }
    expect(await claimTurn(deps, runner, { now })).not.toBeNull();
    const [row] = await leaseRows();
    expect(row!.failures).toBe(4);
    expect(await failingTurns(db, [row!.botId])).toEqual(new Map([[row!.botId, 1]]));
  });

  it('an expired lease counts as a failure', async () => {
    const { runner } = await setup();
    const claimed = await claimTurn(deps, runner, { now: T0, leaseSeconds: 60 });
    expect(claimed?.lease.claimSeq).toBe(1);
    expect(await claimTurn(deps, runner, { now: at(59) })).toBeNull();
    // The lease ended at 60 s; noticed later, the retry delay still runs from then.
    expect(await claimTurn(deps, runner, { now: at(100) })).toBeNull();
    const [row] = await leaseRows();
    expect(row).toMatchObject({ failures: 1, runnerId: null, leasedUntil: null });
    expect(row!.claimableAt).toEqual(at(120));
    // Noticed once: a later claim counts no second failure.
    expect(await claimTurn(deps, runner, { now: at(110) })).toBeNull();
    expect((await leaseRows())[0]!.failures).toBe(1);
    const again = await claimTurn(deps, runner, { now: at(120) });
    expect(again?.lease).toMatchObject({ id: claimed!.lease.id, claimSeq: 2 });
  });

  for (const reclaimer of ['another runner', 'the same runner'] as const) {
    it(`an expired session cannot act on the lease ${reclaimer} took over`, async () => {
      const { owner, runner } = await setup();
      const other = reclaimer === 'the same runner' ? runner : await insertRunner(owner);
      const first = (await claimTurn(deps, runner, { now: T0, leaseSeconds: 60 }))!.lease;
      const second = (await claimTurn(deps, other, { now: at(120) }))!.lease;
      expect(second).toMatchObject({ id: first.id, runnerId: other.id, failures: 1 });
      expect(second.claimSeq).toBe(first.claimSeq + 1);

      const ended = { details: { reason: 'turn_ended' } };
      const stale = { claimSeq: first.claimSeq };
      await expect(requireLiveLease(db, first.id, at(130), stale)).rejects.toMatchObject(ended);
      await expect(spendCall(db, first.id, first.claimSeq)).rejects.toMatchObject(ended);
      await releaseTurn(db, runner.id, first.id, first.claimSeq, at(130));

      // The new session's lease, budget and failure count are untouched.
      const [row] = await leaseRows();
      expect(row).toMatchObject({
        runnerId: other.id,
        leasedUntil: second.leasedUntil,
        callsUsed: 0,
        failures: 1,
      });
      await expect(
        requireLiveLease(db, second.id, at(130), { claimSeq: second.claimSeq }),
      ).resolves.toMatchObject({ id: second.id });
      await spendCall(db, second.id, second.claimSeq);
    });
  }

  it('ignores a release by a runner that does not hold the lease', async () => {
    const { owner, runner } = await setup();
    const other = await insertRunner(owner);
    const claimed = await claimTurn(deps, runner, { now: T0 });
    await releaseTurn(db, other.id, claimed!.lease.id, claimed!.lease.claimSeq, T0);
    await releaseTurn(db, runner.id, 999_999, 1, T0);
    const [row] = await leaseRows();
    expect(row).toMatchObject({ runnerId: runner.id, failures: 0 });
  });

  it('drops the lease row once the move is played', async () => {
    const { bot, game, runner } = await setup();
    const claimed = await claimTurn(deps, runner, { now: T0, leaseSeconds: 60 });
    await playMove(deps, { gameId: game.publicId, userId: bot.id, move: 'e4', expectedPly: 0 });
    expect(await claimTurn(deps, runner, { now: at(60) })).toBeNull();
    expect(await leaseRows()).toEqual([]);
    expect(claimed).not.toBeNull();
  });

  it('keeps a resolved lease until it expires so notes can still be written', async () => {
    const { bot, game, runner } = await setup();
    const claimed = await claimTurn(deps, runner, { now: T0, leaseSeconds: 60 });
    const leaseId = claimed!.lease.id;
    await playMove(deps, { gameId: game.publicId, userId: bot.id, move: 'e4', expectedPly: 0 });
    expect(await claimTurn(deps, runner, { now: at(30) })).toBeNull();
    expect(await leaseRows()).toHaveLength(1);
    await expect(
      requireLiveLease(db, leaseId, at(30), { allowResolved: true }),
    ).resolves.toMatchObject({ id: leaseId });
    // Its lease ends: the row goes, and no failure is counted anywhere.
    expect(await claimTurn(deps, runner, { now: at(60) })).toBeNull();
    expect(await leaseRows()).toEqual([]);
  });

  it('drops a resolved turn released early without counting a failure', async () => {
    const { bot, game, runner } = await setup();
    const claimed = await claimTurn(deps, runner, { now: T0 });
    await playMove(deps, { gameId: game.publicId, userId: bot.id, move: 'e4', expectedPly: 0 });
    await releaseTurn(db, runner.id, claimed!.lease.id, claimed!.lease.claimSeq, at(10));
    expect(await leaseRows()).toEqual([]);
  });

  it('serves only the bots in runner.botIds when set', async () => {
    const { group, owner, bot, human } = await setup();
    const second = await insertBot(db, owner);
    await insertGame(db, group.id, second.id, human.id);
    const narrow = await insertRunner(owner, [second.id]);
    const first = await claimTurn(deps, narrow, { now: T0 });
    expect(first?.bot.id).toBe(second.id);
    expect(await claimTurn(deps, narrow, { now: T0 })).toBeNull();
    const wide = await insertRunner(owner);
    expect((await claimTurn(deps, wide, { now: T0 }))?.bot.id).toBe(bot.id);
  });

  it("serves neither another owner's bots nor deleted ones", async () => {
    const { bot, runner } = await setup();
    const stranger = await insertRunner(await insertUser(db));
    expect(await claimTurn(deps, stranger, { now: T0 })).toBeNull();
    await db.update(users).set({ deletedAt: T0 }).where(eq(users.id, bot.id));
    expect(await claimTurn(deps, runner, { now: T0 })).toBeNull();
  });

  it('puts practice first, then derived turns, then game-over turns', async () => {
    const { group, bot, human, runner } = await setup();
    const ended = await insertGame(db, group.id, bot.id, human.id, { status: 'finished' });
    await db.insert(turnLeases).values([
      { botId: bot.id, kind: 'game_over', gameId: ended.id, claimableAt: T0, expiresAt: at(9) },
      { botId: bot.id, kind: 'practice', claimableAt: T0, expiresAt: at(600) },
    ]);
    const kinds: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const claimed = await claimTurn(deps, runner, { now: T0 });
      if (claimed) kinds.push(claimed.lease.kind);
    }
    expect(kinds).toEqual(['practice', 'move', 'game_over']);
  });

  it('gives a practice turn one attempt: a release fails it for good, and it goes once expired', async () => {
    const { bot, runner } = await setup();
    await db
      .insert(turnLeases)
      .values({ botId: bot.id, kind: 'practice', claimableAt: T0, expiresAt: at(600) });
    const claimed = await claimTurn(deps, runner, { now: T0 });
    expect(claimed?.lease.kind).toBe('practice');
    await releaseTurn(db, runner.id, claimed!.lease.id, claimed!.lease.claimSeq, T0);
    const [practice] = await db.select().from(turnLeases).where(eq(turnLeases.kind, 'practice'));
    expect(practice).toMatchObject({ runnerId: null, leasedUntil: null, failures: 1 });
    expect(practice!.claimableAt).toEqual(at(600));
    // Not claimable again, however long it waits, while the row stands.
    expect((await claimTurn(deps, runner, { now: at(599) }))?.lease.kind).toBe('move');
    expect(await claimTurn(deps, runner, { now: at(599) })).toBeNull();
    expect(await claimTurn(deps, runner, { now: at(600) })).toBeNull();
    expect(await db.select().from(turnLeases).where(eq(turnLeases.kind, 'practice'))).toEqual([]);
  });

  it('fails a practice turn whose lease ran out, but not one the server could not deliver', async () => {
    const { bot, runner } = await setup();
    await db
      .insert(turnLeases)
      .values({ botId: bot.id, kind: 'practice', claimableAt: T0, expiresAt: at(600) });
    const first = await claimTurn(deps, runner, { now: T0, leaseSeconds: 10 });
    await unclaimTurn(db, runner.id, first!.lease.id, first!.lease.claimSeq);
    const [freed] = await db.select().from(turnLeases).where(eq(turnLeases.kind, 'practice'));
    expect(freed).toMatchObject({ runnerId: null, failures: 0 });
    const second = await claimTurn(deps, runner, { now: T0, leaseSeconds: 10 });
    expect(second?.lease.kind).toBe('practice');
    expect((await claimTurn(deps, runner, { now: at(11) }))?.lease.kind).toBe('move');
    const [failed] = await db.select().from(turnLeases).where(eq(turnLeases.kind, 'practice'));
    expect(failed).toMatchObject({ runnerId: null, leasedUntil: null, failures: 1 });
    expect(failed!.claimableAt).toEqual(at(600));
  });
});

describe('requireLiveLease', () => {
  it('requireLiveLease refuses after the turn resolved, with reason turn_ended', async () => {
    const { bot, game, runner } = await setup();
    const claimed = await claimTurn(deps, runner, { now: T0 });
    const leaseId = claimed!.lease.id;
    await expect(requireLiveLease(db, leaseId, at(10))).resolves.toMatchObject({ id: leaseId });
    await playMove(deps, { gameId: game.publicId, userId: bot.id, move: 'e4', expectedPly: 0 });
    await expect(requireLiveLease(db, leaseId, at(10))).rejects.toMatchObject({
      code: 'stale_state',
      details: { reason: 'turn_ended' },
    });
  });

  it('refuses an expired, released or deleted-bot lease even when resolved turns are allowed', async () => {
    const { bot, runner } = await setup();
    const claimed = await claimTurn(deps, runner, { now: T0 });
    const leaseId = claimed!.lease.id;
    const ended = { details: { reason: 'turn_ended' } };
    const opts = { allowResolved: true };
    await expect(requireLiveLease(db, leaseId, at(300), opts)).rejects.toMatchObject(ended);
    await db.update(users).set({ deletedAt: T0 }).where(eq(users.id, bot.id));
    await expect(requireLiveLease(db, leaseId, at(10), opts)).rejects.toMatchObject(ended);
    await db.update(users).set({ deletedAt: null }).where(eq(users.id, bot.id));
    await releaseTurn(db, runner.id, leaseId, claimed!.lease.claimSeq, at(10));
    await expect(requireLiveLease(db, leaseId, at(10), opts)).rejects.toMatchObject(ended);
    await expect(requireLiveLease(db, 999_999, at(10), opts)).rejects.toMatchObject(ended);
  });
});

describe('spendCall', () => {
  it('spendCall refuses the 31st call', async () => {
    const { runner } = await setup();
    const claimed = await claimTurn(deps, runner, { now: T0 });
    const leaseId = claimed!.lease.id;
    for (let i = 0; i < 30; i += 1) await spendCall(db, leaseId, claimed!.lease.claimSeq);
    await expect(spendCall(db, leaseId, claimed!.lease.claimSeq)).rejects.toMatchObject({
      code: 'limit_exceeded',
      details: { reason: 'turn_budget_spent' },
    });
    const [row] = await leaseRows();
    expect(row!.callsUsed).toBe(30);
  });
});

describe('game-over turns', () => {
  async function botGame() {
    const group = await insertGroup(db);
    const owner = await insertUser(db);
    const white = await insertBot(db, owner);
    const black = await insertBot(db, owner);
    const game = await insertGame(db, group.id, white.id, black.id);
    return { owner, white, black, game, runner: await insertRunner(owner) };
  }
  const gameOverRows = (game: GameRow) =>
    db
      .select()
      .from(turnLeases)
      .where(and(eq(turnLeases.kind, 'game_over'), eq(turnLeases.gameId, game.id)));

  it('offers a game-over turn once to each bot, never for an aborted game', async () => {
    const { white, black, game } = await botGame();
    await resign(deps, { gameId: game.publicId, userId: black.id });
    const rows = await gameOverRows(game);
    expect(rows.map((row) => row.botId).sort()).toEqual([white.id, black.id].sort());
    const [finished] = await db.select().from(games).where(eq(games.id, game.id));
    for (const row of rows) {
      expect(row.ply).toBeNull();
      expect(row.expiresAt!.getTime() - finished!.finishedAt!.getTime()).toBe(86_400_000);
    }
    // A second offer for the same game changes nothing, and does not fail.
    await offerGameOverTurns(db, { ...game, status: 'finished', endReason: 'resignation' }, T0);
    expect(await gameOverRows(game)).toEqual(rows);

    const aborted = await botGame();
    await abortGame(deps, { gameId: aborted.game.publicId, userId: aborted.white.id });
    expect(await gameOverRows(aborted.game)).toEqual([]);
  });

  it('offers none to a person or a deleted bot', async () => {
    const { bot, game } = await setup();
    await db.update(users).set({ deletedAt: T0 }).where(eq(users.id, bot.id));
    await offerGameOverTurns(db, { ...game, status: 'finished', endReason: 'resignation' }, T0);
    expect(await gameOverRows(game)).toEqual([]);
  });

  it('deletes the match notes of a bot offered no game-over turn, and keeps the others', async () => {
    const notes = (...rows: { botId: number; gameId: number }[]) =>
      db.insert(matchNotes).values(rows.map((row) => ({ ...row, body: 'notes' })));
    const notesOf = async (game: GameRow) =>
      (await db.select().from(matchNotes).where(eq(matchNotes.gameId, game.id))).map(
        (n) => n.botId,
      );

    const aborted = await botGame();
    await notes(
      { botId: aborted.white.id, gameId: aborted.game.id },
      { botId: aborted.black.id, gameId: aborted.game.id },
    );
    await abortGame(deps, { gameId: aborted.game.publicId, userId: aborted.white.id });
    expect(await notesOf(aborted.game)).toEqual([]);

    const resigned = await botGame();
    await db.update(users).set({ deletedAt: T0 }).where(eq(users.id, resigned.black.id));
    await notes(
      { botId: resigned.white.id, gameId: resigned.game.id },
      { botId: resigned.black.id, gameId: resigned.game.id },
    );
    await resign(deps, { gameId: resigned.game.publicId, userId: resigned.white.id });
    expect(await notesOf(resigned.game)).toEqual([resigned.white.id]);
  });

  it('deletes match notes when the game-over turn ends or 24 h pass', async () => {
    const { white, black, game, runner } = await botGame();
    await offerGameOverTurns(db, { ...game, status: 'finished', endReason: 'checkmate' }, T0);
    const gameOver = 'game_over' as const;
    await setMatchNotes(db, {
      botId: white.id,
      gameId: game.id,
      text: 'white',
      leaseKind: gameOver,
    });
    await setMatchNotes(db, {
      botId: black.id,
      gameId: game.id,
      text: 'black',
      leaseKind: gameOver,
    });
    const notesOf = async (botId: number) =>
      db
        .select()
        .from(matchNotes)
        .where(and(eq(matchNotes.botId, botId), eq(matchNotes.gameId, game.id)));

    // Only the offer was made here; finish the game in its row so no move turn comes first.
    await db.update(games).set({ status: 'finished' }).where(eq(games.id, game.id));

    const claimed = await claimTurn(deps, runner, { now: T0 });
    expect(claimed?.lease.kind).toBe('game_over');
    await releaseTurn(db, runner.id, claimed!.lease.id, claimed!.lease.claimSeq, at(10));
    expect(await notesOf(claimed!.bot.id)).toEqual([]);
    const other = claimed!.bot.id === white.id ? black.id : white.id;
    expect(await notesOf(other)).toHaveLength(1);

    // The other bot's turn is never claimed; 24 h on it is gone, and its notes with it.
    expect(await claimTurn(deps, runner, { now: at(86_400) })).toBeNull();
    expect(await notesOf(other)).toEqual([]);
    expect(await leaseRows()).toEqual([]);
  });
});

describe('unclaimTurn', () => {
  it('frees the lease without a failure or a delay', async () => {
    const { runner } = await setup();
    const claimed = (await claimTurn(deps, runner, { now: T0 }))!;
    const before = claimed.lease;
    await unclaimTurn(db, runner.id, before.id, before.claimSeq);
    const [row] = await leaseRows();
    expect(row).toMatchObject({ runnerId: null, leasedUntil: null, failures: 0 });
    expect(row!.claimableAt).toEqual(before.claimableAt);
    expect((await claimTurn(deps, runner, { now: at(1) }))?.lease.id).toBe(before.id);
  });

  it('leaves a lease held at another claim sequence or by another runner alone', async () => {
    const { owner, runner } = await setup();
    const other = await insertRunner(owner);
    const { lease } = (await claimTurn(deps, runner, { now: T0 }))!;
    await unclaimTurn(db, runner.id, lease.id, lease.claimSeq + 1);
    await unclaimTurn(db, other.id, lease.id, lease.claimSeq);
    expect((await leaseRows())[0]).toMatchObject({ runnerId: runner.id });
  });

  it('drops the row of a turn that has resolved', async () => {
    const { runner, game, human } = await setup();
    const { lease } = (await claimTurn(deps, runner, { now: T0 }))!;
    await abortGame(deps, { gameId: game.publicId, userId: human.id });
    await unclaimTurn(db, runner.id, lease.id, lease.claimSeq);
    expect((await leaseRows()).filter((r) => r.kind === 'move')).toHaveLength(0);
  });
});

describe('practice reporting', () => {
  const practiceRows = () => db.select().from(turnLeases).where(eq(turnLeases.kind, 'practice'));

  it('clears exactly the finished row it reported, never a fresh test started since', async () => {
    const { bot, runner } = await setup();
    await db.update(runners).set({ lastSeenAt: T0 }).where(eq(runners.id, runner.id));
    const first = await startPractice(db, bot.id, T0);
    await db.update(turnLeases).set({ failures: 1 }).where(eq(turnLeases.id, first.id));
    expect(await reportPractice(db, bot.id, T0)).toEqual({ status: 'failed', rowId: first.id });
    expect(await practiceRows()).toEqual([]);
    const second = await startPractice(db, bot.id, T0);
    expect(second.id).not.toBe(first.id);
    // A second call that also saw the first test finished reports what is there now.
    expect(await reportPractice(db, bot.id, T0)).toEqual({
      status: 'not_claimed',
      rowId: second.id,
    });
    expect((await practiceRows()).map((r) => r.id)).toEqual([second.id]);
  });

  it('replaces a test with under 60 s left, reuses one with more', async () => {
    const { bot } = await setup();
    const first = await startPractice(db, bot.id, T0);
    await db
      .update(turnLeases)
      .set({ expiresAt: at(120) })
      .where(eq(turnLeases.id, first.id));
    expect((await startPractice(db, bot.id, T0)).id).toBe(first.id);
    await db
      .update(turnLeases)
      .set({ expiresAt: at(30) })
      .where(eq(turnLeases.id, first.id));
    const fresh = await startPractice(db, bot.id, T0);
    expect(fresh.id).not.toBe(first.id);
    expect(fresh.expiresAt).toEqual(at(600));
  });
});
