import { Chess } from 'chess.js';

const LEGAL_MOVES_SHOWN = 30;
const UCI = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/;

export type ResolvedMove = { uci: string } | { uci: null; legal: string };

/**
 * `move`, as SAN (`Nf3`, `O-O`, `e8=Q`) or UCI (`g1f3`, `e7e8q`), on `fen`: its UCI when legal
 * there, or else the legal moves (up to 30, as `SAN (uci)`) to choose from.
 */
export function resolveMove(fen: string, move: string): ResolvedMove {
  const chess = new Chess(fen);
  const uci = UCI.exec(move.trim());
  try {
    const played = uci
      ? chess.move({ from: uci[1]!, to: uci[2]!, promotion: uci[3] })
      : chess.move(move.trim());
    return { uci: `${played.from}${played.to}${played.promotion ?? ''}` };
  } catch {
    const legal = new Chess(fen)
      .moves({ verbose: true })
      .slice(0, LEGAL_MOVES_SHOWN)
      .map((m) => `${m.san} (${m.from}${m.to}${m.promotion ?? ''})`)
      .join(', ');
    return { uci: null, legal };
  }
}
