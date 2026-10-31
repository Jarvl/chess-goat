import {
  INITIAL_FEN,
  against,
  ended,
  held,
  lost,
  made,
  quickMate,
  streak,
  total,
  won,
  type PlayerResult,
} from '@chess-goat/shared';
import { describe, expect, it } from 'vitest';
import { ruleHolds, type CountedGame, type RuleContext } from '../../src/flair/rules';
import { countedGame, LINES, PROMOTION_FEN, QUEEN_MATE_FEN, play } from '../helpers/chess';

/** Scores the last game of `history`. */
const at = (history: CountedGame[], over: Partial<RuleContext> = {}): RuleContext => ({
  game: history.at(-1)!,
  history,
  moves: [],
  side: 'white',
  ...over,
});
/** Rated wins with these ids, oldest first. */
const ratedWins = (...ids: number[]): CountedGame[] => ids.map((id) => countedGame(id, 'win'));

describe('held', () => {
  it('holds the rung of the displayed rating a rated game left', () => {
    expect(ruleHolds(held(null, 1199), at([countedGame(1, 'loss', { ratingAfter: 1199.4 })]))).toBe(
      true,
    );
    expect(ruleHolds(held(1200, 1299), at([countedGame(1, 'loss', { ratingAfter: 1199.4 })]))).toBe(
      false,
    );
    expect(ruleHolds(held(1200, 1299), at([countedGame(1, 'win', { ratingAfter: 1199.5 })]))).toBe(
      true,
    );
    expect(ruleHolds(held(1800, null), at([countedGame(1, 'win', { ratingAfter: 1800 })]))).toBe(
      true,
    );
    // 1299.5 reads 1300, above the band.
    expect(ruleHolds(held(1200, 1299), at([countedGame(1, 'win', { ratingAfter: 1299.5 })]))).toBe(
      false,
    );
    // A rated game that left no rating holds no rung.
    expect(ruleHolds(held(null, 1199), at([countedGame(1, 'win')]))).toBe(false);
  });
  it('holds no rung after a casual game', () => {
    expect(ruleHolds(held(1500, 1599), at([countedGame(1, 'win', { rated: false })]))).toBe(false);
    // Even one that carries a rating.
    expect(
      ruleHolds(held(1500, 1599), at([countedGame(1, 'win', { rated: false, ratingAfter: 1550 })])),
    ).toBe(false);
  });
});

describe('won and lost', () => {
  it('holds won(pattern) only for a win in which the player made the pattern', () => {
    const moves = play(INITIAL_FEN, ...LINES.enPassant);
    expect(ruleHolds(won('en_passant'), at([countedGame(1, 'win')], { moves }))).toBe(true);
    expect(ruleHolds(won('en_passant'), at([countedGame(1, 'draw')], { moves }))).toBe(false);
    expect(
      ruleHolds(won('en_passant'), at([countedGame(1, 'win')], { moves, side: 'black' })),
    ).toBe(false);
  });
  it('holds lost(pattern) for the player the opponent did it to', () => {
    const moves = play(INITIAL_FEN, ...LINES.scholarsMateQh5);
    expect(
      ruleHolds(lost('scholars_mate'), at([countedGame(1, 'loss')], { moves, side: 'black' })),
    ).toBe(true);
    expect(ruleHolds(lost('scholars_mate'), at([countedGame(1, 'win')], { moves }))).toBe(false);
    // A loss in which the opponent did not mate on f7.
    expect(
      ruleHolds(
        lost('scholars_mate'),
        at([countedGame(1, 'loss')], {
          moves: play(INITIAL_FEN, ...LINES.enPassant),
          side: 'black',
        }),
      ),
    ).toBe(false);
    // The player has to have lost as well: White promoted, but the game was drawn.
    expect(
      ruleHolds(
        lost('promotion'),
        at([countedGame(1, 'draw')], { moves: play(PROMOTION_FEN, 'e7e8q'), side: 'black' }),
      ),
    ).toBe(false);
    // The pattern has to be the opponent's: White promoted and still lost, and Black did not.
    expect(
      ruleHolds(
        lost('promotion'),
        at([countedGame(1, 'loss')], { moves: play(PROMOTION_FEN, 'e7e8q'), side: 'white' }),
      ),
    ).toBe(false);
  });
});

describe('made', () => {
  it('holds made(pattern) whenever the player made the pattern, whatever the result', () => {
    const moves = play(PROMOTION_FEN, 'e7e8q');
    for (const result of ['win', 'draw', 'loss'] as const)
      expect(ruleHolds(made('promotion'), at([countedGame(1, result)], { moves }))).toBe(true);
    // The opponent's promotion is not the player's.
    expect(
      ruleHolds(made('promotion'), at([countedGame(1, 'loss')], { moves, side: 'black' })),
    ).toBe(false);
    expect(
      ruleHolds(
        made('promotion'),
        at([countedGame(1, 'win')], { moves: play(INITIAL_FEN, 'e2e4') }),
      ),
    ).toBe(false);
  });
});

