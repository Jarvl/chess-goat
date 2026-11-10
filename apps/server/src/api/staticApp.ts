import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { Hono } from 'hono';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
};

const IMMUTABLE = 'public, max-age=31536000, immutable';
const SHORT = 'public, max-age=300';
/** No third-party scripts, fonts or analytics; chessground needs inline styles. */
export const APP_CSP =
  "default-src 'self'; script-src 'self' https://telegram.org; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'";

async function fileAt(path: string): Promise<Buffer | null> {
  try {
    if (!(await stat(path)).isFile()) return null;
    return await readFile(path);
  } catch {
    return null;
  }
}

/**
 * Serves the built Mini App under `mountPath`: hashed files in `assets/` are immutable
 * for a year, `index.html` is never cached, other files get five minutes, and paths without an
 * extension fall back to `index.html` so client-side routes survive a reload.
 */
export function staticAppRoutes(dir: string, mountPath = '/app'): Hono {
  const root = resolve(dir);
  const app = new Hono();
  app.get('/*', async (c) => {
    let relative: string;
    try {
      const path = c.req.path.startsWith(mountPath)
        ? c.req.path.slice(mountPath.length)
        : c.req.path;
      relative = normalize(`/${decodeURIComponent(path)}`)
        .split(sep)
        .join('/');
    } catch {
      return c.notFound();
    }
    const target = join(root, relative);
    if (target !== root && !target.startsWith(root + sep)) return c.notFound();
    const isIndex = relative === '/' || relative === '/index.html';
    let body = isIndex ? null : await fileAt(target);
    let type = TYPES[extname(target)] ?? 'application/octet-stream';
    let cache = relative.startsWith('/assets/') ? IMMUTABLE : SHORT;
    if (!body) {
      if (!isIndex && extname(relative) !== '') return c.notFound();
      body = await fileAt(join(root, 'index.html'));
      if (!body) return c.notFound();
      type = TYPES['.html']!;
      cache = 'no-store';
    }
    c.header('Content-Type', type);
    c.header('Cache-Control', cache);
    if (type === TYPES['.html']) c.header('Content-Security-Policy', APP_CSP);
    // A fresh Uint8Array: Hono's body type wants an ArrayBuffer-backed view, not a Node Buffer.
    return c.body(new Uint8Array(body));
  });
  return app;
}
