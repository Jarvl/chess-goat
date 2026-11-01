import { createServer, type Server } from 'node:net';
import { defineConfig, devices } from '@playwright/test';

// Each run gets two free ports, so `pnpm e2e` in one worktree never meets another worktree's harness.
// Workers load this file again; they inherit the ports chosen here through `process.env`.
if (!process.env.E2E_APP_PORT || !process.env.E2E_HARNESS_PORT) {
  const [app, harness] = await freePorts(2);
  process.env.E2E_APP_PORT = String(app);
  process.env.E2E_HARNESS_PORT = String(harness);
}

const APP = `http://127.0.0.1:${process.env.E2E_APP_PORT}`;
const HARNESS = `http://127.0.0.1:${process.env.E2E_HARNESS_PORT}`;

/** Spec §15: Chromium with touch emulation against the server plus the fake WebApp harness. */
export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  // docs/testing.md: a failing test is never a flake until proven, so a retry hides nothing.
  retries: 0,
  reporter: 'line',
  use: {
    baseURL: APP,
    ...devices['Pixel 7'],
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined },
  },
  webServer: {
    command: 'pnpm --filter @chess-goat/server exec tsx test/e2e/harness.ts',
    url: `${HARNESS}/health`,
    timeout: 90_000,
    // Never another run's server: it would be another worktree's code.
    reuseExistingServer: false,
  },
});

/** `count` distinct free ports: every listener stays open until all are bound, so none repeats. */
async function freePorts(count: number): Promise<number[]> {
  const servers: Server[] = [];
  try {
    for (let i = 0; i < count; i += 1) {
      const server = createServer();
      servers.push(server);
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
    }
    return servers.map((server) => (server.address() as { port: number }).port);
  } finally {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  }
}
