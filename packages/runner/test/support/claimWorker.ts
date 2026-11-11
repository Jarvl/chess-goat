// Claims the pid file in <dataDir> at <startAtMs>, prints `won <pid>` or `lost`, holds for 1 s.
// Run with `node --import tsx` from the package folder: the claim logic is TypeScript.
import { claimPidFile } from '../../src/daemon.js';

const dataDir = process.argv[2] as string;
const startAt = process.argv[3];
while (Date.now() < Number(startAt)) await new Promise((r) => setTimeout(r, 1));
try {
  const claim = claimPidFile(dataDir);
  console.log(`won ${process.pid}`);
  await new Promise((r) => setTimeout(r, 1000));
  claim.release();
} catch {
  console.log('lost');
}
