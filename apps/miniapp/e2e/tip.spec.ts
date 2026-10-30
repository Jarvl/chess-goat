import { expect } from '@playwright/test';
import { openApp, seed, test } from './support';

test('a preset tip goes through the server and Telegram and says thank you', async ({ page }) => {
  const world = await seed('ranked', {});
  await openApp(page, { user: world.users.alice.telegram });
  await page.locator('[data-nav="settings"]').click();
  await page.locator('[data-tip="250"]').click();
  await expect
    .poll(() => page.evaluate(() => window.__tg!.invoices))
    .toEqual(['https://t.me/$TestInvoice']);
  await page.evaluate(() => window.__tg!.answerInvoice('paid'));
  await expect(page.locator('.toast')).toHaveText('Thank you for supporting Chess Goat');
});
