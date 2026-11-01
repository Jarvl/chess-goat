import { ensureTestDatabase } from './testDatabase';

/** This worktree's own database, created and migrated, so concurrent worktrees never meet. */
export default async function setup(): Promise<void> {
  try {
    await ensureTestDatabase('test');
  } catch (error) {
    // Vitest 5 crashes mapping a global setup error's stack frames to source and prints that crash
    // instead, so the error goes out with its message and no frames.
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 0;
    const bare = new Error(error instanceof Error ? error.message : String(error));
    Error.stackTraceLimit = limit;
    throw bare;
  }
}
