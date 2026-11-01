export const REPO_ROOT: string;
export function worktreeKey(root: string): string;
export function testDatabaseName(root: string, kind?: 'test' | 'e2e'): string;
export function scratchDatabaseName(root: string, name: string, pid: number): string;