describe('quickMate', () => {
  const mate = play(QUEEN_MATE_FEN, 'a1a8');
  const lasting = (seconds: number, over: Partial<CountedGame> = {}) =>
    countedGame(1, 'win', {
      startedAt: new Date(Date.UTC(2026, 1, 1, 12) - seconds * 1000),
      finishedAt: new Date(Date.UTC(2026, 1, 1, 12)),
      ...over,
    });
  it('holds for a win by mate at most the given seconds after the game started', () => {
    expect(ruleHolds(quickMate(180), at([lasting(180)], { moves: mate }))).toBe(true);
    expect(ruleHolds(quickMate(180), at([lasting(12)], { moves: mate }))).toBe(true);
    expect(ruleHolds(quickMate(180), at([lasting(181)], { moves: mate }))).toBe(false);
  });
  it('holds only for the side that mated, and only by mate', () => {
    expect(
      ruleHolds(
        quickMate(180),
        at([lasting(60, { result: 'loss' })], { moves: mate, side: 'black' }),
      ),
    ).toBe(false);
    // A quick win on resignation or time: the last move is not mate.
    expect(
      ruleHolds(quickMate(180), at([lasting(60)], { moves: play(QUEEN_MATE_FEN, 'a1a7') })),
    ).toBe(false);
  });
});

describe('streak', () => {
  const five = streak('win', 5);
  it('holds at the fifth win in a row and at every win after it', () => {
    const wins = [1, 2, 3, 4, 5, 6].map((id) => countedGame(id, 'win'));
    expect(ruleHolds(five, at(wins.slice(0, 4)))).toBe(false);
    expect(ruleHolds(five, at(wins.slice(0, 5)))).toBe(true);
    expect(ruleHolds(five, at(wins))).toBe(true);
    // An earlier loss does not matter once five wins follow it.
    expect(ruleHolds(five, at([countedGame(1, 'loss'), ...ratedWins(2, 3, 4, 5, 6)]))).toBe(true);
  });
  it('skips casual games, which neither extend nor break the run', () => {
    const history = [
      countedGame(1, 'win'),
      countedGame(2, 'win'),
      countedGame(3, 'loss', { rated: false }),
      countedGame(4, 'win', { rated: false }),
      countedGame(5, 'win'),
      countedGame(6, 'win'),
      countedGame(7, 'win'),
    ];
    expect(ruleHolds(five, at(history))).toBe(true);
    expect(ruleHolds(five, at(history.slice(0, 4)))).toBe(false);
    // A casual game is not itself a qualifying game, whatever rated wins precede it.
    expect(
      ruleHolds(five, at([...ratedWins(1, 2, 3, 4, 5), countedGame(6, 'win', { rated: false })])),
    ).toBe(false);
  });
  it('breaks on a rated draw or loss', () => {
    const history = [
      countedGame(1, 'win'),
      countedGame(2, 'win'),
      countedGame(3, 'draw'),
      countedGame(4, 'win'),
      countedGame(5, 'win'),
      countedGame(6, 'win'),
    ];
    expect(ruleHolds(five, at(history))).toBe(false);
    // Five losses in a row are not a win streak.
    expect(ruleHolds(five, at([1, 2, 3, 4, 5].map((id) => countedGame(id, 'loss'))))).toBe(false);
    // Five old wins do not count once a loss has broken them.
    expect(
      ruleHolds(
        five,
        at([...ratedWins(1, 2, 3, 4, 5), countedGame(6, 'loss'), countedGame(7, 'win')]),
      ),
    ).toBe(false);
  });
  it('runs a losing streak over rated games only, a casual loss neither extending nor breaking it', () => {
    const casual = { rated: false };
    const run = [
      countedGame(1, 'loss'),
      countedGame(2, 'loss', casual),
      countedGame(3, 'loss'),
      countedGame(4, 'win', casual),
    ];
    expect(ruleHolds(streak('loss', 3), at(run.slice(0, 3)))).toBe(false);
    expect(ruleHolds(streak('loss', 3), at([...run, countedGame(5, 'loss')]))).toBe(true);
    // Scored at a casual game, a streak never holds.
    expect(ruleHolds(streak('loss', 2), at(run.slice(0, 2)))).toBe(false);
  });
});

