import {
  ratedLabel,
  ratingLabel,
  t,
  timePerMoveLabel,
  type FlairCategory,
  type FlairEarned,
  type GameSummary,
  type PlayerRef,
  type TimePerMove,
} from '@chess-goat/shared';

// en-US on purpose (flair spec §5.5): month first, and "Sep" where en-GB writes "Sept".
const MONTH_YEAR = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric' });
const MONTH_DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const MONTH_DAY_YEAR = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

export function playerLabel(player: PlayerRef): string {
  return `${player.name} ${ratingLabel(player.rating, player.provisional)}`;
}

export function termsLabel(timePerMove: TimePerMove, rated: boolean): string {
  return t('app.lobby.terms', {
    timePerMove: timePerMoveLabel(timePerMove),
    rated: ratedLabel(rated),
  });
}

export function summaryTitle(summary: GameSummary): string {
  return `${summary.white.name} vs ${summary.black.name}`;
}

/**
 * The line under an earned flair (flair spec §5.3): a rung of the rank ladder by the month it was
 * reached, anything else by the game that earned it. The year is added when it is not `now`'s, in
 * the viewer's local time.
 */
export function flairEarnedLabel(
  category: FlairCategory,
  earned: Pick<FlairEarned, 'earnedAt' | 'opponent'>,
  now: Date,
): string {
  const at = new Date(earned.earnedAt);
  if (category === 'rank') return t('app.flair.earned', { when: MONTH_YEAR.format(at) });
  const date = (at.getFullYear() === now.getFullYear() ? MONTH_DAY : MONTH_DAY_YEAR).format(at);
  return t('app.flair.earned', {
    when: t('app.flair.earned_vs', { opponent: earned.opponent, date }),
  });
}
