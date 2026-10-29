import {
  applyMove,
  opposite,
  sideToMove,
  timeoutOutcome,
  type Colour,
  type EndReason,
  type GameDto,
  type GameResult,
  type TimePerMove,
} from '@group-chess/shared';
import { asc, eq, sql } from 'drizzle-orm';
import { dbNow, type DbOrTx } from '../db/client';
import { adminActions, games, groups, moves, type GameRow, type MoveRow } from '../db/schema';
import { isCountedGame } from '../flair/history';
import { enqueue } from '../jobs/queue';
import type { Deps } from './deps';
import { enqueueEngineMove, isEngineGame } from './engineGames';
import { DomainError } from './errors';
import { buildGameDto, colourOf, positionKeys } from './gameDto';
import { deadlineExpression, reminderExpression } from './limits';
import { gameEndedStub, moveLabel, waitingText } from './dmText';
import { resultRecipients } from './dmRules';
import { markWaiting, retireGameDms } from './dms';
import { applyGameResultToRatings, getPlayerRating } from './ratings';
import { nameWithFlair, requireUser, wantsDms } from './users';

export type EndInput = { result: GameResult; endReason: EndReason };

export async function requireGameByPublicId(
  tx: DbOrTx,
  publicId: string,
  options: { forUpdate?: boolean } = {},
): Promise<GameRow> {
  const query = tx.select().from(games).where(eq(games.publicId, publicId)).limit(1);
  const [row] = options.forUpdate ? await query.for('update') : await query;
  if (!row) throw new DomainError('not_found', 'game not found');
  return row;
}

export async function requireGameById(
  tx: DbOrTx,
  id: number,
  options: { forUpdate?: boolean } = {},
): Promise<GameRow> {
  const query = tx.select().from(games).where(eq(games.id, id)).limit(1);
  const [row] = options.forUpdate ? await query.for('update') : await query;
  if (!row) throw new DomainError('not_found', 'game not found');
  return row;
}

export async function listMoves(tx: DbOrTx, gameId: number): Promise<MoveRow[]> {
  return tx.select().from(moves).where(eq(moves.gameId, gameId)).orderBy(asc(moves.ply));
}

export async function loadGameDto(
  tx: DbOrTx,
  game: GameRow,
  viewerUserId: number | null,
): Promise<GameDto> {
  const [group] = await tx
    .select({ publicId: groups.publicId, title: groups.title })
    .from(groups)
    .where(eq(groups.id, game.groupId))
    .limit(1);
  if (!group) throw new DomainError('not_found', 'group not found');
  const [moveRows, white, black, whiteRating, blackRating, now] = await Promise.all([
    listMoves(tx, game.id),
    requireUser(tx, game.whiteId),
    requireUser(tx, game.blackId),
    getPlayerRating(tx, game.groupId, game.whiteId),
    getPlayerRating(tx, game.groupId, game.blackId),
    dbNow(tx),
  ]);
  return buildGameDto({
    game,
    moves: moveRows,
    group,
    white,
    black,
    whiteRating,
    blackRating,
    viewerUserId,
    now,
  });
}

export async function getGameDto(
  deps: Deps,
  input: { gameId: string; viewerUserId: number | null },
): Promise<GameDto> {
  const game = await requireGameByPublicId(deps.db, input.gameId);
  return loadGameDto(deps.db, game, input.viewerUserId);
}

const ABORT_REASONS: ReadonlySet<EndInput['endReason']> = new Set(['abort', 'timeout_abort']);

/**
 * Ends a game inside `tx`: status and result, ratings and snapshots, then the card, result photo
 * and import jobs, and the players' DMs. `endedBy` is the player whose action ended it, or null
 * when nobody's did (a timeout, a void): the result DM goes to whoever did not end it.
 */
