import { expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { clickBack, openApp, seed, test } from './support';

// Game switcher spec: the strip sits at the bottom, where a thumb reaches it.

/** Saves a screenshot for a person to look at when SCREENS_DIR is set, as screens.spec.ts does. */
async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.SCREENS_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: `${dir}/${name}.png`, animations: 'disabled' });
}

async function openFirstGame(page: Page): Promise<void> {
  const world = await seed('several');
  await openApp(page, { user: world.users.alice.telegram });
  await expect(page.locator('.title')).toHaveText('Your games');
  // Alice's move against Bob comes first on the list.
  await page.locator('.game-card').first().click();
  await expect(page.locator('.switcher [data-switch]')).toHaveCount(2);
  // The fake Telegram reports a 720 px stable height by default; a real phone reports its own.
  // The board resizes at once, but chessground lays its squares out again only from a
  // ResizeObserver, which runs after the next frame's animation callbacks; until then they keep
  // the old size and spill past the board. A second frame is past that.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        window.__tg!.setStableHeight(window.innerHeight);
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

test('hops between games from the strip and backs out to the list in one tap', async ({ page }) => {
  await openFirstGame(page);
  const carol = page.locator('.switcher .switcher-game', { hasText: 'Carol' });
  await expect(carol).toHaveClass(/\bdim\b/);
  await expect(page.locator('.switcher .switcher-game.current')).toContainText('@bob');
  await carol.click();
  await expect(page.locator('.player-bar').first()).toContainText('@carol');
  // The order did not change under the thumb: Bob's game is still first.
  await expect(page.locator('.switcher .switcher-game').first()).toContainText('@bob');
  await expect(page.locator('.switcher .switcher-game.current')).toContainText('@carol');
  await clickBack(page);
  await expect(page.locator('.title')).toHaveText('Your games');
});

for (const height of [667, 844]) {
  test(`docks above the tab bar and lets the game scroll clear of it at ${height} px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height });
    await openFirstGame(page);
    const box = async (selector: string) => (await page.locator(selector).boundingBox())!;
    // Flush on the tab bar: no gap, and nothing tucked under it.
    const restsOnTabBar = async (selector: string) => {
      const bottom = (await box(selector)).y + (await box(selector)).height;
      const top = (await box('.tabbar')).y;
      expect(Math.abs(bottom - top)).toBeLessThanOrEqual(1);
    };
    // Flush on the tab bar, whatever has scrolled behind it.
    await restsOnTabBar('.switcher-dock');
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    expect((await box('.icon-bar')).y + (await box('.icon-bar')).height).toBeLessThanOrEqual(
      (await box('.switcher-toggle')).y,
    );
    await shot(page, `switcher-open-${height}`);

    // Minimized, only the chevron is left, on the tab bar; the game still scrolls clear of it.
    await page.locator('.switcher-toggle').click();
    await expect(page.locator('.switcher')).toHaveCount(0);
    await expect(page.locator('.switcher-toggle')).toHaveAttribute('aria-expanded', 'false');
    await restsOnTabBar('.switcher-toggle');
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    expect((await box('.icon-bar')).y + (await box('.icon-bar')).height).toBeLessThanOrEqual(
      (await box('.switcher-toggle')).y,
    );
    await shot(page, `switcher-min-${height}`);
  });
}

test('keeps the strip where it was when you hop, so nothing moves under your thumb', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 844 });
  const world = await seed('crowd');
  await openApp(page, { user: world.users.alice.telegram });
  await page.locator('.game-card').first().click();
  await expect(page.locator('.switcher [data-switch]')).toHaveCount(9);
  await page.locator('.switcher').evaluate((strip) => (strip.scrollLeft = 100));
  const target = page.locator('.switcher [data-switch]').nth(3);
  const id = await target.getAttribute('data-switch');
  const before = (await target.boundingBox())!;
  await target.click();
  // Inside the loaded game, not the strip that stands in while it loads.
  const after = page.locator(`.game .switcher [data-switch="${id}"]`);
  await expect(after).toHaveClass(/\bcurrent\b/);
  expect(Math.abs((await after.boundingBox())!.x - before.x)).toBeLessThanOrEqual(1);
});

test('raises toasts above the strip, open or minimized', async ({ page }) => {
  await openFirstGame(page);
  const box = async (selector: string) => (await page.locator(selector).boundingBox())!;
  const clearOfStrip = async () => {
    await page.locator('[data-action="share"]').click();
    await expect(page.locator('.toast')).toBeVisible();
    const toast = await box('.toast');
    expect(toast.y + toast.height).toBeLessThanOrEqual((await box('.switcher-toggle')).y);
  };
  await clearOfStrip();
  await page.locator('.switcher-toggle').click();
  await expect(page.locator('.switcher')).toHaveCount(0);
  await expect(page.locator('.toast')).toHaveCount(0, { timeout: 10_000 });
  await clearOfStrip();
});

test('gives the tab bar the height every layout reserves for it', async ({ page }) => {
  await openFirstGame(page);
  const reserved = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.height = 'var(--tabbar-h)';
    document.body.appendChild(probe);
    const height = probe.getBoundingClientRect().height;
    probe.remove();
    return height;
  });
  expect((await page.locator('.tabbar').boundingBox())!.height).toBeCloseTo(reserved, 0);
});

test('takes a finger-sized tap on the chevron, just above its tab', async ({ page }) => {
  await openFirstGame(page);
  const tab = (await page.locator('.switcher-toggle').boundingBox())!;
  // 44 px tall in all: the tab, and the hit area reaching above it.
  const hit = await page.evaluate(
    ([x, y]) => document.elementFromPoint(x!, y!)?.closest('.switcher-toggle') !== null,
    [tab.x + tab.width / 2, tab.y + tab.height - 43],
  );
  expect(hit).toBe(true);
});

test('keeps the board under the strip on a very short screen', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 500 });
  await openFirstGame(page);
  const dockTop = (await page.locator('.switcher-toggle').boundingBox())!.y;
  // Coordinates ignore pointers, which would hide them from the hit test; let them take part, so
  // the hit test follows what is painted on top.
  await page.addStyleTag({ content: '.board-wrap coord { pointer-events: auto !important; }' });
  // Every board coordinate the strip covers is behind it.
  const covered = await page.evaluate((top) => {
    return [...document.querySelectorAll('.board-wrap coord')]
      .map((coord) => coord.getBoundingClientRect())
      .filter((box) => box.top + box.height / 2 > top)
      .map((box) =>
        Boolean(
          document
            .elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
            ?.closest('.switcher-dock'),
        ),
      );
  }, dockTop);
  expect(covered.length).toBeGreaterThan(0);
  expect(covered.every(Boolean)).toBe(true);
});
