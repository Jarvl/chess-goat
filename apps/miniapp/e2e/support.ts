import { expect, test as base, type Page } from '@playwright/test';
import { decodePremoveTree, type PremoveNode } from '@chess-goat/shared';
import { createHmac } from 'node:crypto';
import {
  installFakeWebApp,
  type FakeWebAppOptions,
  type FakeWebAppRecord,
} from '../test/support/fakeWebApp';

/**
 * Playwright's `test`, whose `page` fails the test afterwards if the app used a Telegram method
 * below the client version that has it: the fake records each such use (see `fakeWebApp.ts`).
 */
export const test = base.extend({
  page: async ({ page }, use) => {
    await use(page);
    if (page.isClosed()) return;
    const unsupported = await page.evaluate(() => window.__tg?.unsupported ?? []);
    expect(unsupported, 'Telegram methods used below their minimum version').toEqual([]);
  },
});

export const BOT_TOKEN = '123456:TEST-TOKEN';
export const HARNESS = 'http://127.0.0.1:4181';
/** The harness's METRICS_TOKEN (apps/server/test/e2e/harness.ts). */
const METRICS_TOKEN = 'e2e-metrics-token-0123456789abcdef';

export type TelegramUser = { id: number; first_name: string; username: string };

/** Signs init data the way Telegram does: the same recipe as the server's test helper, kept local so this project stays self-contained. */
export function signInitData(
  botToken: string,
  fields: { user: TelegramUser; startParam?: string },
): string {
  const params = new URLSearchParams();
  params.set('user', JSON.stringify(fields.user));
  params.set('auth_date', String(Math.floor(Date.now() / 1000)));
  if (fields.startParam) params.set('start_param', fields.startParam);
  const dataCheckString = [...params.entries()]
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  params.set('hash', createHmac('sha256', secret).update(dataCheckString).digest('hex'));
  return params.toString();
}
export type Seed = {
  group: { id: number; publicId: string };
  users: Record<'alice' | 'bob' | 'carol', { id: number; telegram: TelegramUser }>;
  game: { id: number; publicId: string } | null;
};

