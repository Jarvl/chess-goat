import os from 'node:os';
import path from 'node:path';

export type Platform = 'linux' | 'darwin' | 'win32';

const APP = 'goat-runner';

// Pure: callers pass env/platform/home, and paths are built for that platform, not the host's.
const pathFor = (platform: Platform) => (platform === 'win32' ? path.win32 : path.posix);

/** One computation for both folders, so they can never disagree. */
function layout(
  env: NodeJS.ProcessEnv,
  platform: Platform,
  home: string,
): { config: string; data: string } {
  const p = pathFor(platform);
  // Relative values are ignored, as the XDG spec requires.
  const abs = (v: string | undefined) => (v && p.isAbsolute(v) ? v : undefined);

  if (env.GOAT_RUNNER_HOME) {
    if (!p.isAbsolute(env.GOAT_RUNNER_HOME)) {
      throw new Error('GOAT_RUNNER_HOME must be an absolute path');
    }
    return {
      config: p.join(env.GOAT_RUNNER_HOME, 'config'),
      data: p.join(env.GOAT_RUNNER_HOME, 'data'),
    };
  }

  let config: string;
  let data: string;
  if (platform === 'win32') {
    config = p.join(abs(env.APPDATA) ?? p.join(home, 'AppData', 'Roaming'), APP);
    data = p.join(abs(env.LOCALAPPDATA) ?? p.join(home, 'AppData', 'Local'), APP);
  } else if (platform === 'darwin') {
    const base = p.join(home, 'Library', 'Application Support', APP);
    return { config: p.join(base, 'config'), data: p.join(base, 'data') };
  } else {
    config = p.join(abs(env.XDG_CONFIG_HOME) ?? p.join(home, '.config'), APP);
    data = p.join(abs(env.XDG_DATA_HOME) ?? p.join(home, '.local', 'share'), APP);
  }

  // A session starts in a bot folder under data; the credential must never be in or above it.
  const rel = p.relative(config, data);
  if (rel === '' || (rel !== '..' && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel))) {
    return { config: p.join(config, 'config'), data: p.join(config, 'data') };
  }
  return { config, data };
}

export function configDir(env: NodeJS.ProcessEnv, platform: Platform, home: string): string {
  return layout(env, platform, home).config;
}

export function dataDir(env: NodeJS.ProcessEnv, platform: Platform, home: string): string {
  return layout(env, platform, home).data;
}

/** Keyed by id, not name, so renaming a bot cannot orphan its folder. */
export function botDir(
  data: string,
  botId: number,
  platform: Platform = process.platform as Platform,
): string {
  if (!Number.isSafeInteger(botId) || botId <= 0) {
    throw new RangeError('bot id must be a positive integer');
  }
  return pathFor(platform).join(data, 'bots', String(botId));
}

export function defaultPaths(): { config: string; data: string } {
  return layout(process.env, process.platform as Platform, os.homedir());
}
