import {
  encodePremoveTree,
  INITIAL_FEN,
  type GameDto,
  type MoveDto,
  type PremoveNode,
} from '@chess-goat/shared';

export const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
export const AFTER_E4_E5 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2';
/** 1. f3 e5 2. g4 Qh4#: the fool's mate, four plies. */
export const FOOLS_MATE: MoveDto[] = [
  {
    ply: 1,
    uci: 'f2f3',
    san: 'f3',
    fenAfter: 'rnbqkbnr/pppppppp/8/8/8/5P2/PPPPP1PP/RNBQKBNR b KQkq - 0 1',
    playedAt: '2026-09-20T10:00:00.000Z',
  },
  {
    ply: 2,
    uci: 'e7e5',
    san: 'e5',
    fenAfter: 'rnbqkbnr/pppp1ppp/8/4p3/8/5P2/PPPPP1PP/RNBQKBNR w KQkq e6 0 2',
    playedAt: '2026-09-20T10:01:00.000Z',
  },
  {
    ply: 3,
    uci: 'g2g4',
    san: 'g4',
    fenAfter: 'rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq g3 0 2',
    playedAt: '2026-09-20T10:02:00.000Z',
  },
  {
    ply: 4,
    uci: 'd8h4',
    san: 'Qh4#',
    fenAfter: 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3',
    playedAt: '2026-09-20T10:03:00.000Z',
  },
];

const player = (id: string, name: string) => ({
  id,
  name,
  username: null,
  rating: 1500,
  provisional: true,
  isBot: false,
  photoUrl: null,
  flair: [],
  ratingAfter: null,
  provisionalAfter: null,
});

export function gameDto(overrides: Partial<GameDto> = {}): GameDto {
  return {
    id: 'AbCdEfGhIj',
    group: { id: 'GrOuPiDxYz', title: 'Chess Club' },
    status: 'active',
    white: player('1', 'Alice'),
    black: player('2', 'Bob'),
    timePerMove: 86400,
    rated: true,
    fen: INITIAL_FEN,
    plyCount: 0,
    version: 0,
    moves: [],
    deadlineAt: '2026-09-21T10:00:00.000Z',
    serverTime: '2026-09-20T10:00:00.000Z',
    drawOffer: null,
    claims: { threefold: false, fiftyMove: false },
    viewerRole: 'white',
    result: null,
    endReason: null,
    voided: false,
    startedAt: '2026-09-20T10:00:00.000Z',
    finishedAt: null,
    engineLevel: null,
    premoveTree: '',
    ...overrides,
  };
}

/** A game after the given number of fool's-mate plies, consistent fen, plyCount and version. */
export function afterPlies(plies: number, overrides: Partial<GameDto> = {}): GameDto {
  const moves = FOOLS_MATE.slice(0, plies);
  const last = moves.at(-1);
  return gameDto({
    moves,
    plyCount: plies,
    version: plies,
    fen: last ? last.fenAfter : INITIAL_FEN,
    ...overrides,
  });
}

/** A premove pair for fixtures: if the opponent plays `move`, the owner answers `reply`. */
export function pair(move: string, reply: string, ...children: PremoveNode[]): PremoveNode {
  return { move, reply, children };
}

/** The wire form of a premove tree, for a `premoveTree` override. */
export function treeText(...nodes: PremoveNode[]): string {
  return encodePremoveTree(nodes);
}
