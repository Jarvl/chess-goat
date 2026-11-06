import type { PublicId } from './ids';

/** What a Mini App direct link opens (spec §5.3). */
export type StartParam =
  | { kind: 'game'; gameId: PublicId }
  | { kind: 'lobby'; groupId: PublicId }
  /** The group's New game form, for a chat button that says "challenge someone". */
  | { kind: 'newGame'; groupId: PublicId }
  | { kind: 'settings'; groupId: PublicId }
  /** The group's bot browser. */
  | { kind: 'bots'; groupId: PublicId }
  /** New game with this bot already picked; `botId` is the bot's user id. */
  | { kind: 'challengeBot'; groupId: PublicId; botId: number };

const START_PARAM_PATTERN = /^([glnsb])_([A-Za-z0-9]{10})$/;
/** `c_<groupId>_<botId in lower-case base36>`: at most 2 + 10 + 1 + 11 characters. */
const CHALLENGE_BOT_PATTERN = /^c_([A-Za-z0-9]{10})_([0-9a-z]{1,11})$/;

export function encodeStartParam(param: StartParam): string {
  switch (param.kind) {
    case 'game':
      return `g_${param.gameId}`;
    case 'lobby':
      return `l_${param.groupId}`;
    case 'newGame':
      return `n_${param.groupId}`;
    case 'settings':
      return `s_${param.groupId}`;
    case 'bots':
      return `b_${param.groupId}`;
    case 'challengeBot':
      return `c_${param.groupId}_${param.botId.toString(36)}`;
  }
}

export function decodeStartParam(raw: string | null | undefined): StartParam | null {
  if (!raw) return null;
  const challenge = CHALLENGE_BOT_PATTERN.exec(raw);
  if (challenge) {
    const groupId = challenge[1];
    const encoded = challenge[2];
    if (!groupId || !encoded) return null;
    const botId = Number.parseInt(encoded, 36);
    // Only the canonical form decodes: no leading zeros, no zero, nothing past safe integers.
    if (!Number.isSafeInteger(botId) || botId < 1 || botId.toString(36) !== encoded) return null;
    return { kind: 'challengeBot', groupId, botId };
  }
  const match = START_PARAM_PATTERN.exec(raw);
  if (!match) return null;
  const prefix = match[1];
  const id = match[2];
  if (!prefix || !id) return null;
  if (prefix === 'g') return { kind: 'game', gameId: id };
  if (prefix === 'l') return { kind: 'lobby', groupId: id };
  if (prefix === 'n') return { kind: 'newGame', groupId: id };
  if (prefix === 'b') return { kind: 'bots', groupId: id };
  return { kind: 'settings', groupId: id };
}
