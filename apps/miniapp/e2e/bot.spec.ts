import { expect } from '@playwright/test';
import { clickMain, dragMove, openApp, seed, telegramCalls, test, tgState } from './support';

/**
 * Spec §11's end-to-end row: one engine game created from the picker and played through the whole
 * composed stack — endpoint, job row, worker, handler, `playMove`, bus, SSE — on the fake engine the
 * harness injects into `startServer`. Nothing here asserts *which* move the bot played, only that it
 * played one (spec §11: liveness and legality, never choice).
 */
test('creates a game against the bot and sees its reply arrive', async ({ page }) => {
  const world = await seed('none');
  await openApp(page, {
    user: world.users.alice.telegram,
    startParam: `l_${world.group.publicId}`,
  });
  await page.locator('[data-action="new-game"]').click();
  await page.locator('[data-testid="opponent-bot"]').click();
  await page.locator('[data-testid="bot-level-casual"]').click();
  // White on purpose: the human moves first, so the second move can only be the engine's.
  await page.locator('[data-colour="white"]').click();
  // Spec §8: the rated switch is forced off and disabled while the bot is selected.
  await expect(page.locator('[data-rated]')).toBeDisabled();
  await clickMain(page);

  // Not `.cg-wrap`: the New game colour tiles reuse that class for their king glyphs, so the
  // locator would still be ambiguous for an instant after the board mounts.
  await expect(page.locator('cg-board')).toBeVisible();
  await expect(page.locator('.player-bar[data-colour="black"]')).toContainText('Stockfish');
  await dragMove(page, 'e2', 'e4');
  await expect(page.locator('.move-list [data-ply="1"]')).not.toBeEmpty();
  // Move confirmations default, Only against people: a bot game sends on drop, with no Cancel.
  expect((await tgState(page)).secondaryButton?.visible ?? false).toBe(false);
  // The bot's answer appears on its own, over the live stream, with no reload: the job the human's
  // move enqueued reached the worker and the handler played through `playMove` like any player.
  await expect(page.locator('.move-list [data-ply="2"]')).not.toBeEmpty({ timeout: 20_000 });
  await expect(page.locator('.move-list [data-ply="3"]')).toHaveCount(0);
  // Spec §8: an engine game posts nothing to the group chat — no card, not even a result.
  expect((await telegramCalls()).filter((call) => call.method === 'sendMessage')).toHaveLength(0);
});
