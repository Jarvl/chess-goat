import os from 'node:os';
import path from 'node:path';

export type Platform = 'linux' | 'darwin' | 'win32';

const APP = 'goat-runner';

// Pure: callers pass env/platform/home, and paths are built for that platform, not the host's.
const pathFor = (platform: Platform) => (platform === 'win32' ? path.win32 : path.posix);
const set = (v: string | undefined): v is string => v !== undefined && v !== '';

export function configDir(env: NodeJS.ProcessEnv, platform: Platform, home: string): string {
  const p = pathFor(platform);
  if (set(env.GOAT_RUNNER_HOME)) return p.join(env.GOAT_RUNNER_HOME, 'config');
  if (platform === 'win32') {
    return p.join(set(env.APPDATA) ? env.APPDATA : p.join(home, 'AppData', 'Roaming'), APP);
  }
  if (platform === 'darwin') return p.join(home, 'Library', 'Application Support', APP, 'config');
  return p.join(set(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : p.join(home, '.config'), APP);
}

export function dataDir(env: NodeJS.ProcessEnv, platform: Platform, home: string): string {
  const p = pathFor(platform);
  if (set(env.GOAT_RUNNER_HOME)) return p.join(env.GOAT_RUNNER_HOME, 'data');
  if (platform === 'win32') {
    return p.join(set(env.LOCALAPPDATA) ? env.LOCALAPPDATA : p.join(home, 'AppData', 'Local'), APP);
  }
  if (platform === 'darwin') return p.join(home, 'Library', 'Application Support', APP, 'data');
  return p.join(set(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : p.join(home, '.local', 'share'), APP);
}

/** Keyed by id, not name, so renaming a bot cannot orphan its folder. */
export function botDir(data: string, botId: number): string {
  if (!Number.isInteger(botId) || botId <= 0) {
    throw new RangeError('bot id must be a positive integer');
  }
  return path.join(data, 'bots', String(botId));
}

export function defaultPaths(): { config: string; data: string } {
  const platform = process.platform as Platform;
  const home = os.homedir();
  return {
    config: configDir(process.env, platform, home),
    data: dataDir(process.env, platform, home),
  };
}
