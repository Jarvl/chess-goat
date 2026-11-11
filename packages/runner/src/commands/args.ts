import { parseArgs, type ParseArgsConfig } from 'node:util';
import { UsageError } from './context.js';

type Opts = NonNullable<ParseArgsConfig['options']>;

/** parseArgs, with its errors turned into usage errors for `command`. */
export function parse<O extends Opts>(
  command: string,
  args: string[],
  options: O,
  positionals: number,
) {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: { json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, ...options },
      allowPositionals: true,
      strict: true,
    });
  } catch (e) {
    throw new UsageError((e as Error).message.split('\n')[0] ?? 'bad arguments', command);
  }
  if (!(parsed.values as { help?: boolean }).help && parsed.positionals.length !== positionals) {
    throw new UsageError(
      positionals === 0 ? 'unexpected argument' : 'wrong number of arguments',
      command,
    );
  }
  return parsed;
}
