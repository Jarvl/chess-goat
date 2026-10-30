import {
  applyMove,
  decodePremoveTree,
  encodePremoveTree,
  imaginedBoard,
  INITIAL_FEN,
  legalDests,
  sideToMove,
  type Colour,
  type DraftNode,
  type GameDto,
  type PremoveNode,
} from '@group-chess/shared';
import { batch, computed, signal, type ReadonlySignal, type Signal } from '@preact/signals';
import { Chess } from 'chess.js';
import { fenAt, isPrefix, nodeAt } from './premoveDraft';
import { buildTimeline, timelineTarget, type Timeline } from './premoveTimeline';
import { premoveLabel, sameList } from './premoves';

export type Position = {
  ply: number;
  fen: string;
  lastMove: [string, string] | null;
  check: boolean;
};

export type Notice =
  | 'draw_offered'
  | 'draw_declined'
  | 'opponent_moved'
  | 'finished'
  | 'premove_played'
  | 'premoves_cancelled'
  | 'premove_draft_discarded';

/** The board while premoves are built (conditional premoves spec, Mini App: Board). */
export type BuildView = {
  position: Position;
  turn: Colour;
  dests: Map<string, string[]>;
  canMove: boolean;
};

/** The player's own move, played but waiting for Confirm move. */
export type WaitingMove = { uci: string; san: string };

/**
 * The server tree a draft was started on, and the ply it belongs to: every save of the draft names
 * it as its base, so a tree another device saved meanwhile is refused, never overwritten. `draft`
 * tells drafts apart: a new one starts whenever the draft starts over.
 */
export type DraftBase = { draft: number; tree: string; ply: number };

/** The draft as a replace popup found it, so Cancel can put it back exactly. */
export type DraftSnapshot = {
  base: DraftBase | null;
  waiting: WaitingMove | null;
  draftTree: DraftNode[] | null;
  selected: string[];
  trail: string[];
  viewingPly: number | null;
};

/** A tree the server sent; one that does not decode reads as empty rather than breaking the view. */
function readTree(text: string): PremoveNode[] {
  try {
    return decodePremoveTree(text);
  } catch {
    return [];
  }
}

/** The tree's wire form, or null when the codec refuses it. */
function encodeOrNull(tree: readonly DraftNode[]): string | null {
  try {
    return encodePremoveTree(tree);
  } catch {
    return null;
  }
}

function samePath(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && isPrefix(a, b);
}

function squares(uci: string): [string, string] {
  return [uci.slice(0, 2), uci.slice(2, 4)];
}

function inCheck(fen: string): boolean {
  try {
    return new Chess(fen).inCheck();
  } catch {
    return false;
  }
}

/** The position after `ply` plies; ply 0 is the initial position. */
export function positionAt(dto: GameDto, ply: number): Position {
  if (ply <= 0) return { ply: 0, fen: INITIAL_FEN, lastMove: null, check: false };
  const move = dto.moves[ply - 1];
  const fen = move ? move.fenAfter : dto.fen;
  return {
    ply: move ? move.ply : dto.plyCount,
    fen,
    lastMove: move ? [move.uci.slice(0, 2), move.uci.slice(2, 4)] : null,
    check: inCheck(fen),
  };
}

/**
 * Conditional premoves spec, Notices: walks the moves after `prev`'s ply against `prev`'s tree.
 * Each opponent move that matched a branch and was followed by its reply is a fired pair; the walk
 * stops where a line runs out (nothing cancelled) or on an opponent move the remaining tree has no
 * branch for (the server cleared the tree).
 */
function premoveNotices(prev: GameDto, next: GameDto): Notice[] {
  let level = readTree(prev.premoveTree);
  let index = prev.plyCount;
  let fired = 0;
  let cancelled = false;
  while (level.length > 0) {
    const opponent = next.moves[index];
    if (!opponent) break;
    const branch = level.find((entry) => entry.move === opponent.uci);
    if (!branch) {
      cancelled = true;
      break;
    }
    if (next.moves[index + 1]?.uci !== branch.reply) break;
    fired += 1;
    level = branch.children;
    index += 2;
  }
  const notices: Notice[] = [];
  if (fired >= 1) notices.push('premove_played');
  if (cancelled) notices.push('premoves_cancelled');
  return notices;
}

