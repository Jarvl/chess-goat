import { spawn } from 'node:child_process';
import type { EngineLevel } from '@chess-goat/shared';
import type { Config } from '../config';
import type { Logger } from '../logger';
import type { BestMove, Engine } from './engine';
import { optionsForLevel, parseBestMove, unsupportedOptions } from './protocol';

export type EngineConfig = Pick<Config, 'ENGINE_PATH' | 'ENGINE_MOVETIME_MS'>;

/** Runs one UCI session to completion and returns everything it printed. */
function session(path: string, commands: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(path, [], { stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '';
    let settled = false;
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      if (error) reject(error);
      else resolve(output);
    };
    const timer = setTimeout(() => finish(new Error('engine timed out')), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
    });
    child.on('error', (error) => finish(error));
    child.on('close', () => finish(null));
    child.stdin.on('error', () => undefined);
    child.stdin.end(`${commands.join('\n')}\n`);
  });
}

export function uciEngine(config: EngineConfig, log?: Pick<Logger, 'warn'>): Engine {
  const path = config.ENGINE_PATH;
  // One warning per option per process: a build that ignores an option ignores it on every move,
  // and the point is to make the fact visible, not to fill the log with it.
  const warned = new Set<string>();
  /**
   * Spec §13: an option the packaged build silently ignores would make two levels play identically,
   * "the one failure a user would notice and no test asserts". It stays a warning rather than a
   * failure — a future Stockfish that renames an option should degrade, not refuse to play.
   */
  const warnAboutIgnoredOptions = (level: EngineLevel, output: string): void => {
    for (const option of unsupportedOptions(output)) {
      if (warned.has(option)) continue;
      warned.add(option);
      log?.warn(
        { option, level },
        'the engine rejected a UCI option; this level may play at full strength',
      );
    }
  };
  return {
    async bestMove(fen: string, level: EngineLevel, deadlineMs: number): Promise<BestMove> {
      const options = optionsForLevel(level).map(
        (option) => `setoption name ${option.name} value ${option.value}`,
      );
      const output = await session(
        path,
        [
          'uci',
          ...options,
          'isready',
          'ucinewgame',
          `position fen ${fen}`,
          `go movetime ${config.ENGINE_MOVETIME_MS}`,
          'quit',
        ],
        deadlineMs,
      );
      warnAboutIgnoredOptions(level, output);
      const move = parseBestMove(output);
      if (!move) throw new Error(`engine produced no bestmove: ${output.slice(-200)}`);
      return move;
    },
    async probe() {
      try {
        const output = await session(path, ['uci', 'quit'], 10_000);
        const version = /^id name (.+)$/m.exec(output)?.[1];
        return { available: /uciok/.test(output), version };
      } catch {
        return { available: false };
      }
    },
  };
}
