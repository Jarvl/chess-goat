import { describe, expect, it } from 'vitest';
import {
  against,
  ended,
  FLAIR,
  FLAIR_CATEGORIES,
  flairById,
  flairCategoryKey,
  flairBackfillVersion,
  flairDescriptionKey,
  streak,
  total,
  won,
  type FlairDefinition,
} from '../../src/flair/catalog';
import { t } from '../../src/i18n';

const codePoints = (emoji: string) =>
  [...emoji].map((c) => c.codePointAt(0)!.toString(16).toUpperCase()).join(' ');
const band = (min: number | null, max: number | null) => ({ kind: 'held', min, max });

/**
 * The 14 flair the catalog launched with (spec §1.2), in display order: category, id and code
 * points. Adding a flair is one catalog entry and one string (spec §1.7), so the tests pin these by
 * id and in their relative order, and never that the catalog holds exactly them.
 */
const LAUNCH: [category: string, id: string, codePoints: string][] = [
  ['rank', 'rank_under_1200', '1F98D'],
  ['rank', 'rank_1200', '1F9D1 200D 1F9BC'],
  ['rank', 'rank_1300', '1F9D1 200D 1F9BD'],
  ['rank', 'rank_1400', '1F9D1 200D 1F9AF'],
  ['rank', 'rank_1500', '1F6B6'],
  ['rank', 'rank_1600', '1F3C3'],
  ['rank', 'rank_1700', '1F5FF'],
  ['rank', 'rank_1800', '1F916'],
  ['feat', 'en_passant_win', '1F451'],
  ['feat', 'win_streak_5', '1F525'],
  ['feat', 'queenside_castle_win', '1F3F0'],
  ['feat', 'promotion_win', '265F FE0F'],
  ['feat', 'draws_10', '1F91D'],
  ['dubious', 'scholars_mate_loss', '1FAA4'],
];
const LAUNCH_IDS = LAUNCH.map(([, id]) => id);

