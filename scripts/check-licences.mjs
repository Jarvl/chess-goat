#!/usr/bin/env node
// Every dependency must carry a licence from the allow-list (all compatible with the
// repository's GPL-3.0-or-later). Reads `pnpm licenses list --json`; exits 1 on any other licence.
// Limits: the listing covers the packages installed on this platform (other platforms' optional
// binaries in the lockfile are not inspected), and `permitted` reads flat SPDX expressions only —
// anything more elaborate fails closed and needs a human look.
//
// This gate reads npm metadata only. The Docker image also installs Stockfish via `apt-get`
// (Dockerfile, runtime stage) — a non-npm, GPL-3.0 dependency this script cannot see and does not
// gate. That is compatible with this repository's own GPL-3.0-or-later licence, and is recorded
// here rather than left implicit: Stockfish, packaged version 15.1-4 (Debian bookworm), GPL-3.0.
// The licence text ships in the image at /usr/share/doc/stockfish/copyright.
import { execFileSync } from 'node:child_process';

const DEFAULT_ALLOWED = [
  'MIT',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'ISC',
  'Apache-2.0',
  'MPL-2.0',
  'Unlicense',
  'CC0-1.0',
  'BlueOak-1.0.0',
  'GPL-3.0-or-later',
];
const allowed = new Set(
  (process.env.LICENCE_ALLOW ?? DEFAULT_ALLOWED.join(',')).split(',').map((s) => s.trim()),
);

/** True when a licence expression is satisfied by the allow-list: any OR alternative, every AND part. */
export function permitted(expression) {
  const text = expression.replace(/^\(|\)$/g, '').trim();
  if (text.includes(' OR ')) return text.split(' OR ').some((part) => permitted(part));
  if (text.includes(' AND ')) return text.split(' AND ').every((part) => permitted(part));
  return allowed.has(text);
}

const raw = execFileSync('pnpm', ['licenses', 'list', '--json'], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
const byLicence = JSON.parse(raw);
const offenders = [];
let total = 0;
for (const [licence, packages] of Object.entries(byLicence)) {
  total += packages.length;
  if (permitted(licence)) continue;
  for (const pkg of packages) offenders.push(`${pkg.name}@${pkg.versions.join(',')} (${licence})`);
}
console.log(
  `${total} npm packages, ${Object.keys(byLicence).length} licence expressions, allow-list: ${[...allowed].join(', ')}`,
);
if (offenders.length > 0) {
  console.error('Licences outside the allow-list:');
  for (const line of offenders) console.error(`  ${line}`);
  process.exit(1);
}
console.log(
  'All npm dependency licences are allowed. This covers npm dependencies only — see the top of ' +
    'this file for the one non-npm exception shipped in the image (Stockfish, GPL-3.0).',
);
