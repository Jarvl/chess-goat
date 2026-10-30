import { expect } from '@playwright/test';
import { openApp, seed, test, tgState } from './support';

test('replays a finished game and reaches analysis and the PGN', async ({ page }) => {
  const world = await seed('finished');
  await openApp(page, {
    user: world.users.carol.telegram,
    startParam: `g_${world.game!.publicId}`,
  });
  // The result sits on the player bars, in the clocks' place.
  const black = page.locator('.player-bar[data-colour="black"]');
  await expect(black.locator('.result-tag')).toHaveText('Won');
  await expect(black.locator('.sub')).toHaveText('Checkmate');
  await expect(page.locator('.player-bar[data-colour="white"] .result-tag')).toHaveText('Lost');
  await expect(page.locator('.move-list [data-ply]')).toHaveCount(4);
  await page.locator('[data-ply="2"]').click();
  await expect(page.locator('square.last-move')).toHaveCount(2);
  await expect(page.locator('[data-action="latest"]')).toHaveCount(0);
  await page.locator('[data-action="next"]').click();
  await expect(page.locator('[data-ply="3"]')).toHaveAttribute('aria-current', 'true');
  await page.locator('[data-ply="4"]').click();
  await expect(page.locator('[data-ply="4"]')).toHaveAttribute('aria-current', 'true');
  await page.locator('[data-action="analyse"]').click();
  expect((await tgState(page)).links[0]).toContain('lichess.org/analysis/pgn/');
  await page.locator('[data-action="pgn"]').click();
  await expect
    .poll(async () => (await tgState(page)).downloads[0]?.file_name)
    .toBe(`${world.game!.publicId}.pgn`);
});
