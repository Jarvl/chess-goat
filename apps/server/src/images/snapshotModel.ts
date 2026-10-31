import {
  avatarColour,
  flairById,
  isProvisional,
  material,
  personInitial,
  ratingLabel,
  t,
  type Colour,
  type EngineLevel,
  type GameResult,
  type GameStatus,
} from '@chess-goat/shared';
import type { BoardRenderInput } from './board';
import type { PieceCode } from './pieces';

export type SnapshotSide = {
  /** The user's id, which picks their avatar colour as it does in the Mini App. */
  id: string;
  name: string;
  isBot: boolean;
  rating: { rating: number; rd: number } | null;
  /** Set for the engine's side of a bot game; shown instead of a rating. */
  engineLevel: EngineLevel | null;
  /** What this game did to the rating, once it finished rated; null otherwise. */
  ratingChange: { before: number; after: number; rdAfter: number } | null;
  /** The player's stored Telegram photo (a small JPEG); null without one, and for the bot. */
  photo: Buffer | null;
  /** Worn flair ids in slot order (flair spec §2), as stored. */
  flair: readonly string[];
};

export type SnapshotInput = {
  ply: number;
  board: BoardRenderInput;
  white: SnapshotSide;
  black: SnapshotSide;
  status: GameStatus;
  result: GameResult | null;
  plyCount: number;
  /** A finished game keeps its result when voided; the card then names no winner. */
  voided: boolean;
  /** The bot's username, without the @, for the footer. */
  botUsername: string;
};

export type SnapshotAvatar =
  | { kind: 'bot' }
  /** `photo` is a JPEG data URI drawn over the initial; null leaves the initial showing. */
  | { kind: 'person'; initial: string; colour: string; photo: string | null };
export type SnapshotOutcome = 'won' | 'lost' | 'draw';

/** One player bar, already worded (share image spec, "Player bar"). */
export type SnapshotBar = {
  colour: Colour;
  avatar: SnapshotAvatar;
  name: string;
  /** Worn flair ids the catalog knows, in slot order, drawn after the name; none for the bot. */
  flair: string[];
  rating: string | null;
  /** `+16` or `−16`, beside a finished rated game's new rating. */
  ratingDelta: { label: string; gain: boolean } | null;
  /** The opponent's pieces this side took, biggest first. */
  captured: PieceCode[];
  /** `+N` when this side is ahead on material. */
  lead: string | null;
  /** The tag at the bar's end and the badge on this side's king. */
  result: { outcome: SnapshotOutcome; label: string } | null;
};

export type SnapshotModel = {
  board: BoardRenderInput;
  top: SnapshotBar;
  bottom: SnapshotBar;
  /** The bot's @username, in the footer. */
  handle: string;
};

/** The move a share names in its caption; the initial position counts as move 1. */
export function shareMoveNumber(ply: number): number {
  return Math.max(1, Math.ceil(ply / 2));
}

/** Only a finished game's final position has a result; aborted and voided games name none. */
function outcomes(input: SnapshotInput): Record<Colour, SnapshotOutcome> | null {
  if (input.status !== 'finished' || input.ply !== input.plyCount || input.voided) return null;
  if (input.result === '1-0') return { white: 'won', black: 'lost' };
  if (input.result === '0-1') return { white: 'lost', black: 'won' };
  if (input.result === '1/2-1/2') return { white: 'draw', black: 'draw' };
  return null;
}

/** The new rating and its change once the result shows; otherwise the rating as it stands. */
function rating(
  side: SnapshotSide,
  finished: boolean,
): Pick<SnapshotBar, 'rating' | 'ratingDelta'> {
  if (side.engineLevel) return { rating: t(`app.level.${side.engineLevel}`), ratingDelta: null };
  const change = finished ? side.ratingChange : null;
  if (change) {
    const delta = Math.round(change.after) - Math.round(change.before);
    return {
      rating: ratingLabel(change.after, isProvisional(change.rdAfter)),
      ratingDelta: delta
        ? { label: delta > 0 ? `+${delta}` : `−${-delta}`, gain: delta > 0 }
        : null,
    };
  }
  const current = side.rating
    ? ratingLabel(side.rating.rating, isProvisional(side.rating.rd))
    : null;
  return { rating: current, ratingDelta: null };
}

function bar(
  colour: Colour,
  side: SnapshotSide,
  input: SnapshotInput,
  outcome: SnapshotOutcome | null,
): SnapshotBar {
  const taken = material(input.board.fen)[colour];
  const opponent = colour === 'white' ? 'b' : 'w';
  return {
    colour,
    avatar: side.isBot
      ? { kind: 'bot' }
      : {
          kind: 'person',
          initial: personInitial(side.name),
          colour: avatarColour(side.id),
          photo: side.photo ? `data:image/jpeg;base64,${side.photo.toString('base64')}` : null,
        },
    name: side.name,
    flair: side.isBot ? [] : side.flair.filter((id) => flairById(id) !== undefined),
    ...rating(side, outcome !== null),
    captured: taken.captured.map((piece) => `${opponent}${piece.toUpperCase()}` as PieceCode),
    lead: taken.lead ? `+${taken.lead}` : null,
    result: outcome ? { outcome, label: t(`app.game.tag.${outcome}`) } : null,
  };
}

export function buildSnapshotModel(input: SnapshotInput): SnapshotModel {
  const result = outcomes(input);
  const white = bar('white', input.white, input, result?.white ?? null);
  const black = bar('black', input.black, input, result?.black ?? null);
  const whiteAtBottom = input.board.orientation === 'white';
  return {
    board: input.board,
    top: whiteAtBottom ? black : white,
    bottom: whiteAtBottom ? white : black,
    handle: `@${input.botUsername}`,
  };
}
