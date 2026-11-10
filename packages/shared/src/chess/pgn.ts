import type { EndReason, GameResult, TimePerMove } from '../protocol/enums';

export type PgnHeaderInput = {
  event?: string;
  /** The group title. */
  site: string;
  /** Game start, rendered in UTC. */
  date: Date;
  white: string;
  black: string;
  result: GameResult;
  /** Ratings before the game; omit or null for casual games. */
  whiteElo?: number | null;
  blackElo?: number | null;
  timePerMove: TimePerMove;
  endReason: EndReason | null;
};

/** PGN standard `Termination` values, capitalised the way Lichess exports them. */
const TERMINATION: Readonly<Record<EndReason, string>> = {
  checkmate: 'Normal',
  stalemate: 'Normal',
  insufficient_material: 'Normal',
  fivefold_repetition: 'Normal',
  seventy_five_moves: 'Normal',
  threefold_claim: 'Normal',
  fifty_move_claim: 'Normal',
  draw_agreement: 'Normal',
  resignation: 'Normal',
  timeout: 'Time forfeit',
  timeout_abort: 'Abandoned',
  abort: 'Abandoned',
  voided: 'Adjudication',
};

const MAX_LINE = 80;

export const LICHESS_ANALYSIS_BASE = 'https://lichess.org/analysis/pgn/';

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

export function formatPgnDate(date: Date): string {
  return `${date.getUTCFullYear()}.${pad2(date.getUTCMonth() + 1)}.${pad2(date.getUTCDate())}`;
}

function tagValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function wrap(tokens: readonly string[]): string {
  const lines: string[] = [];
  let current = '';
  for (const token of tokens) {
    if (current.length === 0) {
      current = token;
    } else if (current.length + 1 + token.length > MAX_LINE) {
      lines.push(current);
      current = token;
    } else {
      current = `${current} ${token}`;
    }
  }
  lines.push(current);
  return lines.join('\n');
}

export function buildPgn(headers: PgnHeaderInput, sanMoves: readonly string[]): string {
  const tags: Array<[string, string]> = [
    ['Event', headers.event ?? 'Chess Goat'],
    ['Site', headers.site],
    ['Date', formatPgnDate(headers.date)],
    ['Round', '-'],
    ['White', headers.white],
    ['Black', headers.black],
    ['Result', headers.result],
  ];
  if (headers.whiteElo != null) tags.push(['WhiteElo', String(Math.round(headers.whiteElo))]);
  if (headers.blackElo != null) tags.push(['BlackElo', String(Math.round(headers.blackElo))]);
  tags.push(['TimeControl', '-']);
  tags.push(['TimePerMove', headers.timePerMove === null ? '-' : String(headers.timePerMove)]);
  tags.push(['Termination', headers.endReason ? TERMINATION[headers.endReason] : 'Unterminated']);

  const tagSection = tags.map(([name, value]) => `[${name} "${tagValue(value)}"]`).join('\n');
  const tokens: string[] = [];
  sanMoves.forEach((san, index) => {
    if (index % 2 === 0) tokens.push(`${index / 2 + 1}.`);
    tokens.push(san);
  });
  tokens.push(headers.result);
  return `${tagSection}\n\n${wrap(tokens)}\n`;
}

/** Lichess's analysis board pre-loaded with the whole game, no account needed. */
export function analysisUrl(sanMoves: readonly string[]): string {
  return LICHESS_ANALYSIS_BASE + sanMoves.map((san) => encodeURIComponent(san)).join('_');
}