export async function finishGame(
  tx: DbOrTx,
  game: GameRow,
  end: EndInput,
  now: Date,
  endedBy: Colour | null = null,
): Promise<GameRow> {
  // A voided game is not worth an import; the fallback analysis link still works (review finding 10).
  // Spec §8: engine games post no card and are never imported — the Lichess quota is shared across
  // the deployment and these games have no human opponent.
  const engineGame = isEngineGame(game);
  const importable = game.plyCount > 0 && end.endReason !== 'voided' && !engineGame;
  const [updated] = await tx
    .update(games)
    .set({
      status: 'finished',
      result: end.result,
      endReason: end.endReason,
      finishedAt: now,
      deadlineAt: null,
      reminderAt: null,
      drawOfferBy: null,
      drawOfferPly: null,
      premoves: [],
      premoveTree: Buffer.alloc(0),
      lichessImportStatus: importable ? 'pending' : null,
      version: sql`${games.version} + 1`,
    })
    .where(eq(games.id, game.id))
    .returning();
  if (!updated) throw new DomainError('not_found', 'game not found');
  await applyGameResultToRatings(tx, updated, now);
  if (!engineGame) {
    await enqueue(tx, {
      kind: 'edit_card',
      payload: { gameId: game.id },
      dedupKey: `card:g:${game.publicId}`,
    });
  }
  // The group hears how a game ended through one result photo, not DMs to its players; bot games
  // and aborted games announce nothing beyond the card.
  if (!engineGame && !ABORT_REASONS.has(end.endReason)) {
    await enqueue(tx, {
      kind: 'send_result_photo',
      payload: { gameId: game.id },
      dedupKey: `result:g:${game.publicId}`,
    });
  }
  if (importable) {
    await enqueue(tx, {
      kind: 'lichess_import',
      payload: { gameId: game.id },
      dedupKey: `lichess:${game.publicId}`,
    });
  }
  if (!engineGame) await endGameDms(tx, game, end.endReason, endedBy);
  // Flair spec §3.2: a decided game against a person is scored; aborts, voids and bot games are not.
  if (isCountedGame(updated)) {
    await enqueue(tx, {
      kind: 'award_flair',
      payload: { gameId: game.id },
      dedupKey: flairAwardDedupKey(game.publicId),
    });
  }
  return requireGameById(tx, game.id);
}

/**
 * DM notifications spec §2.4 and §4.2: every live DM for the game is retired — a waiting line
 * keeps its own text, anything else says the game ended — and the result DM is queued for each
 * player who did not end it.
 */
async function endGameDms(
  tx: DbOrTx,
  game: GameRow,
  endReason: EndReason,
  endedBy: Colour | null,
): Promise<void> {
  const [white, black] = await Promise.all([
    requireUser(tx, game.whiteId),
    requireUser(tx, game.blackId),
  ]);
  await retireGameDms(tx, game.id, (row) =>
    row.kind === 'waiting'
      ? row.stub
      : gameEndedStub(nameWithFlair(row.userId === white.id ? black : white)),
  );
  for (const colour of resultRecipients(endReason, endedBy)) {
    const userId = colour === 'white' ? white.id : black.id;
    await enqueue(tx, {
      kind: 'send_dm',
      payload: { userId, template: 'result', gameId: game.id },
      dedupKey: `dm:${userId}:g:${game.publicId}`,
      mergePayload: true,
    });
  }
}

/** The dedup key of a game's `award_flair` job; the result photo waits while it is pending. */
export function flairAwardDedupKey(gamePublicId: string): string {
  return `flair:g:${gamePublicId}`;
}

/** Spec §7.1: `timeout_abort` when the player to move never moved, otherwise a loss on time (FIDE 6.9). */
export function timeoutEnd(game: Pick<GameRow, 'fen' | 'plyCount'>): EndInput {
  const flagged = sideToMove(game.fen);
  const neverMoved =
    (flagged === 'white' && game.plyCount === 0) || (flagged === 'black' && game.plyCount === 1);
  if (neverMoved) return { result: '*', endReason: 'timeout_abort' };
  return timeoutOutcome(game.fen, flagged);
}

