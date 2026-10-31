import { t } from '@chess-goat/shared';
import { Resvg } from '@resvg/resvg-js';
import satori from 'satori';
import { IMAGE_SIZE, parsePlacement, renderBoardSvg, squarePixel } from './board';
import { EMOJI } from './emoji';
import { FLAIR_EMOJI } from './flairEmoji';
import type { SnapshotFonts } from './fonts';
import { GOAT_MARK_PNG } from './goatMark';
import { PIECE_VIEWBOX, PIECES, type PieceCode } from './pieces';
import type { SnapshotAvatar, SnapshotBar, SnapshotModel, SnapshotOutcome } from './snapshotModel';

/** Share image spec, "Canvas": a player bar, the board, a player bar, then the brand footer. */
export const CARD_WIDTH = IMAGE_SIZE;
const BAR_HEIGHT = 128;
const FOOTER_HEIGHT = 64;
export const CARD_HEIGHT = BAR_HEIGHT + IMAGE_SIZE + BAR_HEIGHT + FOOTER_HEIGHT;

const SQUARE = IMAGE_SIZE / 8;
const GREEN = '#153a26';
const FOOTER_GREEN = '#0f2c1d';
const CREAM = '#f5f0dc';
const SAGE = '#bcd3c2';
const GOLD = '#e8c35a';
const AVATAR = 72;
const CAPTURED = 40;
const CAPTURED_OVERLAP = 14;
/** The badge's 54px disc and its 4px ring, drawn as a border so the ring stays inside the square. */
const BADGE = 54 + 2 * 4;
const BADGE_EMOJI = 32;
/** Worn flair at the name's size, as in the Mini App's player bar. */
const FLAIR = 38;

type Style = Record<string, string | number>;
type Child = El | string;
/** The element shape Satori reads; plain objects, so the server needs no React. */
type El = { type: string; props: Record<string, unknown> };

function el(
  type: string,
  style: Style,
  children: Child[] = [],
  attributes: Record<string, unknown> = {},
): El {
  return {
    type,
    props: { ...attributes, style, ...(children.length ? { children } : {}) },
  };
}

const svgDataUri = (svg: string): string =>
  `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;

const picture = (src: string, size: number, style: Style = {}): El =>
  el('img', { width: size, height: size, flexShrink: 0, ...style }, [], {
    src,
    width: size,
    height: size,
  });

/** A taken piece, with a thin cream glow so black pieces still read on the green. */
function capturedPiece(code: PieceCode): string {
  // CSS drop-shadow(0 0 1.5px) at 40px: half the blur radius, in the glyph's 45-unit box.
  const deviation = ((1.5 / 2) * (PIECE_VIEWBOX / CAPTURED)).toFixed(2);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PIECE_VIEWBOX} ${PIECE_VIEWBOX}">` +
    `<filter id="glow"><feDropShadow dx="0" dy="0" stdDeviation="${deviation}" flood-color="${CREAM}"/></filter>` +
    `<g filter="url(#glow)">${PIECES[code]}</g></svg>`
  );
}

function avatar(value: SnapshotAvatar): El {
  const round: Style = { borderRadius: AVATAR / 2 };
  if (value.kind === 'bot') return picture(GOAT_MARK_PNG, AVATAR, round);
  return el(
    'div',
    {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: AVATAR,
      height: AVATAR,
      flexShrink: 0,
      background: value.colour,
      color: '#ffffff',
      fontSize: 32,
      fontWeight: 700,
      position: 'relative',
      ...round,
    },
    [
      value.initial,
      // Profile photos spec: the Telegram photo covers the initial, which shows without one.
      ...(value.photo
        ? [picture(value.photo, AVATAR, { position: 'absolute', left: 0, top: 0, ...round })]
        : []),
    ],
  );
}

/**
 * The player's worn flair (flair spec §5.1), one picture per emoji, spaced by a gap as in the Mini
 * App. It never shrinks, so a long name is cut short before it.
 */
