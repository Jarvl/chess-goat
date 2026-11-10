import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  BOT_NOTES_MAX,
  MATCH_NOTES_MAX,
  setBotNotes,
  setMatchNotes,
  textLength,
} from '../../../domain/botNotes';
import { DomainError } from '../../../domain/errors';
import { registerTurnTool } from '../../tool';

/**
 * Text the schema publishes with `maxLength: max`. It isn't enforced here: `.max` would count UTF-16
 * units, so 2,500 emoji would fail a 4,000 limit; the domain counts code points and says by how
 * much a note is over.
 */
const notesInput = (max: number, description: string) =>
  z.string().meta({ maxLength: max }).describe(description);

const saved = z.object({ length: z.number().int(), limit: z.number().int() });
const output = z.object({ botNotes: saved.optional(), matchNotes: saved.optional() });

const fmt = (n: number): string => n.toLocaleString('en-US');

function registerSetNotes(server: McpServer): void {
  registerTurnTool(server, {
    name: 'set_notes',
    description:
      'Saves notes for your future turns. bot_notes are about you across all your games; match_notes are about this match only (not on a challenge turn). Each replaces the whole text, so merge in what you want to keep. Works after your move, until the session ends.',
    input: z.object({
      bot_notes: notesInput(
        BOT_NOTES_MAX,
        'Replaces the whole text. At most 4,000 characters.',
      ).optional(),
      match_notes: notesInput(
        MATCH_NOTES_MAX,
        'Replaces the whole text. At most 2,000 characters.',
      ).optional(),
    }),
    output,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    allowResolved: true,
    run: async (call, input) => {
      const { deps, bot, lease } = call;
      if (input.bot_notes === undefined && input.match_notes === undefined) {
        throw new DomainError('validation', 'no notes given', { reason: 'no_notes_given' });
      }
      if (input.match_notes !== undefined && lease.gameId === null) {
        throw new DomainError('validation', 'no match yet', { reason: 'no_match_yet' });
      }
      const out: z.infer<typeof output> = {};
      // Match notes first: a `notes_changed` refusal on the bot notes must not lose them.
      if (input.match_notes !== undefined) {
        const text = input.match_notes;
        await setMatchNotes(deps.db, { botId: bot.id, gameId: lease.gameId!, text });
        out.matchNotes = { length: textLength(text), limit: MATCH_NOTES_MAX };
      }
      if (input.bot_notes !== undefined) {
        const text = input.bot_notes;
        await setBotNotes(deps.db, { botId: bot.id, leaseId: lease.id, text });
        out.botNotes = { length: textLength(text), limit: BOT_NOTES_MAX };
      }
      return out;
    },
    text: ({ botNotes, matchNotes }) =>
      [
        botNotes &&
          `Bot notes saved (${fmt(botNotes.length)} of ${fmt(botNotes.limit)} characters).`,
        matchNotes &&
          `Match notes saved (${fmt(matchNotes.length)} of ${fmt(matchNotes.limit)} characters).`,
      ]
        .filter(Boolean)
        .join(' '),
  });
}

export const registerNotesTurnTool = registerSetNotes;
