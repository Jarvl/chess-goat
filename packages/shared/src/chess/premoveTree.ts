import { Chess, type Square } from 'chess.js';
import { parseUci, type PromotionPiece } from './arbiter';

/** A conditional premove: if the opponent plays `move`, the owner answers `reply`. */
export type PremoveNode = { move: string; reply: string; children: PremoveNode[] };

/** A node while it is being built in the editor: the reply may not be chosen yet. */
export type DraftNode = { move: string; reply: string | null; children: DraftNode[] };

export type TreeCheck = { ok: true } | { ok: false; path: string[] };

/** The client never sends a tree whose base64url text is longer than this. */
export const PREMOVE_TREE_MAX_CHARS = 60_000;

/** A sibling list is one count byte, so it holds at most this many nodes. */
const MAX_SIBLINGS = 218;

const PROMOTION_CODES: readonly (PromotionPiece | undefined)[] = [undefined, 'q', 'r', 'b', 'n'];

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export class PremoveTreeFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PremoveTreeFormatError';
  }
}

function squareIndex(square: string): number {
  return (square.charCodeAt(1) - 49) * 8 + (square.charCodeAt(0) - 97);
}

function squareName(index: number): Square {
  return `${String.fromCharCode(97 + (index & 7))}${(index >> 3) + 1}` as Square;
}

function encodeMove(uci: string): number {
  const parsed = parseUci(uci);
  if (!parsed) throw new PremoveTreeFormatError(`Malformed move: ${uci}`);
  const promotion = parsed.promotion ? PROMOTION_CODES.indexOf(parsed.promotion) : 0;
  return squareIndex(parsed.from) | (squareIndex(parsed.to) << 6) | (promotion << 12);
}

function decodeMove(value: number): string {
  if (value & 0x8000) throw new PremoveTreeFormatError('Move has bit 15 set');
  const promotion = (value >> 12) & 7;
  if (promotion >= PROMOTION_CODES.length) {
    throw new PremoveTreeFormatError(`Unknown promotion code ${promotion}`);
  }
  return `${squareName(value & 63)}${squareName((value >> 6) & 63)}${PROMOTION_CODES[promotion] ?? ''}`;
}

/**
 * The tree as bytes: a list is a count then its nodes; a node is move, reply, children list.
 * The empty tree is no bytes at all (not a lone zero count), so it has one form: `''` on the wire.
 * Walks with its own stack, not recursion, so a line thousands of plies deep encodes fine.
 */
export function encodePremoveBytes(tree: readonly DraftNode[]): Uint8Array {
  const out: number[] = [];
  const open = (list: readonly DraftNode[]) => {
    const answered = list.filter((entry) => entry.reply !== null);
    if (answered.length > MAX_SIBLINGS) {
      throw new PremoveTreeFormatError(`More than ${MAX_SIBLINGS} siblings`);
    }
    out.push(answered.length);
    return { list: answered, next: 0 };
  };
  const frames = [open(tree)];
  for (let frame = frames[0]; frame; frame = frames[frames.length - 1]) {
    const entry = frame.list[frame.next];
    if (!entry) {
      frames.pop();
      continue;
    }
    frame.next += 1;
    for (const uci of [entry.move, entry.reply as string]) {
      const value = encodeMove(uci);
      out.push(value & 0xff, value >> 8);
    }
    frames.push(open(entry.children));
  }
  // Only the root's zero count: the empty tree.
  return out.length === 1 ? new Uint8Array() : Uint8Array.from(out);
}

/**
 * Parses bytes written by `encodePremoveBytes`. Untrusted input, so the walk keeps its own
 * stack instead of recursing: a tree thousands of plies deep must not overflow the call stack.
 */
export function decodePremoveBytes(bytes: Uint8Array): PremoveNode[] {
  if (bytes.length === 0) return [];
  let cursor = 0;
  const readByte = (): number => {
    const value = bytes[cursor];
    if (value === undefined) throw new PremoveTreeFormatError('Unexpected end of data');
    cursor += 1;
    return value;
  };
  const readCount = (): number => {
    const count = readByte();
    if (count > MAX_SIBLINGS) throw new PremoveTreeFormatError(`Sibling count ${count} is too big`);
    return count;
  };
  const readMove = (): string => {
    const low = readByte();
    return decodeMove(low | (readByte() << 8));
  };

  const rootCount = readCount();
  if (rootCount === 0)
    throw new PremoveTreeFormatError('The empty tree is no bytes, not a zero count');
  const root: PremoveNode[] = [];
  const frames = [{ list: root, remaining: rootCount }];
  for (let frame = frames[0]; frame; frame = frames[frames.length - 1]) {
    if (frame.remaining === 0) {
      frames.pop();
      continue;
    }
    frame.remaining -= 1;
    const entry: PremoveNode = { move: readMove(), reply: readMove(), children: [] };
    frame.list.push(entry);
    frames.push({ list: entry.children, remaining: readCount() });
  }
  if (cursor !== bytes.length) throw new PremoveTreeFormatError('Trailing bytes');
  return root;
}

export function toBase64Url(bytes: Uint8Array): string {
  let text = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const chunk =
      ((bytes[index] ?? 0) << 16) | ((bytes[index + 1] ?? 0) << 8) | (bytes[index + 2] ?? 0);
    const chars = Math.min(bytes.length - index, 3) + 1;
    for (let char = 0; char < chars; char += 1) {
      text += BASE64URL_ALPHABET[(chunk >> (18 - 6 * char)) & 63];
    }
  }
  return text;
}

