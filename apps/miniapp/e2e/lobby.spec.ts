import { expect } from '@playwright/test';
import { clickBack, clickMain, openApp, seed, telegramCalls, test, tgState } from './support';

test('a challenge made in the app is posted to the group and accepted from the lobby', async ({
  browser,
}) => {
  const world = await seed('none');
  const aliceContext = await browser.newContext();
  const alice = await aliceContext.newPage();
  await openApp(alice, {
    user: world.users.alice.telegram,
    startParam: `l_${world.group.publicId}`,
  });
  await expect(alice.locator('.title')).toHaveText('Chess Club');
  await expect(alice.locator('[data-action="group-settings"]')).toBeVisible();
  await alice.locator('[data-action="new-game"]').click();
  await alice.locator('[data-opponent]').filter({ hasText: '@bob' }).click();
  await alice.locator('[data-time="28800"]').click();
  await clickMain(alice);
  await expect(alice.locator('.toast')).toHaveText('Challenge posted to the group');
  await expect(alice.locator('[data-cancel]')).toBeVisible();
  await expect
    .poll(
      async () => (await telegramCalls()).filter((call) => call.method === 'sendMessage').length,
      { timeout: 10_000 },
    )
    .toBeGreaterThan(0);
  const card = (await telegramCalls()).find((call) => call.method === 'sendMessage');
  expect(String(card?.body.text)).toContain('@alice challenges');

  const bobContext = await browser.newContext();
  const bob = await bobContext.newPage();
  await openApp(bob, { user: world.users.bob.telegram, startParam: `l_${world.group.publicId}` });
  await expect(bob.locator('[data-accept]')).toBeVisible();
  await bob.locator('[data-accept]').click();
  await expect(bob.locator('.cg-wrap')).toBeVisible();
  await expect(
    bob.locator('.player-bar[data-colour="white"], .player-bar[data-colour="black"]').first(),
  ).toContainText(/@alice|@bob/);
  await aliceContext.close();
  await bobContext.close();
});

test('a profile launch lands on the games home and the tabs reach the rest', async ({ page }) => {
  const world = await seed('fresh');
  await openApp(page, { user: world.users.alice.telegram });
  // Home is your games across every group, named by the group they belong to.
  await expect(page.locator('.title')).toHaveText('Your games');
  await expect(page.locator('[data-game]')).toHaveCount(1);
  await expect(page.locator('[data-game]')).toContainText('Chess Club');

  await page.locator('[data-nav="groups"]').click();
  await expect(page.locator('[data-group]')).toHaveText(/Chess Club/);
  await page.locator('[data-group]').click();
  await expect(page.locator('[data-game]')).toHaveCount(1);

  // Tabs move sideways, they never deepen: Settings is reachable without touching the back stack.
  await page.locator('[data-nav="settings"]').click();
  await expect(page.locator('[data-pref="notifications"]')).toBeVisible();
  // The Groups tab still holds the lobby it was left in.
  await page.locator('[data-nav="groups"]').click();
  await expect(page.locator('[data-game]')).toHaveCount(1);
});

test('a game opened from a card is one tap from the chat and one tap from home', async ({
  page,
}) => {
  const world = await seed('fresh');
  await openApp(page, {
    user: world.users.alice.telegram,
    startParam: `g_${world.game!.publicId}`,
  });
  await expect(page.locator('.cg-wrap')).toBeVisible();

  // The badge counts the boards waiting on this player, and shows while they are inside one.
  const badge = page.locator('[data-nav="games"] .nav-badge');
  await expect(badge).toHaveText('1');
  // A round badge whose box is trimmed to the glyph, so the digit sits on the circle's centre
  // rather than high in the descender space no digit uses.
  expect(await badge.evaluate((el) => getComputedStyle(el).textBoxTrim)).toBe('trim-both');
  const size = (await badge.boundingBox())!;
  expect(size.width).toBe(size.height);

  // The tab bar is the way home, so it costs no back taps to get there.
  await page.locator('[data-nav="games"]').click();
  await expect(page.locator('.title')).toHaveText('Your games');
  await page.locator('[data-game]').click();
  await expect(page.locator('.cg-wrap')).toBeVisible();

  // Back from that game returns to the list it was opened from, not out of the app.
  await clickBack(page);
  await expect(page.locator('.title')).toHaveText('Your games');
  expect((await tgState(page)).closed).toBe(false);

  // At the root of a launch that came from a chat card, back means leave — one tap, as before.
  expect((await tgState(page)).backButton.visible).toBe(true);
  await clickBack(page);
  await expect.poll(async () => (await tgState(page)).closed).toBe(true);
});

test('the lobby’s leaderboard chip ranks you and reaches a player', async ({ page }) => {
  const world = await seed('ranked');
  await openApp(page, {
    user: world.users.alice.telegram,
    startParam: `l_${world.group.publicId}`,
  });
  const chip = page.locator('[data-action="leaderboard"]');
  await expect(chip).toContainText('#1');
  await chip.click();
  await expect(page.locator('.title')).toHaveText('Leaderboard');
  await expect(page.locator('[data-player]')).toHaveCount(2);
  await expect(page.locator('.player-row.you')).toContainText('(you)');
  await page.locator(`[data-player="${world.users.bob.id}"]`).click();
  await expect(page.locator('.title')).toHaveText('@bob');
  await page.locator('[data-action="challenge"]').click();
  await expect(page.locator(`[data-opponent="${world.users.bob.id}"]`)).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await clickBack(page);
  await expect(page.locator('.title')).toHaveText('@bob');
  await clickBack(page);
  await expect(page.locator('.title')).toHaveText('Leaderboard');
});

test('a Challenge someone link from the chat opens New game, and back leads to the lobby', async ({
  page,
}) => {
  const world = await seed('none');
  await openApp(page, {
    user: world.users.alice.telegram,
    startParam: `n_${world.group.publicId}`,
  });
  await expect(page.locator('.title')).toHaveText('New game');
  await page.locator('[data-opponent]').filter({ hasText: '@bob' }).click();
  await expect.poll(async () => (await tgState(page)).mainButton.enabled).toBe(true);
  await clickBack(page);
  await expect(page.locator('.title')).toHaveText('Chess Club');
  expect((await tgState(page)).closed).toBe(false);
});
