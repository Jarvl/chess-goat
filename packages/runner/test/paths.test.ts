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

  it.each(['linux', 'darwin', 'win32'] as const)('data never lies inside config on %s', (p) => {
    for (const env of [{}, { GOAT_RUNNER_HOME: p === 'win32' ? 'D:\\g' : '/g' }]) {
      const c = configDir(env, p, p === 'win32' ? 'C:\\u' : '/u');
      const d = dataDir(env, p, p === 'win32' ? 'C:\\u' : '/u');
      const rel = (p === 'win32' ? path.win32 : path.posix).relative(c, d);
      expect(rel.startsWith('..')).toBe(true);
    }
  });
});

describe('botDir', () => {
  it('is <data>/bots/<id>', () => {
    expect(botDir('/d', 7)).toBe(path.join('/d', 'bots', '7'));
  });

  it('the bot folder never lies inside the config folder', () => {
    const c = configDir({}, 'linux', '/h');
    const b = botDir(dataDir({}, 'linux', '/h'), 3);
    expect(path.relative(c, b).startsWith('..')).toBe(true);
  });

  it.each([0, -1, 1.5, Number.NaN, '3' as unknown as number, Infinity])('rejects %s', (id) => {
    expect(() => botDir('/d', id)).toThrow(RangeError);
  });
});
