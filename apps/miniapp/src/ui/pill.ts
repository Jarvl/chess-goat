import {
  endReasonLabel,
  formatClock,
  resultLabel,
  t,
  type Colour,
  type EndReason,
  type GameResult,
  type GameSummary,
} from '@chess-goat/shared';
import { isUrgent, remainingMs } from '../state/clock';

export type Pill = { kind: 'yours' | 'urgent' | 'other'; text: string };

/** The viewer's side in this game, or null when they are watching. */
export function roleOf(game: GameSummary, viewerId: string | null): Colour | null {
  if (viewerId === null) return null;
  if (game.white.id === viewerId) return 'white';
  if (game.black.id === viewerId) return 'black';
  return null;
}

/** "You won · Checkmate · 1-0" from a player's side, "White won · …" for anyone else. */
export function outcomeFor(
  result: GameResult | null,
  endReason: EndReason | null,
  voided: boolean,
  role: Colour | null,
): string {
  if (voided) return t('app.game.voided');
  let outcome: string;
  if (!result || result === '*') outcome = t('app.game.result.aborted');
  else if (result === '1/2-1/2') outcome = t('app.game.result.draw');
  else {
    const winner = result === '1-0' ? 'white' : 'black';
    outcome =
      role === null
        ? t(`app.game.result.${winner}`)
        : t(role === winner ? 'app.game.result.win' : 'app.game.result.loss');
  }
  const parts = [outcome];
  if (endReason) parts.push(endReasonLabel(endReason));
  if (result && result !== '*') parts.push(resultLabel(result));
  return parts.join(' · ');
}

/** The status line of a game row (redesign spec §3.1 Pill). */
export function pillFor(game: GameSummary, viewerId: string | null, now: Date): Pill {
  if (game.status === 'finished')
    return {
      kind: 'other',
      text: outcomeFor(game.result, game.endReason, game.voided, roleOf(game, viewerId)),
    };
  const remaining = remainingMs(game.deadlineAt, now);
  if (game.yourTurn) {
    if (game.timePerMove === null || remaining === null)
      return { kind: 'yours', text: t('app.lobby.your_move') };
    const clock = formatClock(remaining);
    return isUrgent(remaining, game.timePerMove)
      ? { kind: 'urgent', text: t('app.card.your_move_left', { clock }) }
      : { kind: 'yours', text: t('app.card.your_move_clock', { clock }) };
  }
  const mover = game.sideToMove === 'white' ? game.white.name : game.black.name;
  const clock =
    game.timePerMove === null
      ? t('app.game.no_clock')
      : formatClock(remaining ?? game.timePerMove * 1000);
  return { kind: 'other', text: t('app.card.to_move_clock', { name: mover, clock }) };
}
