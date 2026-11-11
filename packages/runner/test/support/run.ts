import spawn from 'cross-spawn';
import { fileURLToPath } from 'node:url';

export const CLI = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

// Runs the built CLI as a real child process; stdin is closed unless a test asks for a pipe.
export function run(
  args: string[],
  opts: { env?: Record<string, string>; stdin?: 'ignore' | 'pipe'; cwd?: string } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: [opts.stdin ?? 'ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr?.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, code }));
  });
}
