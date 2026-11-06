import {
  BOT_ACTIVE_NOW_MS,
  compactDuration,
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

/** A date with its year, in the viewer's local time (en-US, as the flair dates). */
export function dateLabel(iso: string): string {
  return MONTH_DAY_YEAR.format(new Date(iso));
}

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

/** A bot's activity as a short line ("Active now", "Last active 3d ago"); null for people. */
export function botActivityLabel(player: Pick<PlayerRef, 'botActivity'>, now: Date): string | null {
  if (!player.botActivity) return null;
  const { lastActiveAt } = player.botActivity;
  if (lastActiveAt === null) return t('app.player.bot_never_active');
  const age = now.getTime() - new Date(lastActiveAt).getTime();
  if (age <= BOT_ACTIVE_NOW_MS) return t('app.player.bot_active_now');
  return t('app.player.bot_last_active', { ago: compactDuration(age) });
}
