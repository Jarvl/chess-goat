import { expect } from '@playwright/test';
import { harnessGame, openApp, seed, tapMove, test, tgState } from './support';

// The `test` from ./support also fails this if the app used anything a 6.0 client lacks: haptics,
// the secondary button, the swipe lock, write access.
test('a 6.0 client sends moves', async ({ page }) => {
  const world = await seed('fresh', { alice: { moveConfirmations: 'never' } });
  await openApp(page, {
    user: world.users.alice.telegram,
    startParam: `g_${world.game!.publicId}`,
    version: '6.0',
  });
  await tapMove(page, 'e2', 'e4');
  await expect.poll(async () => (await harnessGame(world.game!.publicId)).plyCount).toBe(1);
});

test('a 7.0 client opens the PGN as a link instead of a download', async ({ page }) => {
  const world = await seed('finished');
  await openApp(page, {
    user: world.users.carol.telegram,
    startParam: `g_${world.game!.publicId}`,
    version: '7.0',
  });
  await page.locator('[data-action="pgn"]').click();
  // The app first asks the server for a short-lived link, then opens it.
  await expect
    .poll(async () => (await tgState(page)).links[0])
    .toContain(`/api/games/${world.game!.publicId}/pgn?token=`);
  expect((await tgState(page)).downloads).toEqual([]);
  // The link works in a plain browser, and its token is not the session token.
  const link = (await tgState(page)).links[0]!;
  const response = await page.request.get(link);
  expect(response.status()).toBe(200);
  expect(await response.text()).toContain('[Result "0-1"]');
  const token = new URL(link).searchParams.get('token')!;
  expect(
    (
      await page.request.get(`/api/games/${world.game!.publicId}`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).status(),
  ).toBe(401);
});
