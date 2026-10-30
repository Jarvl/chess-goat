import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FONT_MANIFEST, fetchFonts, type FontEntry } from '../../../../scripts/fetch-fonts.mjs';

const BYTES = Buffer.from('pretend font bytes');
const ENTRY: FontEntry = {
  file: 'Test-Regular.ttf',
  url: 'https://example.test/Test-Regular.ttf',
  sha256: createHash('sha256').update(BYTES).digest('hex'),
};

const serving = (body: Buffer, status = 200) =>
  vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fonts-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('fetchFonts', () => {
  it('downloads a missing font and verifies it', async () => {
    const fetchImpl = serving(BYTES);
    expect(await fetchFonts({ dir, manifest: [ENTRY], fetchImpl })).toEqual(['Test-Regular.ttf']);
    expect(await readFile(join(dir, ENTRY.file))).toEqual(BYTES);
  });

  it('skips a font already present with the right checksum', async () => {
    await writeFile(join(dir, ENTRY.file), BYTES);
    const fetchImpl = serving(BYTES);
    expect(await fetchFonts({ dir, manifest: [ENTRY], fetchImpl })).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('replaces a truncated file left by an interrupted download', async () => {
    await writeFile(join(dir, ENTRY.file), BYTES.subarray(0, 4));
    expect(await fetchFonts({ dir, manifest: [ENTRY], fetchImpl: serving(BYTES) })).toEqual([
      'Test-Regular.ttf',
    ]);
    expect(await readFile(join(dir, ENTRY.file))).toEqual(BYTES);
  });

  it('fails on a checksum mismatch and leaves nothing behind', async () => {
    await expect(
      fetchFonts({ dir, manifest: [ENTRY], fetchImpl: serving(Buffer.from('changed upstream')) }),
    ).rejects.toThrow(/Test-Regular\.ttf: sha256 [0-9a-f]{64}, expected/);
    expect(await readdir(dir)).toEqual([]);
  });

  it('fails on an HTTP error', async () => {
    await expect(
      fetchFonts({ dir, manifest: [ENTRY], fetchImpl: serving(Buffer.alloc(0), 404) }),
    ).rejects.toThrow('Test-Regular.ttf: HTTP 404 from https://example.test/Test-Regular.ttf');
  });
});

describe('FONT_MANIFEST', () => {
  // Which fonts, by file name, is pinned in fonts.test.ts against what the renderer loads.
  it('pins every font by https URL and sha256', () => {
    for (const entry of FONT_MANIFEST) {
      expect(entry.url).toMatch(/^https:\/\//);
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