export async function applyTimeout(tx: DbOrTx, game: GameRow, now: Date): Promise<GameRow> {
  return finishGame(tx, game, timeoutEnd(game), now);
}

export type LockedGame = {
  game: GameRow;
  colour: 'white' | 'black';
  /** The database clock; constant for the rest of the transaction. */
  now: Date;
  /** True when the deadline had already passed: `game` is then the finished row and the action must not proceed. */
  ended: boolean;
};

/**
 * Locks an active game for one of its players. A deadline that passed before this transaction is
 * applied right here, so no action (move, resign, abort, draw offer, acceptance or claim) can beat
 * the forfeit scanner (spec §7.3, §7.4).
 */
export async function lockActiveGame(
  tx: DbOrTx,
  publicId: string,
  userId: number,
): Promise<LockedGame> {
  const game = await requireGameByPublicId(tx, publicId, { forUpdate: true });
  const colour = colourOf(game, userId);
  if (!colour) throw new DomainError('forbidden', 'only the players can do that');
  if (game.status !== 'active') throw new DomainError('stale_state', 'the game is over');
  const now = await dbNow(tx);
  if (game.deadlineAt && game.deadlineAt.getTime() < now.getTime()) {
    return { game: await applyTimeout(tx, game, now), colour, now, ended: true };
  }
  return { game, colour, now, ended: false };
}

export type PlayMoveInput = {
  gameId: string;
  userId: number;
  uci: string;
  expectedPly: number;
  clientMoveId: string;
};

type CommitInput = {
  game: GameRow;
  colour: Colour;
  uci: string;
  clientMoveId: string;
  now: Date;
  history: MoveRow[];
  /**
   * False only on the recursive call that plays a fired premove. Any leftover chain still belongs
   * to the side that just moved (the premove's owner), for their next turn — not to whoever is to
   * move now — so only the outer call may look at the queue and try to fire from it. Defaults to true.
   */
  firePremoves?: boolean;
};

/**
 * Plays `uci` for `colour`, who is to move on the locked `game`, and everything that follows a
 * move: the clock, the end of the game, the card, the turn DM or the engine's reply. The queue on the
 * row belongs to the other side, whose turn it now is; its first premove is played or the whole
 * chain cancelled right here (premoves spec, Firing). Returns the final row.
 */
