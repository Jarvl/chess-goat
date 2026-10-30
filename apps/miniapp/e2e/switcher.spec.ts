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
  await page.evaluate(() => window.__tg!.setStableHeight(window.innerHeight));
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
    // No gap above the tab bar: the bottom edge meets it, or tucks a pixel or two under it (the
    // tab bar is drawn on top, and stands a little taller than --tabbar-h).
    const restsOnTabBar = async (selector: string) => {
      const bottom = (await box(selector)).y + (await box(selector)).height;
      const top = (await box('.tabbar')).y;
      expect(bottom).toBeGreaterThanOrEqual(top);
      expect(bottom - top).toBeLessThanOrEqual(4);
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
