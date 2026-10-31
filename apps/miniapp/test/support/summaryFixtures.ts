import { INITIAL_FEN, type GameSummary, type PlayerRef } from '@chess-goat/shared';

export function playerRef(id: string, name: string, overrides: Partial<PlayerRef> = {}): PlayerRef {
  return {
    id,
    name,
    username: null,
    rating: 1500,
    provisional: true,
    isBot: false,
    photoUrl: null,
    flair: [],
    ...overrides,
  };
}

/** An active game between Alice (id 1, white, the session user) and Bob (id 2), Alice to move. */
export function gameSummary(overrides: Partial<GameSummary> = {}): GameSummary {
  return {
    id: 'GameAaaaaa',
    white: playerRef('1', 'Alice'),
    black: playerRef('2', 'Bob'),
    status: 'active',
    timePerMove: 86400,
    rated: true,
    plyCount: 0,
    sideToMove: 'white',
    yourTurn: true,
    deadlineAt: null,
    lastMoveAt: null,
    startedAt: '2026-09-20T10:00:00.000Z',
    finishedAt: null,
    result: null,
    endReason: null,
    voided: false,
    fen: INITIAL_FEN,
    lastMove: null,
    engineLevel: null,
    ...overrides,
  };
}
