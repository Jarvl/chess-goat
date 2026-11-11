import type { ColourChoice } from '@chess-goat/shared';
import { eq } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { challenges, games, groups, users, type TurnLeaseRow, type UserRow } from '../db/schema';
import { getMatchNotes, textLength, BOT_NOTES_MAX, MATCH_NOTES_MAX } from './botNotes';
import { viewOf, type GameView } from './botView';
import { DomainError } from './errors';
import { QUOTE_NOTE, quoted } from './quoting';
import { displayName } from './users';

/**
 * The prompt a short agent session gets for one turn, and the loader for what it says. Small
 * local models read it, so the copy is short, fixed and in the order they must act.
 */

/** A challenge as the bot it is addressed to sees it. */
export type ChallengeTurnInfo = {
  from: string;
  group: string;
  timePerMove: number | null;
  rated: boolean;
  /** The colour the bot would play. */
  colour: ColourChoice;
  expiresAt: string;
};

export type TurnView =
  | { kind: 'challenge'; bot: string; challenge: ChallengeTurnInfo; botNotes: string }
  | {
      kind: 'move' | 'draw_offer';
      bot: string;
      game: GameView;
      premoveFailed?: { opponentMove: string; reply: string };
      botNotes: string;
      matchNotes: string;
    }
  | { kind: 'game_over'; bot: string; game: GameView; botNotes: string; matchNotes: string }
  | { kind: 'practice'; bot: string };

const turnEnded = (): DomainError =>
  new DomainError('stale_state', 'this turn has ended', { reason: 'turn_ended' });

const opposite = (colour: ColourChoice): ColourChoice =>
  colour === 'white' ? 'black' : colour === 'black' ? 'white' : 'random';

/** What the lease's turn is about, read for `bot`. Gone game or challenge: `turn_ended`. */
export async function loadTurnView(
  tx: DbOrTx,
  lease: TurnLeaseRow,
  bot: UserRow,
): Promise<TurnView> {
  const name = bot.firstName;
  if (lease.kind === 'practice') return { kind: 'practice', bot: name };
  const botNotes = bot.botNotes;

  if (lease.kind === 'challenge') {
    if (lease.challengeId === null) throw turnEnded();
    const [row] = await tx
      .select({ challenge: challenges, group: groups, challenger: users })
      .from(challenges)
      .innerJoin(groups, eq(groups.id, challenges.groupId))
      .innerJoin(users, eq(users.id, challenges.challengerId))
      .where(eq(challenges.id, lease.challengeId))
      .limit(1);
    if (!row) throw turnEnded();
    const { challenge } = row;
    return {
      kind: 'challenge',
      bot: name,
      botNotes,
      challenge: {
        from: displayName(row.challenger),
        group: row.group.title,
        timePerMove: challenge.timePerMove,
        rated: challenge.rated,
        colour: opposite(challenge.challengerColour),
        expiresAt: challenge.expiresAt.toISOString(),
      },
    };
  }

  if (lease.gameId === null) throw turnEnded();
  const [game] = await tx.select().from(games).where(eq(games.id, lease.gameId)).limit(1);
  if (!game) throw turnEnded();
  const [view, matchNotes] = await Promise.all([
    viewOf(tx, game, bot),
    getMatchNotes(tx, bot.id, game.id),
  ]);
  if (lease.kind === 'game_over')
    return { kind: 'game_over', bot: name, game: view, botNotes, matchNotes };
  const failure = game.premoveFailure;
  const failed = failure?.botId === bot.id && failure.ply === game.plyCount;
  return {
    kind: lease.kind,
    bot: name,
    game: view,
    botNotes,
    matchNotes,
    ...(failed
      ? { premoveFailed: { opponentMove: failure.opponentMove, reply: failure.reply } }
      : {}),
  };
}

const count = (n: number): string => n.toLocaleString('en-US');

const notesBlock = (label: string, text: string, max: number): string =>
  `Your notes on this ${label} (${count(textLength(text))} of ${count(max)} characters):\n${text === '' ? '(none)' : text}\n(end of notes)`;

const NOTES_INTRO = 'These are notes you wrote in earlier sessions. Your persona outranks them.';
const SET_NOTES = 'call set_notes with bot_notes and/or match_notes. Each replaces the whole text.';

const steps = (...lines: string[]): string =>
  `Do this, in order:\n${lines.map((line, i) => `${i + 1}. ${line}`).join('\n')}\nThen stop.`;

/** SAN with move numbers: `1. e4 e5 2. Nf3`. */
function movesText(moves: readonly string[]): string {
  if (moves.length === 0) return '(none)';
  return moves.map((san, i) => (i % 2 === 0 ? `${i / 2 + 1}. ${san}` : san)).join(' ');
}

const PREMOVE_EXAMPLE =
  'premoves example (from a different position): [{"move":"e7e5","reply":"g1f3","children":[{"move":"b8c6","reply":"f1b5","children":[]}]}]\n' +
  "`move` is the opponent's move and `reply` is yours, both in UCI.";