/**
 * Spec §6.4: banners come from the diff between consecutive states, never from separate events.
 * `discardedDraft` says the store held unconfirmed premove changes before `next` was applied:
 * a new ply or a game end throws them away (conditional premoves spec, Sending it).
 */
export function diffNotices(
  prev: GameDto,
  next: GameDto,
  options: { discardedDraft?: boolean } = {},
): Notice[] {
  const notices: Notice[] = [];
  const viewer = next.viewerRole;
  const movedOn = next.plyCount !== prev.plyCount || next.status !== prev.status;
  const discarded: Notice[] = options.discardedDraft && movedOn ? ['premove_draft_discarded'] : [];
  if (prev.status === 'active' && next.status === 'finished') {
    notices.push('finished', ...discarded);
    return notices;
  }
  if (next.drawOffer && !prev.drawOffer && next.drawOffer.by !== viewer)
    notices.push('draw_offered');
  if (
    prev.drawOffer &&
    prev.drawOffer.by === viewer &&
    !next.drawOffer &&
    next.plyCount === prev.plyCount &&
    next.status === 'active'
  ) {
    notices.push('draw_declined');
  }
  if (
    next.plyCount > prev.plyCount &&
    next.status === 'active' &&
    (viewer === 'white' || viewer === 'black') &&
    sideToMove(next.fen) === viewer
  ) {
    notices.push('opponent_moved');
  }
  if (next.plyCount > prev.plyCount && next.status === 'active') {
    notices.push(...premoveNotices(prev, next));
  }
  notices.push(...discarded);
  return notices;
}

export class GameStore {
  readonly dto: Signal<GameDto>;
  /** null shows the latest position; a number shows an earlier one view-only (spec §6.3). */
  readonly viewingPly: Signal<number | null> = signal(null);
  readonly flipped: Signal<boolean> = signal(false);
  readonly position: ReadonlySignal<Position>;
  readonly isLatest: ReadonlySignal<boolean>;
  readonly orientation: ReadonlySignal<Colour>;
  readonly sideToMove: ReadonlySignal<Colour>;
  readonly canMove: ReadonlySignal<boolean>;
  readonly dests: ReadonlySignal<Map<string, string[]>>;
  /**
   * The chain the player has made but the server hasn't confirmed yet. A state from the server
   * replaces it, except a same-ply one while a save is running: the save owns it until it settles
   * (premoves spec, Queuing).
   */
  readonly optimisticPremoves: Signal<string[] | null> = signal(null);
  /** null is the end of the chain; 0 the current position; k the position after premove k. */
  readonly premoveStep: Signal<number | null> = signal(null);
  /** A premove save is running. The board stays live; further edits wait their turn. */
  readonly premoveSending: Signal<boolean> = signal(false);
  /**
   * True while the player's own move is anywhere short of settled (waiting for Confirm, sending,
   * retrying). The stream can already show the opponent's turn then, but every drop would be
   * refused until the move settles, so the board offers no premoves meanwhile.
   */
  readonly moveBusy: Signal<boolean> = signal(false);
  readonly premoves: ReadonlySignal<string[]>;
  /** Premoves are possible: the player waits on the opponent. True while an earlier move is shown. */
  readonly premoveOpen: ReadonlySignal<boolean>;
  /** Premoves are possible and the latest position is shown, so the board shows the chain. */
  readonly premoveMode: ReadonlySignal<boolean>;
  /** The slider's last index: the real plies, then the premoves while they are possible. */
  readonly timelineEnd: ReadonlySignal<number>;
  /** Where the slider stands: a ply, or past the last one, a premove step. */
  readonly timelineAt: ReadonlySignal<number>;
  readonly shownStep: ReadonlySignal<number>;
  readonly atChainEnd: ReadonlySignal<boolean>;
  readonly boardView: ReadonlySignal<Position>;
  readonly boardTurn: ReadonlySignal<Colour>;
  readonly premoveSquares: ReadonlySignal<string[]>;
  readonly premoveLabels: ReadonlySignal<string[]>;

