#!/usr/bin/env node
// Initial JavaScript ≤ 120 KB gzipped, CSS ≤ 25 KB gzipped, measured on the built app.
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUDGET = { js: 120 * 1024, css: 25 * 1024 };
const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../apps/miniapp/dist/assets');

if (!existsSync(dist)) {
  console.error(`no built app at ${dist}; run \`pnpm build\` first`);
  process.exit(1);
}
const totals = { js: 0, css: 0 };
for (const name of await readdir(dist)) {
  const kind = name.endsWith('.js') ? 'js' : name.endsWith('.css') ? 'css' : null;
  if (!kind) continue;
  const size = gzipSync(await readFile(join(dist, name))).length;
  totals[kind] += size;
  console.log(`${name}: ${(size / 1024).toFixed(1)} KB gzipped`);
}
let failed = false;
for (const kind of ['js', 'css']) {
  const ok = totals[kind] <= BUDGET[kind];
  console.log(
    `${kind}: ${(totals[kind] / 1024).toFixed(1)} KB of ${BUDGET[kind] / 1024} KB ${ok ? 'OK' : 'OVER BUDGET'}`,
  );
  if (!ok) failed = true;
}
process.exit(failed ? 1 : 0);