function flair(bar: SnapshotBar): El[] {
  const pictures = bar.flair.flatMap((id) => {
    const svg = FLAIR_EMOJI[id];
    return svg ? [picture(svgDataUri(svg), FLAIR)] : [];
  });
  if (!pictures.length) return [];
  return [el('div', { display: 'flex', alignItems: 'center', gap: 3, flexShrink: 0 }, pictures)];
}

/**
 * Name, worn flair, then rating and, once the result is in, the change it made, in the order of
 * the Mini App's player bar. The name gives way first.
 */
function nameLine(bar: SnapshotBar): El {
  return el('div', { display: 'flex', alignItems: 'center', gap: 14, minWidth: 0 }, [
    el(
      'span',
      {
        fontSize: 38,
        fontWeight: 700,
        color: CREAM,
        minWidth: 0,
        flexShrink: 1,
        overflow: 'hidden',
        whiteSpace: 'nowrap',
        textOverflow: 'ellipsis',
      },
      [bar.name],
    ),
    ...flair(bar),
    ...(bar.rating ? [el('span', { fontSize: 28, color: SAGE, flexShrink: 0 }, [bar.rating])] : []),
    ...(bar.ratingDelta
      ? [
          el(
            'span',
            {
              fontSize: 26,
              fontWeight: 700,
              color: bar.ratingDelta.gain ? '#8fd6a8' : '#ef8a8a',
              flexShrink: 0,
            },
            [bar.ratingDelta.label],
          ),
        ]
      : []),
  ]);
}

/** The pieces this side took, overlapping, then its lead; left out when there is neither. */
function materialLine(bar: SnapshotBar): El[] {
  if (!bar.captured.length && !bar.lead) return [];
  const pieces = bar.captured.length
    ? [
        el(
          'div',
          { display: 'flex', alignItems: 'center', paddingRight: CAPTURED_OVERLAP },
          bar.captured.map((code) =>
            picture(svgDataUri(capturedPiece(code)), CAPTURED, { marginRight: -CAPTURED_OVERLAP }),
          ),
        ),
      ]
    : [];
  const lead = bar.lead
    ? [el('span', { fontSize: 26, fontWeight: 800, color: GOLD }, [bar.lead])]
    : [];
  return [
    el('div', { display: 'flex', alignItems: 'center', gap: 12, minHeight: CAPTURED }, [
      ...pieces,
      ...lead,
    ]),
  ];
}

const TAG: Record<SnapshotOutcome, Style> = {
  won: { background: GOLD, color: '#2a2000' },
  lost: { background: 'rgba(245, 240, 220, 0.12)', color: SAGE },
  draw: { background: 'rgba(245, 240, 220, 0.12)', color: CREAM },
};

function playerBar(bar: SnapshotBar): El {
  return el(
    'div',
    {
      display: 'flex',
      alignItems: 'center',
      gap: 20,
      height: BAR_HEIGHT,
      padding: '0 40px',
      flexShrink: 0,
    },
    [
      avatar(bar.avatar),
      el('div', { display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 0 }, [
        nameLine(bar),
        ...materialLine(bar),
      ]),
      ...(bar.result
        ? [
            el(
              'span',
              {
                flexShrink: 0,
                padding: '12px 22px',
                borderRadius: 14,
                fontSize: 30,
                fontWeight: 800,
                ...TAG[bar.result.outcome],
              },
              [bar.result.label],
            ),
          ]
        : []),
    ],
  );
}

const BADGE_ART: Record<SnapshotOutcome, { emoji: string; background: string }> = {
  won: { emoji: EMOJI.trophy, background: GOLD },
  lost: { emoji: EMOJI.skull, background: '#d14e4e' },
  draw: { emoji: EMOJI.scales, background: CREAM },
};

