import {
  applyMove,
  encodePremoveTree,
  fromBase64Url,
  PREMOVE_TREE_MAX_CHARS,
  premoveTreeHash,
  t,
  type Colour,
  type DraftNode,
} from '@chess-goat/shared';
import { Chess } from 'chess.js';
import type { WaitingMove } from '../../state/game';
import { moveLabel } from '../../state/premoveDraft';

/** The tree's wire form, or null when it cannot be sent: the codec refuses it or it is too big. */
export function sendable(tree: readonly DraftNode[]): string | null {
  try {
    const text = encodePremoveTree(tree);
    return text.length > PREMOVE_TREE_MAX_CHARS ? null : text;
  } catch {
    return null;
  }
}

/** The fingerprint the server compares a premove save against (the tree it holds). */
export function fingerprint(text: string): Promise<string> {
  return premoveTreeHash(fromBase64Url(text));
}

export function sanOf(fen: string, uci: string): string {
  const result = applyMove(fen, [], uci);
  return result.legal ? result.san : uci;
}

/** Whether an opponent move in the tree still waits for its reply. */
export function hasOpenMove(tree: readonly DraftNode[]): boolean {
  const pending = [tree];
  for (let list = pending.pop(); list; list = pending.pop()) {
    for (const node of list) {
      if (node.reply === null) return true;
      pending.push(node.children);
    }
  }
  return false;
}

export function sameTree(a: readonly DraftNode[], b: readonly DraftNode[]): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

export function samePath(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((move, index) => move === b[index]);
}

export function colourAt(fen: string, square: string): Colour | null {
  try {
    const piece = new Chess(fen).get(square as 'a1');
    return piece ? (piece.color === 'w' ? 'white' : 'black') : null;
  } catch {
    return null;
  }
}

/** Confirm move, with the number of premoves going with it (never the move's name). */
export function confirmMoveLabel(pairs: number): string {
  if (pairs === 0) return t('app.game.confirm_move');
  if (pairs === 1) return t('app.game.confirm_move_premove');
  return t('app.game.confirm_move_premoves', { n: pairs });
}

/** "Replace 4.Ng5 with 4.Nc3?" and, when moves hang off it, what goes with it. */
export function replaceReplyMessage(
  fen: string,
  old: string,
  uci: string,
  dropped: number,
): string {
  const lines = [
    t('app.game.premove_replace_confirm', { old: moveLabel(fen, old), new: moveLabel(fen, uci) }),
  ];
  const move = sanOf(fen, old);
  if (dropped === 1) lines.push(t('app.game.premove_replace_after_one', { move }));
  else if (dropped > 1) lines.push(t('app.game.premove_replace_after', { n: dropped, move }));
  return lines.join('\n');
}

/** "Replace 3.Bc4 with 3.d4?" with the premoves built on the waiting move. */
export function replaceWaitingMessage(
  fen: string,
  waiting: WaitingMove,
  uci: string,
  premoves: number,
): string {
  return [
    t('app.game.premove_replace_confirm', {
      old: moveLabel(fen, waiting.uci),
      new: moveLabel(fen, uci),
    }),
    premoves === 1
      ? t('app.game.premove_replace_waiting_one', { move: waiting.san })
      : t('app.game.premove_replace_waiting', { n: premoves, move: waiting.san }),
  ].join('\n');
}

/** "Remove 3…Nf6 and the 4 moves after it?" */
export function removeMessage(move: string, after: number): string {
  if (after === 0) return t('app.game.premove_remove_confirm', { move });
  if (after === 1) return t('app.game.premove_remove_confirm_next', { move });
  return t('app.game.premove_remove_confirm_rest', { move, n: after });
}

/** "Removed 3…Nf6 and 4 moves after it" */
export function removedMessage(move: string, after: number): string {
  if (after === 0) return t('app.game.premove_removed', { move });
  if (after === 1) return t('app.game.premove_removed_next', { move });
  return t('app.game.premove_removed_rest', { move, n: after });
}