async function commitMove(tx: DbOrTx, input: CommitInput): Promise<GameRow> {
  const { game, colour, now, history } = input;
  const result = applyMove(game.fen, positionKeys(history), input.uci);
  if (!result.legal) throw new DomainError('illegal_move', 'illegal move');

  const ply = game.plyCount + 1;
  const [inserted] = await tx
    .insert(moves)
    .values({
      gameId: game.id,
      ply,
      uci: result.uci,
      san: result.san,
      fenAfter: result.fenAfter,
      playedAt: now,
      clientMoveId: input.clientMoveId,
    })
    .returning();
  if (!inserted) throw new Error('move insert returned no row');
  const opponentId = colour === 'white' ? game.blackId : game.whiteId;
  const opponent = await requireUser(tx, opponentId);
  // `engineNext` decides whether to enqueue the engine's reply; `engineGame` suppresses the card
  // and the turn DM. Neither touches the clock any more: a bot game has no time control, so both
  // clock expressions below already return null for it without being asked about the engine.
  const engineNext = opponent.isEngine;
  const engineGame = isEngineGame(game);
  if (!engineGame) {
    // DM notifications spec §2.2: the mover's live DM quietly becomes the waiting line. A fired
    // premove comes through here too, for its owner.
    await markWaiting(tx, {
      userId: colour === 'white' ? game.whiteId : game.blackId,
      gameId: game.id,
      text: waitingText({ move: moveLabel(ply, result.san), opponent: nameWithFlair(opponent) }),
    });
  }
  const timePerMove = game.timePerMove as TimePerMove;
  const offerLapses = game.drawOfferBy !== null && game.drawOfferBy !== colour;
  const [moved] = await tx
    .update(games)
    .set({
      fen: result.fenAfter,
      plyCount: ply,
      version: sql`${games.version} + 1`,
      lastMoveAt: now,
      // No engine special case: a bot game's time control is null (spec §8), so both of these
      // already yield null for it. That null clock is what makes the engine unforfeitable and
      // leaves the human nothing to be reminded about.
      deadlineAt: deadlineExpression(timePerMove),
      reminderAt: reminderExpression(timePerMove, wantsDms(opponent)),
      // The opponent's queue rides along; after a fired premove this is the rest of the chain.
      premoves: game.premoves,
      ...(offerLapses ? { drawOfferBy: null, drawOfferPly: null } : {}),
    })
    .where(eq(games.id, game.id))
    .returning();
  if (!moved) throw new DomainError('not_found', 'game not found');

  if (result.outcome.kind !== 'continue') {
    const end: EndInput =
      result.outcome.kind === 'checkmate'
        ? { result: result.outcome.winner === 'white' ? '1-0' : '0-1', endReason: 'checkmate' }
        : { result: '1/2-1/2', endReason: result.outcome.reason };
    return finishGame(tx, moved, end, now, colour);
  }

  let premovesCancelled = false;
  if (input.firePremoves !== false) {
    const [next, ...rest] = moved.premoves;
    if (next !== undefined) {
      const played = [...history, inserted];
      const trial = applyMove(moved.fen, positionKeys(played), next);
      if (trial.legal) {
        // `rest` rides along untouched, even an entry the reply has already made impossible: it is
        // cancelled when it comes up after the opponent's next move, and only then does the
        // owner's turn DM say "Your premoves were cancelled." (premoves spec, Firing).
        // The premove is the opponent's move: its commit does the card, the turn DM to `colour` (or
        // the engine enqueue) and the clock. The opponent gets no turn DM of their own. It is the
        // only recursive call, and it never fires again (see `firePremoves` above).
        return commitMove(tx, {
          game: { ...moved, premoves: rest },
          colour: opposite(colour),
          uci: next,
          clientMoveId: `premove:${game.publicId}:${ply + 1}`,
          now,
          history: played,
          firePremoves: false,
        });
      }
      await tx.update(games).set({ premoves: [] }).where(eq(games.id, game.id));
      premovesCancelled = true;
    }
  }

  if (engineNext) {
    // Spec §8: engine games post no card, and the engine has no DM to receive.
    await enqueueEngineMove(tx, moved);
  } else if (!engineGame) {
    // Spec §8: a bot game announces nothing when the engine moves — no card, and no turn DM to
    // the human. The whole branch is a no-op for it.
    await enqueue(tx, {
      kind: 'edit_card',
      payload: { gameId: game.id },
      dedupKey: `card:g:${game.publicId}`,
    });
    await enqueue(tx, {
      kind: 'send_dm',
      payload: {
        userId: opponentId,
        template: 'turn',
        gameId: game.id,
        // The ply it applies to, so a merged payload cannot repeat it on a later turn.
        ...(premovesCancelled ? { premovesCancelledAtPly: ply } : {}),
      },
      dedupKey: `dm:${opponentId}:g:${game.publicId}`,
      mergePayload: true,
    });
  }
  return premovesCancelled ? { ...moved, premoves: [] } : moved;
}

