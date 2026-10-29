import { describe, expect, it } from 'vitest';
import {
  GROUP_SETTINGS_DEFAULTS,
  GameDtoSchema,
  GameSummarySchema,
  GroupSettingsSchema,
  LaunchRouteSchema,
  LeaderboardEntrySchema,
  PREFS_DEFAULTS,
  PlayerRefSchema,
  PrefsSchema,
  TipInvoiceDtoSchema,
} from '../../src/protocol/dto';

const activeGame = {
  id: 'aZ09bY18cX',
  group: { id: 'grp0000001', title: 'Chess Club' },
  status: 'active',
  white: {
    id: '1',
    name: 'Alice',
    username: 'alice',
    rating: 1520,
    provisional: false,
    isBot: false,
    photoUrl: null,
    flair: [],
    ratingAfter: null,
    provisionalAfter: null,
  },
  black: {
    id: '2',
    name: 'Bob',
    username: null,
    rating: 1498,
    provisional: true,
    isBot: false,
    photoUrl: null,
    flair: [],
    ratingAfter: null,
    provisionalAfter: null,
  },
  timePerMove: 86400,
  rated: true,
  fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
  plyCount: 1,
  version: 1,
  moves: [
    {
      ply: 1,
      uci: 'e2e4',
      san: 'e4',
      fenAfter: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
      playedAt: '2026-09-20T10:00:00.000Z',
    },
  ],
  deadlineAt: '2026-09-21T10:00:00.000Z',
  serverTime: '2026-09-20T10:00:05.000Z',
  drawOffer: null,
  claims: { threefold: false, fiftyMove: false },
  viewerRole: 'black',
  result: null,
  endReason: null,
  voided: false,
  startedAt: '2026-09-20T09:00:00.000Z',
  finishedAt: null,
  engineLevel: null,
  premoves: [],
  premoveTree: '',
};

describe('GameDtoSchema', () => {
  it('parses an active game without changing it', () => {
    expect(GameDtoSchema.parse(activeGame)).toEqual(activeGame);
  });

  it('parses a finished game carrying Lichess links', () => {
    const finished = {
      ...activeGame,
      status: 'finished',
      result: '1-0',
      endReason: 'resignation',
      finishedAt: '2026-09-20T12:00:00.000Z',
      white: { ...activeGame.white, ratingAfter: 1534, provisionalAfter: false },
      black: { ...activeGame.black, ratingAfter: 1484, provisionalAfter: true },
      lichessUrl: 'https://lichess.org/abcdefgh',
      analysisUrl: 'https://lichess.org/analysis/pgn/e4',
    };
    expect(GameDtoSchema.safeParse(finished).success).toBe(true);
  });

  it('rejects a negative version', () => {
    expect(GameDtoSchema.safeParse({ ...activeGame, version: -1 }).success).toBe(false);
  });

  it('rejects a move with a malformed UCI string', () => {
    const moves = [{ ...activeGame.moves[0], uci: 'e2e9' }];
    expect(GameDtoSchema.safeParse({ ...activeGame, moves }).success).toBe(false);
  });

  it('rejects a server time that is not ISO-8601', () => {
    expect(GameDtoSchema.safeParse({ ...activeGame, serverTime: 'yesterday' }).success).toBe(false);
  });
});

describe('LaunchRouteSchema', () => {
  it('parses a locked route', () => {
    const route = { kind: 'locked', group: { id: 'grp0000001', title: 'Chess Club' } };
    expect(LaunchRouteSchema.parse(route)).toEqual(route);
  });

  it('rejects an unknown kind', () => {
    expect(LaunchRouteSchema.safeParse({ kind: 'admin' }).success).toBe(false);
  });
});

describe('GroupSettingsSchema', () => {
  it('accepts the defaults', () => {
    expect(GroupSettingsSchema.parse(GROUP_SETTINGS_DEFAULTS)).toEqual({
      defaultTimePerMove: 259200,
      ratedDefault: true,
      allowOpenChallenges: true,
      cardTopicMode: 'origin',
      fixedTopicId: null,
    });
  });

  it.each([0, -1])('rejects %d as a fixed topic id', (value) => {
    expect(
      GroupSettingsSchema.safeParse({ ...GROUP_SETTINGS_DEFAULTS, fixedTopicId: value }).success,
    ).toBe(false);
  });
});

describe('LeaderboardEntrySchema', () => {
  it('rejects a negative win count', () => {
    const entry = {
      id: '1',
      name: 'Alice',
      username: null,
      rating: 1500,
      provisional: true,
      isBot: false,
      photoUrl: null,
      gamesPlayed: 0,
      record: { wins: -1, draws: 0, losses: 0 },
    };
    expect(LeaderboardEntrySchema.safeParse(entry).success).toBe(false);
  });
});

