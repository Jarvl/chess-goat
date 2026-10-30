import { defineConfig, devices } from '@playwright/test';

const APP = 'http://127.0.0.1:4180';
const HARNESS = 'http://127.0.0.1:4181';

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
    command: 'pnpm --filter @group-chess/server exec tsx test/e2e/harness.ts',
    url: `${HARNESS}/health`,
    timeout: 90_000,
    reuseExistingServer: !process.env.CI,
  },
});
