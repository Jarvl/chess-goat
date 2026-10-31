import { createHash } from 'node:crypto';
import { FLAIR } from '@chess-goat/shared';
import { Resvg } from '@resvg/resvg-js';
import { beforeAll, describe, expect, it } from 'vitest';
import { snapshotImageKey } from '../../src/images/cache';
import { EMOJI } from '../../src/images/emoji';
import { FLAIR_EMOJI } from '../../src/images/flairEmoji';
import { loadFonts, type SnapshotFonts } from '../../src/images/fonts';
import { GOAT_MARK_PNG } from '../../src/images/goatMark';
import { renderSnapshotPng, renderSnapshotSvg } from '../../src/images/snapshot';
import { buildSnapshotModel, type SnapshotInput } from '../../src/images/snapshotModel';
import { FIXTURE_JPEG } from '../helpers/photos';
import { snapshotInput } from '../helpers/snapshotFixtures';

let fonts: SnapshotFonts;
beforeAll(async () => {
  fonts = await loadFonts();
});

const render = (overrides: Partial<SnapshotInput> = {}) =>
  renderSnapshotSvg(buildSnapshotModel(snapshotInput(overrides)), fonts);

/** Fool's mate: Black has mated; the white king stands on e1, the black king on e8. */
const FOOLS_MATE = 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3';
const mated = (overrides: Partial<SnapshotInput> = {}): Partial<SnapshotInput> => ({
  status: 'finished',
  result: '0-1',
  ply: 4,
  plyCount: 4,
  board: { fen: FOOLS_MATE, lastMove: 'd8h4', check: true, orientation: 'white' },
  ...overrides,
});

/** Where the card places a picture, by the start of its data; null when it is not drawn. */
function placed(svg: string, picture: string): { x: number; y: number }[] {
  const needle = picture.startsWith('data:')
    ? picture.slice(0, 200)
    : `data:image/svg+xml;base64,${Buffer.from(picture).toString('base64').slice(0, 200)}`;
  return [...svg.matchAll(/<image x="([\d.]+)" y="([\d.]+)"[^>]*href="([^"]+)"/g)]
    .filter((match) => match[3]!.startsWith(needle))
    .map((match) => ({ x: Number(match[1]), y: Number(match[2]) }));
}

/** The 128px square the card draws a board square in: 128px bar above, then the board. */
const square = (column: number, row: number) => ({
  left: column * 128,
  top: 128 + row * 128,
});
const within = (point: { x: number; y: number }, box: { left: number; top: number }) =>
  point.x >= box.left && point.x < box.left + 128 && point.y >= box.top && point.y < box.top + 128;

describe('renderSnapshotPng', () => {
  it('rasterises the card to a 1024 × 1344 PNG', async () => {
    const png = renderSnapshotPng(await render());
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.readUInt32BE(16)).toBe(1024);
    expect(png.readUInt32BE(20)).toBe(1344);
  });
});

