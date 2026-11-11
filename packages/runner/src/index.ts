// The library face of the package, for tests that run the loop in-process. The CLI is cli.ts.
export { createClient } from './client.js';
export type { Client } from './client.js';
export type { RunnerConfig } from './config.js';
export { runLoop } from './loop.js';
export type { LoopDeps, Logger } from './loop.js';
