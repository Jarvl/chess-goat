#!/usr/bin/env node
// Each worktree's test databases are named after the worktree, so sessions working side by side in
// separate worktrees never share one (docs/testing.md). The name is the end of the folder name, for
// a human reading `\l`, plus a hash of the full path, so two folders with one name never collide.
// `scripts/local-postgres.sh prune` calls `key` to tell live worktrees' databases from stale ones.
import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** PostgreSQL truncates identifiers past this many bytes. */
const MAX_IDENTIFIER = 63;

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');

/** `<slug>_<hash>`: the last 16 characters of the folder name, made identifier-safe, and 6 hex of the path. */
export function worktreeKey(root) {
  const path = resolve(root);
  const slug =
    basename(path)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .slice(-16)
      .replace(/^_+|_+$/g, '') || 'root';
  const hash = createHash('sha256').update(path).digest('hex').slice(0, 6);
  return `${slug}_${hash}`;
}

export function testDatabaseName(root, kind = 'test') {
  return `chess_goat_test_${worktreeKey(root)}${kind === 'e2e' ? '_e2e' : ''}`;
}

/** A migration test's throwaway database, carrying the worktree key so `prune` can attribute it. */
export function scratchDatabaseName(root, name, pid) {
  return `chess_goat_scratch_${worktreeKey(root)}_${pid}_${name}`.slice(0, MAX_IDENTIFIER);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, root] = process.argv.slice(2);
  if (command !== 'key' || !root) {
    console.error('usage: test-database-name.mjs key <worktree root>');
    process.exit(2);
  }
  console.log(worktreeKey(root));
}
