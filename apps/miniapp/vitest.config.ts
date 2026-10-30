import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact', jsxDev: false },
  test: {
    name: 'miniapp',
    environment: 'happy-dom',
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['test/support/setup.ts'],
    // The app formats dates in the device's time zone, and the tests' fixtures are UTC instants, so
    // the tests run in UTC whatever the machine's zone: at UTC+12 "Aug 12" would read "Aug 13". It
    // is set before any test module loads, so the date formatters built at import see it too.
    env: { TZ: 'UTC' },
  },
});
