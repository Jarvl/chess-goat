import { expect, type Page } from '@playwright/test';
import { clickBack, openApp, seed, test } from './support';

// Game switcher spec: the strip sits at the bottom, where a thumb reaches it.
test.use({ viewport: { width: 375, height: 667 } });

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
