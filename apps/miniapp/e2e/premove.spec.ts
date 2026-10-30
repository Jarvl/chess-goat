import { expect, type Page, type Request } from '@playwright/test';
import { decodePremoveTree } from '@group-chess/shared';
import {
  clickBack,
  clickMain,
  dragMove,
  harnessGame,
  openApp,
  pieceAt,
  scriptEngine,
  seed,
  storedPremoves,
  test,
  tgState,
} from './support';

/** Every request the page sends that matches, as it is sent (a route spy). */
function spy(page: Page, method: string, path: RegExp): Request[] {
  const seen: Request[] = [];
  page.on('request', (request) => {
    if (request.method() === method && path.test(new URL(request.url()).pathname))
      seen.push(request);
  });
  return seen;
}
const MOVES = /^\/api\/games\/[^/]+\/moves$/;
const PREMOVES = /^\/api\/games\/[^/]+\/premoves$/;

const lastPopup = async (page: Page) => (await tgState(page)).popups.at(-1);
const strip = (page: Page, index: number) => page.locator(`.move-list [data-line="${index}"]`);

test('confirms a move with two branches in one request', async ({ browser }) => {
  const world = await seed('fresh', {
    alice: { moveConfirmations: 'never' },
    bob: { moveConfirmations: 'always' },
  });
  const gameId = world.game!.publicId;
  const aliceContext = await browser.newContext();
  const alice = await aliceContext.newPage();
  await openApp(alice, { user: world.users.alice.telegram, startParam: `g_${gameId}` });
  await dragMove(alice, 'e2', 'e4');
  await expect.poll(async () => (await harnessGame(gameId)).plyCount).toBe(1);
  await aliceContext.close();

  const bobContext = await browser.newContext();
  const bob = await bobContext.newPage();
  const moves = spy(bob, 'POST', MOVES);
  const saves = spy(bob, 'PUT', PREMOVES);
  await openApp(bob, { user: world.users.bob.telegram, startParam: `g_${gameId}` });
  await expect(bob.locator('.move-list [data-ply="1"]')).toHaveText('e4');

  // Bob's own move waits for Confirm; the board then takes White's reply and Bob's answer to it.
  await dragMove(bob, 'e7', 'e5', 'black');
  await expect(bob.locator('.move-list [data-waiting]')).toHaveText('e5');
  await expect
    .poll(async () => (await tgState(bob)).mainButton)
    .toMatchObject({ text: 'Confirm move', visible: true });
  await dragMove(bob, 'g1', 'f3', 'black');
  await expect(strip(bob, 0)).toHaveText('Nf3');
  await dragMove(bob, 'b8', 'c6', 'black');
  await expect(strip(bob, 1)).toHaveText('Nc6');
  await expect
    .poll(async () => (await tgState(bob)).mainButton.text)
    .toBe('Confirm move + 1 premove');

  // Back to the start of the tree (the position after the waiting move), then a second branch.
  await bob.locator('[data-action="prev"]').click();
  await expect(strip(bob, 0)).toHaveAttribute('aria-current', 'true');
  await bob.locator('[data-action="prev"]').click();
  await expect(bob.locator('.move-list [data-waiting]')).toHaveAttribute('aria-current', 'true');
  await expect(bob.locator('.lines-panel [data-path=""]')).toHaveAttribute('aria-current', 'true');
  await dragMove(bob, 'f1', 'c4', 'black');
  await expect(strip(bob, 0)).toHaveText('Bc4');
  await dragMove(bob, 'g8', 'f6', 'black');
  await expect(strip(bob, 1)).toHaveText('Nf6');
  await expect(bob.locator('.lines-panel [data-path="g1f3,b8c6"]')).toHaveText('Nc6');
  await expect(bob.locator('.lines-panel [data-path="f1c4,g8f6"]')).toHaveText('Nf6');
  // The panel scrolls on its own, at most a third of the screen tall, and does not trap the
  // page's scrolling when it reaches its end.
  const panel = await bob.locator('.lines-panel').evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      overflowY: style.overflowY,
      maxHeight: Number.parseFloat(style.maxHeight),
      overscroll: style.overscrollBehaviorY,
      viewport: window.innerHeight,
    };
  });
  expect(panel.overflowY).toBe('auto');
  expect(panel.maxHeight).toBeCloseTo(panel.viewport * 0.34, 0);
  expect(panel.overscroll).toBe('auto');
  await expect
    .poll(async () => (await tgState(bob)).mainButton)
    .toMatchObject({ text: 'Confirm move + 2 premoves', visible: true });
  // Nothing reaches the server before Confirm.
  expect((await harnessGame(gameId)).plyCount).toBe(1);
  expect(moves).toHaveLength(0);

  await clickMain(bob);
  await expect.poll(async () => (await harnessGame(gameId)).plyCount).toBe(2);
  const expected = [
    { move: 'g1f3', reply: 'b8c6', children: [] },
    { move: 'f1c4', reply: 'g8f6', children: [] },
  ];
  expect(await storedPremoves(gameId)).toEqual(expected);
  // One request carried the move and the whole tree; no separate premove save.
  expect(moves).toHaveLength(1);
  const body = moves[0]!.postDataJSON() as { uci: string; premoveTree: string };
  expect(body.uci).toBe('e7e5');
  expect(decodePremoveTree(body.premoveTree)).toEqual(expected);
  expect(saves).toHaveLength(0);
  await expect(bob.locator('.move-list [data-ply="2"]')).toHaveText('e5');
  await expect.poll(async () => (await tgState(bob)).mainButton.visible).toBe(false);
  await bobContext.close();
});

