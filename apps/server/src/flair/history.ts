import type { GameResult, PlayerResult } from '@chess-goat/shared';
import { and, asc, eq, inArray, isNull, lt, lte, or } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { games, type GameRow } from '../db/schema';
import type { CountedGame } from './rules';

// `finishGame` uses `isCountedGame` (flair spec §3.2), so nothing here may import `domain/games.ts`.

/** The results that decide a game (flair spec §1.3); an abort ends `*`. */
const DECIDED_RESULTS = ['1-0', '0-1', '1/2-1/2'] as const;

type DecidedResult = (typeof DECIDED_RESULTS)[number];

function isDecided(result: GameResult | null): result is DecidedResult {
  return (DECIDED_RESULTS as readonly (GameResult | null)[]).includes(result);
}

/**
 * Flair spec §1.3: a counted game is finished, not voided, decided, and not against the bot. Keep
 * `COUNTED` below in step with it.
 */
export function isCountedGame(
  game: Pick<GameRow, 'status' | 'voidedAt' | 'result' | 'engineLevel'>,
): boolean {
  return (
    game.status === 'finished' &&
    game.voidedAt === null &&
    isDecided(game.result) &&
    game.engineLevel === null
  );
}

/**
 * `isCountedGame` as a condition on `games`; the backfill lists players by it (backfill spec §4.2).
 */
export const COUNTED = and(
  eq(games.status, 'finished'),
  isNull(games.voidedAt),
  inArray(games.result, [...DECIDED_RESULTS]),
  isNull(games.engineLevel),
);

/** A decided game's result from one side: `1-0` is a win for White and a loss for Black. */
function resultFor(result: DecidedResult, white: boolean): PlayerResult {
  if (result === '1/2-1/2') return 'draw';
  return (result === '1-0') === white ? 'win' : 'loss';
}

/**
 * The player's counted games (flair spec §1.3), oldest first: all of them, or with `through` those
 * up to and including that game. The order and the cut both use `(finished_at, id)`, so of games
 * that finished at the same instant the lower ids come first and any above `through` are left out.
 * A rule therefore sees no game after the one it is scored at, and that game, when it counts, is
 * the last entry (spec §1.6). Every earlier game counts, however long ago (backfill spec §5).
 */
export async function loadCountedGames(
  tx: DbOrTx,
  userId: number,
  window: { through?: Pick<GameRow, 'id' | 'finishedAt'> } = {},
): Promise<CountedGame[]> {
  const { through } = window;
  const throughAt = through?.finishedAt;
  if (through && throughAt === null) throw new Error(`game ${through.id} has no finish time`);
  const rows = await tx
    .select({
      id: games.id,
      startedAt: games.startedAt,
      finishedAt: games.finishedAt,
      rated: games.rated,
      result: games.result,
      whiteId: games.whiteId,
      blackId: games.blackId,
      endReason: games.endReason,
      whiteRatingAfter: games.whiteRatingAfter,
      blackRatingAfter: games.blackRatingAfter,
    })
    .from(games)
    .where(
      and(
        or(eq(games.whiteId, userId), eq(games.blackId, userId)),
        COUNTED,
        through && throughAt
          ? or(
              lt(games.finishedAt, throughAt),
              and(eq(games.finishedAt, throughAt), lte(games.id, through.id)),
            )
          : undefined,
      ),
    )
    .orderBy(asc(games.finishedAt), asc(games.id));
  return (
    rows
      // The query keeps only finished, decided games; this narrows the types to match.
      .filter(
        (row): row is typeof row & { finishedAt: Date; result: DecidedResult } =>
          row.finishedAt !== null && isDecided(row.result),
      )
      .map((row): CountedGame => {
        const white = row.whiteId === userId;
        return {
          id: row.id,
          startedAt: row.startedAt,
          finishedAt: row.finishedAt,
          rated: row.rated,
          result: resultFor(row.result, white),
          // The rating this side left the game with, unrounded; null when the game left none.
          ratingAfter: white ? row.whiteRatingAfter : row.blackRatingAfter,
          side: white ? 'white' : 'black',
          endReason: row.endReason,
          opponentId: white ? row.blackId : row.whiteId,
        };
      })
  );
}
