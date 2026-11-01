import {
  decodeCallbackData,
  encodeCallbackData,
  ratedLabel,
  t,
  timePerMoveLabel,
  type GroupSettings,
  type PromptSettings,
  type PromptTime,
} from '@chess-goat/shared';
import type { EphemeralButton, EphemeralMarkup } from './ephemeral';

const TIMES: [PromptTime, 'button.time.1d' | 'button.time.3d' | 'button.time.7d'][] = [
  [86400, 'button.time.1d'],
  [259200, 'button.time.3d'],
  [604800, 'button.time.7d'],
];
const COLOURS = ['random', 'white', 'black'] as const;

export function startingSettings(group: GroupSettings): PromptSettings {
  return { timePerMove: 259200, colour: 'random', rated: group.ratedDefault };
}

const data = (op: 'main' | 'settings' | 'anyone', owner: number, settings: PromptSettings) =>
  encodeCallbackData({ action: 'prompt', op, ownerTelegramId: owner, settings });

/** The prompt's text and keyboard; `force_reply` keeps the @-mention reply path open. */
export function promptView(
  view: 'main' | 'settings',
  owner: number,
  s: PromptSettings,
): { text: string; replyMarkup: EphemeralMarkup & { force_reply: true } } {
  const text = `${t('prompt.challenge')}\n${t('prompt.summary', {
    timePerMove: timePerMoveLabel(s.timePerMove),
    colour: t(`prompt.colour.${s.colour}`),
    rated: ratedLabel(s.rated),
  })}`;

  // The current choice is blue; the others carry no `style` key.
  const option = (label: string, next: PromptSettings, current: boolean): EphemeralButton => ({
    text: label,
    callback_data: data('settings', owner, next),
    ...(current ? { style: 'primary' as const } : {}),
  });

  const rows: EphemeralButton[][] =
    view === 'main'
      ? [
          [
            { text: t('button.anyone'), callback_data: data('anyone', owner, s), style: 'success' },
            { text: t('button.game_settings'), callback_data: data('settings', owner, s) },
          ],
        ]
      : [
          TIMES.map(([timePerMove, key]) =>
            option(t(key), { ...s, timePerMove }, s.timePerMove === timePerMove),
          ),
          COLOURS.map((colour) =>
            option(t(`button.colour.${colour}`), { ...s, colour }, s.colour === colour),
          ),
          [
            option(t('button.rated'), { ...s, rated: true }, s.rated),
            option(t('button.casual'), { ...s, rated: false }, !s.rated),
          ],
          [{ text: t('button.done'), callback_data: data('main', owner, s) }],
        ];

  return { text, replyMarkup: { inline_keyboard: rows, force_reply: true } };
}

/**
 * Reads the prompt's owner and settings from its keyboard; null for any other message. Option
 * buttons in the settings view carry a changed state, so it reads Anyone or Done, which carry the
 * current one.
 */
export function promptStateFrom(
  markup: unknown,
): { owner: number; settings: PromptSettings } | null {
  const rows = (markup as { inline_keyboard?: unknown } | null | undefined)?.inline_keyboard;
  if (!Array.isArray(rows)) return null;
  for (const row of rows as unknown[]) {
    if (!Array.isArray(row)) continue;
    for (const button of row as { callback_data?: unknown }[]) {
      if (typeof button?.callback_data !== 'string') continue;
      const decoded = decodeCallbackData(button.callback_data);
      if (decoded?.action === 'prompt' && decoded.op !== 'settings')
        return { owner: decoded.ownerTelegramId, settings: decoded.settings };
    }
  }
  return null;
}
