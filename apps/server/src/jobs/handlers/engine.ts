import { legalDests, sideToMove, type EngineLevel } from '@group-chess/shared';
import { z } from 'zod';
import type { Config } from '../../config';
import type { Deps } from '../../domain/deps';
import { isDomainError } from '../../domain/errors';
import { getEngineUser } from '../../domain/engineGames';
import { finishGame, lockActiveGame, playMove, requireGameById } from '../../domain/games';
import type { DbOrTx } from '../../db/client';
import type { GameRow } from '../../db/schema';
import type { BestMove, Engine } from '../../engine/engine';
import type { Metrics } from '../../metrics';
import type { JobHandlers, JobResult } from '../types';

export type EngineHandlerContext = {
  deps: Deps;
  engine: Engine;
  config: Config;
  metrics: Metrics;
};

const PayloadSchema = z.object({ gameId: z.number().int() });

/** The piece letter (FEN case, e.g. `P`/`n`) occupying `square`, or `undefined` if it is empty. */
function pieceOn(fen: string, square: string): string | undefined {
  const file = square.charCodeAt(0) - 'a'.charCodeAt(0);
  const rank = Number(square[1]);
  const row = fen.split(' ')[0]!.split('/')[8 - rank]!;
  let col = 0;
  for (const symbol of row) {
    if (symbol >= '1' && symbol <= '8') {
      col += Number(symbol);
      continue;
    }
    if (col === file) return symbol;
    col += 1;
  }
  return undefined;
}

/**
 * A uniformly random legal move, used only to recover from an illegal engine reply (spec §9, E7).
 * Exported so its promotion-suffix logic can be pinned by a deterministic unit test without going
 * through `Math.random`.
 */
export function randomLegalMove(fen: string): string | null {
  const dests = [...legalDests(fen).entries()];
  if (dests.length === 0) return null;
  const [from, targets] = dests[Math.floor(Math.random() * dests.length)]!;
  const to = targets[Math.floor(Math.random() * targets.length)]!;
  // A pawn reaching the last rank must carry a promotion piece or the arbiter rejects the move —
  // and only a pawn: a rook or king retreating from rank 2/7 to rank 1/8 is not a promotion, and
  // tagging it with one would make the arbiter reject an otherwise-legal move.
  const piece = pieceOn(fen, from)?.toLowerCase();
  const promoting = piece === 'p' && /^[a-h][18]$/.test(to);
  return promoting ? `${from}${to}q` : `${from}${to}`;
}

/**
 * Spec §9: a sustained outage must not leave the game dead — but it must not become a random mover
 * either, since the player was told which level they chose. The engine is one of the game's two
 * players, so it may end its own game this way; `abortGame` itself is not used because its
 * player-facing guard (no abort past ply 1) exists to stop a *player* from dodging a bad position,
 * not to block a system failure path caused by our own engine outage.
 */
async function abortForUnavailableEngine(
  deps: Deps,
  game: GameRow,
  reason: string,
): Promise<JobResult> {
  await deps.db.transaction(async (tx) => {
    const engineUser = await getEngineUser(tx);
    const locked = await lockActiveGame(tx, game.publicId, engineUser.id);
    if (!locked.ended) {
      await finishGame(tx, locked.game, { result: '*', endReason: 'abort' }, locked.now);
    }
  });
  deps.bus.publish(game.publicId);
  return { outcome: 'fail', error: reason };
}

/**
 * How a single run of the handler failed to make progress. Nothing inside the handler decides what
 * to do about it: every one of these reaches the one attempts-exhausted decision below, which is
 * what keeps spec §9's invariant (never leave the game `active` with the engine to move) true of
 * *all* the ways out of this handler rather than of the ones somebody remembered to guard.
 */
type Escape = { error: string; delayMs?: number };

/** A flag flip is not a transient fault, so the disabled path waits longer between attempts. */
const DISABLED_RETRY_MS = 30_000;
const FAILURE_RETRY_MS = 5_000;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True when the game is waiting on a move the engine owes it. */
async function engineIsToMove(tx: DbOrTx, game: GameRow): Promise<boolean> {
  const engineUser = await getEngineUser(tx);
  const engineColour = game.whiteId === engineUser.id ? 'white' : 'black';
  return sideToMove(game.fen) === engineColour;
}

