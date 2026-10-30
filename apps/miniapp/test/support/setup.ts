import { afterEach, expect } from 'vitest';

let allowed = new Set<string>();

/**
 * Lets the current test use `names` below their minimum version without failing. For a test that
 * exercises an ungated path on purpose; say why where it is called.
 */
export function allowUnsupported(...names: string[]): void {
  for (const name of names) allowed.add(name);
}

// The fake Telegram client records every method the app used below the version that has it. A
// real client of that version would warn and do nothing, or throw, so any such use is an app bug.
afterEach(() => {
  const recorded = window.__tg?.unsupported.splice(0) ?? [];
  const unsupported = recorded.filter((name) => !allowed.has(name));
  allowed = new Set();
  expect(unsupported, 'Telegram methods used below their minimum version').toEqual([]);
});