describe('ended', () => {
  it('holds for the result and the reason together', () => {
    const resigned = countedGame(1, 'loss', { endReason: 'resignation' });
    expect(ruleHolds(ended('loss', 'resignation'), at([resigned]))).toBe(true);
    expect(
      ruleHolds(
        ended('loss', 'resignation'),
        at([countedGame(1, 'win', { endReason: 'resignation' })]),
      ),
    ).toBe(false);
    expect(
      ruleHolds(
        ended('loss', 'resignation'),
        at([countedGame(1, 'loss', { endReason: 'timeout' })]),
      ),
    ).toBe(false);
    expect(
      ruleHolds(ended('loss', 'resignation'), at([countedGame(1, 'loss', { endReason: null })])),
    ).toBe(false);
  });

  it('holds for a loss on time, and not for the win on time', () => {
    const flagged = countedGame(1, 'loss', { endReason: 'timeout' });
    expect(ruleHolds(ended('loss', 'timeout'), at([flagged]))).toBe(true);
    expect(
      ruleHolds(ended('loss', 'timeout'), at([countedGame(1, 'win', { endReason: 'timeout' })])),
    ).toBe(false);
  });

  it('holds for a win on time, and not for a win another way', () => {
    const flagged = countedGame(1, 'win', { endReason: 'timeout' });
    expect(ruleHolds(ended('win', 'timeout'), at([flagged]))).toBe(true);
    expect(
      ruleHolds(ended('win', 'timeout'), at([countedGame(1, 'win', { endReason: 'resignation' })])),
    ).toBe(false);
  });
});

describe('against', () => {
  const vs = (id: number, opponentId: number, result: PlayerResult = 'win') =>
    countedGame(id, result, { opponentId, rated: id % 2 === 0 });
  it('counts only games against this game’s opponent, rated or casual', () => {
    const fourVs7 = [vs(1, 7), vs(2, 8), vs(3, 7), vs(4, 7), vs(5, 9), vs(6, 7)];
    expect(ruleHolds(against(5), at(fourVs7))).toBe(false);
    expect(ruleHolds(against(5), at([...fourVs7, vs(7, 7, 'draw')]))).toBe(true);
    // Scored at a game against someone else, the count is theirs.
    expect(ruleHolds(against(5), at([...fourVs7, vs(7, 7), vs(8, 8)]))).toBe(false);
  });
  it('with a result, counts only those games and needs this game to have it', () => {
    const losses = [1, 2, 3, 4].map((id) => vs(id, 7, 'loss'));
    expect(ruleHolds(against(5, 'loss'), at([...losses, vs(5, 7, 'win'), vs(6, 7, 'loss')]))).toBe(
      true,
    );
    expect(ruleHolds(against(5, 'loss'), at([...losses, vs(5, 7, 'loss'), vs(6, 7, 'win')]))).toBe(
      false,
    );
    expect(ruleHolds(against(5, 'loss'), at([...losses, vs(5, 8, 'loss')]))).toBe(false);
  });
});

describe('total', () => {
  const ten = total('draw', 10);
  it('holds from the tenth draw, rated or casual, and only at a draw', () => {
    const draws = Array.from({ length: 11 }, (_, i) =>
      countedGame(i + 1, 'draw', { rated: i % 2 === 0 }),
    );
    expect(ruleHolds(ten, at(draws.slice(0, 9)))).toBe(false);
    expect(ruleHolds(ten, at(draws.slice(0, 10)))).toBe(true);
    expect(ruleHolds(ten, at(draws))).toBe(true);
    expect(ruleHolds(ten, at([...draws, countedGame(12, 'win')]))).toBe(false);
    // Only draws count toward draws.
    expect(
      ruleHolds(ten, at([...ratedWins(1, 2, 3, 4, 5, 6, 7, 8, 9), countedGame(10, 'draw')])),
    ).toBe(false);
  });
  it('counts the draws in a row or not', () => {
    // Twenty games alternating a win and a draw: the last is the tenth draw, and no two draws are
    // next to each other, so a total that counted only a run would never reach ten.
    const alternating = Array.from({ length: 20 }, (_, i) =>
      countedGame(i + 1, i % 2 === 0 ? 'win' : 'draw'),
    );
    expect(ruleHolds(ten, at(alternating))).toBe(true);
  });
  it('counts only rated games when the rule asks', () => {
    const rated = total('draw', 2, { rated: true });
    expect(
      ruleHolds(rated, at([countedGame(1, 'draw', { rated: false }), countedGame(2, 'draw')])),
    ).toBe(false);
    expect(ruleHolds(rated, at([countedGame(1, 'draw'), countedGame(2, 'draw')]))).toBe(true);
    // A casual draw does not qualify for a rated total, however many rated draws precede it.
    expect(
      ruleHolds(
        rated,
        at([
          countedGame(1, 'draw'),
          countedGame(2, 'draw'),
          countedGame(3, 'draw', { rated: false }),
        ]),
      ),
    ).toBe(false);
  });
});
