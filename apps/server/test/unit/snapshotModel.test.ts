import { describe, expect, it } from 'vitest';
import { buildSnapshotModel, shareMoveNumber } from '../../src/images/snapshotModel';
import { FIXTURE_JPEG } from '../helpers/photos';
import { AFTER_E4, snapshotInput } from '../helpers/snapshotFixtures';

/** White is missing a knight and a pawn; Black is missing its queen. */
const WHITE_AHEAD = 'rnb1kbnr/pppppppp/8/8/8/8/PPPPPPP1/RNBQKB1R w KQkq - 0 1';

/** The final position of a finished game, ended however a test says. */
const finished = (overrides: Parameters<typeof snapshotInput>[0] = {}) =>
  snapshotInput({ status: 'finished', result: '1-0', ply: 40, plyCount: 40, ...overrides });

const rated = (before: number, after: number, rdAfter = 50) => ({ before, after, rdAfter });

describe('shareMoveNumber', () => {
  it('counts the initial position as move 1 and rounds half-moves up', () => {
    expect([0, 1, 2, 3, 59, 60].map(shareMoveNumber)).toEqual([1, 1, 1, 2, 30, 30]);
  });
});

describe('buildSnapshotModel', () => {
  it('puts the side at the bottom of the board in the bottom bar', () => {
    const fromWhite = buildSnapshotModel(snapshotInput());
    expect([fromWhite.top.name, fromWhite.bottom.name]).toEqual(['@mayachess', '@sam_k']);
    expect([fromWhite.top.colour, fromWhite.bottom.colour]).toEqual(['black', 'white']);
    const fromBlack = buildSnapshotModel(
      snapshotInput({ board: { ...snapshotInput().board, orientation: 'black' } }),
    );
    expect([fromBlack.top.name, fromBlack.bottom.name]).toEqual(['@sam_k', '@mayachess']);
  });

  it('gives a person their Telegram-coloured initial and the bot the goat mark', () => {
    const model = buildSnapshotModel(
      snapshotInput({
        black: { ...snapshotInput().black, id: '13' },
        white: {
          ...snapshotInput().white,
          name: 'Chess Goat',
          kind: 'engine',
          engineLevel: 'strong',
        },
      }),
    );
    expect(model.top.avatar).toEqual({
      kind: 'person',
      initial: 'M',
      colour: '#ee7aae',
      photo: null,
    });
    expect(model.bottom.avatar).toEqual({ kind: 'bot' });
  });

  it("lays a person's stored Telegram photo over their initial, never the bot's", () => {
    const model = buildSnapshotModel(
      snapshotInput({
        black: { ...snapshotInput().black, photo: FIXTURE_JPEG },
        white: {
          ...snapshotInput().white,
          name: 'Chess Goat',
          kind: 'engine',
          engineLevel: 'strong',
          photo: FIXTURE_JPEG,
        },
      }),
    );
    expect(model.top.avatar).toMatchObject({
      kind: 'person',
      initial: 'M',
      photo: `data:image/jpeg;base64,${FIXTURE_JPEG.toString('base64')}`,
    });
    expect(model.bottom.avatar).toEqual({ kind: 'bot' });
  });

  it("keeps a person's worn flair in slot order, skipping ids the catalog does not know", () => {
    const model = buildSnapshotModel(
      snapshotInput({
        white: { ...snapshotInput().white, flair: ['win_streak_5', 'retired_flair', 'rank_1500'] },
      }),
    );
    expect(model.bottom.flair).toEqual(['win_streak_5', 'rank_1500']);
    expect(model.top.flair).toEqual([]);
  });

  it('gives the bot no flair', () => {
    const model = buildSnapshotModel(
      snapshotInput({
        white: {
          ...snapshotInput().white,
          name: 'Chess Goat',
          kind: 'engine',
          engineLevel: 'strong',
          flair: ['rank_1800'],
        },
      }),
    );
    expect(model.bottom.flair).toEqual([]);
  });

  it('marks a provisional rating, leaves out a missing one, and shows a bot its level', () => {
    const model = buildSnapshotModel(
      snapshotInput({
        white: { ...snapshotInput().white, rating: { rating: 1500, rd: 300 } },
        black: { ...snapshotInput().black, rating: null },
      }),
    );
    expect([model.top.rating, model.bottom.rating]).toEqual([null, '1500?']);
    const bot = buildSnapshotModel(
      snapshotInput({
        black: {
          ...snapshotInput().black,
          name: 'Chess Goat',
          kind: 'engine',
          rating: { rating: 1500, rd: 350 },
          engineLevel: 'strong',
        },
      }),
    );
    expect(bot.top.rating).toBe('Strong');
  });

  it('lists the pieces each side took, biggest first, and the lead of the side ahead', () => {
    const model = buildSnapshotModel(
      snapshotInput({ board: { ...snapshotInput().board, fen: WHITE_AHEAD } }),
    );
    expect(model.bottom).toMatchObject({ colour: 'white', captured: ['bQ'], lead: '+5' });
    expect(model.top).toMatchObject({ colour: 'black', captured: ['wN', 'wP'], lead: null });
  });

  it('has nothing taken and no lead at the start', () => {
    const model = buildSnapshotModel(snapshotInput());
    expect(model.top).toMatchObject({ captured: [], lead: null });
    expect(model.bottom).toMatchObject({ captured: [], lead: null });
  });

  it('names the bot account in the footer', () => {
    expect(buildSnapshotModel(snapshotInput({ botUsername: 'ChessGoatStagingBot' })).handle).toBe(
      '@ChessGoatStagingBot',
    );
  });

  describe('result', () => {
    const results = (input: Parameters<typeof snapshotInput>[0]) => {
      const model = buildSnapshotModel(snapshotInput(input));
      const byColour = { [model.top.colour]: model.top, [model.bottom.colour]: model.bottom };
      return { white: byColour.white?.result ?? null, black: byColour.black?.result ?? null };
    };

    it('tags the winner and the loser of a finished game', () => {
      expect(results(finished({ result: '1-0' }))).toEqual({
        white: { outcome: 'won', label: 'Won' },
        black: { outcome: 'lost', label: 'Lost' },
      });
      expect(results(finished({ result: '0-1' }))).toEqual({
        white: { outcome: 'lost', label: 'Lost' },
        black: { outcome: 'won', label: 'Won' },
      });
    });

    it('tags both sides of a draw', () => {
      expect(results(finished({ result: '1/2-1/2' }))).toEqual({
        white: { outcome: 'draw', label: 'Draw' },
        black: { outcome: 'draw', label: 'Draw' },
      });
    });

    it('is left out while the game is running', () => {
      expect(results({})).toEqual({ white: null, black: null });
    });

    it('is left out for an earlier position of a finished game', () => {
      expect(
        results(
          finished({
            ply: 1,
            board: { fen: AFTER_E4, lastMove: 'e2e4', check: false, orientation: 'white' },
          }),
        ),
      ).toEqual({ white: null, black: null });
    });

    it('is left out for an aborted game', () => {
      expect(results(finished({ result: '*' }))).toEqual({ white: null, black: null });
      expect(results(finished({ result: null }))).toEqual({ white: null, black: null });
    });

    it('is left out for a game an admin voided after it finished', () => {
      expect(results(finished({ result: '1-0', voided: true }))).toEqual({
        white: null,
        black: null,
      });
    });
  });

  describe('rating change', () => {
    const ratedFinal = (overrides: Parameters<typeof snapshotInput>[0] = {}) =>
      finished({
        white: { ...snapshotInput().white, ratingChange: rated(1512, 1528) },
        black: { ...snapshotInput().black, ratingChange: rated(1587, 1571) },
        ...overrides,
      });

    it("shows each side's new rating and what the game changed it by", () => {
      const model = buildSnapshotModel(ratedFinal());
      expect(model.bottom).toMatchObject({
        rating: '1528',
        ratingDelta: { label: '+16', gain: true },
      });
      expect(model.top).toMatchObject({
        rating: '1571',
        ratingDelta: { label: '−16', gain: false },
      });
    });

    it('counts the change between the ratings as shown, not the unrounded ones', () => {
      const model = buildSnapshotModel(
        ratedFinal({
          white: { ...snapshotInput().white, ratingChange: rated(1512.4, 1527.6) },
        }),
      );
      expect(model.bottom).toMatchObject({ rating: '1528', ratingDelta: { label: '+16' } });
    });

    it('keeps the provisional mark on the new rating', () => {
      const model = buildSnapshotModel(
        ratedFinal({
          white: { ...snapshotInput().white, ratingChange: rated(1500, 1662, 250) },
        }),
      );
      expect(model.bottom).toMatchObject({ rating: '1662?', ratingDelta: { label: '+162' } });
    });

    it('shows no change when the rating did not move', () => {
      const model = buildSnapshotModel(
        ratedFinal({
          white: { ...snapshotInput().white, ratingChange: rated(1512.2, 1511.8) },
        }),
      );
      expect(model.bottom).toMatchObject({ rating: '1512', ratingDelta: null });
    });

    it('shows the current rating for an earlier position of the game', () => {
      const model = buildSnapshotModel(
        ratedFinal({
          ply: 1,
          board: { fen: AFTER_E4, lastMove: 'e2e4', check: false, orientation: 'white' },
        }),
      );
      expect(model.bottom).toMatchObject({ rating: '1512', ratingDelta: null });
    });

    it('shows the current rating once an admin voided the game', () => {
      const model = buildSnapshotModel(ratedFinal({ voided: true }));
      expect(model.bottom).toMatchObject({ rating: '1512', ratingDelta: null });
    });
  });
});
