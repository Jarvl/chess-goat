import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileLogger, LOG_MAX_BYTES, readLogTail } from '../src/log.js';

const posix = process.platform !== 'win32';
let dir: string;
beforeEach(() => {
  dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'goat-log-')), 'data');
});
afterEach(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));

const read = (name: string) => fs.readFileSync(path.join(dir, name), 'utf8');

describe('fileLogger', () => {
  it('caps at 5 MB by default', () => {
    expect(LOG_MAX_BYTES).toBe(5 * 1024 * 1024);
  });

  it('writes one timestamped line per call, creating the folder', () => {
    const log = fileLogger(dir);
    log.info('hello');
    log.warn('careful');
    const [a, b] = read('runner.log').trimEnd().split('\n');
    expect(a).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z INFO hello$/);
    expect(b).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z WARN careful$/);
  });

  it('turns newlines inside a message into spaces', () => {
    fileLogger(dir).info('bot\nEvil\r\nname');
    const lines = read('runner.log').trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/INFO bot Evil {2}name$/);
  });

  it('rotates at the cap and replaces the old rotated copy', () => {
    const log = fileLogger(dir, { maxBytes: 100 });
    log.info('a'.repeat(120));
    log.info('second');
    expect(read('runner.log.1')).toContain('a'.repeat(120));
    expect(read('runner.log')).toMatch(/second\n$/);
    log.info('b'.repeat(120));
    log.info('third');
    expect(read('runner.log.1')).toContain('second');
    expect(read('runner.log.1')).not.toContain('a'.repeat(120));
    expect(read('runner.log')).toMatch(/third\n$/);
  });

  it('does not lose the line when the rotated copy cannot be written', () => {
    const log = fileLogger(dir, { maxBytes: 50 });
    log.info('x'.repeat(80));
    fs.mkdirSync(path.join(dir, 'runner.log.1', 'sub'), { recursive: true }); // a non-empty dir blocks rename
    log.info('kept');
    expect(read('runner.log')).toMatch(/kept\n$/);
  });

  it.skipIf(!posix)('creates the folder 0700 and the file 0600', () => {
    fileLogger(dir).info('x');
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(dir, 'runner.log')).mode & 0o777).toBe(0o600);
  });
});

describe('readLogTail', () => {
  it('returns the last N lines', () => {
    const log = fileLogger(dir);
    for (let i = 1; i <= 5; i++) log.info(`line ${i}`);
    const tail = readLogTail(dir, 2).split('\n');
    expect(tail).toHaveLength(2);
    expect(tail[0]).toMatch(/line 4$/);
    expect(tail[1]).toMatch(/line 5$/);
  });

  it('returns everything when fewer lines exist, and "" without a file', () => {
    expect(readLogTail(dir, 5)).toBe('');
    fileLogger(dir).info('only');
    expect(readLogTail(dir, 5).split('\n')).toHaveLength(1);
  });

  it('reads at most the last 256 KB and drops the cut first line', () => {
    fs.mkdirSync(dir, { recursive: true });
    const big = `${'z'.repeat(300 * 1024)}\nlast line\n`;
    fs.writeFileSync(path.join(dir, 'runner.log'), big);
    expect(readLogTail(dir, 100)).toBe('last line');
  });
});
