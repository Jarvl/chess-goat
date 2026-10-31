import { type ColourChoice } from '@chess-goat/shared';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createEngineGame, getEngineUser } from '../../src/domain/engineGames';
import { requireGameByPublicId, resign } from '../../src/domain/games';
import { touchMember } from '../../src/domain/members';
import { Metrics } from '../../src/metrics';

import { testConfig } from '../helpers/config';
import { openTestDb, testDeps, truncateAll } from '../helpers/db';
import { createEngineJobRunner, gameAwaitingEngine } from '../helpers/engineJob';
import { fakeEngine } from '../helpers/fakeEngine';
import { insertGame, insertGroup, insertUser, played } from '../helpers/fixtures';

const { db, close } = openTestDb();
const deps = testDeps(db);
const config = testConfig();
let metrics = new Metrics();
let group: Awaited<ReturnType<typeof insertGroup>>;
let alice: Awaited<ReturnType<typeof insertUser>>;
let runEngineJob: ReturnType<typeof createEngineJobRunner>;

beforeEach(async () => {
  await truncateAll(db);
  metrics = new Metrics();
  runEngineJob = createEngineJobRunner(deps, db, metrics, config);
  group = await insertGroup(db);
  alice = await insertUser(db, { firstName: 'Alice' });
  await touchMember(db, group.id, alice.id);
});
afterAll(() => close());

async function startedEngineGame(colour: ColourChoice) {
  return createEngineGame(deps, {
    groupId: group.id,
    userId: alice.id,
    level: 'club',
    colour,
  });
}

