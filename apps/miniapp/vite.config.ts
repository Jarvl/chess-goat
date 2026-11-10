import { defineConfig } from 'vite';

/** Served by the server under /app/; hashed assets are immutable there. */
export default defineConfig({
  base: '/app/',
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  build: { target: 'es2022', sourcemap: false, reportCompressedSize: true },
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:3000' } },
});
