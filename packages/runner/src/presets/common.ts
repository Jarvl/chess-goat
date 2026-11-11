import fs from 'node:fs';
import path from 'node:path';
import type { Preset, RunnerTurn } from '@chess-goat/shared';
import type { SessionSpec } from '../session.js';

export type TurnFiles = {
  dir: string;
  promptFile: string;
  personaFile: string;
  mcpConfigFile: string;
};

export type HarnessPreset = {
  name: Preset;
  status: 'verified' | 'unverified';
  /** Is the harness's executable on PATH. Never runs it. */
  detect(): Promise<boolean>;
  writeFiles(turn: RunnerTurn, dir: string): Promise<TurnFiles>;
  session(turn: RunnerTurn, files: TurnFiles, cwd: string): SessionSpec;
};

export const DEFAULT_PERSONA = 'You are a chess bot. Play sound, sensible chess.';

/** The one MCP server every preset gives a session. */
export const SERVER_NAME = 'chess-goat';
export const TOKEN_ENV = 'GOAT_TURN_TOKEN';

const isPosix = () => process.platform !== 'win32';

/** Writes a new private file (0600 on POSIX). Throws if it exists: the folder is fresh per session. */
export function writePrivate(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, ...(isPosix() ? { mode: 0o700 } : {}) });
  fs.writeFileSync(file, text, { flag: 'wx', ...(isPosix() ? { mode: 0o600 } : {}) });
  if (isPosix()) fs.chmodSync(file, 0o600); // in case of a umask surprise
}

export const personaOf = (turn: RunnerTurn) => turn.persona ?? DEFAULT_PERSONA;

/** Writes prompt.txt, persona.txt and (unless null) the MCP config; returns their paths. */
export function writeTurnFiles(
  turn: RunnerTurn,
  dir: string,
  mcpConfigFile: string,
  mcpConfigText: string | null,
): TurnFiles {
  const dirAbs = path.resolve(dir);
  const promptFile = path.join(dirAbs, 'prompt.txt');
  const personaFile = path.join(dirAbs, 'persona.txt');
  writePrivate(promptFile, turn.prompt);
  writePrivate(personaFile, personaOf(turn));
  if (mcpConfigText !== null) writePrivate(mcpConfigFile, mcpConfigText);
  return { dir: dirAbs, promptFile, personaFile, mcpConfigFile };
}

/** The Claude Code shape of an MCP config; the token is referenced, never written. */
export function claudeMcpConfig(mcpUrl: string): string {
  return `${JSON.stringify(
    {
      mcpServers: {
        [SERVER_NAME]: {
          type: 'http',
          url: mcpUrl,
          headers: { Authorization: `Bearer \${${TOKEN_ENV}}` },
        },
      },
    },
    null,
    2,
  )}\n`;
}

/** Walks PATH (and PATHEXT on Windows) for an executable called `name`. Does not run it. */
export function onPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const win = platform === 'win32';
  // Windows env names are case-insensitive ("Path").
  const get = (key: string) =>
    win ? Object.entries(env).find(([k]) => k.toUpperCase() === key)?.[1] : env[key];
  const dirs = (get('PATH') ?? '').split(win ? ';' : ':').filter(Boolean);
  // Windows runs only files with an executable extension: a bare name is tried as given only when
  // it already ends in one.
  const pathExt = win ? (get('PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [];
  const hasExt = pathExt.some((e) => name.toUpperCase().endsWith(e.toUpperCase()));
  const exts = win ? (hasExt ? [''] : pathExt) : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = path.join(dir.replace(/^"|"$/g, ''), name + ext);
      try {
        if (!fs.statSync(file).isFile()) continue;
        fs.accessSync(file, win ? fs.constants.F_OK : fs.constants.X_OK);
        return true;
      } catch {
        // not here
      }
    }
  }
  return false;
}

export const detectOnPath = (name: string) => async () => onPath(name);
