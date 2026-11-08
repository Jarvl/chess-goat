import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { can, isBot, isEngine, isHuman, kindOf } from '../../src/domain/playerKind';

const human = { isEngine: false, ownerId: null };
const engine = { isEngine: true, ownerId: null };
const bot = { isEngine: false, ownerId: 5 };

describe('kindOf', () => {
  it('tells a person, the engine and a bot apart', () => {
    expect([human, engine, bot].map(kindOf)).toEqual(['human', 'engine', 'bot']);
    expect([human, engine, bot].map(isHuman)).toEqual([true, false, false]);
    expect([human, engine, bot].map(isEngine)).toEqual([false, true, false]);
    expect([human, engine, bot].map(isBot)).toEqual([false, false, true]);
  });
});

describe('what each kind can do', () => {
  // The rules as they stood when gathered here, odd rows included (see playerKind.ts).
  it.each([
    ['wearFlair', [true, false, false]],
    ['getDms', [true, true, false]],
    ['showPhoto', [true, false, true]],
    ['actAsPerson', [true, false, false]],
  ] as const)('%s', (capability, expected) => {
    expect([human, engine, bot].map((user) => can(user, capability))).toEqual(expected);
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
  it('only the Player Kind module reads is_engine or owner_id to tell kinds apart', () => {
    const src = fileURLToPath(new URL('../../src', import.meta.url));
    const allowed = new Set(['domain/playerKind.ts', 'db/schema.ts']);
    // `.isEngine` read off a row, `ownerId` tested for null, or the old predicate. Columns named
    // in a query (`users.isEngine`, or `isEngine: alias.isEngine` in a select) are not reads.
    const pattern =
      /(?<!users|isEngine: \w+)\.isEngine\b|\bisOwnedBot\(|\.ownerId (?:!==|===) null/;
    const offenders = sources(src)
      .map((path) => relative(src, path))
      .filter((path) => !allowed.has(path))
      .filter((path) => pattern.test(readFileSync(join(src, path), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
