import { expect } from '@playwright/test';
import {
  boardBox,
  dragMove,
  harnessGame,
  openApp,
  seed,
  squareCentre,
  test,
  tgState,
} from './support';

test('drags a move as White, the server records it and the app stays on the game', async ({
  page,
}) => {
  const world = await seed('fresh', { alice: { moveConfirmations: 'never' } });
  await openApp(page, {
    user: world.users.alice.telegram,
    startParam: `g_${world.game!.publicId}`,
  });
  await expect(page.locator('.player-bar[data-colour="white"]')).toContainText('@alice');
  await dragMove(page, 'e2', 'e4');
  await expect.poll(async () => (await harnessGame(world.game!.publicId)).plyCount).toBe(1);
  expect((await harnessGame(world.game!.publicId)).fen).toContain('4P3');
  await expect(page.locator('.move-list [data-ply="1"]')).toHaveText('e4');
  const state = await tgState(page);
  expect(state.calls).toEqual(expect.arrayContaining(['ready', 'expand', 'disableVerticalSwipes']));
  expect(state.haptics).toContain('impact:light');
  // Opened from a chat card, yet the player stays on the board after moving.
  await page.waitForTimeout(500);
  expect((await tgState(page)).closed).toBe(false);
  await expect(page.locator('.cg-wrap')).toBeVisible();
});

test('taps a move: the piece shows its destinations and the move is sent on the second tap', async ({
  page,
}) => {
  const world = await seed('fresh', { alice: { moveConfirmations: 'never' } });
  await openApp(page, {
    user: world.users.alice.telegram,
    startParam: `g_${world.game!.publicId}`,
  });
  // Tapping a piece shows its destinations; the spectator specs assert this selector stays empty.
  const box = await boardBox(page);
  const e2 = squareCentre(box, 'e2');
  await page.touchscreen.tap(e2.x, e2.y);
  await expect(page.locator('square.move-dest')).toHaveCount(2);
  const e4 = squareCentre(box, 'e4');
  await page.touchscreen.tap(e4.x, e4.y);
  await expect.poll(async () => (await harnessGame(world.game!.publicId)).plyCount).toBe(1);
  await expect(page.locator('.move-list [data-ply="1"]')).toHaveText('e4');
  await expect.poll(async () => (await tgState(page)).mainButton.visible).toBe(false);
  expect((await tgState(page)).secondaryButton?.visible ?? false).toBe(false);
  expect((await tgState(page)).closed).toBe(false);
});
