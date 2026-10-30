import { beforeEach, describe, expect, it } from 'vitest';
import { FLAIR, t } from '@group-chess/shared';
import { myFlair } from '../src/state/flair';
import { prefs } from '../src/state/session';
import { Settings } from '../src/ui/screens/Settings';
import type { FakeRoute } from './support/fakeFetch';
import { renderApp, type Rendered } from './support/render';

const FLAIR_DTO = {
  worn: ['rank_1500', 'en_passant_win'],
  earned: ['rank_1500', 'en_passant_win', 'scholars_mate_loss'].map((id) => ({
    id,
    earnedAt: '2026-04-10T12:00:00.000Z',
    opponent: '@tom',
  })),
};
/** Answers the Flair row's load; every other call goes to `route`. */
const withFlair =
  (route: FakeRoute): FakeRoute =>
  (call) =>
    call.path === '/api/me/flair' ? { status: 200, body: FLAIR_DTO } : route(call);
/** The calls other than the Flair row's load. */
const writes = (r: Rendered) => r.calls.filter((call) => call.path !== '/api/me/flair');
beforeEach(() => {
  myFlair.value = null;
});

describe('Settings', () => {
  it('saves a toggled preference and keeps the returned prefs', async () => {
    const r = renderApp(
      () => <Settings />,
      withFlair(({ body }) => ({
        status: 200,
        body: { prefs: { ...prefs.value, ...(body as { prefs: object }).prefs }, dmAllowed: false },
      })),
    );
    await r.click('[data-pref="notifications"]');
    expect(writes(r)[0]).toMatchObject({
      method: 'PUT',
      path: '/api/me/prefs',
      body: { prefs: { notifications: false } },
    });
    expect(window.__tg!.haptics).toContain('selection');
    expect(prefs.value.notifications).toBe(false);
    expect(r.root.querySelector('[data-pref="notifications"]')?.getAttribute('aria-checked')).toBe(
      'false',
    );
  });

  it('shows Flair first and Move confirmations second', () => {
    const r = renderApp(
      () => <Settings />,
      withFlair(() => ({ status: 200, body: { ok: true } })),
    );
    const flairRow = r.root.querySelector('.card [data-action="flair"]');
    const row = r.root.querySelector('.card [data-pref="moveConfirmations"]');
    expect(row?.textContent).toContain('Move confirmations');
    expect(row?.textContent).toContain('Only against people');
    expect(r.root.querySelector('.card')?.firstElementChild).toBe(flairRow);
    expect(flairRow?.nextElementSibling).toBe(row);
    expect(r.root.querySelector('[data-pref="confirmMoves"]')).toBeNull();
    expect(r.root.querySelector('[data-pref="closeAfterMove"]')).toBeNull();
  });

  it("saves a choice picked in Telegram's popup", async () => {
    const r = renderApp(
      () => <Settings />,
      withFlair(({ body }) => ({
        status: 200,
        body: { prefs: { ...prefs.value, ...(body as { prefs: object }).prefs }, dmAllowed: false },
      })),
    );
    // Lets <Dialogs /> register the native popup host in its effect before choiceDialog runs.
    await r.flush();
    await r.click('[data-pref="moveConfirmations"]');
    expect(window.__tg!.popups.at(-1)).toMatchObject({
      title: 'Move confirmations',
      message:
        'Ask before a move is sent. With "Only against people", moves against the bot send on drop. Premoves are confirmed with the move.',
      buttons: [
        { id: 'always', text: 'Always' },
        { id: 'people', text: '✓ Only against people' },
        { id: 'never', text: 'Never' },
      ],
    });
    window.__tg!.answerPopup('never');
    await r.flush();
    expect(writes(r)[0]).toMatchObject({
      method: 'PUT',
      path: '/api/me/prefs',
      body: { prefs: { moveConfirmations: 'never' } },
    });
    expect(window.__tg!.haptics).toContain('selection');
    expect(prefs.value.moveConfirmations).toBe('never');
    expect(r.root.querySelector('[data-pref="moveConfirmations"]')?.textContent).toContain('Never');
  });

  it('changes nothing when the popup is dismissed or the current choice is picked', async () => {
    const r = renderApp(
      () => <Settings />,
      withFlair(() => ({ status: 200, body: { ok: true } })),
    );
    await r.flush();
    await r.click('[data-pref="moveConfirmations"]');
    window.__tg!.answerPopup('');
    await r.flush();
    await r.click('[data-pref="moveConfirmations"]');
    window.__tg!.answerPopup('people');
    await r.flush();
    expect(writes(r)).toHaveLength(0);
    expect(window.__tg!.haptics).not.toContain('selection');
    expect(prefs.value.moveConfirmations).toBe('people');
  });

  it('reverts the choice and says so when the save fails', async () => {
    const r = renderApp(
      () => <Settings />,
      withFlair(() => ({ status: 500, body: { error: { code: 'internal', message: 'boom' } } })),
    );
    await r.flush();
    await r.click('[data-pref="moveConfirmations"]');
    window.__tg!.answerPopup('always');
    await r.flush();
    expect(prefs.value.moveConfirmations).toBe('people');
    expect(document.querySelector('.toast')?.textContent).toBe(t('app.common.error'));
  });

  it('offers the choices in the page on clients without popups', async () => {
    const r = renderApp(
      () => <Settings />,
      withFlair(({ body }) => ({
        status: 200,
        body: { prefs: { ...prefs.value, ...(body as { prefs: object }).prefs }, dmAllowed: false },
      })),
      { version: '6.1' },
    );
    await r.flush();
    await r.click('[data-pref="moveConfirmations"]');
    await r.click('[data-choice="always"]');
    expect(writes(r)[0]).toMatchObject({ body: { prefs: { moveConfirmations: 'always' } } });
  });

  it('deletes my data after confirmation and closes the app', async () => {
    const r = renderApp(
      () => <Settings />,
      withFlair(() => ({ status: 200, body: { ok: true } })),
    );
    await r.click('[data-action="delete"]');
    window.__tg!.answerPopup('cancel');
    await r.flush();
    expect(writes(r)).toHaveLength(0);
    await r.click('[data-action="delete"]');
    window.__tg!.answerPopup('confirm');
    await r.flush();
    expect(writes(r)[0]).toMatchObject({ method: 'DELETE', path: '/api/me' });
    expect(window.__tg!.closed).toBe(true);
  });

  it('asks for permission to message when notifications go on and the bot cannot write yet', async () => {
    const r = renderApp(
      () => <Settings />,
      withFlair(({ body }) => ({
        status: 200,
        body: {
          prefs: { ...prefs.value, ...((body as { prefs?: object }).prefs ?? {}) },
          dmAllowed: false,
        },
      })),
      { writeAccess: true },
    );
    await r.click('[data-pref="notifications"]'); // off: nothing to ask
    expect(window.__tg!.calls).not.toContain('requestWriteAccess');
    await r.click('[data-pref="notifications"]'); // on again
    expect(window.__tg!.calls).toContain('requestWriteAccess');
    const writeAccessCall = r.calls.find(
      (c) =>
        c.method === 'PUT' &&
        c.path === '/api/me/prefs' &&
        typeof c.body === 'object' &&
        c.body !== null &&
        'writeAccess' in c.body,
    );
    expect(writeAccessCall).toMatchObject({
      body: { writeAccess: { allowed: true } },
    });
  });

  it('links to the author, the source and the licences', async () => {
    const r = renderApp(
      () => <Settings />,
      withFlair(() => ({ status: 200, body: { ok: true } })),
    );
    await r.flush();
    expect(r.root.querySelector('img.banner-img')?.getAttribute('src')).toMatch(/goat-banner/);
    await r.click('[data-action="author"]');
    await r.click('[data-action="source"]');
    expect(window.__tg!.telegramLinks).toEqual(['https://t.me/Jarvl']);
    expect(window.__tg!.links).toEqual(['https://github.com/Jarvl/telegram-chess-bot']);
    await r.click('[data-action="about"]');
    expect(window.__tg!.popups.at(-1)).toMatchObject({
      title: 'About Chess Goat',
      message: expect.stringContaining('Chess Goat is free software'),
    });
  });

  it('confirms deletion in the page on clients without popups', async () => {
    const r = renderApp(
      () => <Settings />,
      withFlair(() => ({ status: 200, body: { ok: true } })),
      { version: '6.1' },
    );
    await r.click('[data-action="delete"]');
    await r.click('[data-dialog="confirm"]');
    expect(writes(r)[0]).toMatchObject({ method: 'DELETE', path: '/api/me' });
  });

  it('shows the Support card between the preferences and the links', () => {
    const r = renderApp(
      () => <Settings />,
      withFlair(() => ({ status: 200, body: { ok: true } })),
    );
    const cards = [...r.root.querySelectorAll('.card')];
    const support = cards.findIndex((card) => card.matches('[data-card="support"]'));
    expect(support).toBe(1);
    expect(cards[2]?.querySelector('img.banner-img')).not.toBeNull();
  });

  it('says tip records are kept when asking to delete', async () => {
    const r = renderApp(
      () => <Settings />,
      withFlair(() => ({ status: 200, body: { ok: true } })),
    );
    // Lets the Dialogs' mount effect register its native-popup host before the click,
    // same as the "links to the author..." test above (a happy-dom/preact effect-timing quirk).
    await r.flush();
    await r.click('[data-action="delete"]');
    expect(window.__tg!.popups.at(-1)?.message).toContain('kept as payment records');
  });

  it('opens Flair from its row, which shows the share unlocked and the worn flair once loaded', async () => {
    const r = renderApp(
      () => <Settings />,
      withFlair(() => ({ status: 200, body: { ok: true } })),
    );
    const flairRow = () => r.root.querySelector('[data-action="flair"]')!;
    expect(flairRow().textContent).toContain('Flair');
    expect(flairRow().textContent).not.toContain('unlocked');
    await r.flush();
    // FLAIR_DTO has earned three of the catalog's flair, whatever its size (21% of the 14 at launch).
    expect(flairRow().textContent).toContain(`${Math.round((100 * 3) / FLAIR.length)}% unlocked`);
    expect(flairRow().querySelector('.flair')?.textContent).toBe('🚶👑');
    await r.click('[data-action="flair"]');
    expect(r.app.router.current.value).toEqual({ name: 'flair' });
  });

  it('keeps the row working when the flair cannot load', async () => {
    const r = renderApp(
      () => <Settings />,
      (call) =>
        call.path === '/api/me/flair'
          ? { status: 500, body: { error: { code: 'internal', message: 'boom' } } }
          : { status: 200, body: { ok: true } },
    );
    await r.flush();
    expect(r.root.querySelector('[data-action="flair"]')?.textContent).not.toContain('unlocked');
    expect(document.querySelector('.toast')).toBeNull();
    await r.click('[data-action="flair"]');
    expect(r.app.router.current.value).toEqual({ name: 'flair' });
  });
});
