import { endReasonLabel, type Colour, type GameDto } from '@chess-goat/shared';

export type ResultTag = 'won' | 'lost' | 'draw' | 'aborted' | 'voided';

/**
 * What one player bar shows once the game is over: the tag in the clock's place, and the reason
 * that replaces the bar's second line. The reason goes under the winner, under both sides for a
 * draw, and under White alone for an abort; a voided game gives none. Null while the game is on.
 */
export function sideResult(
  dto: GameDto,
  colour: Colour,
): { tag: ResultTag; reason: string | null } | null {
  if (dto.status !== 'finished') return null;
  if (dto.voided) return { tag: 'voided', reason: null };
  const reason = dto.endReason ? endReasonLabel(dto.endReason) : null;
  if (!dto.result || dto.result === '*')
    return { tag: 'aborted', reason: colour === 'white' ? reason : null };
  if (dto.result === '1/2-1/2') return { tag: 'draw', reason };
  const winner: Colour = dto.result === '1-0' ? 'white' : 'black';
  return winner === colour ? { tag: 'won', reason } : { tag: 'lost', reason: null };
}
