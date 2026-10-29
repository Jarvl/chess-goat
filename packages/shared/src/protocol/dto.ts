import { z } from 'zod';
import { MAX_WORN_FLAIR } from '../flair/catalog';
import {
  ChallengeStatusSchema,
  ColourChoiceSchema,
  ColourSchema,
  EndReasonSchema,
  EngineLevelSchema,
  GameResultSchema,
  GameStatusSchema,
  MoveConfirmationsSchema,
  TimePerMoveSchema,
  ViewerRoleSchema,
} from './enums';
import { PublicIdSchema, UserIdSchema } from './ids';

export const UciSchema = z.string().regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/);

export type Uci = z.infer<typeof UciSchema>;

/** A premove tree on the wire: base64url without padding, `''` for the empty tree (premove tree codec). */
export const PremoveTreeTextSchema = z.string().regex(/^[A-Za-z0-9_-]*$/);

/** Timestamps travel as ISO-8601 UTC strings, exactly what `Date#toISOString()` produces. */
export const IsoDateSchema = z.iso.datetime();

export const PlayerRefSchema = z.object({
  id: UserIdSchema,
  name: z.string(),
  username: z.string().nullable(),
  /**
   * Rounded rating in this group: the live value everywhere, except for the players of a finished
   * rated game, where it is the rating when that game started (`*_rating_before`). 1500 and
   * provisional before the first rated game.
   */
  rating: z.number().int(),
  provisional: z.boolean(),
  /** The bot opponent: drawn as the Chess Goat mark, with its level instead of a rating. */
  isBot: z.boolean(),
  /** The player's Telegram photo on this server; null without one, and always for the bot and deleted players. */
  photoUrl: z.string().nullable(),
  /** Worn flair ids in slot order; the app skips ids it does not know. */
  flair: z.array(z.string()).max(MAX_WORN_FLAIR).default([]),
});

export type PlayerRef = z.infer<typeof PlayerRefSchema>;

export const GamePlayerSchema = PlayerRefSchema.extend({
  /** The `*_rating_after` snapshot; null while the game runs and for casual, aborted or voided games. */
  ratingAfter: z.number().int().nullable(),
  provisionalAfter: z.boolean().nullable(),
});

export type GamePlayer = z.infer<typeof GamePlayerSchema>;

export const MoveDtoSchema = z.object({
  ply: z.number().int().min(1),
  uci: UciSchema,
  san: z.string().min(1),
  fenAfter: z.string().min(1),
  playedAt: IsoDateSchema,
});

export type MoveDto = z.infer<typeof MoveDtoSchema>;

export const DrawOfferSchema = z.object({
  by: ColourSchema,
  atPly: z.number().int().min(0),
});

export type DrawOffer = z.infer<typeof DrawOfferSchema>;

export const ClaimsSchema = z.object({
  threefold: z.boolean(),
  fiftyMove: z.boolean(),
});

export const GroupRefSchema = z.object({
  id: PublicIdSchema,
  title: z.string(),
});

export type GroupRef = z.infer<typeof GroupRefSchema>;

export const GameDtoSchema = z.object({
  id: PublicIdSchema,
  group: GroupRefSchema,
  status: GameStatusSchema,
  white: GamePlayerSchema,
  black: GamePlayerSchema,
  timePerMove: TimePerMoveSchema,
  rated: z.boolean(),
  fen: z.string().min(1),
  plyCount: z.number().int().min(0),
  version: z.number().int().min(0),
  moves: z.array(MoveDtoSchema),
  deadlineAt: IsoDateSchema.nullable(),
  serverTime: IsoDateSchema,
  drawOffer: DrawOfferSchema.nullable(),
  claims: ClaimsSchema,
  viewerRole: ViewerRoleSchema,
  result: GameResultSchema.nullable(),
  endReason: EndReasonSchema.nullable(),
  voided: z.boolean(),
  startedAt: IsoDateSchema,
  finishedAt: IsoDateSchema.nullable(),
  /** The bot level when this is a game against the bot, otherwise null. */
  engineLevel: EngineLevelSchema.nullable(),
  /** The viewer's own premove chain while it is not their turn; `[]` for everyone else (premoves spec). */
  premoves: z.array(UciSchema).default([]),
  /** The viewer's own premove tree while it is not their turn; `''` for everyone else. */
  premoveTree: PremoveTreeTextSchema.default(''),
  /** Only present once the game is finished (spec §7.6). */
  lichessUrl: z.url().optional(),
  analysisUrl: z.url().optional(),
});

export type GameDto = z.infer<typeof GameDtoSchema>;

