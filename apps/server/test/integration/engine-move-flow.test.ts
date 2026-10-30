import { encodePremoveTree, t, type EngineLevel } from '@group-chess/shared';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { jobs, ratings } from '../../src/db/schema';
import { createEngineGame, getEngineUser } from '../../src/domain/engineGames';
import { playMove, requireGameByPublicId, resign, voidGame } from '../../src/domain/games';
import { buildGamePgn } from '../../src/domain/pgn';
import { forfeitOverdueGames } from '../../src/clock/scanners';
import { reminderExpression } from '../../src/domain/limits';
import { touchMember } from '../../src/domain/members';
import { Metrics } from '../../src/metrics';
import { testConfig } from '../helpers/config';
import { openTestDb, testDeps, truncateAll } from '../helpers/db';
import { createEngineJobRunner } from '../helpers/engineJob';
import { fakeEngine } from '../helpers/fakeEngine';
import { insertGame, insertGroup, insertUser } from '../helpers/fixtures';

const { db, close } = openTestDb();
const deps = testDeps(db);

beforeEach(() => truncateAll(db));
afterAll(() => close());

const jobKinds = async (): Promise<string[]> =>
  (await db.select().from(jobs)).map((job) => job.kind);

async function setup(userOverrides: { dmAllowed?: boolean } = {}) {
  const group = await insertGroup(db);
  const alice = await insertUser(db, { firstName: 'Alice', ...userOverrides });
  await touchMember(db, group.id, alice.id);
  return { group, alice };
}

describe('playMove and finishGame with an engine opponent', () => {
  it('leaves no deadline for the engine and enqueues its move, with no card or DM job', async () => {
    const { group, alice } = await setup();
    const game = await createEngineGame(deps, {
      groupId: group.id,
      userId: alice.id,
      level: 'club',
      colour: 'white',
    });
    await playMove(deps, {
      gameId: game.publicId,
      userId: alice.id,
      uci: 'e2e4',
      expectedPly: 0,
      clientMoveId: 'c1',
    });
    const after = await requireGameByPublicId(db, game.publicId);
    expect(after.deadlineAt).toBeNull();
    expect(after.reminderAt).toBeNull();
    const kinds = (await db.select().from(jobs)).map((job) => job.kind);
    expect(kinds).toContain('engine_move');
    expect(kinds).not.toContain('edit_card');
    expect(kinds).not.toContain('send_dm');
  });

  it('announces nothing and grants no clock when the engine has moved', async () => {
    const { group, alice } = await setup();
    const game = await createEngineGame(deps, {
      groupId: group.id,
      userId: alice.id,
      level: 'club',
      colour: 'white',
    });
    await playMove(deps, {
      gameId: game.publicId,
      userId: alice.id,
      uci: 'e2e4',
      expectedPly: 0,
      clientMoveId: 'c1',
    });
    const engine = await getEngineUser(db);
    await playMove(deps, {
      gameId: game.publicId,
      userId: engine.id,
      uci: 'e7e5',
      expectedPly: 1,
      clientMoveId: 'e1',
    });
    const after = await requireGameByPublicId(db, game.publicId);
    // Spec §8: a bot game has no clock, so the human gets no deadline back either — the bot answers
    // immediately, so there is nothing to time.
    expect(after.deadlineAt).toBeNull();
    // The engine's own move (e7e5) reaches playMove's non-`engineNext` branch, where the game is
    // still an engine game and must still get no card — and no move notification to the human
    // either. The turn DM is enqueued regardless of the recipient's DM preference (the handler
    // filters later), so its absence here is the branch, not a preference.
    const kinds = await jobKinds();
    expect(kinds).not.toContain('edit_card');
    expect(kinds).not.toContain('send_dm');
  });

  it('leaves the human no reminder to be notified by after the engine moves', async () => {
    const { group, alice } = await setup({ dmAllowed: true });
    // Guard against a vacuous pass: the production expression does produce a reminder for these
    // inputs, so the null below is spec §8's rule rather than a broken reminder path.
    expect(reminderExpression(86_400, true)).not.toBeNull();
    const game = await createEngineGame(deps, {
      groupId: group.id,
      userId: alice.id,
      level: 'club',
      colour: 'white',
    });
    await playMove(deps, {
      gameId: game.publicId,
      userId: alice.id,
      uci: 'e2e4',
      expectedPly: 0,
      clientMoveId: 'c1',
    });
    const engine = await getEngineUser(db);
    await playMove(deps, {
      gameId: game.publicId,
      userId: engine.id,
      uci: 'e7e5',
      expectedPly: 1,
      clientMoveId: 'e1',
    });
    const after = await requireGameByPublicId(db, game.publicId);
    // Nothing to remind about, because there is nothing to be late for.
    expect(after.deadlineAt).toBeNull();
    expect(after.reminderAt).toBeNull();
  });

  // Correction to the brief: the original test forged a past deadline onto an engine game and
  // expected it to survive. But forfeitOverdueGames has no engine awareness at all (by design —
  // teaching the scanner to parse side-to-move out of a FEN was rejected). The real mechanism is
  // that an engine game's deadline is NEVER set in the first place, so the scanner never picks it
  // up. This test exercises that real mechanism instead, with a human control game proving the
  // scanner actually ran.
  it('is never forfeited because it is never given a deadline, unlike a human game', async () => {
    const { group, alice } = await setup();
    const engineGame = await createEngineGame(deps, {
      groupId: group.id,
      userId: alice.id,
      level: 'club',
      colour: 'black',
    });
    expect(engineGame.deadlineAt).toBeNull();

    const bob = await insertUser(db, { firstName: 'Bob' });
    const carol = await insertUser(db, { firstName: 'Carol' });
    await touchMember(db, group.id, bob.id);
    await touchMember(db, group.id, carol.id);
    const humanGame = await insertGame(db, group.id, bob.id, carol.id, {
      deadlineInSeconds: -86_400,
    });

    await forfeitOverdueGames(deps);

    expect((await requireGameByPublicId(db, engineGame.publicId)).status).toBe('active');
    expect((await requireGameByPublicId(db, humanGame.publicId)).status).toBe('finished');
  });

  it('writes no rating row and no Lichess import job when an engine game ends', async () => {
    const { group, alice } = await setup();
    const game = await createEngineGame(deps, {
      groupId: group.id,
      userId: alice.id,
      level: 'club',
      colour: 'white',
    });
    // A move first, so plyCount > 0 and the pre-existing `game.plyCount > 0` term of `importable`
    // is already satisfied — the `!engineGame` conjunct this task adds is then the only thing
    // suppressing the import. Resigning immediately (plyCount 0) would make this vacuous.
    await playMove(deps, {
      gameId: game.publicId,
      userId: alice.id,
      uci: 'e2e4',
      expectedPly: 0,
      clientMoveId: 'c1',
    });
    await resign(deps, { gameId: game.publicId, userId: alice.id });
    const finished = await requireGameByPublicId(db, game.publicId);
    expect(finished.status).toBe('finished');
    expect(finished.plyCount).toBeGreaterThan(0);
    expect(finished.lichessImportStatus).toBeNull();
    expect(await db.select().from(ratings)).toHaveLength(0);
    const kinds = await jobKinds();
    expect(kinds).not.toContain('lichess_import');
    expect(kinds).not.toContain('edit_card');
    // Bot games announce nothing when they end: no result photo in the group, no DM to the human.
    expect(kinds).not.toContain('send_result_photo');
    expect(kinds).not.toContain('send_dm');
  });

  it('voids an engine game without enqueueing a card', async () => {
    const { group, alice } = await setup();
    const admin = await insertUser(db, { firstName: 'Admin' });
    await touchMember(db, group.id, admin.id);
    const game = await createEngineGame(deps, {
      groupId: group.id,
      userId: alice.id,
      level: 'club',
      colour: 'white',
    });
    await voidGame(deps, { gameId: game.publicId, adminUserId: admin.id });
    const voided = await requireGameByPublicId(db, game.publicId);
    expect(voided.status).toBe('finished');
    expect(voided.endReason).toBe('voided');
    expect(voided.voidedAt).not.toBeNull();
    const kinds = await jobKinds();
    expect(kinds).not.toContain('edit_card');
    expect(kinds).not.toContain('rebuild_ratings');
    expect(kinds).not.toContain('send_result_photo');
    expect(kinds).not.toContain('send_dm');
  });
});