/** A result badge in the top-right corner of the side's king square. */
function kingBadge(model: SnapshotModel, bar: SnapshotBar): El[] {
  if (!bar.result) return [];
  const code = bar.colour === 'white' ? 'wK' : 'bK';
  const king = parsePlacement(model.board.fen).find((placed) => placed.piece === code);
  if (!king) return [];
  const { x, y } = squarePixel(king.file, king.rank, model.board.orientation);
  const art = BADGE_ART[bar.result.outcome];
  return [
    el(
      'div',
      {
        position: 'absolute',
        left: x + SQUARE - BADGE,
        top: y,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: BADGE,
        height: BADGE,
        borderRadius: BADGE / 2,
        border: `4px solid ${GREEN}`,
        background: art.background,
        boxShadow: '0 3px 8px rgba(0, 0, 0, 0.35)',
      },
      [picture(svgDataUri(art.emoji), BADGE_EMOJI)],
    ),
  ];
}

function board(model: SnapshotModel): El {
  return el(
    'div',
    { display: 'flex', position: 'relative', width: IMAGE_SIZE, height: IMAGE_SIZE, flexShrink: 0 },
    [
      el('img', { position: 'absolute', left: 0, top: 0 }, [], {
        src: svgDataUri(renderBoardSvg(model.board)),
        width: IMAGE_SIZE,
        height: IMAGE_SIZE,
      }),
      ...kingBadge(model, model.top),
      ...kingBadge(model, model.bottom),
    ],
  );
}

/** Share image spec, "Brand footer": says where the image came from once it is forwarded. */
function footer(model: SnapshotModel): El {
  return el(
    'div',
    {
      display: 'flex',
      alignItems: 'center',
      gap: 14,
      height: FOOTER_HEIGHT,
      padding: '0 14px 0 40px',
      background: FOOTER_GREEN,
      flexShrink: 0,
    },
    [
      picture(GOAT_MARK_PNG, 40, { borderRadius: 20 }),
      // Two colours need two words; the gap is Young Serif's own word space at 32px.
      el(
        'div',
        {
          display: 'flex',
          gap: 8,
          fontFamily: 'Young Serif',
          fontSize: 32,
          lineHeight: 1,
          letterSpacing: '-0.01em',
          whiteSpace: 'nowrap',
        },
        [el('span', { color: CREAM }, ['Chess']), el('span', { color: GOLD }, ['Goat'])],
      ),
      el(
        'div',
        {
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          marginLeft: 'auto',
          whiteSpace: 'nowrap',
        },
        [
          el(
            'span',
            {
              fontSize: 19,
              fontWeight: 700,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: SAGE,
            },
            [t('image.share.play_on_telegram')],
          ),
          // The design's 2px inset ring, as a border inside the same outer size.
          el(
            'span',
            {
              padding: '5px 14px',
              borderRadius: 999,
              background: 'rgba(245, 240, 220, 0.1)',
              border: '2px solid rgba(232, 195, 90, 0.45)',
              fontSize: 25,
              fontWeight: 700,
              letterSpacing: '0.01em',
              color: CREAM,
            },
            [model.handle],
          ),
        ],
      ),
    ],
  );
}

/** Satori lays the card out and turns its text into paths, so resvg needs no fonts. */
export async function renderSnapshotSvg(
  model: SnapshotModel,
  fonts: SnapshotFonts,
): Promise<string> {
  const card = el(
    'div',
    {
      display: 'flex',
      flexDirection: 'column',
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
      background: GREEN,
      color: CREAM,
      fontFamily: 'Noto Sans',
    },
    [playerBar(model.top), board(model), playerBar(model.bottom), footer(model)],
  );
  return satori(card as unknown as Parameters<typeof satori>[0], {
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    fonts,
  });
}

export function renderSnapshotPng(svg: string): Buffer {
  return new Resvg(svg, { fitTo: { mode: 'width', value: CARD_WIDTH } }).render().asPng();
}
