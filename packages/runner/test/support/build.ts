import spawn from 'cross-spawn';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
let built: Promise<void> | undefined;

// Builds dist/ with tsup.config.ts from the package root, whatever the working directory is (the
// root `pnpm test` runs this package's tests from the repo root). Repeated calls share one build.
export function buildOnce(): Promise<void> {
  built ??= new Promise<void>((resolve, reject) => {
    const pkgPath = createRequire(import.meta.url).resolve('tsup/package.json');
    const { bin } = createRequire(import.meta.url)(pkgPath) as { bin: { tsup: string } };
    const child = spawn(process.execPath, [join(dirname(pkgPath), bin.tsup)], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout?.setEncoding('utf8').on('data', (d: string) => (output += d));
    child.stderr?.setEncoding('utf8').on('data', (d: string) => (output += d));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`tsup exited ${code}:\n${output}`)),
    );
  });
  return built;
}
