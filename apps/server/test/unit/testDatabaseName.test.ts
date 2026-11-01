import { describe, expect, it } from 'vitest';
import {
  scratchDatabaseName,
  testDatabaseName,
  worktreeKey,
} from '../../../../scripts/test-database-name.mjs';

const WORKTREE = '/home/x/chess-goat/.claude/worktrees/bridge-cse_01DAqcvHKEGKk8jaxWGSw1sA';

describe('test database names', () => {
  it('names a worktree database from the end of its folder name plus a path hash', () => {
    expect(testDatabaseName(WORKTREE)).toMatch(/^chess_goat_test_kegkk8jaxwgsw1sa_[0-9a-f]{6}$/);
    expect(testDatabaseName(WORKTREE, 'e2e')).toBe(`${testDatabaseName(WORKTREE)}_e2e`);
  });

  it('gives folders with the same name at different paths different databases', () => {
    expect(testDatabaseName('/a/chess-goat')).not.toBe(testDatabaseName('/b/chess-goat'));
  });

  it('is stable for one root, with or without a trailing slash', () => {
    expect(testDatabaseName(WORKTREE)).toBe(testDatabaseName(`${WORKTREE}/`));
  });

  it.each([WORKTREE, `/x/${'Ü-'.repeat(80)}`, '/'])(
    'stays a valid PostgreSQL identifier for %s',
    (root) => {
      for (const name of [
        testDatabaseName(root, 'e2e'),
        scratchDatabaseName(root, 'migration_0011', 4_194_304),
      ]) {
        expect(name).toMatch(/^[a-z0-9_]+$/);
        expect(Buffer.byteLength(name)).toBeLessThanOrEqual(63);
      }
    },
  );

  it('puts the worktree key in scratch database names', () => {
    expect(scratchDatabaseName(WORKTREE, 'migrate', 42)).toBe(
      `chess_goat_scratch_${worktreeKey(WORKTREE)}_42_migrate`,
    );
  });
});
