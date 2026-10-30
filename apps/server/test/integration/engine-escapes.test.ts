/**
 * The two ways out of the `engine_move` handler that no fake engine can produce: the move write
 * itself failing, and the illegal-move recovery's own write failing. Both used to leave the handler
 * by throwing, which counts an attempt and then gives up — leaving the game `active` with the engine
 * to move and no deadline for any scanner to find (spec §9). `playMove` is therefore the one thing
 * stubbed here; everything else is the real composed path on real PostgreSQL.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { requireGameByPublicId } from '../../src/domain/games';
import { touchMember } from '../../src/domain/members';
import { Metrics } from '../../src/metrics';
import { testConfig } from '../helpers/config';
import { openTestDb, testDeps, truncateAll } from '../helpers/db';
import { createEngineJobRunner, gameAwaitingEngine } from '../helpers/engineJob';
import { fakeEngine } from '../helpers/fakeEngine';
import { insertGroup, insertUser } from '../helpers/fixtures';

const stub = vi.hoisted(() => ({ mode: 'real' as 'real' | 'broken' | 'break-recovery', calls: 0 }));

vi.mock('../../src/domain/games', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/domain/games')>('../../src/domain/games');
  return {
    ...actual,
    async playMove(...args: Parameters<typeof actual.playMove>) {
      if (stub.mode === 'real') return actual.playMove(...args);
      stub.calls += 1;
      if (stub.mode === 'broken') throw new Error('the database went away');
      // 'break-recovery': let the engine's own (illegal) reply be judged for real, and break only
      // the write of the random legal move that spec §9's E7 recovery substitutes for it.
      if (stub.calls > 1) throw new Error('the database went away');
      return actual.playMove(...args);
    },
  };
});

const { db, close } = openTestDb();
const deps = testDeps(db);
const config = testConfig();
let metrics = new Metrics();
let group: Awaited<ReturnType<typeof insertGroup>>;
let alice: Awaited<ReturnType<typeof insertUser>>;
let runEngineJob: ReturnType<typeof createEngineJobRunner>;

beforeEach(async () => {
  stub.mode = 'real';
  stub.calls = 0;
  await truncateAll(db);
  metrics = new Metrics();
  runEngineJob = createEngineJobRunner(deps, db, metrics, config);
  group = await insertGroup(db);
  alice = await insertUser(db, { firstName: 'Alice' });
  await touchMember(db, group.id, alice.id);
});
afterAll(() => close());

/** An engine game with the human to move having just played, so the engine owes a reply. */
describe('every escape from the engine_move handler', () => {
  it('routes a throw through the retry ladder instead of past it', async () => {
    const game = await gameAwaitingEngine(deps, { groupId: group.id, userId: alice.id });
    stub.mode = 'broken';
    const result = await runEngineJob(fakeEngine({ replies: [{ uci: 'e7e5' }] }), game.id);
    expect(result).toMatchObject({ outcome: 'retry_attempt' });
    expect((await requireGameByPublicId(db, game.publicId)).status).toBe('active');
    expect((await metrics.engineMoveFailures.get()).values[0]?.value).toBe(1);
  });

  it('aborts on a throw once the attempts are exhausted, rather than stranding the game', async () => {
    const game = await gameAwaitingEngine(deps, { groupId: group.id, userId: alice.id });
    stub.mode = 'broken';
    const result = await runEngineJob(fakeEngine({ replies: [{ uci: 'e7e5' }] }), game.id, {
      attempts: 7,
      maxAttempts: 8,
    });
    expect(result).toMatchObject({ outcome: 'fail' });
    const after = await requireGameByPublicId(db, game.publicId);
    expect(after.status).toBe('finished');
    expect(after.endReason).toBe('abort');
  });

  it('routes a failed illegal-move recovery through the retry ladder', async () => {
    const game = await gameAwaitingEngine(deps, { groupId: group.id, userId: alice.id });
    stub.mode = 'break-recovery';
    // An illegal reply, so the recovery of spec §9's E7 row really runs — and then fails.
    const result = await runEngineJob(fakeEngine({ replies: [{ uci: 'a1a8' }] }), game.id);
    expect(stub.calls).toBe(2);
    expect(result).toMatchObject({ outcome: 'retry_attempt' });
    expect((await requireGameByPublicId(db, game.publicId)).plyCount).toBe(1);
    expect((await metrics.engineIllegalMoves.get()).values[0]?.value).toBe(1);
    expect((await metrics.engineMoveFailures.get()).values[0]?.value).toBe(1);
  });

  it('aborts on a failed illegal-move recovery once the attempts are exhausted', async () => {
    const game = await gameAwaitingEngine(deps, { groupId: group.id, userId: alice.id });
    stub.mode = 'break-recovery';
    const result = await runEngineJob(fakeEngine({ replies: [{ uci: 'a1a8' }] }), game.id, {
      attempts: 7,
      maxAttempts: 8,
    });
    expect(result).toMatchObject({ outcome: 'fail' });
    const after = await requireGameByPublicId(db, game.publicId);
    expect(after.status).toBe('finished');
    expect(after.endReason).toBe('abort');
  });
});
