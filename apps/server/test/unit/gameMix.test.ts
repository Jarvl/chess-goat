import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  audienceOf,
  frozenSide,
  mixOf,
  mixOfPlayers,
  storedBotPlayers,
} from '../../src/domain/gameMix';

const human = { isEngine: false, ownerId: null };
const engine = { isEngine: true, ownerId: null };
const bot = { isEngine: false, ownerId: 5 };

describe('Game Mix', () => {
  it('reads the stored count, and round-trips it', () => {
    expect([0, 1, 2].map((botPlayers) => mixOf({ botPlayers }))).toEqual([
      'humans',
      'mixed',
      'bots',
    ]);
    for (const mix of ['humans', 'mixed', 'bots'] as const) {
      expect(mixOf({ botPlayers: storedBotPlayers(mix) })).toBe(mix);
    }
  });

  it('is worked out from the players; the engine is not a bot', () => {
    expect(mixOfPlayers(human, human)).toBe('humans');
    expect(mixOfPlayers(human, engine)).toBe('humans');
    expect(mixOfPlayers(human, bot)).toBe('mixed');
    expect(mixOfPlayers(bot, human)).toBe('mixed');
    expect(mixOfPlayers(bot, bot)).toBe('bots');
    expect(mixOfPlayers(bot, null)).toBe('mixed');
    expect(mixOfPlayers(human, null)).toBe('humans');
  });
});

describe('Game Audience', () => {
  it.each([
    ['humans', null, { chat: true, importable: true }],
    ['mixed', null, { chat: true, importable: false }],
    ['bots', null, { chat: false, importable: false }],
    ['humans', 'club', { chat: false, importable: false }],
  ] as const)('%s game, engine level %s', (mix, engineLevel, expected) => {
    expect(audienceOf({ botPlayers: storedBotPlayers(mix), engineLevel })).toEqual(expected);
  });

  it('a challenge row has no engine level: only its mix counts', () => {
    expect(audienceOf({ botPlayers: 2 }).chat).toBe(false);
    expect(audienceOf({ botPlayers: 1 }).chat).toBe(true);
  });
});

describe('frozenSide', () => {
  it('freezes the human in a human-against-bot game, and no one otherwise', () => {
    expect(frozenSide('mixed', true)).toBe('black');
    expect(frozenSide('mixed', false)).toBe('white');
    expect(frozenSide('humans', false)).toBeUndefined();
    expect(frozenSide('bots', true)).toBeUndefined();
  });
});

/** Every .ts file under `dir`. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? sources(path) : path.endsWith('.ts') ? [path] : [];
  });
}

describe('guard', () => {
  it('only the Game Mix module reads bot_players', () => {
    const src = fileURLToPath(new URL('../../src', import.meta.url));
    const allowed = new Set(['domain/gameMix.ts', 'db/schema.ts']);
    // `.botPlayers` read off a row, or compared. Columns named in a query (`games.botPlayers`,
    // `challenges.botPlayers`) and stored values (`botPlayers: storedBotPlayers(mix)`) are not reads.
    const pattern = /(?<!games|challenges)\.botPlayers\b|\bbotPlayers\s*(?:[=!]==|[<>]=?)/;
    const offenders = sources(src)
      .map((path) => relative(src, path))
      .filter((path) => !allowed.has(path))
      .filter((path) => pattern.test(readFileSync(join(src, path), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
