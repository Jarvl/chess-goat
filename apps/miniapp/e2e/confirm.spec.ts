import { expect, test } from '@playwright/test';
import {
  clickMain,
  clickSecondary,
  clickSettings,
  dragMove,
  harnessGame,
  openApp,
  seed,
  tgState,
} from './support';

// Move confirmations spec: Alice keeps the default, Only against people, and plays Bob.
const openAsAlice = async (page: Parameters<typeof openApp>[0]) => {
  const world = await seed('fresh');
  await openApp(page, {
    user: world.users.alice.telegram,
    startParam: `g_${world.game!.publicId}`,
  });
  return world.game!.publicId;
};

test('a move against a person waits for Confirm move, with the tab bar hidden, then is sent', async ({
  page,
}) => {
  const gameId = await openAsAlice(page);
  await expect(page.locator('.tabbar')).toBeVisible();
  await dragMove(page, 'e2', 'e4');
  await expect
    .poll(async () => (await tgState(page)).mainButton)
    .toMatchObject({ text: 'Confirm move', visible: true });
  expect((await tgState(page)).secondaryButton).toMatchObject({ text: 'Cancel', visible: true });
  await expect(page.locator('.tabbar')).toHaveCount(0);
  expect((await harnessGame(gameId)).plyCount).toBe(0);
  await clickMain(page);
  await expect.poll(async () => (await harnessGame(gameId)).plyCount).toBe(1);
  await expect(page.locator('.move-list [data-ply="1"]')).toHaveText('e4');
  await expect.poll(async () => (await tgState(page)).mainButton.visible).toBe(false);
  await expect(page.locator('.tabbar')).toBeVisible();
});

test('Cancel puts the piece back and sends nothing', async ({ page }) => {
  const gameId = await openAsAlice(page);
  await dragMove(page, 'e2', 'e4');
  await expect.poll(async () => (await tgState(page)).secondaryButton?.visible).toBe(true);
  await clickSecondary(page);
  await expect.poll(async () => (await tgState(page)).mainButton.visible).toBe(false);
  expect((await harnessGame(gameId)).plyCount).toBe(0);
  // The pawn is back on e2, so the same move can be played again.
  await dragMove(page, 'e2', 'e4');
  await expect.poll(async () => (await tgState(page)).mainButton.visible).toBe(true);
  await clickMain(page);
  await expect.poll(async () => (await harnessGame(gameId)).plyCount).toBe(1);
});

test('leaving the game with a move waiting asks first, then cancels it', async ({ page }) => {
  const gameId = await openAsAlice(page);
  await dragMove(page, 'e2', 'e4');
  await expect.poll(async () => (await tgState(page)).mainButton.visible).toBe(true);
  // The tab bar is hidden while the move waits; Telegram's Settings item still selects a tab, once
  // the player agrees to leave (conditional premoves spec, Sending it).
  await clickSettings(page);
  await expect
    .poll(async () => (await tgState(page)).popups.at(-1))
    .toMatchObject({
      title: 'Leave this game?',
      message: "Your move hasn't been sent and will be lost.",
    });
  await page.evaluate(() => window.__tg!.answerPopup('confirm'));
  await expect(page.locator('[data-pref="moveConfirmations"]')).toBeVisible();
  const state = await tgState(page);
  expect(state.mainButton.visible).toBe(false);
  expect(state.secondaryButton?.visible).toBe(false);
  await clickMain(page); // nothing is bound any more
  await page.waitForTimeout(500);
  expect((await harnessGame(gameId)).plyCount).toBe(0);
});