describe('a premove tree in an engine game', () => {
  it("fires the human's reply after the engine's move and owes the engine its next move", async () => {
    const { group, alice } = await setup();
    const game = await createEngineGame(deps, {
      groupId: group.id,
      userId: alice.id,
      level: 'club',
      colour: 'white',
    });
    await playMove(deps, {
      gameId: game.publicId,
      userId: alice.id,
      uci: 'e2e4',
      expectedPly: 0,
      clientMoveId: 'c1',
      premoveTree: encodePremoveTree([{ move: 'e7e5', reply: 'g1f3', children: [] }]),
    });
    const runEngineJob = createEngineJobRunner(deps, db, new Metrics(), testConfig());
    const outcome = await runEngineJob(fakeEngine({ replies: [{ uci: 'e7e5' }] }), game.id);
    // The fired reply moved the game past the job's ply, which is not a stall.
    expect(outcome).toEqual({ outcome: 'done' });
    const after = await requireGameByPublicId(db, game.publicId);
    expect(after).toMatchObject({ plyCount: 3, status: 'active' });
    expect(after.premoveTree).toHaveLength(0);
    const queued = await db.select().from(jobs);
    expect(queued.map((job) => job.dedupKey)).toContain(`engine:g:${game.publicId}:ply:3`);
    expect(queued.map((job) => job.kind)).not.toContain('send_dm');
    expect(queued.map((job) => job.kind)).not.toContain('edit_card');
  });
});

describe('the PGN of an engine game', () => {
  const pgnOf = async (level: EngineLevel) => {
    const { group, alice } = await setup();
    const game = await createEngineGame(deps, {
      groupId: group.id,
      userId: alice.id,
      level,
      colour: 'white',
    });
    await playMove(deps, {
      gameId: game.publicId,
      userId: alice.id,
      uci: 'e2e4',
      expectedPly: 0,
      clientMoveId: 'c1',
    });
    return buildGamePgn(db, await requireGameByPublicId(db, game.publicId));
  };

  it('names the level, because the PGN is the only permanent record the game gets', async () => {
    // Spec §5: `Stockfish (Club)`. Engine games get no Lichess URL (spec §8), so a bare `Stockfish`
    // would leave nothing anywhere saying which level was played.
    const pgn = await pgnOf('club');
    expect(pgn).toContain('[Black "Stockfish (Club)"]');
    expect(pgn).toContain('[White "Alice"]');
  });

  it('uses the level copy rather than the stored enum value, and no rating numbers', async () => {
    const pgn = await pgnOf('beginner');
    // `beginner` is shown as "Easiest" everywhere the player sees it (spec §7's honesty rule), and
    // spec §7 forbids rating numbers in user-facing output — the PGN included.
    expect(pgn).toContain(`[Black "Stockfish (${t('app.level.beginner')})"]`);
    expect(pgn).not.toContain('beginner');
    expect(pgn).not.toContain('Elo');
  });
});
