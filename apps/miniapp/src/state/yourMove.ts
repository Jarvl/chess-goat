import { sideToMove, type GameDto, type MeGamesDto } from '@group-chess/shared';
import { signal } from '@preact/signals';

/**
 * How many active games, across every group the viewer can see, are waiting on their move: the
 * number on the Games tab. It outlives any one screen, so it is a module signal rather than screen
 * state — the badge shows while the viewer is deep inside a game, where no list is mounted.
 *
 * Three things keep it true, in order of authority: the launch response seeds it (so a deep link
 * into a single game still shows the real total), a fetched games list recounts it from scratch,
 * and a game changing hands under the viewer's eyes adjusts it by one without another request.
 */
export const yourMoveCount = signal(0);

export function setYourMoveCount(total: number): void {
  yourMoveCount.value = Math.max(0, total);
}

/** A fetched list is the truth, and heals any drift the per-game adjustments left behind. */
export function countYourMove(games: MeGamesDto): void {
  yourMoveCount.value = games.items.filter(
    (game) => game.status === 'active' && game.yourTurn,
  ).length;
}

/**
 * One game crossing into or out of "waiting on you" moves the badge by one. Only the difference
 * between two snapshots of the *same* game is applied, so a state that changes nothing about whose
 * turn it is — a draw offer, a spectator's view, a replayed snapshot — leaves the badge alone.
 */
export function noteTurnChange(previous: GameDto, next: GameDto): void {
  const before = waitsOnViewer(previous);
  const after = waitsOnViewer(next);
  if (before === after) return;
  turnChanges += 1;
  yourMoveCount.value = Math.max(0, yourMoveCount.value + (after ? 1 : -1));
}

let turnChanges = 0;

/**
 * How many turn changes `noteTurnChange` has applied. A list asked for before the latest one was
 * counted from the server before it, so it must not overwrite the adjusted badge.
 */
export function turnChangesSeen(): number {
  return turnChanges;
}

function waitsOnViewer(dto: GameDto): boolean {
  return (
    dto.status === 'active' &&
    (dto.viewerRole === 'white' || dto.viewerRole === 'black') &&
    sideToMove(dto.fen) === dto.viewerRole
  );
}
