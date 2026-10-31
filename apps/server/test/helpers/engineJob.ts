import type { Db } from '../../src/db/client';
import type { JobRow } from '../../src/db/schema';
import type { Config } from '../../src/config';
import type { Deps } from '../../src/domain/deps';
import type { EngineLevel } from '@chess-goat/shared';
import type { Engine } from '../../src/engine/engine';
import { createEngineGame } from '../../src/domain/engineGames';
import { playMove } from '../../src/domain/games';
import { engineJobHandlers } from '../../src/jobs/handlers/engine';
import type { Metrics } from '../../src/metrics';

function buildJob(gameId: number, overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: 1,
    kind: 'engine_move',
    dedupKey: null,
    payload: { gameId },
    runAt: new Date(),
    attempts: 0,
    maxAttempts: 8,
    lockedUntil: null,
    lockedBy: null,
    lastError: null,
    createdAt: new Date(),
    doneAt: null,
    failedAt: null,
    ...overrides,
  };
}

/**
 * Builds a `runEngineJob(engine, gameId, jobOverrides?, config?)` bound to one test file's
 * `deps`/`db`/`metrics`/default config, so callers keep the short call shape the integration
 * tests use while still being able to override the config per call (e.g. `ENGINE_ENABLED: false`).
 */
export function createEngineJobRunner(deps: Deps, db: Db, metrics: Metrics, defaultConfig: Config) {
  return function runEngineJob(
    engine: Engine,
    gameId: number,
    jobOverrides: Partial<JobRow> = {},
    config: Config = defaultConfig,
  ) {
    const handlers = engineJobHandlers({ deps, engine, config, metrics });
    const job = buildJob(gameId, jobOverrides);
    return handlers.engine_move!({ job, db, log: deps.log });
  };
}

/** An engine game where the player, White, has played 1.e4: the engine is to move. */
export async function gameAwaitingEngine(
  deps: Deps,
  opts: { groupId: number; userId: number; level?: EngineLevel },
) {
  const game = await createEngineGame(deps, {
    groupId: opts.groupId,
    userId: opts.userId,
    level: opts.level ?? 'club',
    colour: 'white',
  });
  await playMove(deps, {
    gameId: game.publicId,
    userId: opts.userId,
    uci: 'e2e4',
    expectedPly: 0,
    clientMoveId: 'c1',
  });
  return game;
}