describe('the flair catalog', () => {
  it('holds the prototype’s 14 flair in display order, code point for code point', () => {
    expect(
      LAUNCH_IDS.map((id) => {
        const flair = flairById(id);
        return [flair?.category, id, flair && codePoints(flair.emoji)];
      }),
    ).toEqual(LAUNCH);
    // A flair added later may sit anywhere in its category, but the launch flair keep their order.
    expect(FLAIR.map((f) => f.id).filter((id) => LAUNCH_IDS.includes(id))).toEqual(LAUNCH_IDS);
  });

  it('gives each flair its rule', () => {
    expect(Object.fromEntries(LAUNCH_IDS.map((id) => [id, flairById(id)?.rule]))).toEqual({
      rank_under_1200: band(null, 1199),
      rank_1200: band(1200, 1299),
      rank_1300: band(1300, 1399),
      rank_1400: band(1400, 1499),
      rank_1500: band(1500, 1599),
      rank_1600: band(1600, 1699),
      rank_1700: band(1700, 1799),
      rank_1800: band(1800, null),
      en_passant_win: { kind: 'won', pattern: 'en_passant' },
      win_streak_5: { kind: 'streak', result: 'win', length: 5 },
      queenside_castle_win: { kind: 'won', pattern: 'castle_queenside' },
      // Loosened after launch from a win with a promotion to any promotion.
      promotion_win: { kind: 'made', pattern: 'promotion' },
      draws_10: { kind: 'total', result: 'draw', count: 10, rated: false },
      scholars_mate_loss: { kind: 'lost', pattern: 'scholars_mate' },
    });
  });

  it('holds the second batch in display order, with its rules and descriptions', () => {
    const second: [category: string, id: string, codePoints: string, rule: object, text: string][] =
      [
        ['feat', 'win_streak_3', '1F321 FE0F', streak('win', 3), 'Win three rated games in a row'],
        ['feat', 'win_streak_10', '1F30B', streak('win', 10), 'Win ten rated games in a row'],
        [
          'feat',
          'underpromotion_win',
          '1FAE6',
          { kind: 'won', pattern: 'underpromotion' },
          'Promote a pawn to something other than a queen and win the game',
        ],
        [
          'feat',
          'queen_mate',
          '1F485',
          { kind: 'won', pattern: 'queen_mate' },
          'Checkmate with only a queen left',
        ],
        [
          'feat',
          'bishops_mate',
          '1F5FC',
          { kind: 'won', pattern: 'bishops_mate' },
          'Checkmate with only two bishops left',
        ],
        [
          'feat',
          'flawless_mate',
          '1FAAC',
          { kind: 'won', pattern: 'flawless_mate' },
          'Win by checkmate without losing a piece',
        ],
        [
          'feat',
          'quick_mate',
          '1F3CE FE0F',
          { kind: 'quickMate', seconds: 180 },
          'Win by checkmate within three minutes',
        ],
        [
          'dubious',
          'bongcloud_win',
          '1F4A8',
          { kind: 'won', pattern: 'bongcloud' },
          'Win with the Bongcloud opening',
        ],
      ];
    expect(
      second.map(([, id]) => {
        const flair = flairById(id);
        return (
          flair && [
            flair.category,
            id,
            codePoints(flair.emoji),
            flair.rule,
            t(flairDescriptionKey(flair.id)),
          ]
        );
      }),
    ).toEqual(second);
    // The win streaks read as a ladder around 🔥, and the mates follow the promotions. Later
    // batches may add flair anywhere, so only these two batches' relative order is pinned.
    const known = new Set<string>([...LAUNCH_IDS, ...second.map(([, id]) => id)]);
    const order = (category: string) =>
      FLAIR.filter((f) => f.category === category && known.has(f.id))
        .map((f) => f.emoji)
        .join('');
    expect(order('feat')).toBe('👑🌡️🔥🌋🏰♟️🫦💅🗼🪬🏎️🤝');
    expect(order('dubious')).toBe('🪤💨');
  });

  it('holds the third batch in display order, with its rules and descriptions', () => {
    const third: [category: string, id: string, codePoints: string, rule: object, text: string][] =
      [
        ['feat', 'marathon_win', '1F422', won('marathon'), 'Win a game longer than 100 moves'],
        [
          'feat',
          'pacifist_mate',
          '1F54A FE0F',
          won('pacifist_mate'),
          'Checkmate without making a single capture',
        ],
        ['feat', 'rival_5', '1F46C', against(5), 'Play the same person five times'],
        ['dubious', 'loss_streak_3', '1F476', streak('loss', 3), 'Lose three rated games in a row'],
        ['dubious', 'loss_streak_5', '1F4A9', streak('loss', 5), 'Lose five rated games in a row'],
        [
          'dubious',
          'loss_streak_10',
          '1F5D1 FE0F',
          streak('loss', 10),
          'Lose ten rated games in a row',
        ],
        ['dubious', 'nemesis_5', '1F608', against(5, 'loss'), 'Lose five games to the same person'],
        ['dubious', 'resigned', '1F414', ended('loss', 'resignation'), 'Resign a game'],
      ];
    expect(
      third.map(([, id]) => {
        const flair = flairById(id);
        return (
          flair && [
            flair.category,
            id,
            codePoints(flair.emoji),
            flair.rule,
            t(flairDescriptionKey(flair.id)),
          ]
        );
      }),
    ).toEqual(third);
    // Relative to the earlier flair they follow: later batches may add flair anywhere.
    const placed = new Set([
      'draws_10',
      'scholars_mate_loss',
      'bongcloud_win',
      ...third.map(([, id]) => id),
    ]);
    const ids = (category: string) =>
      FLAIR.filter((f) => f.category === category && placed.has(f.id)).map((f) => f.id);
    expect(ids('feat')).toEqual(['draws_10', 'marathon_win', 'pacifist_mate', 'rival_5']);
    expect(ids('dubious')).toEqual([
      'scholars_mate_loss',
      'bongcloud_win',
      'loss_streak_3',
      'loss_streak_5',
      'loss_streak_10',
      'nemesis_5',
      'resigned',
    ]);
  });

  it('holds 💤 after 🐔, with its rule and description', () => {
    const flair = flairById('timed_out');
    expect(
      flair && [
        flair.category,
        codePoints(flair.emoji),
        flair.rule,
        t(flairDescriptionKey(flair.id)),
      ],
    ).toEqual(['dubious', '1F4A4', ended('loss', 'timeout'), 'Lose a game on time']);
    const ids = FLAIR.filter((f) => f.category === 'dubious').map((f) => f.id);
    expect(ids.indexOf('timed_out')).toBe(ids.indexOf('resigned') + 1);
  });

  it('holds 🚩 after 👬, with its rule and description', () => {
    const flair = flairById('timeout_win');
    expect(
      flair && [
        flair.category,
        codePoints(flair.emoji),
        flair.rule,
        t(flairDescriptionKey(flair.id)),
      ],
    ).toEqual(['feat', '1F6A9', ended('win', 'timeout'), 'Win a game on time']);
    const ids = FLAIR.filter((f) => f.category === 'feat').map((f) => f.id);
    expect(ids.indexOf('timeout_win')).toBe(ids.indexOf('rival_5') + 1);
  });

  it('backfills ♟️ again for its loosened rule', () =>
    expect(flairBackfillVersion(flairById('promotion_win')!)).toBe(2));

  it('gives every flair a backfill version, 1 unless its entry says otherwise', () => {
    const flair: FlairDefinition = {
      id: 'x',
      emoji: '🧪',
      category: 'feat',
      rule: total('draw', 1),
    };
    expect(flairBackfillVersion(flair)).toBe(1);
    expect(flairBackfillVersion({ ...flair, backfill: 3 })).toBe(3);
  });

  it('writes a backfill version only when it is an integer of at least 2', () => {
    for (const flair of FLAIR as readonly FlairDefinition[])
      if (flair.backfill !== undefined) {
        expect(Number.isInteger(flair.backfill)).toBe(true);
        expect(flair.backfill).toBeGreaterThanOrEqual(2);
      }
  });

  it('gives every rating exactly one rung', () => {
    const ladder = FLAIR.filter((f) => f.category === 'rank');
    const bands = ladder.flatMap(({ rule }) => (rule.kind === 'held' ? [rule] : []));
    expect(bands).toHaveLength(ladder.length);

    // Open at both ends, and every other rung starts one rating above the rung before it. A null
    // max below the top becomes NaN, which no min equals.
    expect(bands[0]?.min).toBeNull();
    expect(bands.at(-1)?.max).toBeNull();
    expect(bands.slice(1).map((b) => b.min)).toEqual(
      bands.slice(0, -1).map((b) => (b.max ?? NaN) + 1),
    );

    // A rung whose min is above its max would let the bands overlap and still meet end to end.
    expect(bands.filter((b) => b.min !== null && b.max !== null && b.min > b.max)).toEqual([]);
  });

  it('describes each flair in the prototype’s words', () => {
    const description = (id: string) => {
      const flair = flairById(id);
      return flair && t(flairDescriptionKey(flair.id));
    };
    expect(LAUNCH_IDS.map(description)).toEqual([
      'Held a rating under 1200',
      'Held a rating of 1200–1299',
      'Held a rating of 1300–1399',
      'Held a rating of 1400–1499',
      'Held a rating of 1500–1599',
      'Held a rating of 1600–1699',
      'Held a rating of 1700–1799',
      'Held a rating of 1800 or more',
      'Capture en passant and win the game',
      'Win five rated games in a row',
      'Win a game you castled queenside in',
      'Promote a pawn',
      'Draw ten games',
      'Lose to a scholar’s mate',
    ]);
  });

  it('titles the categories in display order', () => {
    expect(FLAIR_CATEGORIES.map((c) => t(flairCategoryKey(c)))).toEqual([
      'Rank ladder',
      'Feats',
      'Dubious honours',
    ]);
  });

  it('never repeats an id or an emoji', () => {
    expect(new Set(FLAIR.map((f) => f.id)).size).toBe(FLAIR.length);
    expect(new Set(FLAIR.map((f) => f.emoji)).size).toBe(FLAIR.length);
  });

  it('finds a flair by id, and nothing for an id it no longer has', () => {
    expect(flairById('draws_10')?.emoji).toBe('🤝');
    expect(flairById('retired_flair')).toBeUndefined();
  });

  it('leaves a total unrated unless asked', () => {
    expect(total('draw', 10)).toEqual({ kind: 'total', result: 'draw', count: 10, rated: false });
    expect(total('win', 25, { rated: true })).toEqual({
      kind: 'total',
      result: 'win',
      count: 25,
      rated: true,
    });
  });
});
