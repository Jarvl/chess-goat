import { endReasonLabel, isProvisional, ratingLabel, t, type EndReason } from '@chess-goat/shared';

/**
 * DM notifications spec §4: the text of every DM and of the one line a DM leaves behind. Names
 * arrive already rendered with `nameWithFlair`.
 */

export function moveLabel(ply: number, san: string): string {
  const number = Math.ceil(ply / 2);
  return ply % 2 === 1 ? `${number}. ${san}` : `${number}... ${san}`;
}

type Clocked = { opponent: string; lastMove: string | null; timeLeft: string | null };

/** Picks the variant of a `dm.turn`-style key for the parts that are present. */
function clockedKey<K extends 'dm.turn' | 'dm.draw_offer'>(base: K, p: Clocked) {
  if (p.lastMove) return p.timeLeft ? base : (`${base}.no_clock` as const);
  return p.timeLeft ? (`${base}.first` as const) : (`${base}.first_no_clock` as const);
}

function clocked(base: 'dm.turn' | 'dm.draw_offer', p: Clocked): string {
  return t(clockedKey(base, p), {
    opponent: p.opponent,
    lastMove: p.lastMove ?? '',
    timeLeft: p.timeLeft ?? '',
  });
}

export function turnText(
  p: Clocked & { drawOffered: boolean; premovesCancelled: boolean },
): string {
  const lines = [clocked('dm.turn', p)];
  if (p.drawOffered) lines.push(t('dm.draw_offer_line', { opponent: p.opponent }));
  if (p.premovesCancelled) lines.push(t('dm.premoves_cancelled'));
  return lines.join('\n\n');
}

export function reminderText(p: {
  opponent: string;
  timeLeft: string;
  drawOffered: boolean;
}): string {
  const line = t('dm.reminder', { opponent: p.opponent, timeLeft: p.timeLeft });
  return p.drawOffered ? `${line}\n\n${t('dm.draw_offer_line', { opponent: p.opponent })}` : line;
}

export function drawOfferText(p: Clocked): string {
  return clocked('dm.draw_offer', p);
}

function ratingChange(before: number, after: number): string {
  const delta = Math.round(after) - Math.round(before);
  if (delta === 0) return '±0';
  return delta > 0 ? `+${delta}` : `−${-delta}`;
}

export function resultText(p: {
  outcome: 'win' | 'draw' | 'loss';
  opponent: string;
  endReason: EndReason;
  rating: { before: number; after: number; rdAfter: number } | null;
}): string {
  const line = t(`dm.result.${p.outcome}`, {
    opponent: p.opponent,
    reason: endReasonLabel(p.endReason),
  });
  if (!p.rating) return line;
  return (
    line +
    t('dm.result.rating', {
      rating: ratingLabel(p.rating.after, isProvisional(p.rating.rdAfter)),
      change: ratingChange(p.rating.before, p.rating.after),
    })
  );
}

export function waitingText(p: { move: string; opponent: string }): string {
  return t('dm.waiting', p);
}

export function gameEndedStub(opponent: string): string {
  return t('dm.stub.game_ended', { opponent });
}

export type ChallengeOutcome = 'accepted' | 'declined' | 'cancelled' | 'expired';

export function challengeStub(challenger: string, outcome: ChallengeOutcome): string {
  return t(`dm.stub.challenge.${outcome}`, { challenger });
}

export function deletedStub(): string {
  return t('dm.stub.deleted');
}