test('fires a premove on the bot’s reply', async ({ page }) => {
  const world = await seed('none', { alice: { moveConfirmations: 'never' } });
  // The bot "thinks" until the premoves are saved; then it plays these, in order.
  await scriptEngine({ replies: ['e7e5', 'b8c6', 'a7a6'], hold: true });
  const saves = spy(page, 'PUT', PREMOVES);
  await openApp(page, {
    user: world.users.alice.telegram,
    startParam: `l_${world.group.publicId}`,
  });
  await page.locator('[data-action="new-game"]').click();
  await page.locator('[data-testid="opponent-bot"]').click();
  await page.locator('[data-testid="bot-level-casual"]').click();
  await page.locator('[data-colour="white"]').click();
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && response.url().endsWith('/engine-games'),
  );
  await clickMain(page);
  const gameId = ((await (await created).json()) as { id: string }).id;
  await expect(page.locator('cg-board')).toBeVisible();
  await dragMove(page, 'e2', 'e4');
  await expect.poll(async () => (await harnessGame(gameId)).plyCount).toBe(1);

  // Each pair saves on its own once its reply is played: no Confirm, no draft.
  await dragMove(page, 'e7', 'e5');
  await expect(strip(page, 0)).toHaveText('e5');
  await dragMove(page, 'g1', 'f3');
  await expect(strip(page, 1)).toHaveText('Nf3');
  await expect
    .poll(() => storedPremoves(gameId))
    .toEqual([{ move: 'e7e5', reply: 'g1f3', children: [] }]);
  await dragMove(page, 'b8', 'c6');
  await expect(strip(page, 2)).toHaveText('Nc6');
  await dragMove(page, 'f1', 'b5');
  await expect(strip(page, 3)).toHaveText('Bb5');
  await expect
    .poll(() => storedPremoves(gameId))
    .toEqual([
      { move: 'e7e5', reply: 'g1f3', children: [{ move: 'b8c6', reply: 'f1b5', children: [] }] },
    ]);
  expect(saves.map((request) => decodePremoveTree(request.postDataJSON().tree as string))).toEqual([
    [{ move: 'e7e5', reply: 'g1f3', children: [] }],
    [
      {
        move: 'e7e5',
        reply: 'g1f3',
        children: [{ move: 'b8c6', reply: 'f1b5', children: [] }],
      },
    ],
  ]);
  expect((await tgState(page)).mainButton.visible).toBe(false);
  expect((await harnessGame(gameId)).plyCount).toBe(1);

  // The bot's e5 is answered in its own move by Nf3, and its Nc6 by Bb5.
  await scriptEngine({ hold: false });
  await expect(page.locator('.move-list [data-ply="2"]')).toHaveText('e5', { timeout: 15_000 });
  await expect(page.locator('.move-list [data-ply="3"]')).toHaveText('Nf3');
  await expect(page.locator('.move-list [data-ply="4"]')).toHaveText('Nc6', { timeout: 15_000 });
  await expect(page.locator('.move-list [data-ply="5"]')).toHaveText('Bb5');
  await expect(page.locator('.move-list [data-line]')).toHaveCount(0);
  await expect.poll(() => storedPremoves(gameId)).toEqual([]);
  await expect(page.locator('.move-list [data-ply="6"]')).toHaveText('a6', { timeout: 15_000 });
  // The tree ran out: nothing was cancelled.
  await expect(page.locator('.toast', { hasText: 'Premoves cancelled' })).toHaveCount(0);
});