export const GameSummarySchema = z.object({
  id: PublicIdSchema,
  white: PlayerRefSchema,
  black: PlayerRefSchema,
  status: GameStatusSchema,
  timePerMove: TimePerMoveSchema,
  rated: z.boolean(),
  plyCount: z.number().int().min(0),
  sideToMove: ColourSchema,
  yourTurn: z.boolean(),
  deadlineAt: IsoDateSchema.nullable(),
  lastMoveAt: IsoDateSchema.nullable(),
  startedAt: IsoDateSchema,
  finishedAt: IsoDateSchema.nullable(),
  result: GameResultSchema.nullable(),
  endReason: EndReasonSchema.nullable(),
  voided: z.boolean(),
  /** The current position, drawn as the row's thumbnail. */
  fen: z.string().min(1),
  /** The last move played, tinted on the thumbnail; null before the first move. */
  lastMove: UciSchema.nullable(),
  /** The bot level when this is a game against the bot, otherwise null (mirrors `GameDto`). */
  engineLevel: EngineLevelSchema.nullable(),
});

export type GameSummary = z.infer<typeof GameSummarySchema>;

export const ChallengeDtoSchema = z.object({
  id: PublicIdSchema,
  challenger: PlayerRefSchema,
  opponent: PlayerRefSchema.nullable(),
  timePerMove: TimePerMoveSchema,
  challengerColour: ColourChoiceSchema,
  rated: z.boolean(),
  status: ChallengeStatusSchema,
  createdAt: IsoDateSchema,
  expiresAt: IsoDateSchema,
  viewer: z.object({
    canAccept: z.boolean(),
    canDecline: z.boolean(),
    canCancel: z.boolean(),
  }),
});

export type ChallengeDto = z.infer<typeof ChallengeDtoSchema>;

export const WinDrawLossSchema = z.object({
  wins: z.number().int().min(0),
  draws: z.number().int().min(0),
  losses: z.number().int().min(0),
});

export type WinDrawLoss = z.infer<typeof WinDrawLossSchema>;

export const LeaderboardEntrySchema = PlayerRefSchema.extend({
  gamesPlayed: z.number().int().min(0),
  record: WinDrawLossSchema,
});

export type LeaderboardEntry = z.infer<typeof LeaderboardEntrySchema>;

export const GroupSettingsSchema = z.object({
  defaultTimePerMove: TimePerMoveSchema,
  ratedDefault: z.boolean(),
  allowOpenChallenges: z.boolean(),
  cardTopicMode: z.enum(['origin', 'fixed']),
  fixedTopicId: z.number().int().positive().nullable(),
});

export type GroupSettings = z.infer<typeof GroupSettingsSchema>;

export const GROUP_SETTINGS_DEFAULTS: GroupSettings = {
  defaultTimePerMove: 259200,
  ratedDefault: true,
  allowOpenChallenges: true,
  cardTopicMode: 'origin',
  fixedTopicId: null,
};

export const FinishedPageDtoSchema = z.object({
  items: z.array(GameSummarySchema),
  nextCursor: z.string().nullable(),
});

export type FinishedPageDto = z.infer<typeof FinishedPageDtoSchema>;

export const LobbyDtoSchema = z.object({
  group: GroupRefSchema,
  isAdmin: z.boolean(),
  settings: GroupSettingsSchema.pick({
    defaultTimePerMove: true,
    ratedDefault: true,
    allowOpenChallenges: true,
  }),
  /** Active games, the viewer's "your move" games first. */
  active: z.array(GameSummarySchema),
  finished: FinishedPageDtoSchema,
  challenges: z.array(ChallengeDtoSchema),
  players: z.array(LeaderboardEntrySchema),
});

export type LobbyDto = z.infer<typeof LobbyDtoSchema>;

export const PlayersPickerDtoSchema = z.object({
  players: z.array(PlayerRefSchema),
  /** The group's challenge defaults, so the form is right however it was reached. */
  settings: LobbyDtoSchema.shape.settings,
  /**
   * Deliberately not a `PlayerRef`: no screen can render the bot as if it were a human, and it
   * never carries a rating. Null when the engine is unavailable or switched off — a present `bot`
   * always has at least one level, so the picker never has to invent one.
   */
  bot: z.object({ levels: z.array(EngineLevelSchema).min(1) }).nullable(),
});

export type PlayersPickerDto = z.infer<typeof PlayersPickerDtoSchema>;

export const PlayerPageDtoSchema = z.object({
  player: LeaderboardEntrySchema,
  /** The viewer's record against this player. */
  headToHead: WinDrawLossSchema,
  recentGames: z.array(GameSummarySchema),
});

export type PlayerPageDto = z.infer<typeof PlayerPageDtoSchema>;