  // Conditional premoves (spec, Mini App: Server state vs draft). These sit beside the blind-chain
  // signals above until GameView switches over to them.
  /** The viewer's tree as the server last sent it. */
  readonly serverTree: ReadonlySignal<PremoveNode[]>;
  /** The player's move waiting for Confirm move; GameView sets it from the move machine. */
  readonly waiting: Signal<WaitingMove | null> = signal(null);
  /** The tree being edited; null means no edits, so the server tree shows. */
  readonly draftTree: Signal<DraftNode[] | null> = signal(null);
  readonly tree: ReadonlySignal<DraftNode[]>;
  /** The path from the tree's root to the shown position (opponent move, reply, …). */
  readonly selected: Signal<string[]> = signal([]);
  /** The line last visited, so stepping back and forward again returns to the same branch. */
  readonly trail: Signal<string[]> = signal([]);
  readonly building: ReadonlySignal<boolean>;
  /** The tree's root position: the real one, or the one after the waiting move. */
  readonly rootFen: ReadonlySignal<string>;
  /** The draft holds changes the server has not confirmed: a waiting move or premove edits. */
  readonly draftDirty: ReadonlySignal<boolean>;
  /** The draft's premoves differ from the server's; a waiting move alone does not count. */
  readonly premoveDraftChanged: ReadonlySignal<boolean>;
  readonly timeline: ReadonlySignal<Timeline>;
  readonly buildView: ReadonlySignal<BuildView>;
  /**
   * The board shows the draft but takes no drops: the player's move, or the draft confirmed with
   * Confirm premoves, is on its way to the server.
   */
  readonly locked: Signal<boolean> = signal(false);
  /** What the open draft builds on; null while there is no draft. */
  readonly draftBase: Signal<DraftBase | null> = signal(null);
  private drafts = 0;
  /** The selected premove's squares, for chessground's custom highlights. */
  readonly highlights: ReadonlySignal<string[]>;

