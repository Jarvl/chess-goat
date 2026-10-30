import { expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { clickBack, openApp, seed, test } from './support';

// Review Focus 5: a long title or display name must never push the page sideways at phone width.
const LONG_TITLE = 'The Extremely Long Friday Evening Correspondence Chess Club of Manchester';
const LONG_NAME = 'Maximilian Alexander Constantine Wolfgang von Hohenzollern-Sigmaringen';
test.use({ viewport: { width: 390, height: 844 } });

async function fits(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

const dir = process.env.SCREENS_DIR;
async function shot(page: Page, name: string): Promise<void> {
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`every main screen fits at 390 px (${colorScheme})`, async ({ page }) => {
    const world = await seed(
      'ranked',
      {},
      { groupTitle: LONG_TITLE, bobName: LONG_NAME, flair: true },
    );
    await openApp(page, { user: world.users.alice.telegram, colorScheme });
    await expect(page.locator('.title')).toHaveText('Your games');
    // Alice's card shows her opponent's flair: Bob's three, whose name is long (Review Focus 5).
    await expect(page.locator('.game-card .flair')).toHaveText('🧑‍🦼♟️🪤');
    await fits(page);
    await shot(page, `${colorScheme}-games`);

    await page.locator('[data-nav="groups"]').click();
    await expect(page.locator('[data-group]')).toBeVisible();
    await fits(page);
    await shot(page, `${colorScheme}-groups`);

    await page.locator('[data-group]').click();
    await expect(page.locator('[data-action="new-game"]')).toBeVisible();
    await fits(page);
    await shot(page, `${colorScheme}-lobby`);

    await page.locator('[data-action="leaderboard"]').click();
    await expect(page.locator('[data-player]')).toHaveCount(2);
    await expect(page.locator('[data-player] .flair')).toHaveCount(2);
    // Alice, the viewer, wears three flair as well. Her own row's name, which "(you)" is part of,
    // must keep a real width beside them and her rating (Review Focus 1): `fits` only checks that
    // the page does not scroll sideways.
    const yourName = await page.locator('.player-row.you .name').boundingBox();
    expect(yourName?.width ?? 0).toBeGreaterThanOrEqual(60);
    await fits(page);
    await shot(page, `${colorScheme}-leaderboard`);

    await page.locator('[data-player]').filter({ hasText: LONG_NAME }).click();
    await expect(page.locator('.title')).toHaveText(LONG_NAME);
    await fits(page);
    await shot(page, `${colorScheme}-player`);
    await clickBack(page);

    await page.locator('[data-nav="games"]').click();
    await page.locator('[data-game]').click();
    // Not `.cg-wrap`: the games list's own MiniBoard thumbnails carry that class too, so the
    // locator would still be ambiguous for an instant while the list screen unmounts.
    await expect(page.locator('cg-board')).toBeVisible();
    await expect(page.locator('.player-bar .flair')).toHaveCount(2);
    await fits(page);
    await shot(page, `${colorScheme}-game`);

    await page.locator('[data-nav="settings"]').click();
    await expect(page.locator('[data-action="about"]')).toBeVisible();
    await expect(page.locator('[data-card="support"]')).toBeVisible();
    await expect(page.locator('[data-action="flair"] .flair')).toHaveText('🧑‍🦯👑🔥');
    await fits(page);
    await shot(page, `${colorScheme}-settings`);

    await page.locator('[data-action="tip-custom"]').click();
    await page.locator('[data-tip-input]').fill('12345');
    await expect(page.locator('.tip-hint.bad')).toBeVisible();
    await fits(page);
    await shot(page, `${colorScheme}-settings-tip`);

    await page.locator('[data-action="flair"]').click();
    await expect(page.locator('.flair-slot')).toHaveCount(3);
    await fits(page);
    await shot(page, `${colorScheme}-flair`);
  });
}

test("shows a player's Telegram photo on the game screen", async ({ page }) => {
  const world = await seed('opening', {}, { alicePhoto: true });
  await openApp(page, { user: world.users.bob.telegram, startParam: `g_${world.game!.publicId}` });
  const photo = page.locator('.player-bar[data-colour="white"] img.photo');
  await expect(photo).toBeVisible();
  expect(await photo.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await expect(page.locator('.player-bar[data-colour="black"] img.photo')).toHaveCount(0);
});