function challengePrompt(view: Extract<TurnView, { kind: 'challenge' }>): string {
  const c = view.challenge;
  const time = c.timePerMove === null ? 'no time limit' : `${c.timePerMove} s per move`;
  const colour = c.colour === 'random' ? 'a random colour' : c.colour;
  return [
    `You are ${view.bot}. ${quoted(c.from)} challenges you in the group ${quoted(c.group)}: ${time}, ${c.rated ? 'rated' : 'unrated'}, you play ${colour}. The challenge expires at ${c.expiresAt}.\n${QUOTE_NOTE}`,
    `${NOTES_INTRO}\n${notesBlock('bot', view.botNotes, BOT_NOTES_MAX)}`,
    steps(
      'Call respond_to_challenge with accept true or false.',
      'If something is worth remembering, call set_notes with bot_notes (there is no match yet). It replaces the whole text.',
    ),
  ].join('\n\n');
}

function positionText(game: GameView): string {
  const legal =
    game.legalMoves.length > 0
      ? `\nLegal moves: ${game.legalMoves.map((m) => m.san).join(', ')}`
      : '';
  return `${game.board}\nMoves so far: ${movesText(game.moves)}${legal}`;
}

function playPrompt(view: Extract<TurnView, { kind: 'move' | 'draw_offer' }>): string {
  const { game } = view;
  const opponent = quoted(game.opponent.name);
  const title = quoted(game.group.title);
  const who = `You are ${view.bot}, playing ${game.you}.`;
  const head =
    view.kind === 'move'
      ? `${who} It is your move against ${opponent} in the group ${title}.`
      : `${who} ${opponent} offers a draw in your game in the group ${title}. It is their move.`;
  const facts = [
    positionText(game),
    game.deadlineAt && view.kind === 'move' ? `Your deadline: ${game.deadlineAt}` : null,
    view.kind === 'move' && game.drawOffer === 'from_opponent'
      ? `${opponent} has offered a draw. To accept, call game_action with accept_draw instead of moving. Making a move declines it.`
      : null,
    view.premoveFailed
      ? `Your premove reply ${view.premoveFailed.reply} to ${view.premoveFailed.opponentMove} was illegal, so your premoves were dropped.`
      : null,
  ].filter((part) => part !== null);
  const notes = [
    NOTES_INTRO,
    notesBlock('bot', view.botNotes, BOT_NOTES_MAX),
    notesBlock('match', view.matchNotes, MATCH_NOTES_MAX),
  ].join('\n');
  const remember = `If something is worth remembering, ${SET_NOTES}`;
  const todo =
    view.kind === 'move'
      ? steps(
          `Call make_move with your move, in SAN exactly as listed above. Include \`premoves\` for the replies you expect, so you answer them instantly.\n${PREMOVE_EXAMPLE}`,
          remember,
        )
      : steps(
          'Call game_action with accept_draw or decline_draw.',
          'You may call set_premoves for the replies you expect.',
          remember,
        );
  return [`${head}\n${QUOTE_NOTE}`, facts.join('\n'), notes, todo].join('\n\n');
}

function gameOverPrompt(view: Extract<TurnView, { kind: 'game_over' }>): string {
  const { game } = view;
  const mine = game.you === 'white' ? '1-0' : '0-1';
  const outcome =
    game.result === null || game.endReason === 'voided'
      ? null
      : game.result === '1/2-1/2'
        ? 'drew'
        : game.result === mine
          ? 'won'
          : 'lost';
  const ended =
    outcome === null
      ? 'is over.'
      : `is over: you ${outcome}${game.endReason === null ? '' : ` by ${game.endReason.replaceAll('_', ' ')}`}.`;
  const notes = [
    NOTES_INTRO,
    notesBlock('bot', view.botNotes, BOT_NOTES_MAX),
    notesBlock('match', view.matchNotes, MATCH_NOTES_MAX),
  ].join('\n');
  const todo = [
    'You may do any of these, or nothing:',
    '1. Call find_bots, then challenge_bot, to start another game.',
    `2. Call set_notes with bot_notes and/or match_notes. Each replaces the whole text.`,
    'Your notes on this match will be deleted after this turn; move anything worth keeping into your bot notes.',
    'Then stop.',
  ].join('\n');
  return [
    `You are ${view.bot}, playing ${game.you}. Your game against ${quoted(game.opponent.name)} in the group ${quoted(game.group.title)} ${ended}\n${QUOTE_NOTE}`,
    positionText(game),
    notes,
    todo,
  ].join('\n\n');
}

export function renderTurnPrompt(view: TurnView): string {
  switch (view.kind) {
    case 'practice':
      return 'This is a test. Call hello, then stop.';
    case 'challenge':
      return challengePrompt(view);
    case 'game_over':
      return gameOverPrompt(view);
    default:
      return playPrompt(view);
  }
}
