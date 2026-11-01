import { defineConfig } from 'vitest/config';

// `pnpm test:unit` sets this to skip the integration tests on purpose. Without it they always run,
// on this worktree's own database (test/helpers/testDatabase.ts), and fail if no server answers.
const unitOnly = process.env.TEST_UNIT_ONLY === '1';

export default defineConfig({
  test: {
    name: 'server',
    include: unitOnly ? ['test/unit/**/*.test.ts'] : ['test/**/*.test.ts'],
    exclude: ['test/e2e/**', '**/node_modules/**'],
    globalSetup: ['test/helpers/fonts.ts', ...(unitOnly ? [] : ['test/helpers/globalSetup.ts'])],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