test('shows the toast when the opponent misses the tree', async ({ browser }) => {
  const world = await seed('fresh', {
    alice: { moveConfirmations: 'never' },
    bob: { moveConfirmations: 'never' },
  });
  const gameId = world.game!.publicId;
  const bobContext = await browser.newContext();
  const bob = await bobContext.newPage();
  await openApp(bob, { user: world.users.bob.telegram, startParam: `g_${gameId}` });
  await dragMove(bob, 'e2', 'e4', 'black');
  await expect(strip(bob, 0)).toHaveText('e4');
  await dragMove(bob, 'e7', 'e5', 'black');
  await expect
    .poll(() => storedPremoves(gameId))
    .toEqual([{ move: 'e2e4', reply: 'e7e5', children: [] }]);

  const aliceContext = await browser.newContext();
  const alice = await aliceContext.newPage();
  await openApp(alice, { user: world.users.alice.telegram, startParam: `g_${gameId}` });
  await dragMove(alice, 'd2', 'd4');
  await expect(bob.locator('.toast')).toContainText('Premoves cancelled', { timeout: 10_000 });
  await expect(bob.locator('.move-list [data-ply="1"]')).toHaveText('d4');
  await expect(bob.locator('.move-list [data-ply="2"]')).toHaveCount(0);
  await expect(bob.locator('.move-list [data-line]')).toHaveCount(0);
  expect(await storedPremoves(gameId)).toEqual([]);
  // Alice never saw Bob's tree, and her move was not answered.
  await expect(alice.locator('.move-list [data-line]')).toHaveCount(0);
  await aliceContext.close();
  await bobContext.close();
});

