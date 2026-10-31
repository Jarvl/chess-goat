#!/usr/bin/env node
// Fails the image build when the packaged Stockfish is missing, netless or unparseable by our
// adapter. Asserts only that a legal move comes back — never a specific move, an evaluation, a
// mate score or a strength claim, because those are Stockfish's behaviour, not ours, and they
// change between versions (spec §11). Legality is judged by this project's own arbiter, the same
// one that governs real games, not by asserting anything about the engine's choice.
// Imported by relative path, not the `@chess-goat/shared` package name: this script lives in
// `scripts/`, outside every workspace package, so the bare specifier has nothing to resolve
// against. `apps/server/src/engine/uci.ts` is imported the same way, but it is a real workspace
// module and resolves its own `@chess-goat/shared` and `chess.js` imports normally once loaded.
import { applyMove, positionKey } from '../packages/shared/src/index.ts';
import { uciEngine } from '../apps/server/src/engine/uci.ts';

const FEN = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
const engine = uciEngine({
  ENGINE_PATH: process.env.ENGINE_PATH ?? 'stockfish',
  ENGINE_MOVETIME_MS: 200,
});

const probed = await engine.probe();
if (!probed.available) {
  console.error('stockfish did not complete the uci handshake');
  process.exit(1);
}

const reply = await engine.bestMove(FEN, 'club', 10_000);
if (!('uci' in reply)) {
  console.error('stockfish returned no move for a position with legal moves');
  process.exit(1);
}

const result = applyMove(FEN, [positionKey(FEN)], reply.uci);
if (!result.legal) {
  console.error(`stockfish move ${reply.uci} is not legal in the test position`);
  process.exit(1);
}

console.log(`engine ok: ${probed.version ?? 'unknown version'}, replied ${reply.uci}`);
