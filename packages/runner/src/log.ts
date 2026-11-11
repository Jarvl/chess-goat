import fs from 'node:fs';
import path from 'node:path';

export type Logger = { info(line: string): void; warn(line: string): void };

export const LOG_MAX_BYTES = 5 * 1024 * 1024;
const TAIL_READ_BYTES = 256 * 1024;
const posix = process.platform !== 'win32';

export function consoleLogger(): Logger {
  return {
    info: (line) => console.log(line),
    warn: (line) => console.error(line),
  };
}

const logPath = (dataDir: string) => path.join(dataDir, 'runner.log');

function rotate(file: string): void {
  try {
    // Windows rename does not overwrite an existing file.
    fs.rmSync(`${file}.1`, { force: true });
    fs.renameSync(file, `${file}.1`);
  } catch {
    // Never lose the line over a failed rename: start the file again instead.
    try {
      fs.truncateSync(file, 0);
    } catch {
      // append below will report nothing; logging must not throw
    }
  }
}

/** One line per call, appended synchronously so it survives a crash. Never throws. */
export function fileLogger(dataDir: string, opts: { maxBytes?: number } = {}): Logger {
  const max = opts.maxBytes ?? LOG_MAX_BYTES;
  const file = logPath(dataDir);
  const write = (level: 'INFO' | 'WARN', line: string) => {
    // Bot names are chosen by other people: a log line must stay one line.
    const text = `${new Date().toISOString()} ${level} ${line.replace(/[\r\n]/g, ' ')}\n`;
    try {
      fs.mkdirSync(dataDir, { recursive: true, ...(posix ? { mode: 0o700 } : {}) });
      try {
        if (fs.statSync(file).size >= max) rotate(file);
      } catch {
        // no file yet
      }
      fs.appendFileSync(file, text, posix ? { mode: 0o600 } : undefined);
    } catch {
      // a full disk must not take the runner down
    }
  };
  return { info: (l) => write('INFO', l), warn: (l) => write('WARN', l) };
}

/** The last `lines` lines of the log (reading at most its last 256 KB); '' when there is none. */
export function readLogTail(dataDir: string, lines: number): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(logPath(dataDir), 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_READ_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let all = buf.toString('utf8').split('\n');
    if (start > 0) all = all.slice(1); // first line is probably cut
    if (all[all.length - 1] === '') all.pop();
    return lines > 0 ? all.slice(-lines).join('\n') : '';
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