export function fromBase64Url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) {
    throw new PremoveTreeFormatError('Not base64url text');
  }
  if (text.length % 4 === 1) throw new PremoveTreeFormatError('Truncated base64url text');
  const bytes = new Uint8Array(Math.floor((text.length * 3) / 4));
  for (let index = 0, out = 0; index < text.length; index += 4) {
    let chunk = 0;
    for (let char = 0; char < 4; char += 1) {
      const value = BASE64URL_ALPHABET.indexOf(text[index + char] ?? 'A');
      chunk = (chunk << 6) | value;
    }
    for (let byte = 0; byte < 3 && out < bytes.length; byte += 1) {
      bytes[out] = (chunk >> (16 - 8 * byte)) & 0xff;
      out += 1;
    }
  }
  return bytes;
}

export function encodePremoveTree(tree: readonly DraftNode[]): string {
  return toBase64Url(encodePremoveBytes(tree));
}

export function decodePremoveTree(text: string): PremoveNode[] {
  return decodePremoveBytes(fromBase64Url(text));
}

/** SHA-256 of the tree's bytes as base64url (43 characters); works in Node and browsers. */
export async function premoveTreeHash(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes.slice());
  return toBase64Url(new Uint8Array(digest));
}

/** The node answering the opponent move `uci`, if the tree has one. */
export function branchFor(tree: readonly PremoveNode[], uci: string): PremoveNode | null {
  return tree.find((entry) => entry.move === uci) ?? null;
}

/** Nodes with a reply, at every depth. */
export function countPremovePairs(tree: readonly DraftNode[]): number {
  let count = 0;
  const pending = [tree];
  for (let list = pending.pop(); list; list = pending.pop()) {
    for (const entry of list) {
      if (entry.reply === null) continue;
      count += 1;
      pending.push(entry.children);
    }
  }
  return count;
}

/** Plays `uci` on `chess`; false when it is not exactly a legal move in coordinate notation. */
function playLegal(chess: Chess, uci: string): boolean {
  const parsed = parseUci(uci);
  if (!parsed) return false;
  try {
    const played = chess.move(parsed);
    return `${played.from}${played.to}${played.promotion ?? ''}` === uci;
  } catch {
    return false;
  }
}

type CheckFrame = {
  list: readonly PremoveNode[];
  known: readonly PremoveNode[];
  /** Position the opponent moves from; null until something below needs it. */
  fen: string | null;
  seen: Set<string>;
  next: number;
  /** Length of the shared path when this frame was opened. */
  pathLength: number;
};

/**
 * Checks that every pair is legal in its own line and that no list repeats an opponent move.
 * Yields once per newly checked pair so callers can slice the work. A pair found in `known`
 * (same path, move and reply) is not checked again; its children are compared against `known`'s.
 * Walks with its own stack, not recursion: the tree is decoded input and may be thousands deep.
 */
export function* premoveTreeCheck(
  fen: string,
  tree: readonly PremoveNode[],
  known: readonly PremoveNode[] = [],
): Generator<void, TreeCheck> {
  const open = (
    list: readonly PremoveNode[],
    knownList: readonly PremoveNode[],
    position: string | null,
    pathLength: number,
  ): CheckFrame => ({
    list,
    known: knownList,
    fen: position,
    seen: new Set(),
    next: 0,
    pathLength,
  });
  /** The position of frame `index`, replaying the pairs above it if it was left unbuilt. */
  const positionOf = (index: number): string => {
    let start = index;
    while (frames[start]?.fen === null) start -= 1;
    let position = frames[start]?.fen as string;
    for (let level = start; level < index; level += 1) {
      const parent = frames[level] as CheckFrame;
      const entry = parent.list[parent.next - 1] as PremoveNode;
      const chess = new Chess(position);
      playLegal(chess, entry.move);
      playLegal(chess, entry.reply);
      position = chess.fen();
      (frames[level + 1] as CheckFrame).fen = position;
    }
    return position;
  };

  const path: string[] = [];
  const frames = [open(tree, known, fen, 0)];
  for (let depth = 0; depth >= 0; depth = frames.length - 1) {
    const frame = frames[depth] as CheckFrame;
    const entry = frame.list[frame.next];
    if (!entry) {
      frames.pop();
      continue;
    }
    frame.next += 1;
    path.length = frame.pathLength;
    path.push(entry.move);
    if (frame.seen.has(entry.move)) return { ok: false, path };
    frame.seen.add(entry.move);

    const knownEntry = frame.known.find(
      (candidate) => candidate.move === entry.move && candidate.reply === entry.reply,
    );
    let after: string | null = null;
    if (!knownEntry) {
      const chess = new Chess(positionOf(depth));
      if (!playLegal(chess, entry.move)) return { ok: false, path };
      if (!playLegal(chess, entry.reply)) {
        path.push(entry.reply);
        return { ok: false, path };
      }
      after = chess.fen();
      yield;
    }
    path.push(entry.reply);
    frames.push(open(entry.children, knownEntry?.children ?? [], after, path.length));
  }
  return { ok: true };
}

/** Runs `premoveTreeCheck` to the end. */
export function checkPremoveTree(
  fen: string,
  tree: readonly PremoveNode[],
  known?: readonly PremoveNode[],
): TreeCheck {
  const generator = premoveTreeCheck(fen, tree, known);
  for (;;) {
    const step = generator.next();
    if (step.done) return step.value;
  }
}