/** The move transaction of spec §7.4, step for step. */
export async function playMove(deps: Deps, input: PlayMoveInput): Promise<GameDto> {
  const dto = await deps.db.transaction(async (tx) => {
    const { game, colour, now, ended } = await lockActiveGame(tx, input.gameId, input.userId);
    if (ended) return loadGameDto(tx, game, input.userId);
    // A retried request must return the current state even though it is now the opponent's turn,
    // and a stale client learns that before it learns whose turn it is.
    const history = await listMoves(tx, game.id);
    if (history.some((move) => move.clientMoveId === input.clientMoveId)) {
      return loadGameDto(tx, game, input.userId);
    }
    if (input.expectedPly !== game.plyCount) {
      throw new DomainError('stale_state', 'the position has changed', { plyCount: game.plyCount });
    }
    if (sideToMove(game.fen) !== colour) throw new DomainError('not_your_turn', 'not your turn');
    const final = await commitMove(tx, {
      game,
      colour,
      uci: input.uci,
      clientMoveId: input.clientMoveId,
      now,
      history,
    });
    return loadGameDto(tx, final, input.userId);
  });
  deps.bus.publish(input.gameId);
  return dto;
}

export async function resign(
  deps: Deps,
  input: { gameId: string; userId: number },
): Promise<GameDto> {
  const dto = await deps.db.transaction(async (tx) => {
    const { game, colour, now, ended } = await lockActiveGame(tx, input.gameId, input.userId);
    if (ended) return loadGameDto(tx, game, input.userId);
    const end: EndInput = { result: colour === 'white' ? '0-1' : '1-0', endReason: 'resignation' };
    return loadGameDto(tx, await finishGame(tx, game, end, now, colour), input.userId);
  });
  deps.bus.publish(input.gameId);
  return dto;
}

/** PRD §7.3: abort is available before both players have moved; no rating change. */
export async function abortGame(
  deps: Deps,
  input: { gameId: string; userId: number },
): Promise<GameDto> {
  const dto = await deps.db.transaction(async (tx) => {
    const { game, now, ended } = await lockActiveGame(tx, input.gameId, input.userId);
    if (ended) return loadGameDto(tx, game, input.userId);
    if (game.plyCount >= 2)
      throw new DomainError('forbidden', 'abort is no longer available', {
        reason: 'abort_unavailable',
      });
    return loadGameDto(
      tx,
      await finishGame(tx, game, { result: '*', endReason: 'abort' }, now),
      input.userId,
    );
  });
  deps.bus.publish(input.gameId);
  return dto;
}

/** Spec §7.1/§7.5 void: caller has verified admin rights; ratings are rebuilt by the `rebuild_ratings` job. */
export async function voidGame(
  deps: Deps,
  input: { gameId: string; adminUserId: number },
): Promise<GameDto> {
  const dto = await deps.db.transaction(async (tx) => {
    let game = await requireGameByPublicId(tx, input.gameId, { forUpdate: true });
    const now = await dbNow(tx);
    if (game.voidedAt) throw new DomainError('stale_state', 'already voided');
    if (game.status === 'active') {
      game = await finishGame(tx, game, { result: '*', endReason: 'voided' }, now);
    }
    const [voided] = await tx
      .update(games)
      .set({ voidedAt: now, voidedBy: input.adminUserId, version: sql`${games.version} + 1` })
      .where(eq(games.id, game.id))
      .returning();
    if (!voided) throw new DomainError('not_found', 'game not found');
    const [group] = await tx
      .select({ publicId: groups.publicId })
      .from(groups)
      .where(eq(groups.id, game.groupId));
    if (voided.rated) {
      await enqueue(tx, {
        kind: 'rebuild_ratings',
        payload: { groupId: game.groupId },
        dedupKey: `ratings:${group?.publicId}`,
      });
    }
    if (!isEngineGame(game)) {
      await enqueue(tx, {
        kind: 'edit_card',
        payload: { gameId: game.id },
        dedupKey: `card:g:${game.publicId}`,
      });
    }
    await tx.insert(adminActions).values({
      groupId: game.groupId,
      adminUserId: input.adminUserId,
      action: 'void',
      targetGameId: game.id,
      details: { previousResult: game.result, previousEndReason: game.endReason },
    });
    return loadGameDto(tx, voided, input.adminUserId);
  });
  deps.bus.publish(input.gameId);
  return dto;
}
