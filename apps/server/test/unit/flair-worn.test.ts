import { describe, expect, it } from 'vitest';
import { fillFreeSlots } from '../../src/flair/worn';

describe('fillFreeSlots', () => {
  it('puts new flair in the free slots, in catalog order', () =>
    expect(fillFreeSlots(['draws_10'], ['rank_1500', 'en_passant_win'])).toEqual([
      'draws_10',
      'rank_1500',
      'en_passant_win',
    ]));
  it('leaves three worn flair alone', () => {
    const full = ['rank_1500', 'draws_10', 'scholars_mate_loss'];
    expect(fillFreeSlots(full, ['en_passant_win'])).toEqual(full);
  });
  it('picks at random when more flair is new than slots are free', () => {
    const worn = ['rank_1500', 'draws_10'];
    const fresh = ['en_passant_win', 'promotion_win'] as const;
    expect(fillFreeSlots(worn, fresh, () => 0)).toEqual([...worn, 'en_passant_win']);
    expect(fillFreeSlots(worn, fresh, () => 0.99)).toEqual([...worn, 'promotion_win']);
    const many = ['rank_1500', 'en_passant_win', 'win_streak_5', 'promotion_win'] as const;
    expect(fillFreeSlots([], many, () => 0)).toEqual([
      'rank_1500',
      'en_passant_win',
      'win_streak_5',
    ]);
    // The draws are promotion_win, win_streak_5, en_passant_win; they are stored in catalog order
    //.
    expect(fillFreeSlots([], many, () => 0.99)).toEqual([
      'en_passant_win',
      'win_streak_5',
      'promotion_win',
    ]);
  });
  it('frees the slots of flair the catalog no longer has', () =>
    expect(fillFreeSlots(['retired_flair', 'draws_10'], ['rank_1500'])).toEqual([
      'draws_10',
      'rank_1500',
    ]));
});
