import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { build } from 'tsup';
import pkg from '../package.json';
import { CLI, run } from './support/run';

beforeAll(async () => {
  await build({ silent: true });
});

describe('cli', () => {
  it('prints its version', async () => {
    const { stdout, code } = await run(['--version']);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe(pkg.version);
  });

  it('prints one help line with no arguments', async () => {
    const { stdout, code } = await run([]);
    expect(code).toBe(0);
    expect(stdout.trim().split('\n')).toHaveLength(1);
  });

  it('rejects an unknown command with exit 2', async () => {
    const { stderr, code } = await run(['nope']);
    expect(code).toBe(2);
    expect(stderr).toContain('Unknown command');
  });

  it('the built file has a shebang and imports nothing from the workspace', () => {
    const built = readFileSync(CLI, 'utf8');
    expect(built.startsWith('#!/usr/bin/env node\n')).toBe(true);
    expect(built).not.toContain('@chess-goat/shared');
  });
});
