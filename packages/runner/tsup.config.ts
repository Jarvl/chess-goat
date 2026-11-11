import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export default defineConfig({
  entry: ['src/cli.ts'],
  format: 'esm',
  target: 'node20',
  platform: 'node',
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
  // The published file must not need the workspace package; zod and cross-spawn stay runtime deps.
  noExternal: ['@chess-goat/shared'],
  define: { __VERSION__: JSON.stringify(pkg.version) },
});