describe('renderSnapshotSvg', () => {
  it('is deterministic, and changes with what the card shows', async () => {
    expect(await render()).toBe(await render());
    expect(await render()).not.toBe(
      await render({ board: { ...snapshotInput().board, orientation: 'black' } }),
    );
    expect(await render()).not.toBe(await render({ botUsername: 'ChessGoatStagingBot' }));
  });

  it('draws text as paths, so the SVG carries no font dependency', async () => {
    const svg = await render();
    expect(svg).toMatch(/^<svg /);
    expect(svg).not.toContain('<text');
  });

  it.each([
    ['CJK and Hangul names', '李小龍 さくら 김민수'],
    ['a 60-character unbroken name', 'x'.repeat(60)],
    ['XML-special characters', `<b>&"'</b>`],
    ['emoji, ZWJ sequences and flags', '🐐🔥 👨‍👩‍👧 🇺🇦 ♞'],
  ])('renders %s without throwing', async (_label, name) => {
    const svg = await render({ white: { ...snapshotInput().white, name } });
    expect(() => renderSnapshotPng(svg)).not.toThrow();
  });

  it('draws the goat mark in the footer, and as the avatar of a bot', async () => {
    expect(placed(await render(), GOAT_MARK_PNG)).toHaveLength(1);
    const bot = await render({
      black: { ...snapshotInput().black, name: 'Chess Goat', isBot: true, engineLevel: 'strong' },
    });
    expect(placed(bot, GOAT_MARK_PNG)).toHaveLength(2);
  });

  it("draws a player's stored photo as their avatar, in their bar", async () => {
    const photo = `data:image/jpeg;base64,${FIXTURE_JPEG.toString('base64')}`;
    expect(placed(await render(), photo)).toHaveLength(0);
    const svg = await render({ black: { ...snapshotInput().black, photo: FIXTURE_JPEG } });
    const [where, ...more] = placed(svg, photo);
    expect(more).toHaveLength(0);
    // Black is at the top when White shares: the photo sits in the 128px bar above the board.
    expect(where!.y).toBeLessThan(128);
    expect(() => renderSnapshotPng(svg)).not.toThrow();
  });

  it("draws worn flair after the player's name, in slot order, in their bar", async () => {
    const worn = ['win_streak_5', 'rank_1500'];
    const bare = await render();
    expect(worn.flatMap((id) => placed(bare, FLAIR_EMOJI[id]!))).toHaveLength(0);
    const svg = await render({ black: { ...snapshotInput().black, flair: worn } });
    const [fire, walker] = worn.map((id) => placed(svg, FLAIR_EMOJI[id]!));
    expect([fire, walker].map((where) => where!.length)).toEqual([1, 1]);
    // Black is at the top when White shares; the name starts right of the 40px pad and 72px avatar.
    for (const where of [fire![0]!, walker![0]!]) {
      expect(where.y).toBeLessThan(128);
      expect(where.x).toBeGreaterThan(40 + 72 + 20);
    }
    expect(fire![0]!.x).toBeLessThan(walker![0]!.x);
    expect(() => renderSnapshotPng(svg)).not.toThrow();
  });

  it("puts a trophy on the winner's king and a skull on the loser's", async () => {
    const svg = await render(mated());
    const [trophy] = placed(svg, EMOJI.trophy);
    const [skull] = placed(svg, EMOJI.skull);
    expect(within(trophy!, square(4, 0))).toBe(true);
    expect(within(skull!, square(4, 7))).toBe(true);
    expect(placed(svg, EMOJI.scales)).toEqual([]);
  });

  it("finds the kings from the black side's view too", async () => {
    const svg = await render(
      mated({ board: { fen: FOOLS_MATE, lastMove: 'd8h4', check: true, orientation: 'black' } }),
    );
    expect(within(placed(svg, EMOJI.trophy)[0]!, square(3, 7))).toBe(true);
    expect(within(placed(svg, EMOJI.skull)[0]!, square(3, 0))).toBe(true);
  });

  it('puts the scales on both kings of a draw', async () => {
    const svg = await render(mated({ result: '1/2-1/2' }));
    expect(placed(svg, EMOJI.scales)).toHaveLength(2);
    expect(placed(svg, EMOJI.trophy)).toEqual([]);
  });

  it('has no badges before the result', async () => {
    const svg = await render(mated({ status: 'active', result: null }));
    for (const picture of [EMOJI.trophy, EMOJI.skull, EMOJI.scales])
      expect(placed(svg, picture)).toEqual([]);
  });
});

describe('snapshotImageKey', () => {
  it('is the sha256 of the card, so identical cards share a key', async () => {
    const svg = await render();
    expect(snapshotImageKey(svg)).toBe(createHash('sha256').update(svg).digest('hex'));
  });
});

describe('FLAIR_EMOJI', () => {
  it('has a colour picture for every flair in the catalog', () => {
    for (const { id } of FLAIR)
      expect(FLAIR_EMOJI[id], id).toMatch(/^<svg[^>]*viewBox="0 0 128 128"/);
  });

  // A picture that is not well-formed XML is left out of the card without an error.
  it('has pictures that parse and draw something', () => {
    for (const [id, svg] of Object.entries(FLAIR_EMOJI)) {
      const pixels = new Resvg(svg).render().pixels;
      const opaque = pixels.filter((_, index) => index % 4 === 3 && pixels[index]! > 0).length;
      expect(opaque, id).toBeGreaterThan(1000);
    }
  });
});
