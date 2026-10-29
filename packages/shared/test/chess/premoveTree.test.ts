import { describe, expect, it } from 'vitest';
import { INITIAL_FEN } from '../../src/chess/arbiter';
import {
  PREMOVE_TREE_MAX_CHARS,
  PremoveTreeFormatError,
  branchFor,
  checkPremoveTree,
  countPremovePairs,
  decodePremoveBytes,
  decodePremoveTree,
  encodePremoveBytes,
  encodePremoveTree,
  fromBase64Url,
  premoveTreeCheck,
  premoveTreeHash,
  toBase64Url,
  type DraftNode,
  type PremoveNode,
} from '../../src/chess/premoveTree';

/** 1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5: both sides may still castle short. */
const ITALIAN = 'r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';
/** After 1.e4, Black to move. */
const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';

const node = (move: string, reply: string, children: PremoveNode[] = []): PremoveNode => ({
  move,
  reply,
  children,
});

describe('encodePremoveBytes', () => {
  it('encodes a move in two bytes', () => {
    expect(encodePremoveBytes([{ move: 'e2e4', reply: 'e7e5', children: [] }])).toEqual(
      Uint8Array.of(1, 12, 7, 52, 9, 0),
    );
  });

  it('encodes an empty tree as no bytes at all, and no text', () => {
    expect(encodePremoveBytes([])).toEqual(new Uint8Array());
    expect(encodePremoveTree([])).toBe('');
    // A tree of unanswered nodes only is empty too.
    expect(encodePremoveBytes([{ move: 'e7e5', reply: null, children: [] }])).toEqual(
      new Uint8Array(),
    );
  });

  it('keeps the zero count of an empty child list', () => {
    expect(encodePremoveBytes([{ move: 'e2e4', reply: 'e7e5', children: [] }]).at(-1)).toBe(0);
  });

  it('skips unanswered nodes and everything under them', () => {
    const draft: DraftNode[] = [
      { move: 'e7e5', reply: null, children: [{ move: 'g1f3', reply: 'b8c6', children: [] }] },
      { move: 'd7d5', reply: 'e4d5', children: [] },
    ];
    expect(decodePremoveBytes(encodePremoveBytes(draft))).toEqual([node('d7d5', 'e4d5')]);
  });
});