describe('engine_move job handler', () => {
  it('plays the engine reply and hands the turn back', async () => {
    const engine = fakeEngine({ replies: [{ uci: 'e7e5' }] });
    const game = await gameAwaitingEngine(deps, { groupId: group.id, userId: alice.id });
    await runEngineJob(engine, game.id);
    const after = await requireGameByPublicId(db, game.publicId);
    expect(after.plyCount).toBe(2);
    expect(engine.calls[0]!.level).toBe('club');
  });

  it('substitutes a legal move when the engine returns an illegal one, and counts it', async () => {
    const engine = fakeEngine({ replies: [{ uci: 'a1a8' }] });
    const game = await gameAwaitingEngine(deps, { groupId: group.id, userId: alice.id });
    await runEngineJob(engine, game.id);
    const after = await requireGameByPublicId(db, game.publicId);
    expect(after.status).toBe('active');
    expect(after.plyCount).toBe(2);
    const counted = await metrics.engineIllegalMoves.get();
    expect(counted.values[0]?.value).toBe(1);
  });

  it('completes without moving when the game already ended', async () => {
    const engine = fakeEngine();
    const game = await gameAwaitingEngine(deps, { groupId: group.id, userId: alice.id });
    await resign(deps, { gameId: game.publicId, userId: alice.id });
    await expect(runEngineJob(engine, game.id)).resolves.toMatchObject({ outcome: 'done' });
    expect(engine.calls).toHaveLength(0);
    expect((await requireGameByPublicId(db, game.publicId)).plyCount).toBe(1);
  });

  it('completes without moving when the game ended while the engine was thinking', async () => {
    // Spec §9's `(none)` row: the game really did end between the job being enqueued and the reply
    // arriving, so the job is a success and writes nothing.
    const game = await gameAwaitingEngine(deps, { groupId: group.id, userId: alice.id });
    const engine = fakeEngine({
      replies: [{ none: true }],
      onCall: async () => {
        await resign(deps, { gameId: game.publicId, userId: alice.id });
      },
    });
    await expect(runEngineJob(engine, game.id)).resolves.toMatchObject({ outcome: 'done' });
    const after = await requireGameByPublicId(db, game.publicId);
    expect(after.status).toBe('finished');
    expect(after.plyCount).toBe(1);
  });

  it('does not fall silent when the engine reports a terminal position the arbiter disagrees with', async () => {
    // Spec §9's `(none)` row requires the status to be re-checked. Still active with the engine to
    // move means Stockfish and our arbiter disagree — and an engine game carries no deadline, so
    // completing the job here would strand the game for good.
    const engine = fakeEngine({ replies: [{ none: true }] });
    const game = await gameAwaitingEngine(deps, { groupId: group.id, userId: alice.id });
    const result = await runEngineJob(engine, game.id);
    expect(result).toMatchObject({ outcome: 'retry_attempt' });
    const after = await requireGameByPublicId(db, game.publicId);
    expect(after.status).toBe('active');
    expect(after.plyCount).toBe(1);
    expect((await metrics.engineMoveFailures.get()).values[0]?.value).toBe(1);
  });

  it('ends the game rather than stranding it when the engine never makes a move', async () => {
    const engine = fakeEngine({ replies: [{ none: true }] });
    const game = await gameAwaitingEngine(deps, { groupId: group.id, userId: alice.id });
    const result = await runEngineJob(engine, game.id, { attempts: 7, maxAttempts: 8 });
    expect(result).toMatchObject({ outcome: 'fail' });
    const after = await requireGameByPublicId(db, game.publicId);
    expect(after.status).toBe('finished');
    expect(after.endReason).toBe('abort');
  });

  it('does not fall silent when there is no legal move to substitute for an illegal one', async () => {
    // Black is stalemated (the same position the `randomLegalMove` unit test verifies has no legal
    // moves), so the illegal-move recovery has nothing to play. Spec §9 sends that case to the
    // `(none)` row, which is the status re-check — not a quietly completed job.
    const engineUser = await getEngineUser(db);
    const game = await insertGame(db, group.id, alice.id, engineUser.id, {
      fen: '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1',
      plyCount: 3,
      rated: false,
      engineLevel: 'club',
    });
    const engine = fakeEngine({ replies: [{ uci: 'a7a8' }] });
    const result = await runEngineJob(engine, game.id);
    expect(result).toMatchObject({ outcome: 'retry_attempt' });
    expect((await requireGameByPublicId(db, game.publicId)).status).toBe('active');
    expect((await metrics.engineIllegalMoves.get()).values[0]?.value).toBe(1);
    expect((await metrics.engineMoveFailures.get()).values[0]?.value).toBe(1);
  });

  it('asks for a retry, not silence, when the engine is unavailable', async () => {
    const engine = fakeEngine({ fail: new Error('spawn stockfish ENOENT') });
    const game = await gameAwaitingEngine(deps, { groupId: group.id, userId: alice.id });
    const result = await runEngineJob(engine, game.id);
    expect(result).toMatchObject({ outcome: 'retry_attempt' });
    expect((await requireGameByPublicId(db, game.publicId)).status).toBe('active');
  });

  it('aborts the game once the retry ladder is exhausted, even past the player abort deadline', async () => {
    const engine = fakeEngine({ fail: new Error('spawn stockfish ENOENT') });
    // Get plyCount to 2 (past the point where a human's abortGame would refuse) so this proves
    // the failure path does not go through abortGame's player-facing guard.
    const game = await played(db, await startedEngineGame('white'), ['e2e4', 'e7e5', 'd2d4']);
    const before = await requireGameByPublicId(db, game.publicId);
    expect(before.plyCount).toBeGreaterThanOrEqual(2);
    const result = await runEngineJob(engine, game.id, { attempts: 7, maxAttempts: 8 });
    expect(result).toMatchObject({ outcome: 'fail' });
    const after = await requireGameByPublicId(db, game.publicId);
    expect(after.status).toBe('finished');
    expect(after.endReason).toBe('abort');
  });

  it('asks for a retry, not silence, when the engine is disabled', async () => {
    const engine = fakeEngine();
    const game = await gameAwaitingEngine(deps, { groupId: group.id, userId: alice.id });
    const result = await runEngineJob(engine, game.id, {}, testConfig({ ENGINE_ENABLED: false }));
    expect(result).toMatchObject({ outcome: 'retry_attempt' });
    expect(engine.calls).toHaveLength(0);
    expect((await requireGameByPublicId(db, game.publicId)).status).toBe('active');
  });

  it('aborts the game once the retry ladder is exhausted while the engine is disabled', async () => {
    const engine = fakeEngine();
    // Same past-ply-1 setup as the outage test, so this also proves the disabled path does not
    // go through abortGame's player-facing guard.
    const game = await played(db, await startedEngineGame('white'), ['e2e4', 'e7e5', 'd2d4']);
    const before = await requireGameByPublicId(db, game.publicId);
    expect(before.plyCount).toBeGreaterThanOrEqual(2);
    const result = await runEngineJob(
      engine,
      game.id,
      { attempts: 7, maxAttempts: 8 },
      testConfig({ ENGINE_ENABLED: false }),
    );
    expect(result).toMatchObject({ outcome: 'fail' });
    expect(engine.calls).toHaveLength(0);
    const after = await requireGameByPublicId(db, game.publicId);
    expect(after.status).toBe('finished');
    expect(after.endReason).toBe('abort');
  });

  it('plays only once when the same ply is triggered twice', async () => {
    const engine = fakeEngine({ replies: [{ uci: 'e7e5' }, { uci: 'd7d5' }] });
    const game = await gameAwaitingEngine(deps, { groupId: group.id, userId: alice.id });
    await runEngineJob(engine, game.id);
    await runEngineJob(engine, game.id);
    expect((await requireGameByPublicId(db, game.publicId)).plyCount).toBe(2);
  });
});