test('asks before Remove and Replace, and Cancel restores the board', async ({ page }) => {
  // Confirmations off: changes save at once, yet removing and replacing still ask.
  const world = await seed('fresh', { bob: { moveConfirmations: 'never' } });
  const gameId = world.game!.publicId;
  await openApp(page, { user: world.users.bob.telegram, startParam: `g_${gameId}` });
  await dragMove(page, 'e2', 'e4', 'black');
  await expect(strip(page, 0)).toHaveText('e4');
  await dragMove(page, 'e7', 'e5', 'black');
  await expect(strip(page, 1)).toHaveText('e5');
  await dragMove(page, 'g1', 'f3', 'black');
  await expect(strip(page, 2)).toHaveText('Nf3');
  await dragMove(page, 'b8', 'c6', 'black');
  await expect(strip(page, 3)).toHaveText('Nc6');
  const full = [
    { move: 'e2e4', reply: 'e7e5', children: [{ move: 'g1f3', reply: 'b8c6', children: [] }] },
  ];
  await expect.poll(() => storedPremoves(gameId)).toEqual(full);

  // Replace: from the position after 1.e4, a different reply. The board previews it under the popup.
  await strip(page, 0).click();
  await expect(strip(page, 0)).toHaveAttribute('aria-current', 'true');
  await expect.poll(() => pieceAt(page, 'c7')).toBe('black pawn');
  const popupsBefore = (await tgState(page)).popups.length;
  await dragMove(page, 'c7', 'c5', 'black');
  await expect.poll(async () => (await tgState(page)).popups.length).toBe(popupsBefore + 1);
  expect((await lastPopup(page))?.message).toBe(
    'Replace 1…e5 with 1…c5?\nThe 2 moves after e5 will be removed too.',
  );
  await expect(strip(page, 1)).toHaveText('c5');
  await expect(page.locator('.move-list [data-line]')).toHaveCount(2);
  await expect.poll(() => pieceAt(page, 'c5')).toBe('black pawn');
  await page.evaluate(() => window.__tg!.answerPopup('cancel'));
  // Cancel puts everything back exactly as it was.
  await expect(strip(page, 1)).toHaveText('e5');
  await expect(page.locator('.move-list [data-line]')).toHaveCount(4);
  await expect(strip(page, 0)).toHaveAttribute('aria-current', 'true');
  await expect.poll(() => pieceAt(page, 'c5')).toBeNull();
  await expect.poll(() => pieceAt(page, 'c7')).toBe('black pawn');
  expect(await storedPremoves(gameId)).toEqual(full);

  // The same replacement, answered Replace this time.
  await dragMove(page, 'c7', 'c5', 'black');
  await expect.poll(async () => (await tgState(page)).popups.length).toBe(popupsBefore + 2);
  await page.evaluate(() => window.__tg!.answerPopup('confirm'));
  await expect
    .poll(() => storedPremoves(gameId))
    .toEqual([{ move: 'e2e4', reply: 'c7c5', children: [] }]);
  await expect(page.locator('.move-list [data-line]')).toHaveCount(2);
  await expect(strip(page, 1)).toHaveText('c5');
  await expect(strip(page, 1)).toHaveAttribute('aria-current', 'true');

  // Remove: the ✕ beside the selected premove asks; Cancel keeps it.
  const remove = page.locator('.move-list [data-action="premove-remove"]');
  await remove.click();
  await expect.poll(async () => (await lastPopup(page))?.message).toBe('Remove 1…c5?');
  await page.evaluate(() => window.__tg!.answerPopup('cancel'));
  await expect(strip(page, 1)).toHaveText('c5');
  await expect.poll(() => pieceAt(page, 'c5')).toBe('black pawn');
  expect(await storedPremoves(gameId)).toEqual([{ move: 'e2e4', reply: 'c7c5', children: [] }]);
  const popupsNow = (await tgState(page)).popups.length;
  await remove.click();
  await expect.poll(async () => (await tgState(page)).popups.length).toBe(popupsNow + 1);
  await page.evaluate(() => window.__tg!.answerPopup('confirm'));
  await expect(page.locator('.toast')).toContainText('Removed 1…c5');
  await expect(strip(page, 1)).toHaveCount(0);
  await expect.poll(() => pieceAt(page, 'c5')).toBeNull();
  await expect.poll(() => storedPremoves(gameId)).toEqual([]);
});

