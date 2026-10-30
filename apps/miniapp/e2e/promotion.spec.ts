import { expect } from '@playwright/test';
import { harnessGame, openApp, seed, tapMove, test } from './support';

test('promotes through the chooser', async ({ page }) => {
  const world = await seed('promotion', { alice: { moveConfirmations: 'never' } });
  await openApp(page, {
    user: world.users.alice.telegram,
    startParam: `g_${world.game!.publicId}`,
  });
  await tapMove(page, 'e7', 'e8');
  await expect(page.locator('.promotion')).toBeVisible();
  expect((await harnessGame(world.game!.publicId)).plyCount).toBe(6);
  await page.locator('[data-promote="q"]').click();
  await expect.poll(async () => (await harnessGame(world.game!.publicId)).plyCount).toBe(7);
  expect((await harnessGame(world.game!.publicId)).fen.split(' ')[0]).toBe('3kQ3/8/8/8/8/8/8/4K3');
});