export async function seed(
  scenario:
    'none' | 'fresh' | 'opening' | 'promotion' | 'finished' | 'ranked' | 'several' | 'crowd',
  prefs: Record<string, Record<string, unknown>> = {},
  options: { groupTitle?: string; bobName?: string; alicePhoto?: boolean; flair?: boolean } = {},
): Promise<Seed> {
  const response = await fetch(`${HARNESS}/seed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scenario, prefs, ...options }),
  });
  if (!response.ok) throw new Error(`seed failed: ${response.status} ${await response.text()}`);
  return (await response.json()) as Seed;
}

export async function harnessGame(publicId: string): Promise<{
  status: string;
  fen: string;
  plyCount: number;
  result: string | null;
  /** The stored premove tree, base64url (empty for none). */
  premoveTree: string;
}> {
  return (await (await fetch(`${HARNESS}/games/${publicId}`)).json()) as never;
}

/** The premove tree the server holds for the game, decoded. */
export async function storedPremoves(publicId: string): Promise<PremoveNode[]> {
  return decodePremoveTree((await harnessGame(publicId)).premoveTree);
}

/**
 * Scripts the harness's engine: `replies` are its next moves, in order (then the fake's own);
 * `hold: true` keeps it thinking until `hold: false`. Every seed resets both.
 */
export async function scriptEngine(options: { replies?: string[]; hold?: boolean }): Promise<void> {
  const response = await fetch(`${HARNESS}/engine`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(options),
  });
  if (!response.ok) throw new Error(`scripting the engine failed: ${response.status}`);
}

export async function telegramCalls(): Promise<
  { method: string; body: Record<string, unknown> }[]
> {
  return (await (await fetch(`${HARNESS}/telegram/calls`)).json()) as never;
}

/** Drops every open connection on the server, the way a phone losing its network does. */
export async function dropConnections(): Promise<void> {
  const response = await fetch(`${HARNESS}/connections/close`, { method: 'POST' });
  if (!response.ok) throw new Error(`closing connections failed: ${response.status}`);
}

/** The number of SSE streams the server holds open, from its Prometheus metrics. */
export async function openStreams(): Promise<number> {
  const text = await (
    await fetch('http://127.0.0.1:4180/metrics', {
      headers: { authorization: `Bearer ${METRICS_TOKEN}` },
    })
  ).text();
  const match = /^sse_streams (\d+)$/m.exec(text);
  return match ? Number(match[1]) : Number.NaN;
}

/** Installs the fake WebApp with test-signed init data, stubs Telegram's script and opens the app. */
export async function openApp(
  page: Page,
  options: {
    user: TelegramUser;
    startParam?: string;
    version?: string;
    colorScheme?: 'light' | 'dark';
  },
): Promise<void> {
  await page.route('https://telegram.org/js/telegram-web-app.js', (route) =>
    route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }),
  );
  const initData = signInitData(BOT_TOKEN, { user: options.user, startParam: options.startParam });
  const fake: FakeWebAppOptions = {
    version: options.version ?? '8.0',
    initData,
    startParam: options.startParam,
    writeAccess: true,
    colorScheme: options.colorScheme,
  };
  await page.addInitScript(installFakeWebApp, fake);
  await page.goto('/app/');
}

export async function tgState(
  page: Page,
): Promise<
  Omit<
    FakeWebAppRecord,
    | 'clickMain'
    | 'clickSecondary'
    | 'clickBack'
    | 'emit'
    | 'setStableHeight'
    | 'answerPopup'
    | 'clickSettings'
    | 'answerInvoice'
  >
> {
  return page.evaluate(() => {
    const record = window.__tg!;
    return {
      calls: record.calls,
      mainButton: record.mainButton,
      secondaryButton: record.secondaryButton,
      backButton: record.backButton,
      haptics: record.haptics,
      links: record.links,
      telegramLinks: record.telegramLinks,
      unsupported: record.unsupported,
      downloads: record.downloads,
      closed: record.closed,
      chrome: record.chrome,
      popups: record.popups,
      invoices: record.invoices,
      closingConfirmation: record.closingConfirmation,
      settingsButton: record.settingsButton,
    };
  });
}

export const clickMain = (page: Page) => page.evaluate(() => window.__tg!.clickMain());
export const clickBack = (page: Page) => page.evaluate(() => window.__tg!.clickBack());
export const clickSecondary = (page: Page) => page.evaluate(() => window.__tg!.clickSecondary());
export const clickSettings = (page: Page) => page.evaluate(() => window.__tg!.clickSettings());

export async function boardBox(
  page: Page,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const board = page.locator('cg-board');
  await expect(board).toBeVisible();
  const box = await board.boundingBox();
  if (!box) throw new Error('board has no box');
  return box;
}

export function squareCentre(
  box: { x: number; y: number; width: number; height: number },
  square: string,
  orientation: 'white' | 'black' = 'white',
): { x: number; y: number } {
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]);
  const column = orientation === 'white' ? file : 7 - file;
  const row = orientation === 'white' ? 8 - rank : rank - 1;
  const size = box.width / 8;
  return { x: box.x + column * size + size / 2, y: box.y + row * size + size / 2 };
}

export async function dragMove(
  page: Page,
  from: string,
  to: string,
  orientation: 'white' | 'black' = 'white',
): Promise<void> {
  const box = await boardBox(page);
  const a = squareCentre(box, from, orientation);
  const b = squareCentre(box, to, orientation);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x + 6, a.y - 6);
  await page.mouse.move(b.x, b.y, { steps: 10 });
  await page.mouse.up();
}

/** The piece chessground shows on `square` ("white pawn"), or null; a fading or ghost piece is not there. */
export function pieceAt(page: Page, square: string): Promise<string | null> {
  return page.evaluate((key) => {
    const pieces = [...document.querySelectorAll('cg-board piece')] as (Element & {
      cgKey?: string;
    })[];
    const piece = pieces.find((el) => el.cgKey === key && !el.matches('.fading, .ghost'));
    return piece ? piece.className.replace(/\s*\b(anim|dragging)\b/g, '').trim() : null;
  }, square);
}

export async function tapMove(
  page: Page,
  from: string,
  to: string,
  orientation: 'white' | 'black' = 'white',
): Promise<void> {
  const box = await boardBox(page);
  const a = squareCentre(box, from, orientation);
  const b = squareCentre(box, to, orientation);
  await page.touchscreen.tap(a.x, a.y);
  await page.touchscreen.tap(b.x, b.y);
}