test('refuses a stale edit from a second page as the same player', async ({ browser }) => {
  const world = await seed('fresh', { bob: { moveConfirmations: 'always' } });
  const gameId = world.game!.publicId;
  const phoneContext = await browser.newContext();
  const phone = await phoneContext.newPage();
  await openApp(phone, { user: world.users.bob.telegram, startParam: `g_${gameId}` });
  const laptopContext = await browser.newContext();
  const laptop = await laptopContext.newPage();
  await openApp(laptop, { user: world.users.bob.telegram, startParam: `g_${gameId}` });

  // The laptop starts a draft on the empty tree, and leaves it unconfirmed.
  await dragMove(laptop, 'd2', 'd4', 'black');
  await expect(strip(laptop, 0)).toHaveText('d4');
  await dragMove(laptop, 'd7', 'd5', 'black');
  await expect(strip(laptop, 1)).toHaveText('d5');
  await expect
    .poll(async () => (await tgState(laptop)).mainButton)
    .toMatchObject({ text: 'Confirm premoves', visible: true });

  // Meanwhile the phone saves another tree.
  await dragMove(phone, 'e2', 'e4', 'black');
  await expect(strip(phone, 0)).toHaveText('e4');
  await dragMove(phone, 'e7', 'e5', 'black');
  await expect(strip(phone, 1)).toHaveText('e5');
  await expect
    .poll(async () => (await tgState(phone)).mainButton)
    .toMatchObject({ text: 'Confirm premoves', visible: true });
  await clickMain(phone);
  const phoneTree = [{ move: 'e2e4', reply: 'e7e5', children: [] }];
  await expect.poll(() => storedPremoves(gameId)).toEqual(phoneTree);

  // The laptop's draft was built on a tree the server no longer holds: refused, never overwritten.
  await clickMain(laptop);
  await expect(laptop.locator('.toast')).toContainText('Premoves changed on another device', {
    timeout: 10_000,
  });
  expect(await storedPremoves(gameId)).toEqual(phoneTree);
  await expect(laptop.locator('.lines-panel [data-path="e2e4,e7e5"]')).toHaveText('e5');
  await expect(laptop.locator('.lines-panel [data-path="d2d4"]')).toHaveCount(0);
  await expect.poll(async () => (await tgState(laptop)).mainButton.visible).toBe(false);
  await phoneContext.close();
  await laptopContext.close();
});

test('asks before leaving with an unconfirmed draft', async ({ page }) => {
  const world = await seed('fresh', { bob: { moveConfirmations: 'always' } });
  const gameId = world.game!.publicId;
  await openApp(page, { user: world.users.bob.telegram, startParam: `g_${gameId}` });
  await dragMove(page, 'e2', 'e4', 'black');
  await expect(strip(page, 0)).toHaveText('e4');
  await dragMove(page, 'e7', 'e5', 'black');
  await expect(strip(page, 1)).toHaveText('e5');
  await expect
    .poll(async () => (await tgState(page)).mainButton)
    .toMatchObject({ text: 'Confirm premoves', visible: true });
  // Telegram asks before closing the app while the draft is open.
  expect((await tgState(page)).closingConfirmation).toBe(true);

  // Back (at the root of a chat launch it would close the app) asks first; Stay changes nothing.
  await clickBack(page);
  await expect.poll(async () => (await lastPopup(page))?.title).toBe('Leave this game?');
  const popup = (await lastPopup(page))!;
  expect(popup.message).toBe("Your premoves haven't been confirmed and will be lost.");
  expect(popup.buttons.map((button) => button.text)).toEqual(['Stay', 'Leave']);
  await page.evaluate(() => window.__tg!.answerPopup('cancel'));
  await expect(page.locator('cg-board')).toBeVisible();
  await expect(page.locator('.move-list [data-line]')).toHaveCount(2);
  const state = await tgState(page);
  expect(state.closed).toBe(false);
  expect(state.mainButton).toMatchObject({ text: 'Confirm premoves', visible: true });
  expect(await storedPremoves(gameId)).toEqual([]);

  // Leave goes.
  const asked = (await tgState(page)).popups.length;
  await clickBack(page);
  await expect.poll(async () => (await tgState(page)).popups.length).toBe(asked + 1);
  await page.evaluate(() => window.__tg!.answerPopup('confirm'));
  await expect.poll(async () => (await tgState(page)).closed).toBe(true);
});
