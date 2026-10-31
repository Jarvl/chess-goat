import { FLAIR, flairBackfillVersion, flairById, type FlairEntry } from '@chess-goat/shared';
import { and, eq, exists, gt, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db/client';
import { flairBackfills, games, userFlair, users } from '../db/schema';
import { listMoves } from '../domain/games';
import { enqueue } from '../jobs/queue';
import { COUNTED, loadCountedGames } from './history';
import { earliestQualifying } from './walk';

/** A flair to backfill and the catalog version it is backfilled at (backfill spec §1). */
export type BackfillPair = { id: string; version: number };

/**
 * What one run of a backfill did: the players it walked and, per flair id, the awards added and
 * moved. `next` is the last player walked when players remain, and null once the backfill is done.
 */
export type BackfillSummary = {
  players: number;
  added: Record<string, number>;
  moved: Record<string, number>;
  next: number | null;
};

/**
 * Backfill spec §2: the catalog flair not yet backfilled at their version, in catalog order. Rows
 * for ids no longer in the catalog are ignored.
 */
export async function pendingBackfills(db: DbOrTx): Promise<BackfillPair[]> {
  const rows = await db.select().from(flairBackfills);
  const done = new Map(rows.map((row) => [row.flairId, row.version]));
  return FLAIR.flatMap((flair) => {
    const version = flairBackfillVersion(flair);
    return (done.get(flair.id) ?? 0) < version ? [{ id: flair.id, version }] : [];
  });
}

/** Backfill spec §3: `flair:backfill:` and the pairs as `id@version`, sorted by id. */
export function backfillDedupKey(pairs: readonly BackfillPair[]): string {
  const sorted = [...pairs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return `flair:backfill:${sorted.map((pair) => `${pair.id}@${pair.version}`).join(',')}`;
}

/**
 * Backfill spec §4.1: whether this build can run a backfill of `pairs`. A job enqueued by a newer
 * build can name a flair this one lacks or a version above its own, and is left for a newer worker.
 */
export function canRunBackfill(pairs: readonly BackfillPair[]): boolean {
  return pairs.every((pair) => {
    const flair = flairById(pair.id);
    return flair !== undefined && pair.version <= flairBackfillVersion(flair);
  });
}

/**
 * Backfill spec §3: queues a backfill of whatever is pending, if anything. Boots of the same build
 * compute the same key and share one job; `rearm: false` leaves a job that is retrying as it is.
 */
export async function enqueueFlairBackfill(db: DbOrTx): Promise<void> {
  const pairs = await pendingBackfills(db);
  if (pairs.length === 0) return;
  await enqueue(db, {
    kind: 'backfill_flair',
    payload: { flair: pairs },
    dedupKey: backfillDedupKey(pairs),
    rearm: false,
  });
}

/**
 * Backfill spec §4.2: credits one player with each of `flair` at the first of their counted games
 * that earns it. A flair they hold moves to an earlier game if one qualifies, and never to a later
 * one. It takes no lock and leaves the worn list alone. Both lists come back in catalog order.
 */
export async function backfillPlayer(
  db: DbOrTx,
  userId: number,
  flair: readonly FlairEntry[],
): Promise<{ added: string[]; moved: string[] }> {
  const history = await loadCountedGames(db, userId);
  const found = await earliestQualifying(history, flair, (gameId) => listMoves(db, gameId));
  if (found.size === 0) return { added: [], moved: [] };
  const written = await db
    .insert(userFlair)
    .values(
      [...found].map(([flairId, game]) => ({
        userId,
        flairId,
        gameId: game.id,
        earnedAt: game.finishedAt,
      })),
    )
    .onConflictDoUpdate({
      target: [userFlair.userId, userFlair.flairId],
      set: { gameId: sql`excluded.game_id`, earnedAt: sql`excluded.earned_at` },
      setWhere: sql`excluded.earned_at < ${userFlair.earnedAt}`,
    })
    // `xmax` is 0 on a row this statement inserted, and set on one it updated.
    .returning({ flairId: userFlair.flairId, inserted: sql<boolean>`xmax = 0` });
  const inCatalogOrder = (inserted: boolean) =>
    FLAIR.map((f) => f.id).filter((id) =>
      written.some((row) => row.flairId === id && row.inserted === inserted),
    );
  return { added: inCatalogOrder(true), moved: inCatalogOrder(false) };
}

/**
 * Backfill spec §4.2–§4.3: backfills `pairs` for the players who are not the bot, have not deleted
 * their data and have a counted game, one at a time in id order: those after `afterUserId`, at most
 * `limit` of them. When none remain after them, it sweeps the rows of players who deleted their
 * data meanwhile and records the pairs as done, so a backfill that did not finish leaves them
 * pending. `backfillOne` is a seam for tests.
 */
export async function runFlairBackfill(
  db: Db,
  pairs: readonly BackfillPair[],
  {
    afterUserId = 0,
    limit,
    backfillOne = backfillPlayer,
  }: { afterUserId?: number; limit?: number; backfillOne?: typeof backfillPlayer } = {},
): Promise<BackfillSummary> {
  const flair = pairs.flatMap((pair) => {
    const entry = flairById(pair.id);
    return entry ? [entry] : [];
  });
  const eligible = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        gt(users.id, afterUserId),
        eq(users.isEngine, false),
        isNull(users.deletedAt),
        exists(
          db
            .select({ one: sql`1` })
            .from(games)
            .where(and(or(eq(games.whiteId, users.id), eq(games.blackId, users.id)), COUNTED)),
        ),
      ),
    )
    .orderBy(users.id)
    .limit(limit ?? Number.MAX_SAFE_INTEGER);
  const more = limit !== undefined && eligible.length === limit;
  const next = more ? eligible.at(-1)!.id : null;
  const summary: BackfillSummary = { players: eligible.length, added: {}, moved: {}, next };
  const tally = (into: Record<string, number>, ids: readonly string[]) => {
    for (const id of ids) into[id] = (into[id] ?? 0) + 1;
  };
  for (const { id } of eligible) {
    const { added, moved } = await backfillOne(db, id, flair);
    tally(summary.added, added);
    tally(summary.moved, moved);
  }
  if (more) return summary;

  // The walk takes no lock, so it can write for a player whose Delete my data commits meanwhile.
  await db
    .delete(userFlair)
    .where(
      inArray(
        userFlair.userId,
        db.select({ id: users.id }).from(users).where(isNotNull(users.deletedAt)),
      ),
    );
  if (pairs.length > 0)
    await db
      .insert(flairBackfills)
      .values(pairs.map((pair) => ({ flairId: pair.id, version: pair.version })))
      .onConflictDoUpdate({
        target: flairBackfills.flairId,
        set: {
          version: sql`greatest(${flairBackfills.version}, excluded.version)`,
          completedAt: sql`now()`,
        },
      });
  return summary;
}
