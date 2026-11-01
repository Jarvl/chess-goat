import type { ColourChoice } from './enums';
import type { PublicId } from './ids';

/** Time per move the private /challenge prompt offers: 1, 3 or 7 days. */
export type PromptTime = 86400 | 259200 | 604800;

/** The game settings a private /challenge prompt carries in its buttons. */
export type PromptSettings = { timePerMove: PromptTime; colour: ColourChoice; rated: boolean };

/** Inline-button callback payloads; everything else on a card is a URL button (spec §5.3). */
export type CallbackData =
  | { action: 'accept_challenge'; challengeId: PublicId }
  | { action: 'decline_challenge'; challengeId: PublicId }
  | { action: 'rematch'; gameId: PublicId }
  | {
      action: 'prompt';
      op: 'main' | 'settings' | 'anyone';
      ownerTelegramId: number;
      settings: PromptSettings;
    };

const CALLBACK_PATTERN = /^(ch\/acc|ch\/dec|gm\/rem)\/([A-Za-z0-9]{10})$/;
/** `cp/<op>/<owner>/<days>/<colour>/<rated>`; fits Telegram's 64-byte limit with room to spare. */
const PROMPT_PATTERN = /^cp\/([msa])\/(\d{1,16})\/([137])\/([rwb])\/([01])$/;

const PROMPT_OPS = { m: 'main', s: 'settings', a: 'anyone' } as const;
const PROMPT_TIMES = { '1': 86400, '3': 259200, '7': 604800 } as const;
const PROMPT_COLOURS = { r: 'random', w: 'white', b: 'black' } as const;
const PROMPT_OP_CODES = { main: 'm', settings: 's', anyone: 'a' } as const;
const PROMPT_TIME_CODES = { 86400: '1', 259200: '3', 604800: '7' } as const;
const PROMPT_COLOUR_CODES = { random: 'r', white: 'w', black: 'b' } as const;

export function encodeCallbackData(data: CallbackData): string {
  switch (data.action) {
    case 'accept_challenge':
      return `ch/acc/${data.challengeId}`;
    case 'decline_challenge':
      return `ch/dec/${data.challengeId}`;
    case 'rematch':
      return `gm/rem/${data.gameId}`;
    case 'prompt': {
      const { timePerMove, colour, rated } = data.settings;
      return `cp/${PROMPT_OP_CODES[data.op]}/${data.ownerTelegramId}/${PROMPT_TIME_CODES[timePerMove]}/${PROMPT_COLOUR_CODES[colour]}/${rated ? 1 : 0}`;
    }
  }
}

export function decodeCallbackData(raw: string | null | undefined): CallbackData | null {
  if (!raw) return null;
  const prompt = PROMPT_PATTERN.exec(raw);
  if (prompt) {
    const [, op, owner, time, colour, rated] = prompt as unknown as [
      string,
      keyof typeof PROMPT_OPS,
      string,
      keyof typeof PROMPT_TIMES,
      keyof typeof PROMPT_COLOURS,
      string,
    ];
    return {
      action: 'prompt',
      op: PROMPT_OPS[op],
      ownerTelegramId: Number(owner),
      settings: {
        timePerMove: PROMPT_TIMES[time],
        colour: PROMPT_COLOURS[colour],
        rated: rated === '1',
      },
    };
  }
  const match = CALLBACK_PATTERN.exec(raw);
  if (!match) return null;
  const verb = match[1];
  const id = match[2];
  if (!verb || !id) return null;
  if (verb === 'ch/acc') return { action: 'accept_challenge', challengeId: id };
  if (verb === 'ch/dec') return { action: 'decline_challenge', challengeId: id };
  return { action: 'rematch', gameId: id };
}
