import { expect, type Page } from '@playwright/test';
import { dragMove, dropConnections, openApp, openStreams, seed, test } from './support';

test('the opponent sees a move without refreshing', async ({ browser }) => {
  const world = await seed('fresh', { alice: { moveConfirmations: 'never' } });
  const bobContext = await browser.newContext();
  const bob = await bobContext.newPage();
  await openApp(bob, { user: world.users.bob.telegram, startParam: `g_${world.game!.publicId}` });
  await expect(bob.locator('.cg-wrap')).toBeVisible();
  const aliceContext = await browser.newContext();
  const alice = await aliceContext.newPage();
  await openApp(alice, {
    user: world.users.alice.telegram,
    startParam: `g_${world.game!.publicId}`,
  });
  await dragMove(alice, 'e2', 'e4');
  await expect(bob.locator('.move-list [data-ply="1"]')).toHaveText('e4', { timeout: 10_000 });
  await expect(bob.locator('.player-bar[data-colour="black"] .clock')).toHaveClass(/active/);
  await aliceContext.close();
  await bobContext.close();
});

const isRefresh = (gameId: string) => (url: string, method: string) =>
  method === 'GET' && new URL(url).pathname === `/api/games/${gameId}`;

function countRefreshes(page: Page, gameId: string): () => number {
  let count = 0;
  const matches = isRefresh(gameId);
  page.on('request', (request) => {
    if (matches(request.url(), request.method())) count += 1;
  });
  return () => count;
}

test('shows the latest position after the connection drops and comes back', async ({ browser }) => {
  const world = await seed('fresh', { alice: { moveConfirmations: 'never' } });
  const gameId = world.game!.publicId;
  const bobContext = await browser.newContext();
  const bob = await bobContext.newPage();
  const refreshes = countRefreshes(bob, gameId);
  await openApp(bob, { user: world.users.bob.telegram, startParam: `g_${gameId}` });
  await expect(bob.locator('.cg-wrap')).toBeVisible();
  await expect.poll(openStreams).toBe(1);
  // Bob's phone loses its network: new requests fail and the server sees the socket die.
  await bobContext.setOffline(true);
  await dropConnections();
  await expect.poll(openStreams).toBe(0);
  const refreshesBefore = refreshes();

  const aliceContext = await browser.newContext();
  const alice = await aliceContext.newPage();
  await openApp(alice, { user: world.users.alice.telegram, startParam: `g_${gameId}` });
  await dragMove(alice, 'e2', 'e4');
  await expect(alice.locator('.move-list [data-ply="1"]')).toHaveText('e4');
  await bob.waitForTimeout(500);
  await expect(bob.locator('.move-list [data-ply="1"]')).toHaveCount(0);

  // Back online: the `online` handler refreshes the state (spec §6.4) and reopens the stream.
  await bobContext.setOffline(false);
  await expect(bob.locator('.move-list [data-ply="1"]')).toHaveText('e4', { timeout: 10_000 });
  await expect.poll(refreshes).toBeGreaterThan(refreshesBefore);
  await expect.poll(openStreams, { timeout: 10_000 }).toBe(2);
  await aliceContext.close();
  await bobContext.close();
});