  constructor(initial: GameDto) {
    this.dto = signal(initial);
    this.isLatest = computed(() => this.viewingPly.value === null);
    this.position = computed(() =>
      positionAt(this.dto.value, this.viewingPly.value ?? this.dto.value.plyCount),
    );
    this.orientation = computed(() => {
      const own: Colour = this.dto.value.viewerRole === 'black' ? 'black' : 'white';
      return this.flipped.value ? (own === 'white' ? 'black' : 'white') : own;
    });
    this.sideToMove = computed(() => sideToMove(this.position.value.fen));
    this.premoves = computed(() => this.optimisticPremoves.value ?? this.dto.value.premoves);
    this.premoveOpen = computed(() => {
      const dto = this.dto.value;
      return (
        dto.status === 'active' &&
        (dto.viewerRole === 'white' || dto.viewerRole === 'black') &&
        sideToMove(dto.fen) !== dto.viewerRole &&
        !this.moveBusy.value
      );
    });
    this.premoveMode = computed(() => this.premoveOpen.value && this.isLatest.value);
    this.shownStep = computed(() =>
      Math.min(this.premoveStep.value ?? Number.POSITIVE_INFINITY, this.premoves.value.length),
    );
    this.atChainEnd = computed(() => this.shownStep.value === this.premoves.value.length);
    this.timelineEnd = computed(
      () => this.dto.value.plyCount + (this.premoveOpen.value ? this.premoves.value.length : 0),
    );
    this.timelineAt = computed(() =>
      this.premoveMode.value
        ? this.dto.value.plyCount + this.shownStep.value
        : this.position.value.ply,
    );
    // The queue belongs to the viewer; an entry that would move the other side's piece (one that
    // captured the piece it was queued for) is skipped, as the server's check skips it.
    const owner = (): Colour | undefined => {
      const role = this.dto.value.viewerRole;
      return role === 'white' || role === 'black' ? role : undefined;
    };
    const imagined = (count: number) =>
      imaginedBoard(this.dto.value.fen, this.premoves.value.slice(0, count), owner());
    // The board shows what buildView shows: the real position, an earlier one, or a position in
    // the premove tree while building (conditional premoves spec, Mini App: Board).
    this.boardView = computed(() => this.buildView.value.position);
    this.boardTurn = computed(() => this.buildView.value.turn);
    this.premoveSquares = computed(() => {
      const step = this.shownStep.value;
      const uci = this.premoveMode.value && step > 0 ? this.premoves.value[step - 1] : undefined;
      return uci ? [uci.slice(0, 2), uci.slice(2, 4)] : [];
    });
    this.premoveLabels = computed(() =>
      this.premoves.value.map((uci, index) => premoveLabel(imagined(index), uci, owner())),
    );
    this.canMove = computed(() => this.buildView.value.canMove);
    this.dests = computed(() => this.buildView.value.dests);
    this.highlights = computed(() => {
      const last = this.selected.value.at(-1);
      return this.building.value && this.viewingPly.value === null && last ? squares(last) : [];
    });

    this.serverTree = computed(() => readTree(this.dto.value.premoveTree));
    this.tree = computed(() => this.draftTree.value ?? this.serverTree.value);
    // The board is live for both sides on the opponent's turn, and on the player's own turn once
    // their move is played and waits for Confirm. `moveBusy` is true from that drop until the move
    // settles, so it only stops building while no move waits: when the move is sending or retrying.
    this.building = computed(() => {
      const dto = this.dto.value;
      const viewer = dto.viewerRole;
      if (dto.status !== 'active' || (viewer !== 'white' && viewer !== 'black')) return false;
      if (this.waiting.value !== null) return true;
      return sideToMove(dto.fen) !== viewer && !this.moveBusy.value;
    });
    this.rootFen = computed(() => {
      const fen = this.dto.value.fen;
      const waiting = this.waiting.value;
      if (!waiting) return fen;
      const result = applyMove(fen, [], waiting.uci);
      return result.legal ? result.fenAfter : fen;
    });
    const encodedServerTree = computed(() => encodeOrNull(this.serverTree.value) ?? '');
    this.premoveDraftChanged = computed(() => {
      const draft = this.draftTree.value;
      if (draft === null) return false;
      // A draft the codec refuses (too many siblings) cannot equal what the server holds.
      const text = encodeOrNull(draft);
      return text === null || text !== encodedServerTree.value;
    });
    this.draftDirty = computed(() => this.waiting.value !== null || this.premoveDraftChanged.value);
    this.timeline = computed(() =>
      buildTimeline({
        plies: this.dto.value.plyCount,
        waiting: this.waiting.value !== null,
        tree: this.tree.value,
        selected: this.selected.value,
        trail: this.trail.value,
        earlierPly: this.viewingPly.value,
      }),
    );
    this.buildView = computed(() => {
      const view = this.computeBuildView();
      return this.locked.value && view.canMove
        ? { ...view, canMove: false, dests: new Map<string, string[]>() }
        : view;
    });
  }

