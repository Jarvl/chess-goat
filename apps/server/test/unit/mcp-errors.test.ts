import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DomainError } from '../../src/domain/errors';
import { REFUSALS, toolError, type Viewer } from '../../src/mcp/errors';

const OWNER = 7;
const viewer: Viewer = { ownerId: OWNER, tool: 'respond_to_challenge' };
const challenging: Viewer = { ownerId: OWNER, tool: 'challenge_bot' };
const text = (error: unknown, as: Viewer = viewer) => toolError(error, as).content[0].text;

/** A Pairing error about one of the viewer's bots, or about someone else's. */
const mine = { subjectId: 40, subjectOwnerId: OWNER, name: 'Rook' };
const theirs = { subjectId: 41, subjectOwnerId: 99, name: 'Knightbot' };
const person = { subjectId: 42, subjectOwnerId: null, name: 'Bob' };

describe('toolError', () => {
  it('turns a DomainError into what went wrong and what to do next', () => {
    const stale = toolError(
      new DomainError('stale_state', 'the position has changed', { plyCount: 12 }),
      viewer,
    );
    expect(stale).toEqual({
      isError: true,
      content: [
        {
          type: 'text',
          text: 'The position has changed; it is now ply 12. Call get_game and choose again.',
        },
      ],
    });
    expect(text(new DomainError('not_found', 'unknown bot'))).toBe(
      'Unknown bot. (code: not_found)',
    );
  });

  it('hides an unexpected error behind a generic message', () => {
    expect(text(new Error('connection to 10.0.0.1 refused'))).not.toContain('10.0.0.1');
  });
});

describe('a refusal names the right player', () => {
  const busy = (subject: object) =>
    new DomainError('limit_exceeded', 'too many live games', {
      reason: 'too_many_live_games',
      limit: 50,
      ...subject,
    });

  it('a busy bot: the caller’s own, or the opponent', () => {
    expect(text(busy(mine))).toBe(
      'Too many live games. This bot already has 50 games in progress. Finish some before starting more.',
    );
    expect(text(busy(theirs))).toBe(
      'Too many live games. Knightbot already has 50 games in progress. Try another bot from find_bots.',
    );
  });

  it('takes the limit from the error, not a number in the text', () => {
    expect(text(busy({ ...mine, limit: 7 }))).toContain('already has 7 games');
  });

  it('an owner who left: the caller, or the other bot’s owner', () => {
    const left = (subject: object) =>
      new DomainError('forbidden', "the bot's owner is not in the group", {
        reason: 'owner_not_member',
        ...subject,
      });
    expect(text(left(mine))).toBe(
      "The bot's owner is not in the group. You must be a member of that group. Call list_my_groups for groups you can use.",
    );
    expect(text(left(theirs))).toBe(
      "Knightbot's owner is no longer a member of that group, so it can't play there.",
    );
    // The owner gate before any bot is named (find_bots) has no subject: it is the caller.
    expect(
      text(new DomainError('forbidden', 'not a member', { reason: 'owner_not_member' })),
    ).toContain('You must be a member of that group.');
  });

  it('a bot not in the group, or blocked: the caller’s, or the other one', () => {
    const out = (subject: object) =>
      new DomainError('forbidden', 'this bot is not in the group', {
        reason: 'bot_not_in_group',
        ...subject,
      });
    expect(text(out(mine))).toContain('add_bot_to_group');
    expect(text(out(theirs))).toBe('Knightbot is no longer in that group.');
    const blocked = (subject: object) =>
      new DomainError('forbidden', 'blocked', { reason: 'blocked', ...subject });
    expect(text(blocked(mine))).toContain('blocked this bot or its owner');
    expect(text(blocked(theirs))).toBe(
      'An admin has blocked Knightbot or its owner in that group.',
    );
  });
});

describe('challenge_bot hides whether an opponent exists', () => {
  const hidden = 'Opponent bot not found. Use a bot id from find_bots for that group.';
  const refusals = [
    new DomainError('forbidden', 'bots only challenge bots', {
      reason: 'bots_challenge_bots_only',
    }),
    new DomainError('not_found', 'user not found', { userId: 999 }),
    new DomainError('not_found', 'gone', { reason: 'opponent_gone', ...theirs }),
    new DomainError('forbidden', 'out', { reason: 'bot_not_in_group', ...theirs }),
    new DomainError('forbidden', 'left', { reason: 'owner_not_member', ...theirs }),
    new DomainError('forbidden', 'blocked', { reason: 'blocked', ...theirs }),
    new DomainError('forbidden', 'blocked', { reason: 'blocked', ...person }),
  ];

  it('a person, an unknown id and an unfindable bot all read alike', () => {
    for (const error of refusals) expect(text(error, challenging)).toBe(hidden);
  });

  it("still says what is wrong with the caller's own bots", () => {
    const error = new DomainError('forbidden', 'out', { reason: 'bot_not_in_group', ...mine });
    expect(text(error, challenging)).toContain('add_bot_to_group');
  });

  it('only in challenge_bot', () => {
    const error = new DomainError('forbidden', 'out', { reason: 'bot_not_in_group', ...theirs });
    expect(text(error, viewer)).toBe('Knightbot is no longer in that group.');
  });
});

/** Every `reason: '…'` the server throws, from its source. */
function reasonsInSource(dir: string): Set<string> {
  const found = new Set<string>();
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      for (const reason of reasonsInSource(path)) found.add(reason);
    } else if (path.endsWith('.ts')) {
      const source = readFileSync(path, 'utf8');
      for (const m of source.matchAll(/reason: '([a-z_]+)'/g)) found.add(m[1]!);
      for (const m of source.matchAll(/forbidden\(\s*'([a-z_]+)'/g)) found.add(m[1]!);
    }
  }
  return found;
}

/** Reasons only people meet, in the Mini App or the chat: no MCP tool reaches them. */
const NOT_FOR_AGENTS = new Set([
  'opponent_ambiguous',
  'open_disabled',
  'engine_game',
  'engine_disabled',
  'invalid_level',
  'streams',
  'share',
  'locked',
  'expired',
  'duplicate',
  'announce_limit',
  'premoves_changed',
]);

describe('the refusal table', () => {
  it('has an entry for every reason the server throws, unless no agent can meet it', () => {
    const missing = [
      ...reasonsInSource(fileURLToPath(new URL('../../src', import.meta.url))),
    ].filter((reason) => !(reason in REFUSALS) && !NOT_FOR_AGENTS.has(reason));
    expect(missing).toEqual([]);
  });

  it('lists no reason as not-for-agents that it also has an entry for', () => {
    expect([...NOT_FOR_AGENTS].filter((reason) => reason in REFUSALS)).toEqual([]);
  });

  it('every entry renders without a subject, and with each kind of subject', () => {
    for (const [key, entry] of Object.entries(REFUSALS)) {
      for (const subject of [{}, mine, theirs, person]) {
        const out = text(new DomainError('forbidden', 'refused', { reason: key, ...subject }));
        expect(out.length, key).toBeGreaterThan(0);
        expect(out, key).not.toContain('undefined');
      }
      expect(entry).toBeTypeOf('function');
    }
  });
});
