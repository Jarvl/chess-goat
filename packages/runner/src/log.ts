import fs from 'node:fs';
import path from 'node:path';

export type Logger = { info(line: string): void; warn(line: string): void };

export const LOG_MAX_BYTES = 5 * 1024 * 1024;
const TAIL_READ_BYTES = 256 * 1024;
const MAX_LINE_CHARS = 8000;
const posix = process.platform !== 'win32';

// C0, DEL, C1 and the Unicode line/paragraph separators: bot names are other people's text, and
// an escape sequence in a log must not reach the owner's terminal or split a line.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/** Replaces every control character (newlines included) with a space. */
export function cleanLine(text: string): string {
  return text.replace(CONTROL, ' ');
}

export function consoleLogger(): Logger {
  return {
    info: (line) => console.log(cleanLine(line)),
    warn: (line) => console.error(cleanLine(line)),
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

function capLine(text: string): string {
  if (text.length <= MAX_LINE_CHARS) return text;
  let cut = text.slice(0, MAX_LINE_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1); // not half a surrogate pair
  return `${cut}…`;
}

/** One line per call, appended synchronously so it survives a crash. Never throws. */
export function fileLogger(dataDir: string, opts: { maxBytes?: number } = {}): Logger {
  const max = opts.maxBytes ?? LOG_MAX_BYTES;
  const file = logPath(dataDir);
  const write = (level: 'INFO' | 'WARN', line: string) => {
    const text = `${new Date().toISOString()} ${level} ${capLine(cleanLine(line))}\n`;
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

/**
 * The last `lines` lines of the log (reading at most its last 256 KB); '' when there is none.
 * Cleaned like new lines are: an older or hand-edited log may hold control characters.
 */
export function readLogTail(dataDir: string, lines: number): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(logPath(dataDir), 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_READ_BYTES);
    // One byte early when we can, to tell a window that starts on a line boundary from one that
    // starts inside a line.
    const from = Math.max(0, start - 1);
    const buf = Buffer.alloc(size - from);
    const n = fs.readSync(fd, buf, 0, buf.length, from);
    let all = buf.toString('utf8', 0, n).split('\n');
    if (all[all.length - 1] === '') all.pop();
    if (start > 0) {
      if (all[0] === '')
        all.shift(); // the byte before the window was a newline: nothing is cut
      else if (all.length > 1)
        all.shift(); // the first line is cut; with no newline keep the piece
      else all[0] = (all[0] ?? '').slice(1); // one long line: drop the extra byte we read
    }
    all = lines > 0 ? all.slice(-lines) : [];
    return all.map(cleanLine).join('\n');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
