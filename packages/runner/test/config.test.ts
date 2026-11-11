import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readConfig, removeConfig, writeConfig, type RunnerConfig } from '../src/config';

const SECRET = 'grc_super-secret-credential';
const base: RunnerConfig = {
  server: 'https://goat.example',
  credential: SECRET,
  runnerId: 4,
  preset: 'claude',
  concurrency: 2,
  leaseSeconds: 300,
};

let tmp: string;
let dir: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'goat-runner-test-'));
  dir = path.join(tmp, 'config');
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const file = () => path.join(dir, 'config.json');
const raw = (obj: unknown) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file(), typeof obj === 'string' ? obj : JSON.stringify(obj));
};

describe('config', () => {
  it('returns null when absent', () => {
    expect(readConfig(dir)).toBeNull();
  });

  it('round-trips', () => {
    const cfg: RunnerConfig = {
      ...base,
      preset: 'lean',
      lean: { baseUrl: 'http://localhost:11434/v1', model: 'qwen', apiKeyEnv: 'K' },
      concurrency: 3,
      leaseSeconds: 120,
    };
    writeConfig(dir, cfg);
    expect(readConfig(dir)).toEqual(cfg);
  });

  it('applies defaults for concurrency and leaseSeconds', () => {
    raw({ server: 'https://s.example', credential: 'c', runnerId: 1, preset: 'claude' });
    expect(readConfig(dir)).toMatchObject({ concurrency: 2, leaseSeconds: 300 });
  });

  it('stores server without a trailing slash', () => {
    writeConfig(dir, { ...base, server: 'https://goat.example/base///' });
    expect(JSON.parse(fs.readFileSync(file(), 'utf8')).server).toBe('https://goat.example/base');
  });

  it('refuses a non-http server', () => {
    raw({ ...base, server: 'ftp://x.example' });
    expect(() => readConfig(dir)).toThrow(/not valid/);
  });

  it.each(['http://goat.example', 'http://10.0.0.5:3000', 'http://localhost.evil.com'])(
    'refuses a plain-http server %s that is not loopback',
    (server) => {
      raw({ ...base, server });
      expect(() => readConfig(dir)).toThrow(/the server address must use https/);
    },
  );

  it.each([
    'http://localhost:3000',
    'http://127.0.0.1:8080',
    'http://127.9.9.9',
    'http://[::1]:3000',
  ])('accepts a plain-http loopback server %s', (server) => {
    raw({ ...base, server });
    expect(readConfig(dir)?.server).toBe(server);
  });

  it('malformed JSON throws a message naming the file, without the contents', () => {
    raw(`{"credential":"${SECRET}"`);
    let msg = '';
    try {
      readConfig(dir);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain(file());
    expect(msg).toContain('Remove it and link again.');
    expect(msg).not.toContain(SECRET);
  });

  it('a config missing credential is refused, and the message holds no credential', () => {
    raw({ server: 'https://s.example', runnerId: 1, preset: 'claude', note: SECRET });
    expect(() => readConfig(dir)).toThrow(/credential/);
    try {
      readConfig(dir);
    } catch (e) {
      expect((e as Error).message).not.toContain(SECRET);
    }
  });

  it.each(['preset', 'server', 'runnerId', 'concurrency'])(
    'a secret in the failing %s field is not echoed',
    (field) => {
      raw({ ...base, [field]: SECRET });
      let msg = '';
      try {
        readConfig(dir);
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).toContain('not valid');
      expect(msg).not.toContain(SECRET);
    },
  );

  it('writeConfig throws the same not-valid error, not a ZodError, without the value', () => {
    let err: Error | undefined;
    try {
      writeConfig(dir, { ...base, preset: SECRET as never });
    } catch (e) {
      err = e as Error;
    }
    expect(err?.constructor).toBe(Error);
    expect(err?.message).toContain('not valid');
    expect(err?.message).toContain(file());
    expect(err?.message).not.toContain(SECRET);
  });

  it.each(['https://user:pw@s.example', 'https://s.example/?k=v', 'https://s.example/#frag'])(
    'refuses server %s without echoing it',
    (server) => {
      raw({ ...base, server });
      try {
        readConfig(dir);
        expect.unreachable();
      } catch (e) {
        expect((e as Error).message).toContain('credentials, a query or a fragment');
        expect((e as Error).message).not.toContain('pw');
      }
    },
  );

  it('allows a path prefix on server', () => {
    raw({ ...base, server: 'https://s.example/goat' });
    expect(readConfig(dir)?.server).toBe('https://s.example/goat');
  });

  it.each(['ftp://m.example', 'http://u:p@m.example/v1', 'http://m.example/v1?x=1', 'nope'])(
    'refuses lean.baseUrl %s',
    (baseUrl) => {
      raw({ ...base, preset: 'lean', lean: { baseUrl, model: 'm' } });
      expect(() => readConfig(dir)).toThrow(/lean\.baseUrl/);
    },
  );

  it('strips a UTF-8 BOM before parsing', () => {
    raw('\uFEFF' + JSON.stringify(base));
    expect(readConfig(dir)?.runnerId).toBe(4);
  });

  it.skipIf(process.platform === 'win32')(
    'a stale tmp file at 0644 is replaced, never written into',
    () => {
      fs.mkdirSync(dir, { recursive: true });
      const tmpFile = `${file()}.tmp-${process.pid}`;
      fs.writeFileSync(tmpFile, 'stale', { mode: 0o644 });
      writeConfig(dir, base);
      expect(fs.statSync(file()).mode & 0o777).toBe(0o600);
      expect(fs.existsSync(tmpFile)).toBe(false);
    },
  );

  it.skipIf(process.platform === 'win32')('a tmp symlink is not followed', () => {
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(tmp, 'victim');
    fs.writeFileSync(target, 'keep');
    fs.symlinkSync(target, `${file()}.tmp-${process.pid}`);
    writeConfig(dir, base);
    expect(fs.readFileSync(target, 'utf8')).toBe('keep');
    expect(readConfig(dir)?.credential).toBe(SECRET);
  });

  it.skipIf(process.platform === 'win32')('an existing 0644 config.json ends 0600', () => {
    raw(base);
    fs.chmodSync(file(), 0o644);
    writeConfig(dir, base);
    expect(fs.statSync(file()).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === 'win32')('an existing 0755 folder ends 0700', () => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    fs.chmodSync(dir, 0o755);
    writeConfig(dir, base);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('a failed validation does not echo the credential that was in the file', () => {
    raw({ ...base, runnerId: -3 });
    try {
      readConfig(dir);
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toContain(file());
      expect((e as Error).message).not.toContain(SECRET);
    }
  });

  it('refuses preset custom without a custom section', () => {
    raw({ ...base, preset: 'custom' });
    expect(() => readConfig(dir)).toThrow(/custom/);
  });

  it('refuses preset lean without a lean section', () => {
    raw({ ...base, preset: 'lean' });
    expect(() => readConfig(dir)).toThrow(/lean/);
  });

  it('accepts preset custom with its section', () => {
    const cfg = { ...base, preset: 'custom' as const, custom: { command: 'x', args: ['-y'] } };
    writeConfig(dir, cfg);
    expect(readConfig(dir)?.custom).toEqual({ command: 'x', args: ['-y'] });
  });

  it.each([{ concurrency: 0 }, { concurrency: 9 }, { leaseSeconds: 29 }, { leaseSeconds: 901 }])(
    'refuses out-of-range %o',
    (extra) => {
      raw({ ...base, ...extra });
      expect(() => readConfig(dir)).toThrow(/not valid/);
    },
  );

  it('drops unknown keys on read', () => {
    raw({ ...base, futureThing: 1 });
    expect(readConfig(dir)).not.toHaveProperty('futureThing');
  });

  it('write refuses an invalid config', () => {
    expect(() => writeConfig(dir, { ...base, credential: '' })).toThrow();
    expect(fs.existsSync(file())).toBe(false);
  });

  it('a write over an existing file leaves no tmp file behind', () => {
    writeConfig(dir, base);
    writeConfig(dir, { ...base, runnerId: 9 });
    expect(readConfig(dir)?.runnerId).toBe(9);
    expect(fs.readdirSync(dir)).toEqual(['config.json']);
  });

  it('removes the temporary file and rethrows when the rename fails', () => {
    fs.mkdirSync(file(), { recursive: true }); // a directory cannot be replaced by a file
    expect(() => writeConfig(dir, base)).toThrow();
    expect(fs.readdirSync(dir).filter((n) => n.includes('.tmp-'))).toEqual([]);
  });

  it('removeConfig deletes the file, keeps the folder, and tolerates absence', () => {
    writeConfig(dir, base);
    removeConfig(dir);
    expect(fs.existsSync(file())).toBe(false);
    expect(fs.existsSync(dir)).toBe(true);
    expect(() => removeConfig(dir)).not.toThrow();
    expect(() => removeConfig(path.join(tmp, 'nope'))).not.toThrow();
  });

  it.skipIf(process.platform === 'win32')('writes the file 0600', () => {
    writeConfig(dir, base);
    expect(fs.statSync(file()).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === 'win32')('creates the folder 0700', () => {
    const nested = path.join(tmp, 'a', 'b');
    writeConfig(nested, base);
    expect(fs.statSync(nested).mode & 0o777).toBe(0o700);
  });
});