  private computeBuildView(): BuildView {
    const dto = this.dto.value;
    const viewer = dto.viewerRole;
    const viewing = this.viewingPly.value;
    const waiting = this.waiting.value;
    const none = new Map<string, string[]>();
    if (viewing !== null) {
      const position = positionAt(dto, viewing);
      // The position before the waiting move: playing another move there replaces it.
      if (waiting && viewing === dto.plyCount && this.building.value) {
        return {
          position,
          turn: viewer as Colour,
          dests: legalDests(dto.fen),
          canMove: true,
        };
      }
      return { position, turn: sideToMove(position.fen), dests: none, canMove: false };
    }
    if (!this.building.value) {
      const position = positionAt(dto, dto.plyCount);
      const canMove =
        dto.status === 'active' &&
        (viewer === 'white' || viewer === 'black') &&
        sideToMove(dto.fen) === viewer;
      return {
        position,
        turn: sideToMove(dto.fen),
        dests: canMove ? legalDests(dto.fen) : none,
        canMove,
      };
    }
    let selected: readonly string[] = this.selected.value;
    let fen: string;
    try {
      fen = fenAt(this.rootFen.value, selected);
    } catch {
      // A selection the position no longer allows shows the root rather than breaking the board.
      selected = [];
      fen = this.rootFen.value;
    }
    const last = selected.at(-1) ?? waiting?.uci;
    const position: Position = {
      ply: dto.plyCount + (waiting ? 1 : 0) + selected.length,
      fen,
      lastMove: last ? squares(last) : positionAt(dto, dto.plyCount).lastMove,
      check: inCheck(fen),
    };
    return { position, turn: sideToMove(fen), dests: legalDests(fen), canMove: true };
  }

  /**
   * Applies a newer snapshot; an older or equal version is ignored and leaves the signals alone,
   * so a refresh that brings nothing new does not re-render the board. Returns whether it applied.
   */
  apply(next: GameDto): boolean {
    const current = this.dto.value;
    if (next.version < current.version) return false;
    if (
      next.version === current.version &&
      next.plyCount === current.plyCount &&
      next.status === current.status &&
      sameList(next.premoves, current.premoves) &&
      next.premoveTree === current.premoveTree
    ) {
      return false;
    }
    // One batch, so no effect sees the new state beside the old draft, selection or view.
    batch(() => this.applyNext(current, next));
    return true;
  }

  private applyNext(current: GameDto, next: GameDto): void {
    const viewing = this.viewingPly.value;
    this.dto.value = next;
    const samePly = next.plyCount === current.plyCount && next.status === current.status;
    // A new ply or a game end voids the draft (conditional premoves spec, Sending it); a same-ply
    // state only replaces the server tree.
    if (!samePly) this.resetDraft();
    if (!(this.premoveSending.value && samePly)) this.optimisticPremoves.value = null;
    // The step clamps to the end when the game moves on, or when the chain shrinks to at or
    // below it — otherwise a later append would jump the view back to a stale step (fix round 1).
    if (
      next.plyCount !== current.plyCount ||
      next.premoves.length <= (this.premoveStep.value ?? Number.POSITIVE_INFINITY)
    ) {
      this.premoveStep.value = null;
    }
    // A player reading an old position is brought back when the game moves on; spectators stay.
    if (viewing !== null && next.plyCount > current.plyCount && next.viewerRole !== 'spectator') {
      this.viewingPly.value = null;
    }
  }

  viewPly(ply: number | null): void {
    const max = this.dto.value.plyCount;
    this.viewingPly.value = ply === null || ply >= max ? null : Math.max(0, ply);
  }

  /**
   * Shows index `index` on the slider. While a blind chain is shown the old chain slider rules
   * apply; otherwise the conditional premove timeline does: an earlier ply (the one before the
   * waiting move included) or a position along the line being viewed. Returns whether the view
   * changed.
   */
  viewTimeline(index: number): boolean {
    if (this.premoves.value.length > 0) return this.viewChainTimeline(index);
    const timeline = this.timeline.value;
    const target = timelineTarget(timeline, index);
    if (
      target.earlierPly === this.viewingPly.value &&
      samePath(target.selected, this.selected.value)
    ) {
      return false;
    }
    batch(() => {
      this.viewingPly.value = target.earlierPly;
      this.selected.value = target.selected;
      this.trail.value = timeline.line;
    });
    return true;
  }

