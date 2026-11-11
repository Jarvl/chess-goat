// Types for the runner as the end-to-end test uses it. At run time vitest aliases 'goat-runner' to
// the runner's source (vitest.config.ts); type-checking the sources here would drag them outside
// this project's rootDir, so only the surface the test touches is declared. Keep it in step with
// packages/runner/src/index.ts.
declare module 'goat-runner' {
  import type {
    Preset,
    RunnerClaimRequest,
    RunnerLinkRequest,
    RunnerLinkResponse,
    RunnerReleaseRequest,
    RunnerTurn,
  } from '@chess-goat/shared';

  export type Client = {
    link(body: RunnerLinkRequest): Promise<RunnerLinkResponse>;
    claim(body: RunnerClaimRequest, signal: AbortSignal): Promise<RunnerTurn | null>;
    release(body: RunnerReleaseRequest, signal?: AbortSignal): Promise<void>;
  };
  export function createClient(opts: {
    server: string;
    credential?: string;
    userAgent: string;
  }): Client;

  export type RunnerConfig = {
    server: string;
    credential: string;
    runnerId: number;
    preset: Preset;
    custom?: { command: string; args: string[] };
    lean?: { baseUrl: string; model: string; apiKeyEnv?: string };
    concurrency: number;
    leaseSeconds: number;
  };
  export type Logger = { info(line: string): void; warn(line: string): void };
  export type LoopDeps = {
    client: Client;
    config: RunnerConfig;
    dataDir: string;
    log: Logger;
    tmpRoot?: string;
    timing?: { backoffBaseMs?: number; rateLimitWaitMs?: number; minLeftMs?: number };
  };
  export function runLoop(deps: LoopDeps, signal: AbortSignal): Promise<'stopped' | 'revoked'>;
}
