import type { EndReason, GameResult, TimePerMove, TimePerMoveSeconds } from '../protocol/enums';
import { en } from './en';

export { en };

export type MessageKey = keyof typeof en;

export type MessageParams = Record<string, string | number>;

/** Replaces `{name}` placeholders; unknown placeholders are left in place so a typo is visible. */
export function format(template: string, params: MessageParams): string {
  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : placeholder,
  );
}

export function t(key: MessageKey, params: MessageParams = {}): string {
  return format(en[key], params);
}

export function movesLabel(count: number): string {
  return t(count === 1 ? 'moves.one' : 'moves.other', { count });
}

export function timePerMoveLabel(timePerMove: TimePerMove): string {
  return timePerMove === null ? t('time.per_move.none') : t(`time.per_move.${timePerMove}`);
}

export function timeSpanLabel(seconds: TimePerMoveSeconds): string {
  return t(`time.span.${seconds}`);
}

export function endReasonLabel(reason: EndReason): string {
  return t(`end_reason.${reason}`);
}

export function resultLabel(result: GameResult): string {
  return t(`result.${result}`);
}

export function ratedLabel(rated: boolean): string {
  return t(rated ? 'game.rated' : 'game.casual');
}

/** Provisional ratings carry a `?` suffix. */
export function ratingLabel(rating: number, provisional: boolean): string {
  return `${Math.round(rating)}${provisional ? '?' : ''}`;
}