  /** Clears the draft: the waiting move, the edited tree, and where it was looked at. */
  resetDraft(): void {
    batch(() => {
      this.draftTree.value = null;
      this.draftBase.value = null;
      this.waiting.value = null;
      this.selected.value = [];
      this.trail.value = [];
      // Without a waiting move, the position before it is simply the latest one.
      const viewing = this.viewingPly.value;
      if (viewing !== null && viewing >= this.dto.value.plyCount) this.viewingPly.value = null;
    });
  }

  /** Starts (or swaps) the waiting move: the tree is rooted after it, so the draft starts over. */
  setWaiting(move: WaitingMove): void {
    batch(() => {
      this.waiting.value = move;
      this.draftTree.value = null;
      this.draftBase.value = null;
      this.selected.value = [];
      this.trail.value = [];
      this.viewingPly.value = null;
    });
  }

  /**
   * Puts an edited tree in the draft and shows `path`. The first edit starts the draft on the
   * tree the server last sent.
   */
  editDraft(tree: DraftNode[], path: string[]): void {
    batch(() => {
      if (this.draftTree.value === null || this.draftBase.value === null) {
        this.drafts += 1;
        const dto = this.dto.value;
        this.draftBase.value = { draft: this.drafts, tree: dto.premoveTree, ply: dto.plyCount };
      }
      this.draftTree.value = tree;
      this.selected.value = path;
      this.viewingPly.value = null;
    });
  }

  snapshotDraft(): DraftSnapshot {
    return {
      base: this.draftBase.value,
      waiting: this.waiting.value,
      draftTree: this.draftTree.value,
      selected: this.selected.value,
      trail: this.trail.value,
      viewingPly: this.viewingPly.value,
    };
  }

  restoreDraft(snapshot: DraftSnapshot): void {
    batch(() => {
      // A save can move the same draft's base forward while a popup is open; that newer base is
      // what the server holds now, so it stays. Only a draft started since goes back.
      const current = this.draftBase.value;
      if (current === null || current.draft !== snapshot.base?.draft) {
        this.draftBase.value = snapshot.base;
      }
      this.waiting.value = snapshot.waiting;
      this.draftTree.value = snapshot.draftTree;
      this.selected.value = snapshot.selected;
      this.trail.value = snapshot.trail;
      this.viewingPly.value = snapshot.viewingPly;
    });
  }

  /** Shows the server tree again (a confirmed or refused draft), keeping what still exists of the selection. */
  dropDraftTree(): void {
    batch(() => {
      this.draftTree.value = null;
      this.draftBase.value = null;
      this.clampSelection();
    });
  }

  /** Cuts the selection back to the longest part of it that is still in the tree. */
  clampSelection(): void {
    const tree = this.tree.value;
    const path = this.selected.value;
    let length = path.length;
    while (length > 0 && nodeAt(tree, path.slice(0, length)).node === null) length -= 1;
    if (length < path.length) this.selected.value = path.slice(0, length);
  }

  /**
   * The blind chain's slider: a ply up to the last real move, a premove step past it. The last
   * real move with a chain queued is step 0, the real position.
   */
  private viewChainTimeline(at: number): boolean {
    const plies = this.dto.value.plyCount;
    const k = Math.max(0, Math.min(this.timelineEnd.value, at));
    if (k === this.timelineAt.value) return false;
    if (k < plies) {
      this.viewPly(k);
      return true;
    }
    this.viewPly(null);
    if (this.premoveOpen.value) this.viewPremove(k - plies);
    return true;
  }

  flip(): void {
    this.flipped.value = !this.flipped.value;
  }

  /** Views premove `step` (0 = the current position); returns whether the view changed. */
  viewPremove(step: number): boolean {
    const length = this.premoves.value.length;
    const k = Math.max(0, Math.min(length, step));
    if (k === this.shownStep.value) return false;
    this.premoveStep.value = k === length ? null : k;
    return true;
  }
}
