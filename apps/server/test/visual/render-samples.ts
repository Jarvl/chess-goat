// Snapshot spec §6 "By eye": writes sample cards to compare with the Claude Design prototype.
// Usage: pnpm --filter @chess-goat/server exec tsx test/visual/render-samples.ts <out-dir>
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Chess } from 'chess.js';
import type { BoardRenderInput } from '../../src/images/board';
import { loadFonts } from '../../src/images/fonts';
import { renderSnapshotPng, renderSnapshotSvg } from '../../src/images/snapshot';
import {
  buildSnapshotModel,
  type SnapshotInput,
  type SnapshotSide,
} from '../../src/images/snapshotModel';
import { FIXTURE_JPEG } from '../helpers/photos';
import { snapshotInput } from '../helpers/snapshotFixtures';

/** Kasparov–Topalov, Wijk aan Zee 1999, through 30…Qc4 (the design's long-game example). */
const KASPAROV_TOPALOV =
  'e4 d6 d4 Nf6 Nc3 g6 Be3 Bg7 Qd2 c6 f3 b5 Nge2 Nbd7 Bh6 Bxh6 Qxh6 Bb7 a3 e5 O-O-O Qe7 Kb1 a6 Nc1 O-O-O Nb3 exd4 Rxd4 c5 Rd1 Nb6 g3 Kb8 Na5 Ba8 Bh3 d5 Qf4+ Ka7 Rhe1 d4 Nd5 Nbxd5 exd5 Qd6 Rxd4 cxd4 Re7+ Kb6 Qxd4+ Kxa5 b4+ Ka4 Qc3 Qxd5 Ra7 Bb7 Rxb7 Qc4'.split(
    ' ',
  );

/** The quickest mate: Black's queen mates the white king on e1. */
const FOOLS_MATE = ['f3', 'e5', 'g4', 'Qh4#'];

/** The position after playing `sans` from the start, as the share job would build it. */
function replay(sans: string[], orientation: 'white' | 'black' = 'white'): BoardRenderInput {
  const chess = new Chess();
  for (const san of sans) chess.move(san);
  const last = chess.history({ verbose: true }).at(-1);
  return {
    fen: chess.fen(),
    lastMove: last ? `${last.from}${last.to}` : null,
    check: chess.inCheck(),
    orientation,
  };
}

const base = snapshotInput();
const side = (colour: 'white' | 'black', overrides: Partial<SnapshotSide>): SnapshotSide => ({
  ...base[colour],
  ...overrides,
});
const finishedAt = (sans: string[], orientation: 'white' | 'black' = 'white') => ({
  ply: sans.length,
  plyCount: sans.length,
  board: replay(sans, orientation),
  status: 'finished' as const,
});

const samples: Record<string, Partial<SnapshotInput>> = {
  opening: {
    ply: 1,
    plyCount: 1,
    board: replay(['e4']),
  },
  // The design's in-progress mockup (5c): material off balance, the lead on one side.
  'long-game': {
    ply: 60,
    plyCount: 60,
    board: replay(KASPAROV_TOPALOV),
  },
  // The design's finished mockup (5e): tags, king badges and the rating change.
  finished: {
    ...finishedAt(KASPAROV_TOPALOV),
    result: '1-0',
    white: side('white', { ratingChange: { before: 1512, after: 1528, rdAfter: 50 } }),
    black: side('black', { ratingChange: { before: 1587, after: 1571, rdAfter: 50 } }),
  },
  'checkmate-black-wins': {
    ...finishedAt(FOOLS_MATE, 'black'),
    result: '0-1',
    white: side('white', { ratingChange: { before: 1500, after: 1440, rdAfter: 280 } }),
    black: side('black', { ratingChange: { before: 1587, after: 1593, rdAfter: 50 } }),
  },
  'draw-insufficient': {
    ...finishedAt(KASPAROV_TOPALOV),
    result: '1/2-1/2',
  },
  voided: {
    ...finishedAt(KASPAROV_TOPALOV),
    result: '1-0',
    voided: true,
  },
  'cjk-emoji': {
    white: side('white', { id: '11', name: '李小龍', rating: { rating: 1500, rd: 300 } }),
    black: side('black', { id: '12', name: 'さくら 🐐', rating: null }),
  },
  'unbroken-name': {
    ply: 60,
    plyCount: 60,
    board: replay(KASPAROV_TOPALOV),
    black: side('black', { name: 'x'.repeat(60) }),
  },
  'long-winner': {
    ...finishedAt(KASPAROV_TOPALOV),
    result: '1-0',
    white: side('white', {
      name: '@gregory_pyle_the_great_and_terrible',
      ratingChange: { before: 1512, after: 1528, rdAfter: 50 },
    }),
  },
  'black-bot': {
    board: replay(['e4'], 'black'),
    ply: 1,
    plyCount: 1,
    white: side('white', { name: 'Chess Goat', isBot: true, rating: null, engineLevel: 'club' }),
  },
  // Flair spec §5.1: worn flair after the name; with a long name, the name is cut short first.
  flair: {
    ...finishedAt(KASPAROV_TOPALOV),
    result: '1-0',
    white: side('white', {
      name: '@gregory_pyle_the_great_and_terrible',
      flair: ['rank_1200', 'win_streak_5', 'promotion_win'],
      ratingChange: { before: 1512, after: 1528, rdAfter: 50 },
    }),
    black: side('black', {
      flair: ['scholars_mate_loss'],
      ratingChange: { before: 1587, after: 1571, rdAfter: 50 },
    }),
  },
  // Profile photos spec: a stored Telegram photo covers the initial; the other side has none.
  photo: {
    board: replay(['e4', 'e5']),
    ply: 2,
    plyCount: 2,
    black: side('black', { photo: FIXTURE_JPEG }),
  },
};

const out = process.argv[2];
if (!out) throw new Error('usage: render-samples.ts <out-dir>');
await mkdir(out, { recursive: true });
const fonts = await loadFonts();
for (const [name, overrides] of Object.entries(samples)) {
  const svg = await renderSnapshotSvg(buildSnapshotModel(snapshotInput(overrides)), fonts);
  await writeFile(join(out, `${name}.png`), renderSnapshotPng(svg));
  console.log(join(out, `${name}.png`));
}