export const PrefsSchema = z.object({
  notifications: z.boolean(),
  moveConfirmations: MoveConfirmationsSchema,
  boardTheme: z.string().max(32).nullable(),
  pieceSet: z.string().max(32).nullable(),
});

export type Prefs = z.infer<typeof PrefsSchema>;

export const PREFS_DEFAULTS: Prefs = {
  notifications: true,
  moveConfirmations: 'people',
  boardTheme: null,
  pieceSet: null,
};

export const MeGroupsDtoSchema = z.object({
  groups: z.array(
    GroupRefSchema.extend({
      activeGames: z.number().int().min(0),
      yourMove: z.number().int().min(0),
    }),
  ),
});

export type MeGroupsDto = z.infer<typeof MeGroupsDtoSchema>;

/** An active game on the home screen; it names its group because the list spans all of them. */
export const MeGameSummarySchema = GameSummarySchema.extend({ group: GroupRefSchema });

export type MeGameSummary = z.infer<typeof MeGameSummarySchema>;

export const MeGamesDtoSchema = z.object({
  /** The viewer's active games across every group, their own turn first (spec §9 `GET /me/games`). */
  items: z.array(MeGameSummarySchema),
});

export type MeGamesDto = z.infer<typeof MeGamesDtoSchema>;

export const GroupSettingsDtoSchema = z.object({
  group: GroupRefSchema,
  settings: GroupSettingsSchema,
  blocked: z.array(PlayerRefSchema),
  botIsAdmin: z.boolean(),
  isForum: z.boolean(),
});

export type GroupSettingsDto = z.infer<typeof GroupSettingsDtoSchema>;

/** Where the app lands after `POST /launch`, with that screen's data (spec §6.1 step 3). */
export const LaunchRouteSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('game'), game: GameDtoSchema }),
  z.object({ kind: z.literal('lobby'), lobby: LobbyDtoSchema }),
  /** A "challenge someone" link: the lobby's data, landed with New game on top of it. */
  z.object({ kind: z.literal('newGame'), lobby: LobbyDtoSchema }),
  z.object({ kind: z.literal('settings'), settings: GroupSettingsDtoSchema }),
  z.object({ kind: z.literal('home'), games: MeGamesDtoSchema }),
  z.object({ kind: z.literal('locked'), group: GroupRefSchema }),
]);

export type LaunchRoute = z.infer<typeof LaunchRouteSchema>;

export const LaunchResponseSchema = z.object({
  token: z.string().min(1),
  user: z.object({
    id: UserIdSchema,
    name: z.string(),
    username: z.string().nullable(),
  }),
  prefs: PrefsSchema,
  /** True when the write-access prompt has never been shown to this user (spec §6.1 step 4). */
  askWriteAccess: z.boolean(),
  /**
   * Active games across every visible group that are waiting on this user: the Games tab badge.
   * It ships with the launch so a deep link into one game still shows the true total.
   */
  yourMove: z.number().int().min(0),
  route: LaunchRouteSchema,
  serverTime: IsoDateSchema,
  bot: z.object({
    username: z.string(),
    miniAppShortName: z.string(),
  }),
});

export type LaunchResponse = z.infer<typeof LaunchResponseSchema>;

/** A short-lived download link for a game's PGN; its token opens nothing else (spec §9). */
export const PgnLinkDtoSchema = z.object({ url: z.string().min(1) });

export type PgnLinkDto = z.infer<typeof PgnLinkDtoSchema>;

export const OkDtoSchema = z.object({ ok: z.literal(true) });

export type OkDto = z.infer<typeof OkDtoSchema>;

/** Tip jar spec §2.1: the invoice link the Mini App hands to `WebApp.openInvoice`. */
export const TipInvoiceDtoSchema = z.object({ url: z.string().min(1) });

export type TipInvoiceDto = z.infer<typeof TipInvoiceDtoSchema>;

/** One flair the viewer has earned (flair spec §4). */
export const FlairEarnedSchema = z.object({
  /** A catalog id; the server leaves out rows whose id the catalog no longer has. */
  id: z.string(),
  /** The finish time of the game that earned it. */
  earnedAt: IsoDateSchema,
  /** The display name of the other player in that game, "Deleted player" once they are gone. */
  opponent: z.string(),
});

export type FlairEarned = z.infer<typeof FlairEarnedSchema>;

/** The viewer's own flair (flair spec §4): what they wear, in slot order, and what they have earned. */
export const FlairDtoSchema = z.object({
  worn: z.array(z.string()).max(MAX_WORN_FLAIR),
  /** In catalog order. */
  earned: z.array(FlairEarnedSchema),
});

export type FlairDto = z.infer<typeof FlairDtoSchema>;
