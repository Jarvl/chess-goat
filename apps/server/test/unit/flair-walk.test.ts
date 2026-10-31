import { flairById, INITIAL_FEN, type FlairEntry, type PlayerResult } from '@chess-goat/shared';
import { describe, expect, it, vi } from 'vitest';
import type { StoredMove } from '../../src/flair/patterns';
import type { CountedGame } from '../../src/flair/rules';
import { earliestQualifying } from '../../src/flair/walk';
import { countedGame, LINES, play } from '../helpers/chess';

const flair = (...ids: string[]): FlairEntry[] => ids.map((id) => flairById(id)!);
/** A history of `results`, ids from 1 in order. */
const games = (...results: PlayerResult[]): CountedGame[] =>
  results.map((result, i) => countedGame(i + 1, result));
/** A `movesOf` that finds no moves, so every pattern is absent, and records which games it read. */
const movesSpy = () => vi.fn<(gameId: number) => Promise<readonly StoredMove[]>>(async () => []);
const noMoves = movesSpy();
const found = (map: Map<string, CountedGame>) =>
  Object.fromEntries([...map].map(([id, g]) => [id, g.id]));

describe('earliestQualifying', () => {
  it('credits each flair to the first game its rule holds at', async () => {
    const history = games('win', 'win', 'win', 'win', 'win', 'win');
    expect(found(await earliestQualifying(history, flair('win_streak_5'), noMoves))).toEqual({
      win_streak_5: 5,
    });
  });

  it('evaluates every game against the history up to it only', async () => {
    const history = games(...Array<PlayerResult>(12).fill('draw'));
    expect(found(await earliestQualifying(history, flair('draws_10'), noMoves))).toEqual({
      draws_10: 10,
    });
  });

  it('leaves out a flair whose rule never holds', async () => {
    const history = games('win', 'win');
    expect(found(await earliestQualifying(history, flair('scholars_mate_loss'), noMoves))).toEqual(
      {},
    );
  });

  it('reads moves only where a won or lost candidate could hold', async () => {
    const history = games('win', 'draw', 'loss', 'win');
    const movesOf = movesSpy();
    await earliestQualifying(history, flair('en_passant_win', 'draws_10'), movesOf);
    expect(movesOf.mock.calls.map(([id]) => id)).toEqual([1, 4]);

    const none = movesSpy();
    await earliestQualifying(history, flair('draws_10'), none);
    expect(none).not.toHaveBeenCalled();
  });

  it('reads moves at every game for a made candidate, and at a win for a quick mate', async () => {
    const history = games('win', 'draw', 'loss');
    const made = movesSpy();
    await earliestQualifying(history, flair('promotion_win'), made);
    expect(made.mock.calls.map(([id]) => id)).toEqual([1, 2, 3]);

    const quick = movesSpy();
    await earliestQualifying(history, flair('quick_mate'), quick);
    expect(quick.mock.calls.map(([id]) => id)).toEqual([1]);
  });

  it('reads no moves for ended and against candidates', async () => {
    const movesOf = movesSpy();
    await earliestQualifying(games('win', 'loss', 'draw'), flair('resigned', 'rival_5'), movesOf);
    expect(movesOf).not.toHaveBeenCalled();
  });

  it('reads a game’s moves once however many candidates need them', async () => {
    const movesOf = movesSpy();
    await earliestQualifying(
      games('win'),
      flair('en_passant_win', 'queenside_castle_win'),
      movesOf,
    );
    expect(movesOf).toHaveBeenCalledTimes(1);
  });

  it('stops once every candidate is found', async () => {
    const enPassant = play(INITIAL_FEN, ...LINES.enPassant);
    const movesOf = vi.fn(async (id: number) => (id === 1 ? enPassant : []));
    const result = await earliestQualifying(
      games('win', 'win', 'win'),
      flair('en_passant_win'),
      movesOf,
    );
    expect(found(result)).toEqual({ en_passant_win: 1 });
    expect(movesOf.mock.calls.map(([id]) => id)).toEqual([1]);
  });

  it('scores each game from the side the player had in it', async () => {
    // Black was mated in game 2, so the player, as Black, earns 🪤 there.
    const mated = play(INITIAL_FEN, ...LINES.scholarsMateQh5);
    const history = [countedGame(1, 'loss'), countedGame(2, 'loss', { side: 'black' })];
    const movesOf = async (id: number) => (id === 2 ? mated : []);
    expect(found(await earliestQualifying(history, flair('scholars_mate_loss'), movesOf))).toEqual({
      scholars_mate_loss: 2,
    });
  });
});
