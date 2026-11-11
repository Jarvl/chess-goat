import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { botDir, configDir, dataDir } from '../src/paths';

const posix = (...p: string[]) => path.posix.join(...p);
const win = (...p: string[]) => path.win32.join(...p);

describe('configDir / dataDir', () => {
  it('linux uses XDG variables when set', () => {
    const env = { XDG_CONFIG_HOME: '/x/cfg', XDG_DATA_HOME: '/x/data' };
    expect(configDir(env, 'linux', '/home/u')).toBe('/x/cfg/goat-runner');
    expect(dataDir(env, 'linux', '/home/u')).toBe('/x/data/goat-runner');
  });

  it('linux falls back to ~/.config and ~/.local/share', () => {
    expect(configDir({}, 'linux', '/home/u')).toBe('/home/u/.config/goat-runner');
    expect(dataDir({}, 'linux', '/home/u')).toBe('/home/u/.local/share/goat-runner');
  });

  it('treats empty XDG variables as unset', () => {
    const env = { XDG_CONFIG_HOME: '', XDG_DATA_HOME: '' };
    expect(configDir(env, 'linux', '/home/u')).toBe('/home/u/.config/goat-runner');
    expect(dataDir(env, 'linux', '/home/u')).toBe('/home/u/.local/share/goat-runner');
  });

  it('macOS keeps both under Application Support, in config/ and data/', () => {
    const base = '/Users/u/Library/Application Support/goat-runner';
    expect(configDir({}, 'darwin', '/Users/u')).toBe(`${base}/config`);
    expect(dataDir({}, 'darwin', '/Users/u')).toBe(`${base}/data`);
  });

  it('macOS ignores XDG variables', () => {
    const env = { XDG_CONFIG_HOME: '/x/cfg', XDG_DATA_HOME: '/x/data' };
    expect(configDir(env, 'darwin', '/Users/u')).toBe(
      '/Users/u/Library/Application Support/goat-runner/config',
    );
  });

  it('windows uses APPDATA and LOCALAPPDATA with backslashes', () => {
    const env = { APPDATA: 'C:\\Users\\u\\AppData\\Roaming', LOCALAPPDATA: 'D:\\Local' };
    expect(configDir(env, 'win32', 'C:\\Users\\u')).toBe(
      'C:\\Users\\u\\AppData\\Roaming\\goat-runner',
    );
    expect(dataDir(env, 'win32', 'C:\\Users\\u')).toBe('D:\\Local\\goat-runner');
  });

  it('windows falls back under home when APPDATA / LOCALAPPDATA are missing', () => {
    expect(configDir({}, 'win32', 'C:\\Users\\u')).toBe(
      win('C:\\Users\\u', 'AppData', 'Roaming', 'goat-runner'),
    );
    expect(dataDir({}, 'win32', 'C:\\Users\\u')).toBe(
      win('C:\\Users\\u', 'AppData', 'Local', 'goat-runner'),
    );
    expect(configDir({}, 'win32', 'C:\\Users\\u')).toContain('\\');
    expect(configDir({}, 'win32', 'C:\\Users\\u')).not.toContain('/');
  });

  it.each(['linux', 'darwin', 'win32'] as const)(
    'GOAT_RUNNER_HOME wins on %s, giving config/ and data/',
    (platform) => {
      const j = platform === 'win32' ? win : posix;
      const home = platform === 'win32' ? 'D:\\grh' : '/tmp/grh';
      const env = { GOAT_RUNNER_HOME: home, XDG_CONFIG_HOME: '/x', APPDATA: 'C:\\a' };
      expect(configDir(env, platform, '/h')).toBe(j(home, 'config'));
      expect(dataDir(env, platform, '/h')).toBe(j(home, 'data'));
    },
  );

  it('an empty GOAT_RUNNER_HOME is ignored', () => {
    expect(configDir({ GOAT_RUNNER_HOME: '' }, 'linux', '/home/u')).toBe(
      '/home/u/.config/goat-runner',
    );
  });

  it('an unsupported platform is treated as linux', () => {
    expect(configDir({}, 'freebsd' as never, '/home/u')).toBe('/home/u/.config/goat-runner');
  });

  it('equal XDG variables give config/ and data/ under that folder', () => {
    const env = { XDG_CONFIG_HOME: '/x', XDG_DATA_HOME: '/x' };
    expect(configDir(env, 'linux', '/h')).toBe('/x/goat-runner/config');
    expect(dataDir(env, 'linux', '/h')).toBe('/x/goat-runner/data');
  });

  it('equal APPDATA and LOCALAPPDATA give config\\ and data\\ under that folder', () => {
    const env = { APPDATA: 'C:\\A', LOCALAPPDATA: 'c:\\a' };
    expect(configDir(env, 'win32', 'C:\\u')).toBe('C:\\A\\goat-runner\\config');
    expect(dataDir(env, 'win32', 'C:\\u')).toBe('C:\\A\\goat-runner\\data');
  });

  it('a data folder inside the config folder is moved out too', () => {
    const env = { XDG_CONFIG_HOME: '/x', XDG_DATA_HOME: '/x/goat-runner/deeper' };
    expect(dataDir(env, 'linux', '/h')).toBe('/x/goat-runner/data');
    expect(configDir(env, 'linux', '/h')).toBe('/x/goat-runner/config');
  });

  it('a relative GOAT_RUNNER_HOME throws', () => {
    expect(() => configDir({ GOAT_RUNNER_HOME: 'rel' }, 'linux', '/h')).toThrow(
      'GOAT_RUNNER_HOME must be an absolute path',
    );
    expect(() => dataDir({ GOAT_RUNNER_HOME: '..\\rel' }, 'win32', 'C:\\h')).toThrow(
      'GOAT_RUNNER_HOME must be an absolute path',
    );
  });

  it('relative XDG, APPDATA and LOCALAPPDATA values are ignored', () => {
    const env = { XDG_CONFIG_HOME: 'rel', XDG_DATA_HOME: 'rel2' };
    expect(configDir(env, 'linux', '/h')).toBe('/h/.config/goat-runner');
    expect(dataDir(env, 'linux', '/h')).toBe('/h/.local/share/goat-runner');
    const w = { APPDATA: 'rel', LOCALAPPDATA: 'rel2' };
    expect(configDir(w, 'win32', 'C:\\u')).toBe('C:\\u\\AppData\\Roaming\\goat-runner');
    expect(dataDir(w, 'win32', 'C:\\u')).toBe('C:\\u\\AppData\\Local\\goat-runner');
  });
});

