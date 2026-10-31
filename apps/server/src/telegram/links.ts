import { encodeStartParam, type StartParam } from '@chess-goat/shared';
import type { Config } from '../config';

/** The only Mini App button that works inside groups (spec §5.3). */
export function miniAppLink(
  config: Pick<Config, 'BOT_USERNAME' | 'MINI_APP_SHORT_NAME'>,
  param?: StartParam,
): string {
  const base = `https://t.me/${config.BOT_USERNAME}/${config.MINI_APP_SHORT_NAME}`;
  return param ? `${base}?startapp=${encodeStartParam(param)}` : base;
}

/** `https://t.me/c/<supergroup id without -100>/<message id>`; basic groups have no message links (spec §5.7). */
export function groupMessageLink(telegramChatId: number, messageId: number): string | null {
  if (telegramChatId > -1_000_000_000_000) return null;
  return `https://t.me/c/${String(telegramChatId).slice(4)}/${messageId}`;
}
