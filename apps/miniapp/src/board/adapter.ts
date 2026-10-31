import { sideToMove, type Colour } from '@chess-goat/shared';
import { Chessground } from 'chessground';
import type { Api } from 'chessground/api';
import type { Config } from 'chessground/config';
import type { Dests, Key } from 'chessground/types';

export type BoardPosition = {
  fen: string;
  lastMove: [string, string] | null;
  check: boolean;
  orientation: Colour;
  turnColour: Colour;
};

export type Movable = { colour: Colour | 'none'; dests: Map<string, string[]> };

export type MoveHandler = (orig: string, dest: string, meta: { captured: boolean }) => void;

export type SelectHandler = (square: string) => void;

/** The viewed premove's two squares, as chessground custom highlights (conditional premoves spec, The game screen). */
export function highlightSquares(squares: string[]): Map<Key, string> {
  return new Map(squares.map((square) => [square as Key, 'premove-sq']));
}

/** Spec §6.3: the seam around chessground; nothing else imports it. */
export interface BoardAdapter {
  setPosition(position: BoardPosition): void;
  setMovable(movable: Movable): void;
  setViewOnly(viewOnly: boolean): void;
  onMove(handler: MoveHandler): void;
  /** Marks the viewed premove's squares; `[]` clears them. */
  setHighlights(squares: string[]): void;
  /** Every tap on a square, for jumping to the end of the premove chain. */
  onSelect(handler: SelectHandler): void;
  flip(): void;
  /** Snaps a lifted or dropped piece back; the next `setPosition` restores the board. */
  cancelMove(): void;
  destroy(): void;
}

/**
 * The colour whose king is in check, for chessground. Given `true` it marks the `turnColor` king,
 * but in premove mode `turnColour` is the viewer (so they can lift pieces) while the checked king
 * is the opponent's: the side to move in the FEN is always the one in check.
 */
function checkedColour(position: BoardPosition): Colour | false {
  return position.check ? sideToMove(position.fen) : false;
}

function toDests(dests: Map<string, string[]>): Dests {
  const out: Dests = new Map();
  for (const [from, targets] of dests) out.set(from as Key, targets as Key[]);
  return out;
}

/** The full chessground configuration for a position; pure, so it can be unit-tested. */
export function boardConfig(
  position: BoardPosition,
  movable: Movable,
  viewOnly: boolean,
  onMove: MoveHandler,
  onSelect: SelectHandler = () => undefined,
): Config {
  return {
    fen: position.fen,
    orientation: position.orientation,
    turnColor: position.turnColour,
    lastMove: position.lastMove ? (position.lastMove as [Key, Key]) : undefined,
    check: checkedColour(position),
    coordinates: true,
    viewOnly,
    disableContextMenu: true,
    blockTouchScroll: true,
    highlight: { lastMove: true, check: true },
    animation: { enabled: true, duration: 150 },
    movable: {
      free: false,
      // chessground lifts nothing when the colour is undefined; 'none' is our explicit name for it.
      color: movable.colour === 'none' ? undefined : movable.colour,
      dests: toDests(movable.dests),
      showDests: true,
      events: {
        after: (orig, dest, metadata) =>
          onMove(orig, dest, { captured: metadata.captured !== undefined }),
      },
    },
    premovable: { enabled: false },
    predroppable: { enabled: false },
    draggable: { enabled: true, showGhost: true },
    selectable: { enabled: true },
    drawable: { enabled: false },
    events: { select: (key) => onSelect(key) },
  };
}

class ChessgroundAdapter implements BoardAdapter {
  private readonly api: Api;
  private handler: MoveHandler = () => undefined;
  private selectHandler: SelectHandler = () => undefined;
  private position: BoardPosition;
  private movable: Movable = { colour: 'none', dests: new Map() };
  private viewOnly: boolean;

  constructor(element: HTMLElement, position: BoardPosition, viewOnly: boolean) {
    this.position = position;
    this.viewOnly = viewOnly;
    this.api = Chessground(element, this.config());
  }

  private config(): Config {
    return boardConfig(
      this.position,
      this.movable,
      this.viewOnly,
      (orig, dest, meta) => this.handler(orig, dest, meta),
      (square) => this.selectHandler(square),
    );
  }

  setPosition(position: BoardPosition): void {
    this.position = position;
    // chessground drops `movable.dests` after a user move; a restored position brings them back.
    this.api.set({
      fen: position.fen,
      orientation: position.orientation,
      turnColor: position.turnColour,
      lastMove: position.lastMove ? (position.lastMove as [Key, Key]) : undefined,
      check: checkedColour(position),
      movable: {
        color: this.movable.colour === 'none' ? undefined : this.movable.colour,
        dests: toDests(this.movable.dests),
      },
    });
  }

  setMovable(movable: Movable): void {
    this.movable = movable;
    this.api.set({
      movable: {
        color: movable.colour === 'none' ? undefined : movable.colour,
        dests: toDests(movable.dests),
      },
    });
  }

  setViewOnly(viewOnly: boolean): void {
    this.viewOnly = viewOnly;
    this.api.set({ viewOnly });
  }

  onMove(handler: MoveHandler): void {
    this.handler = handler;
  }

  setHighlights(squares: string[]): void {
    this.api.set({ highlight: { custom: highlightSquares(squares) } });
  }

  onSelect(handler: SelectHandler): void {
    this.selectHandler = handler;
  }

  flip(): void {
    this.api.toggleOrientation();
  }

  cancelMove(): void {
    this.api.cancelMove();
  }

  destroy(): void {
    this.api.destroy();
  }
}

export function createBoardAdapter(
  element: HTMLElement,
  position: BoardPosition,
  options: { viewOnly?: boolean } = {},
): BoardAdapter {
  return new ChessgroundAdapter(element, position, options.viewOnly ?? false);
}
