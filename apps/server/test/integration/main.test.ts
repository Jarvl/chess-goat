import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FLAIR, flairBackfillVersion } from '@chess-goat/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { jobs } from '../../src/db/schema';
import { backfillDedupKey } from '../../src/flair/backfill';
import { startServer, type RunningServer } from '../../src/main';
import { testConfig } from '../helpers/config';
import { openTestDb, truncateAll } from '../helpers/db';
import { FakeTelegram } from '../helpers/fakeTelegram';

const { db, close } = openTestDb();
let fake: FakeTelegram;
let server: RunningServer;
let base: string;
let dir: string;

beforeAll(async () => {
  await truncateAll(db);
  fake = await FakeTelegram.start();
  dir = await mkdtemp(join(tmpdir(), 'miniapp-'));
  await mkdir(join(dir, 'assets'));
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>Chess Goat</title>');
  await writeFile(join(dir, 'assets', 'app-1a2b3c.js'), 'console.log(1)');
  server = await startServer(
    // ENGINE_ENABLED: false — otherwise startServer's boot probe would spawn a real `stockfish`
    // process (global constraint: no test may spawn a binary).
    testConfig({ TELEGRAM_API_ROOT: fake.url, PORT: 0, MINI_APP_DIR: dir, ENGINE_ENABLED: false }),
  );
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(async () => {
  await server.stop();
  await fake.stop();
  await close();
  await rm(dir, { recursive: true, force: true });
});

describe('startServer', () => {
  it('answers the health probes', async () => {
    expect(await (await fetch(`${base}/healthz`)).text()).toBe('ok');
    expect(await (await fetch(`${base}/readyz`)).text()).toBe('ok');
  });

  it('enqueues a backfill of every catalog flair at boot', async () => {
    const key = backfillDedupKey(
      FLAIR.map((f) => ({ id: f.id, version: flairBackfillVersion(f) })),
    );
    const queued = (await db.select().from(jobs)).filter((job) => job.kind === 'backfill_flair');
    expect(queued.map((job) => job.dedupKey)).toEqual([key]);
  });

  it('registers the commands per scope at boot', () => {
    const calls = fake.callsTo('setMyCommands');
    expect(calls).toHaveLength(2);
    const byScope = Object.fromEntries(
      calls.map((call) => [
        (call.body.scope as { type: string }).type,
        (call.body.commands as { command: string }[]).map((c) => c.command),
      ]),
    );
    expect(byScope).toEqual({
      all_group_chats: ['challenge', 'chess', 'settings'],
      all_private_chats: ['start', 'paysupport'],
    });
    const group = calls.find(
      (call) => (call.body.scope as { type: string }).type === 'all_group_chats',
    );
    expect(
      (group?.body.commands as { command: string; is_ephemeral?: boolean }[]).map((c) => [
        c.command,
        c.is_ephemeral ?? false,
      ]),
    ).toEqual([
      ['challenge', true],
      ['chess', true],
      ['settings', true],
    ]);
  });

  it('makes the private-chat menu button open the Mini App', () => {
    const calls = fake.callsTo('setChatMenuButton');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({
      menu_button: { type: 'web_app', text: 'Open', web_app: { url: 'https://chess.test/app/' } },
    });
  });

  it('still starts when Telegram refuses the webhook, the commands or the menu button', async () => {
    // Its own Telegram, so the boot calls the other tests read stay the first server's.
    const refusing = await FakeTelegram.start();
    refusing.failNext('setWebhook', { error_code: 429, description: 'Too Many Requests' });
    refusing.failNext('setMyCommands', { error_code: 500, description: 'Internal Server Error' });
    refusing.failNext('setChatMenuButton', {
      error_code: 500,
      description: 'Internal Server Error',
    });
    const second = await startServer(
      testConfig({ TELEGRAM_API_ROOT: refusing.url, PORT: 0, ENGINE_ENABLED: false }),
    );
    try {
      expect(await (await fetch(`http://127.0.0.1:${second.port}/healthz`)).text()).toBe('ok');
    } finally {
      await second.stop();
      await refusing.stop();
    }
  });

  it('registers the webhook with the secret and the allowed updates', () => {
    const [call] = fake.callsTo('setWebhook');
    expect(call?.body).toMatchObject({
      url: 'https://chess.test/telegram/webhook',
      secret_token: 'w'.repeat(32),
    });
    expect(call?.body.allowed_updates).toEqual([
      'message',
      'callback_query',
      'my_chat_member',
      'chat_member',
      'pre_checkout_query',
    ]);
  });

  it('exposes Prometheus metrics including the Telegram call counters', async () => {
    const text = await (await fetch(`${base}/metrics`)).text();
    expect(text).toMatch(/telegram_api_calls_total\{method="setWebhook",status="ok"\} 1/);
    for (const name of [
      'webhook_updates_total',
      'jobs_pending',
      'jobs_oldest_age_seconds',
      'scanner_lag_seconds',
      'games_started',
      'shares',
      'active_groups',
      'move_latency_seconds',
    ]) {
      expect(text).toContain(name);
    }
  });

  it('serves the Mini App with immutable assets and an uncached index', async () => {
    const index = await fetch(`${base}/app/`);
    expect(index.status).toBe(200);
    expect(index.headers.get('cache-control')).toBe('no-store');
    expect(await index.text()).toContain('Chess Goat');
    const asset = await fetch(`${base}/app/assets/app-1a2b3c.js`);
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(asset.headers.get('content-type')).toContain('text/javascript');
    const route = await fetch(`${base}/app/g/AbCdEfGhIj`);
    expect(route.headers.get('cache-control')).toBe('no-store');
    expect(await route.text()).toContain('Chess Goat');
  });

  it('mounts the webhook behind the secret header and the API behind a session', async () => {
    const webhook = await fetch(`${base}/telegram/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"update_id":1}',
    });
    expect(webhook.status).toBe(401);
    const me = await fetch(`${base}/api/me`);
    expect(me.status).toBe(401);
    expect(me.headers.get('cache-control')).toBe('no-store');
    expect(await me.json()).toEqual({
      error: { code: 'unauthorized', message: expect.any(String) },
    });
  });
});
