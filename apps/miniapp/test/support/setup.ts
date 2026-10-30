import { createHash } from 'node:crypto';
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

// Premove trees are named by their SHA-256. WebCrypto computes it on Node's thread pool, which a
// loaded machine can hold past the few event-loop turns `flush()` waits, so a test would see a
// save not yet sent. The same hash, computed here at once, keeps every flush deterministic.
Object.defineProperty(globalThis.crypto.subtle, 'digest', {
  configurable: true,
  value: async (algorithm: AlgorithmIdentifier, data: BufferSource): Promise<ArrayBuffer> => {
    if (algorithm !== 'SHA-256')
      throw new Error(`the test digest only does SHA-256, not ${String(algorithm)}`);
    const bytes = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);
    return new Uint8Array(createHash('sha256').update(bytes).digest()).buffer;
  },
});