// Every layout the file knows about: the bot folder must never be in or above-the-credential.
const layouts: [string, NodeJS.ProcessEnv, 'linux' | 'darwin' | 'win32', string][] = [
  ['linux default', {}, 'linux', '/h'],
  ['linux xdg', { XDG_CONFIG_HOME: '/c', XDG_DATA_HOME: '/d' }, 'linux', '/h'],
  ['linux equal xdg', { XDG_CONFIG_HOME: '/x', XDG_DATA_HOME: '/x' }, 'linux', '/h'],
  ['linux nested', { XDG_CONFIG_HOME: '/x', XDG_DATA_HOME: '/x/goat-runner/z' }, 'linux', '/h'],
  ['linux home', { GOAT_RUNNER_HOME: '/g' }, 'linux', '/h'],
  ['darwin', {}, 'darwin', '/Users/u'],
  ['win default', {}, 'win32', 'C:\\u'],
  ['win equal', { APPDATA: 'C:\\A', LOCALAPPDATA: 'C:\\A' }, 'win32', 'C:\\u'],
  ['win home', { GOAT_RUNNER_HOME: 'D:\\g' }, 'win32', 'C:\\u'],
];

describe('layout invariant', () => {
  it.each(layouts)(
    'bot folder is never inside the config folder: %s',
    (_n, env, platform, home) => {
      const p = platform === 'win32' ? path.win32 : path.posix;
      const c = configDir(env, platform, home);
      const b = botDir(dataDir(env, platform, home), 1, platform);
      const rel = p.relative(c, b);
      const inside =
        rel === '' || (rel !== '..' && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel));
      expect(inside).toBe(false);
    },
  );
});

describe('botDir', () => {
  it('is <data>/bots/<id>', () => {
    expect(botDir('/d', 7, 'linux')).toBe('/d/bots/7');
  });

  it('uses the platform separator for a win32 path on any host', () => {
    expect(botDir('C:\\d', 7, 'win32')).toBe('C:\\d\\bots\\7');
  });

  it.each([0, -1, 1.5, Number.NaN, '3' as unknown as number, Infinity, 2 ** 60])(
    'rejects %s',
    (id) => {
      expect(() => botDir('/d', id)).toThrow(RangeError);
    },
  );
});