const summary = {
  id: 'aZ09bY18cX',
  white: {
    id: '1',
    name: 'Alice',
    username: 'alice',
    rating: 1520,
    provisional: false,
    isBot: false,
    photoUrl: null,
    flair: [],
  },
  black: {
    id: '2',
    name: 'Stockfish',
    username: null,
    rating: 1500,
    provisional: true,
    isBot: true,
    photoUrl: null,
    flair: [],
  },
  status: 'active',
  timePerMove: null,
  rated: false,
  plyCount: 1,
  sideToMove: 'black',
  yourTurn: false,
  deadlineAt: null,
  lastMoveAt: '2026-09-20T10:00:00.000Z',
  startedAt: '2026-09-20T09:00:00.000Z',
  finishedAt: null,
  result: null,
  endReason: null,
  voided: false,
  fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
  lastMove: 'e2e4',
  engineLevel: 'club',
};

describe('GameSummarySchema', () => {
  it('carries the position, the last move and the bot level for the list thumbnails', () => {
    expect(GameSummarySchema.parse(summary)).toEqual(summary);
  });

  it('allows a game with no moves yet', () => {
    expect(GameSummarySchema.safeParse({ ...summary, lastMove: null }).success).toBe(true);
  });

  it('rejects a malformed last move', () => {
    expect(GameSummarySchema.safeParse({ ...summary, lastMove: 'e2e9' }).success).toBe(false);
  });
});

describe('PlayerRefSchema', () => {
  it('requires the bot flag', () => {
    const withoutFlag: Record<string, unknown> = { ...summary.white };
    delete withoutFlag.isBot;
    expect(PlayerRefSchema.safeParse(withoutFlag).success).toBe(false);
  });

  it('carries a photo url or null, and requires the key', () => {
    const url = `/api/avatars/${'a'.repeat(64)}.jpg`;
    expect(PlayerRefSchema.parse({ ...summary.white, photoUrl: url }).photoUrl).toBe(url);
    expect(PlayerRefSchema.parse({ ...summary.white, photoUrl: null }).photoUrl).toBeNull();
    const withoutPhoto: Record<string, unknown> = { ...summary.white };
    delete withoutPhoto.photoUrl;
    expect(PlayerRefSchema.safeParse(withoutPhoto).success).toBe(false);
  });

  const ref = {
    id: '1',
    name: 'Alice',
    username: null,
    rating: 1500,
    provisional: true,
    isBot: false,
    photoUrl: null,
  };
  it('reads a missing flair list as none', () => {
    expect(PlayerRefSchema.parse(ref).flair).toEqual([]);
  });
  it('refuses more than three worn flair', () => {
    expect(PlayerRefSchema.safeParse({ ...ref, flair: ['a', 'b', 'c', 'd'] }).success).toBe(false);
  });
});

describe('PrefsSchema', () => {
  it('defaults move confirmations to games against people', () => {
    expect(PREFS_DEFAULTS.moveConfirmations).toBe('people');
    expect(PrefsSchema.parse(PREFS_DEFAULTS)).toEqual(PREFS_DEFAULTS);
  });

  it('accepts the three move confirmation settings and nothing else', () => {
    for (const value of ['always', 'people', 'never']) {
      expect(PrefsSchema.safeParse({ ...PREFS_DEFAULTS, moveConfirmations: value }).success).toBe(
        true,
      );
    }
    expect(
      PrefsSchema.safeParse({ ...PREFS_DEFAULTS, moveConfirmations: 'sometimes' }).success,
    ).toBe(false);
  });
});

describe('TipInvoiceDtoSchema', () => {
  it('carries the invoice link', () => {
    expect(TipInvoiceDtoSchema.parse({ url: 'https://t.me/$abc' })).toEqual({
      url: 'https://t.me/$abc',
    });
  });

  it('rejects an empty link', () => {
    expect(TipInvoiceDtoSchema.safeParse({ url: '' }).success).toBe(false);
  });
});

describe('GameDtoSchema premoves', () => {
  it('defaults premoves to an empty list and keeps a sent one', () => {
    expect(GameDtoSchema.parse(activeGame).premoves).toEqual([]);
    expect(GameDtoSchema.parse({ ...activeGame, premoves: ['e7e5', 'e5e4'] }).premoves).toEqual([
      'e7e5',
      'e5e4',
    ]);
    expect(() => GameDtoSchema.parse({ ...activeGame, premoves: ['e9e5'] })).toThrow();
  });
});

describe('GameDtoSchema premoveTree', () => {
  it('defaults the tree to empty text and keeps a sent one', () => {
    const { premoveTree: _omitted, ...withoutTree } = activeGame;
    expect(GameDtoSchema.parse(withoutTree).premoveTree).toBe('');
    expect(GameDtoSchema.parse({ ...activeGame, premoveTree: 'AQwH' }).premoveTree).toBe('AQwH');
    expect(GameDtoSchema.safeParse({ ...activeGame, premoveTree: 'AQ+H' }).success).toBe(false);
  });
});