export function engineJobHandlers(ctx: EngineHandlerContext): JobHandlers {
  const { deps, engine, config, metrics } = ctx;
  return {
    engine_move: async ({ job, log }): Promise<JobResult> => {
      const { gameId } = PayloadSchema.parse(job.payload);
      const game = await requireGameById(deps.db, gameId);
      // Nothing is owed and nothing can stall: the game is over, or it never had an engine side.
      if (game.status !== 'active' || game.engineLevel === null) return { outcome: 'done' };

      /** One attempt at the engine's move. Returns `null` when nothing is left owing. */
      const attempt = async (): Promise<Escape | null> => {
        // Registered even when disabled, on purpose: an unhandled kind is retried forever without
        // counting an attempt (`jobs/worker.ts:119`), so a game started before the engine was
        // turned off would stall for ever instead of reaching the abort path below.
        if (!config.ENGINE_ENABLED) {
          return { error: 'the engine is disabled', delayMs: DISABLED_RETRY_MS };
        }
        const engineUser = await getEngineUser(deps.db);
        const engineColour = game.whiteId === engineUser.id ? 'white' : 'black';
        if (sideToMove(game.fen) !== engineColour) return null;

        const started = process.hrtime.bigint();
        let reply: BestMove;
        try {
          reply = await engine.bestMove(
            game.fen,
            game.engineLevel as EngineLevel,
            Math.max(config.ENGINE_MOVETIME_MS * 10, 5_000),
          );
        } catch (error) {
          return { error: messageOf(error) };
        } finally {
          metrics.engineMoveDuration.observe(Number(process.hrtime.bigint() - started) / 1e9);
        }
        // Spec §9's `(none)` row: the position is supposed to be terminal. Whether it really is, is
        // not this function's business — the status re-check below settles it either way.
        if ('none' in reply) return null;

        let uci = reply.uci;
        try {
          await playMove(deps, {
            gameId: game.publicId,
            userId: engineUser.id,
            uci,
            expectedPly: game.plyCount,
            clientMoveId: `engine:${game.publicId}:${game.plyCount}`,
          });
        } catch (error) {
          if (!isDomainError(error) || error.code !== 'illegal_move') throw error;
          // Stockfish does not emit illegal moves, so this is almost certainly a bug in our own UCI
          // parsing. Recover so the game survives, but make sure it is visible (spec §9).
          metrics.engineIllegalMoves.inc();
          log.error({ gameId, fen: game.fen, bestmove: uci }, 'engine returned an illegal move');
          // Spec §9: with no legal move to substitute, fall through to the `(none)` row — which is
          // the status re-check below, not silence.
          const fallback = randomLegalMove(game.fen);
          if (!fallback) return null;
          uci = fallback;
          try {
            await playMove(deps, {
              gameId: game.publicId,
              userId: engineUser.id,
              uci,
              expectedPly: game.plyCount,
              clientMoveId: `engine:${game.publicId}:${game.plyCount}:fallback`,
            });
          } catch (fallbackError) {
            log.error(
              { gameId, err: fallbackError, fallbackUci: uci },
              'illegal-move recovery itself failed',
            );
            return { error: messageOf(fallbackError) };
          }
        }
        metrics.engineMoves.inc();
        return null;
      };

      let escape: Escape | null;
      try {
        escape = await attempt();
        if (!escape) {
          // The invariant, checked rather than assumed. An engine game carries no deadline, so if
          // this handler returns `done` while the engine is still to move, no scanner will ever
          // touch the game again: it is stalled for good. And because our own arbiter says a move
          // is owed, reaching here means Stockfish and the arbiter disagree — an error, not noise.
          const fresh = await requireGameById(deps.db, gameId);
          // A premove the human queued can answer the engine inside its own move, leaving the
          // engine to move again at a later ply; that ply's job is already enqueued (conditional
          // premoves spec, Firing). Only the same ply still owing a move is a stall.
          if (
            fresh.status === 'active' &&
            fresh.plyCount === game.plyCount &&
            (await engineIsToMove(deps.db, fresh))
          ) {
            log.error(
              { gameId, fen: fresh.fen },
              'the engine made no move and the game is still active',
            );
            escape = { error: 'the engine made no move and the game is still active' };
          }
        }
      } catch (error) {
        // Anything thrown on the way — a missing engine user, a failed draw decline, a database
        // blip — lands here instead of escaping to the worker's generic error path, which counts
        // an attempt and then gives up without ever ending the game.
        log.error({ gameId, err: error }, 'the engine move failed');
        escape = { error: messageOf(error) };
      }
      if (!escape) return { outcome: 'done' };

      metrics.engineMoveFailures.inc();
      if (job.attempts + 1 >= job.maxAttempts) {
        log.error({ gameId, reason: escape.error }, 'the engine cannot move; aborting the game');
        return abortForUnavailableEngine(deps, game, escape.error);
      }
      return {
        outcome: 'retry_attempt',
        delayMs: escape.delayMs ?? FAILURE_RETRY_MS,
        error: escape.error,
      };
    },
  };
}
