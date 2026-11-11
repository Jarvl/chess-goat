import { cleanLine } from '../log.js';
import { autostart, logs, start, status, stop, unlink } from './control.js';
import { Fail, UsageError, type Context } from './context.js';
import { link } from './link.js';
import { preset } from './preset.js';
import { run } from './run.js';
import { TOP, USAGE } from './usage.js';

const COMMANDS = { link, preset, start, stop, status, logs, run, autostart, unlink } as const;

/** Runs one command line; resolves with the exit code and never throws. */
export async function main(argv: string[], ctx: Context): Promise<number> {
  const [name, ...rest] = argv;
  try {
    if (name === '--version') {
      ctx.stdout(`${ctx.version}\n`);
      return 0;
    }
    if (name === undefined || name === '--help' || name === '-h') {
      ctx.stdout(`${TOP}\n`);
      return 0;
    }
    if (!Object.hasOwn(COMMANDS, name)) {
      throw new UsageError(`Unknown command: ${name}`, null);
    }
    if (rest.includes('--help') || rest.includes('-h')) {
      ctx.stdout(`${USAGE[name]}\n`);
      return 0;
    }
    return await COMMANDS[name as keyof typeof COMMANDS](ctx, rest);
  } catch (e) {
    // One sentence, never a stack trace.
    if (e instanceof UsageError) {
      const text = e.message.split('\n').map(cleanLine).join('\n');
      ctx.stderr(`${text}\n${e.command ? USAGE[e.command] : TOP}\n`);
      return 2;
    }
    if (e instanceof Fail) {
      ctx.stderr(`${cleanLine(e.message)}\n`);
      return e.code;
    }
    ctx.stderr(`${cleanLine(e instanceof Error ? e.message : 'goat-runner failed')}\n`);
    return 1;
  }
}
