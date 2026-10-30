import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { staticAppRoutes } from '../../src/api/staticApp';

let app: Hono;
let parent: string;

beforeAll(async () => {
  parent = await mkdtemp(join(tmpdir(), 'static-'));
  const dir = join(parent, 'dist');
  await mkdir(join(dir, 'assets'), { recursive: true });
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>Group Chess</title>');
  await writeFile(join(dir, 'assets', 'app-1a2b3c.js'), 'console.log(1)');
  await writeFile(join(dir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await writeFile(join(parent, 'secret.txt'), 'nope');
  app = new Hono();
  app.route('/app', staticAppRoutes(dir));
});
afterAll(() => rm(parent, { recursive: true, force: true }));

describe('staticAppRoutes', () => {
  it('serves index.html uncached at the mount root', async () => {
    const response = await app.request('/app/');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toContain('Group Chess');
  });

  it('serves hashed assets as immutable', async () => {
    const response = await app.request('/app/assets/app-1a2b3c.js');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('serves other files with a short cache', async () => {
    const response = await app.request('/app/favicon.svg');
    expect(response.headers.get('content-type')).toBe('image/svg+xml');
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
  });

  it('falls back to index.html for client-side routes', async () => {
    const response = await app.request('/app/g/AbCdEfGhIj');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toContain('Group Chess');
  });

  it('answers 404 for a missing asset or file instead of falling back', async () => {
    expect((await app.request('/app/assets/missing.js')).status).toBe(404);
    expect((await app.request('/app/robots.txt')).status).toBe(404);
  });

  it('never leaves the directory', async () => {
    const response = await app.request('/app/%2e%2e/secret.txt');
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('nope');
  });

  it('sets the content security policy on the app HTML only', async () => {
    const index = await app.request('/app/');
    expect(index.headers.get('content-security-policy')).toBe(
      "default-src 'self'; script-src 'self' https://telegram.org; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'",
    );
    const asset = await app.request('/app/assets/app-1a2b3c.js');
    expect(asset.headers.get('content-security-policy')).toBeNull();
  });
});
