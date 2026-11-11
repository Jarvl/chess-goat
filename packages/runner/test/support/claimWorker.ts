// Claims the pid file in <dataDir> at <startAtMs>, prints `won <pid>` or `lost`, holds until stdin ends.
// Run with `node --import tsx` from the package folder: the claim logic is TypeScript.
import { claimPidFile } from '../../src/daemon.js';

const dataDir = process.argv[2] as string;
const startAt = process.argv[3];
while (Date.now() < Number(startAt)) await new Promise((r) => setTimeout(r, 1));
try {
  const claim = claimPidFile(dataDir);
  console.log(`won ${process.pid}`);
  // Holds the claim until the test closes our stdin, so a late starter cannot win after release.
  process.stdin.resume();
  await new Promise((r) => process.stdin.on('end', r));
  claim.release();
} catch {
  console.log('lost');
}
