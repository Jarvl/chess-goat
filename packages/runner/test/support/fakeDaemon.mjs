// Stand-in for `goat-runner run --daemon`. Plain Node: it cannot import the TypeScript source,
// so the pid file format below (three fields, mode 0600) duplicates src/daemon.ts claimPidFile.
// GOAT_FAKE_MODE: unset (normal), `stubborn` (ignores SIGTERM), `silent` (never writes the file),
// `exit` (exits at once without a pid file: a daemon that lost the claim).
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout } from 'node:timers';

const mode = process.env.GOAT_FAKE_MODE;
const data = join(process.env.GOAT_RUNNER_HOME, 'data');
const file = join(data, 'runner.pid');
if (mode === 'exit') process.exit(1);
const token = randomBytes(8).toString('hex');

// Gives up by itself so a failing test cannot leave it behind.
setTimeout(() => process.exit(0), mode === 'silent' ? 3_000 : 30_000);

if (mode !== 'silent') {
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, 'cwd.txt'), process.cwd()); // where startDaemon put us
  writeFileSync(
    file,
    JSON.stringify({ pid: process.pid, since: new Date().toISOString(), token }),
    {
      mode: 0o600,
    },
  );
  process.on('SIGTERM', () => {
    if (mode === 'stubborn') return;
    rmSync(file, { force: true });
    process.exit(0);
  });
}
