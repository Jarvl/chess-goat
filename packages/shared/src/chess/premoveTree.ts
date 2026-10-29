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

/** The tree as bytes: a list is a count then its nodes; a node is move, reply, children list. */
export function encodePremoveBytes(tree: readonly DraftNode[]): Uint8Array {
  const out: number[] = [];
  const writeList = (list: readonly DraftNode[]): void => {
    const answered = list.filter((entry) => entry.reply !== null);
    if (answered.length > MAX_SIBLINGS) {
      throw new PremoveTreeFormatError(`More than ${MAX_SIBLINGS} siblings`);
    }
    out.push(answered.length);
    for (const entry of answered) {
      for (const uci of [entry.move, entry.reply as string]) {
        const value = encodeMove(uci);
        out.push(value & 0xff, value >> 8);
      }
      writeList(entry.children);
    }
  };
  writeList(tree);
  return Uint8Array.from(out);
}

/**
 * Parses bytes written by `encodePremoveBytes`. Untrusted input, so the walk keeps its own
 * stack instead of recursing: a tree thousands of plies deep must not overflow the call stack.
 */
export function decodePremoveBytes(bytes: Uint8Array): PremoveNode[] {
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

  const root: PremoveNode[] = [];
  const frames = [{ list: root, remaining: readCount() }];
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
  for (const entry of tree) {
    if (entry.reply !== null) count += 1 + countPremovePairs(entry.children);
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

/**
 * Checks that every pair is legal in its own line and that no list repeats an opponent move.
 * Yields once per newly checked pair so callers can slice the work. A pair found in `known`
 * (same path, move and reply) is not checked again; its children are compared against `known`'s.
 */
export function* premoveTreeCheck(
  fen: string,
  tree: readonly PremoveNode[],
  known: readonly PremoveNode[] = [],
): Generator<void, TreeCheck> {
  function* walk(
    position: () => string,
    list: readonly PremoveNode[],
    knownList: readonly PremoveNode[],
    path: readonly string[],
  ): Generator<void, TreeCheck> {
    const seen = new Set<string>();
    for (const entry of list) {
      const here = [...path, entry.move];
      if (seen.has(entry.move)) return { ok: false, path: here };
      seen.add(entry.move);

      const knownEntry = knownList.find(
        (candidate) => candidate.move === entry.move && candidate.reply === entry.reply,
      );
      // A known pair was checked before, so its position is only built if something below is new.
      let after: string | undefined;
      const positionAfter = (): string => {
        if (after === undefined) {
          const chess = new Chess(position());
          playLegal(chess, entry.move);
          playLegal(chess, entry.reply);
          after = chess.fen();
        }
        return after;
      };

      if (!knownEntry) {
        const chess = new Chess(position());
        if (!playLegal(chess, entry.move)) return { ok: false, path: here };
        if (!playLegal(chess, entry.reply)) return { ok: false, path: [...here, entry.reply] };
        after = chess.fen();
        yield;
      }

      const result = yield* walk(positionAfter, entry.children, knownEntry?.children ?? [], [
        ...here,
        entry.reply,
      ]);
      if (!result.ok) return result;
    }
    return { ok: true };
  }

  return yield* walk(() => fen, tree, known, []);
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
