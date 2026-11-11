// A stand-in agent harness for session tests. Plain Node so it runs the same on every platform.
import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers';

const [mode, arg] = process.argv.slice(2);
// Hangs, but gives up after 30 s so a failing test cannot leave processes behind.
const hang = () => setTimeout(() => process.exit(0), 30_000);

switch (mode) {
  case 'ok':
    console.log('ok');
    break;
  case 'fail':
    console.error('nope');
    process.exitCode = 3;
    break;
  case 'hang':
    console.log('hanging');
    hang();
    break;
  case 'fork': {
    const grandchild = spawn(process.execPath, [process.argv[1], 'hang'], { stdio: 'ignore' });
    console.log(`grandchild ${grandchild.pid}`);
    hang();
    break;
  }
  case 'orphan-stdout': {
    // Leaves a grandchild holding our stdout open, then exits cleanly.
    const grandchild = spawn(process.execPath, [process.argv[1], 'hang'], {
      stdio: ['ignore', 'inherit', 'ignore'],
    });
    grandchild.unref(); // or its handle would keep us alive
    console.log(`grandchild ${grandchild.pid}`);
    break;
  }
  case 'self-kill':
    process.kill(process.pid, 'SIGKILL');
    break;
  case 'echo-env':
    console.log(process.env[arg] ?? '');
    break;
  case 'ignore-term':
    process.on('SIGTERM', () => {});
    console.log('stubborn');
    hang();
    break;
  case 'spam':
    for (let i = 0; i < Number(arg); i++) console.log(String(i).padStart(100, 'x'));
    break;
  case 'stdin': {
    let length = 0;
    process.stdin.on('data', (d) => (length += d.length));
    process.stdin.on('end', () => console.log(length));
    break;
  }
  default:
    console.error(`unknown mode ${mode}`);
    process.exitCode = 2;
}