describe('round trips', () => {
  const deep: PremoveNode[] = [
    node('e7e5', 'g1f3', [node('b8c6', 'f1b5', [node('a7a6', 'b5a4', [node('g8f6', 'e1g1')])])]),
  ];
  const wide: PremoveNode[] = [
    node('e7e5', 'g1f3', [node('b8c6', 'f1b5'), node('g8f6', 'f3e5'), node('d7d6', 'd2d4')]),
    node('c7c5', 'g1f3'),
    node('d7d5', 'e4d5'),
  ];

  it.each([
    ['an empty tree', []],
    ['a deep tree', deep],
    ['a wide tree', wide],
  ])('round-trips %s through bytes and base64url', (_name, tree) => {
    expect(decodePremoveBytes(encodePremoveBytes(tree))).toEqual(tree);
    expect(decodePremoveTree(encodePremoveTree(tree))).toEqual(tree);
  });

  it('round-trips promotions and castling', () => {
    const tree = [
      node('a2a1q', 'e1g1', [node('b2b1r', 'e8c8'), node('c2c1b', 'h7h8n')]),
      node('d2d1n', 'a7a8q'),
    ];
    expect(decodePremoveBytes(encodePremoveBytes(tree))).toEqual(tree);
    expect(decodePremoveTree(encodePremoveTree(tree))).toEqual(tree);
  });

  it('writes base64url without padding or url-unsafe characters', () => {
    const text = encodePremoveTree(wide);
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('base64url', () => {
  it('round-trips every length from 0 to 9 bytes', () => {
    for (let length = 0; length <= 9; length += 1) {
      const bytes = Uint8Array.from({ length }, (_, index) => 251 - index * 7);
      expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
    }
  });

  it('uses the url alphabet', () => {
    expect(toBase64Url(Uint8Array.of(251, 255, 191))).toBe('-_-_');
    expect(toBase64Url(Uint8Array.of(1))).toBe('AQ');
  });
});

describe('malformed input', () => {
  const rejects = (bytes: Uint8Array) =>
    expect(() => decodePremoveBytes(bytes)).toThrow(PremoveTreeFormatError);

  it('decodes no bytes, and no text, as the empty tree', () => {
    expect(decodePremoveBytes(new Uint8Array())).toEqual([]);
    expect(decodePremoveTree('')).toEqual([]);
  });

  it('rejects a lone zero count: the empty tree is no bytes', () => {
    rejects(Uint8Array.of(0));
    expect(() => decodePremoveTree('AA')).toThrow(PremoveTreeFormatError);
  });

  it('rejects truncated bytes', () => {
    rejects(Uint8Array.of(1, 12, 7, 52, 9));
    rejects(Uint8Array.of(1, 12, 7));
  });

  it('rejects trailing bytes', () => {
    rejects(Uint8Array.of(1, 12, 7, 52, 9, 0, 0));
  });

  it('rejects bit 15 set', () => {
    rejects(Uint8Array.of(1, 12, 0x87, 52, 9, 0));
  });

  it('rejects promotion code 5', () => {
    // e7e8 with promotion 5: 52 | 60<<6 | 5<<12 = 52 | 3840 | 20480
    const move = 52 | (60 << 6) | (5 << 12);
    rejects(Uint8Array.of(1, move & 0xff, move >> 8, 52, 9, 0));
  });

  it('rejects a count above 218', () => {
    rejects(Uint8Array.of(219));
    rejects(Uint8Array.of(255));
  });

  it('rejects bad base64url text', () => {
    expect(() => fromBase64Url('a+b')).toThrow(PremoveTreeFormatError);
    expect(() => fromBase64Url('ab=')).toThrow(PremoveTreeFormatError);
    expect(() => fromBase64Url('a')).toThrow(PremoveTreeFormatError);
    expect(() => decodePremoveTree('a')).toThrow(PremoveTreeFormatError);
  });

  it('refuses to encode a malformed move or too many siblings', () => {
    expect(() => encodePremoveBytes([{ move: 'e9e4', reply: 'e7e5', children: [] }])).toThrow(
      PremoveTreeFormatError,
    );
    const many: DraftNode[] = Array.from({ length: 219 }, () => ({
      move: 'e2e4',
      reply: 'e7e5',
      children: [],
    }));
    expect(() => encodePremoveBytes(many)).toThrow(PremoveTreeFormatError);
  });

  it('decodes a tree nested deeper than the call stack allows', () => {
    const depth = 20_000;
    const bytes = new Uint8Array(depth * 5 + 1);
    bytes[0] = 1;
    for (let level = 0; level < depth; level += 1) {
      bytes.set([12, 7, 52, 9, level === depth - 1 ? 0 : 1], 1 + level * 5);
    }
    let cursor = decodePremoveBytes(bytes);
    let levels = 0;
    while (cursor.length > 0) {
      levels += 1;
      cursor = cursor[0]!.children;
    }
    expect(levels).toBe(depth);
  });
});

/** A knight shuffle from the initial position: legal at any depth, 8_900 pairs fit in 60k chars. */
function knightShuffle(pairs: number): PremoveNode[] {
  const cycle = [
    ['g1f3', 'g8f6'],
    ['f3g1', 'f6g8'],
  ] as const;
  const root: PremoveNode[] = [];
  let list = root;
  for (let ply = 0; ply < pairs; ply += 1) {
    const [move, reply] = cycle[ply % 2] as readonly [string, string];
    const entry = node(move, reply);
    list.push(entry);
    list = entry.children;
  }
  return root;
}

describe('deep lines', () => {
  const pairs = 8_900;

  it('encodes and checks a line as deep as the size limit allows', () => {
    const tree = knightShuffle(pairs);
    const text = encodePremoveTree(tree);
    expect(text.length).toBeLessThanOrEqual(PREMOVE_TREE_MAX_CHARS);
    expect(countPremovePairs(tree)).toBe(pairs);
    const decoded = decodePremoveTree(text);
    expect(checkPremoveTree(INITIAL_FEN, decoded)).toEqual({ ok: true });
    expect(encodePremoveTree(decoded)).toBe(text);
  });

  it('compares a deep line against a known copy and finds a bad deep move', () => {
    const depth = 3_000;
    const tree = knightShuffle(depth);
    expect(checkPremoveTree(INITIAL_FEN, tree, knightShuffle(depth - 1))).toEqual({ ok: true });
    let last = tree[0] as PremoveNode;
    while (last.children[0]) last = last.children[0];
    last.reply = 'a1a8';
    const result = checkPremoveTree(INITIAL_FEN, tree, knightShuffle(depth - 1));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.path).toHaveLength(depth * 2);
      expect(result.path.at(-1)).toBe('a1a8');
    }
  });
});

describe('premoveTreeHash', () => {
  it('fingerprints bytes', async () => {
    expect(await premoveTreeHash(new Uint8Array())).toBe(
      '47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU',
    );
    expect(await premoveTreeHash(Uint8Array.of(1, 2, 3, 4, 5))).toHaveLength(43);
  });
});

describe('branchFor', () => {
  const tree = [node('e7e5', 'g1f3'), node('d7d5', 'e4d5')];

  it('finds a branch', () => {
    expect(branchFor(tree, 'd7d5')).toBe(tree[1]);
    expect(branchFor(tree, 'c7c5')).toBeNull();
  });
});

describe('countPremovePairs', () => {
  it('counts answered nodes recursively', () => {
    const draft: DraftNode[] = [
      {
        move: 'e7e5',
        reply: 'g1f3',
        children: [
          { move: 'b8c6', reply: 'f1b5', children: [] },
          { move: 'g8f6', reply: null, children: [{ move: 'a', reply: 'b', children: [] }] },
        ],
      },
      { move: 'd7d5', reply: 'e4d5', children: [] },
    ];
    expect(countPremovePairs(draft)).toBe(3);
  });
});

describe('premoveTreeCheck', () => {
  const good = (): PremoveNode[] => [node('e7e5', 'g1f3', [node('b8c6', 'f1b5')])];

  it('checks every new move in its own position', () => {
    expect(checkPremoveTree(AFTER_E4, good())).toEqual({ ok: true });
    const bad = [node('e7e5', 'g1f3', [node('b8c6', 'f1b6')])];
    expect(checkPremoveTree(AFTER_E4, bad)).toEqual({
      ok: false,
      path: ['e7e5', 'g1f3', 'b8c6', 'f1b6'],
    });
  });

  it('reports an illegal opponent move at the move itself', () => {
    expect(checkPremoveTree(AFTER_E4, [node('e2e4', 'g1f3')])).toEqual({
      ok: false,
      path: ['e2e4'],
    });
  });

  it('accepts castling and promotion', () => {
    expect(checkPremoveTree(ITALIAN, [node('f1e2', 'g8f6')])).toEqual({
      ok: false,
      path: ['f1e2'],
    });
    expect(checkPremoveTree(ITALIAN, [node('e1g1', 'g8f6', [node('d2d3', 'e8g8')])])).toEqual({
      ok: true,
    });
    expect(checkPremoveTree(ITALIAN, [node('e1g1', 'e8g8')])).toEqual({
      ok: false,
      path: ['e1g1', 'e8g8'],
    });
    expect(checkPremoveTree('8/P7/8/8/8/8/k6K/8 w - - 0 1', [node('a7a8q', 'a2b3')])).toEqual({
      ok: true,
    });
    expect(checkPremoveTree('8/P7/8/8/8/8/k6K/8 w - - 0 1', [node('a7a8', 'a2b3')])).toEqual({
      ok: false,
      path: ['a7a8'],
    });
  });

  it('refuses duplicate siblings', () => {
    const tree = [node('e7e5', 'g1f3'), node('e7e5', 'b1c3')];
    expect(checkPremoveTree(AFTER_E4, tree)).toEqual({ ok: false, path: ['e7e5'] });
    const nested = [node('e7e5', 'g1f3', [node('b8c6', 'f1b5'), node('b8c6', 'f1c4')])];
    expect(checkPremoveTree(AFTER_E4, nested)).toEqual({
      ok: false,
      path: ['e7e5', 'g1f3', 'b8c6'],
    });
  });

  it('refuses moves after a mate', () => {
    // 1.f3 e5 and White plays 2.g4: Black's reply Qh4 mates, so nothing can follow.
    const afterWhiteMoves = 'rnbqkbnr/pppp1ppp/8/4p3/8/5P2/PPPPP1PP/RNBQKBNR w KQkq - 0 2';
    expect(
      checkPremoveTree(afterWhiteMoves, [node('g2g4', 'd8h4', [node('a2a3', 'a7a6')])]),
    ).toEqual({ ok: false, path: ['g2g4', 'd8h4', 'a2a3'] });
    expect(checkPremoveTree(afterWhiteMoves, [node('g2g4', 'd8h4')])).toEqual({ ok: true });
  });

  const countYields = (
    fen: string,
    tree: readonly PremoveNode[],
    known?: readonly PremoveNode[],
  ): { yields: number; result: unknown } => {
    const generator = premoveTreeCheck(fen, tree, known);
    let yields = 0;
    for (;;) {
      const step = generator.next();
      if (step.done) return { yields, result: step.value };
      yields += 1;
    }
  };

  it('yields once per checked pair', () => {
    expect(countYields(AFTER_E4, good())).toEqual({ yields: 2, result: { ok: true } });
  });

  it('skips nodes already in known', () => {
    const known = good();
    const tree = [node('e7e5', 'g1f3', [node('b8c6', 'f1b5', [node('a7a6', 'b5a4')])])];
    expect(countYields(AFTER_E4, tree, known)).toEqual({ yields: 1, result: { ok: true } });
    expect(countYields(AFTER_E4, known, known)).toEqual({ yields: 0, result: { ok: true } });
  });

  it('still checks a node whose reply differs from the known one', () => {
    const known = good();
    const tree = [node('e7e5', 'b1c3', [node('b8c6', 'f1b5')])];
    expect(countYields(AFTER_E4, tree, known)).toEqual({ yields: 2, result: { ok: true } });
  });

  it('checks new deep nodes in the right position below known nodes', () => {
    const known = good();
    const tree = [node('e7e5', 'g1f3', [node('b8c6', 'f1b5', [node('a7a6', 'b5b7')])])];
    expect(checkPremoveTree(AFTER_E4, tree, known)).toEqual({
      ok: false,
      path: ['e7e5', 'g1f3', 'b8c6', 'f1b5', 'a7a6', 'b5b7'],
    });
  });
});

describe('from the initial position', () => {
  it('checks a white tree where the owner moves second', () => {
    expect(checkPremoveTree(INITIAL_FEN, [node('e2e4', 'e7e5', [node('g1f3', 'b8c6')])])).toEqual({
      ok: true,
    });
  });
});
