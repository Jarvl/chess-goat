import { FLAIR, FLAIR_CATEGORIES, t } from '@group-chess/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { myFlair } from '../src/state/flair';
import { App } from '../src/ui/App';
import { FlairScreen } from '../src/ui/screens/Flair';
import type { FakeRoute } from './support/fakeFetch';
import { renderApp, type Rendered } from './support/render';

const EARNED = [
  { id: 'rank_1500', earnedAt: '2026-04-10T12:00:00.000Z', opponent: '@tom' },
  { id: 'en_passant_win', earnedAt: '2026-08-12T12:00:00.000Z', opponent: '@tom_rook' },
  { id: 'scholars_mate_loss', earnedAt: '2026-09-03T12:00:00.000Z', opponent: '@maya' },
];
const server: FakeRoute = ({ method, body }) => ({
  status: 200,
  body: {
    worn: method === 'PUT' ? (body as { worn: string[] }).worn : ['rank_1500', 'en_passant_win'],
    earned: EARNED,
  },
});
const failure = { status: 500, body: { error: { code: 'internal', message: 'boom' } } };
const row = (r: Rendered, id: string) => r.root.querySelector(`[data-flair="${id}"]`)!;
const preview = (r: Rendered) => r.root.querySelector('.flair-preview .flair')?.textContent;
const open = async (route: FakeRoute = server) => {
  const r = renderApp(() => <FlairScreen />, route);
  await r.flush();
  return r;
};
beforeEach(() => {
  // The screen dates rows against today, and "Aug 12" carries no year only in the fixtures' own
  // year, so the clock is held still. Only Date is faked: `flush` waits on real timers.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-29T12:00:00.000Z'));
  myFlair.value = null;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('Flair screen', () => {
  it('previews you wearing your flair above three slots, the first selected', async () => {
    const r = await open();
    expect(r.root.querySelector('.title')?.textContent).toBe('Your flair');
    expect(preview(r)).toBe('🚶👑');
    expect([...r.root.querySelectorAll('[data-slot]')].map((slot) => slot.textContent)).toEqual([
      '🚶Slot 1',
      '👑Slot 2',
      '·Slot 3',
    ]);
    expect(r.root.querySelector('[data-slot="0"]')?.getAttribute('aria-pressed')).toBe('true');
  });
  // Which slot a tap fills, frees or swaps is wearFlair's, tested in flairState.test.ts.
  it('titles each category and shows every flair’s state', async () => {
    const r = await open();
    expect([...r.root.querySelectorAll('.section')].map((s) => s.textContent)).toEqual([
      'Rank ladder',
      'Feats',
      'Dubious honours',
    ]);
    expect(r.root.querySelectorAll('[data-flair]')).toHaveLength(FLAIR.length);
    expect(row(r, 'rank_1500').querySelector('.flair-check')).not.toBeNull();
    expect(row(r, 'en_passant_win').querySelector('.tag')?.textContent).toBe('Slot 2');
    expect(row(r, 'scholars_mate_loss').querySelector('.flair-free')).not.toBeNull();
    expect(row(r, 'rank_1800').matches('.locked')).toBe(true);
    expect(row(r, 'rank_1800').querySelector('.tag')?.textContent).toBe('Locked');
  });
  it('puts a tapped flair in the selected slot and saves the slots', async () => {
    const r = await open();
    await r.click('[data-slot="2"]');
    await r.click('[data-flair="scholars_mate_loss"]');
    expect(r.calls.at(-1)).toMatchObject({
      method: 'PUT',
      path: '/api/me/flair',
      body: { worn: ['rank_1500', 'en_passant_win', 'scholars_mate_loss'] },
    });
    expect(window.__tg!.haptics).toContain('selection');
    expect(preview(r)).toBe('🚶👑🪤');
  });
  it('ignores a tap on a locked flair', async () => {
    const r = await open();
    await r.click('[data-flair="rank_1800"]');
    expect(r.calls.filter((call) => call.method === 'PUT')).toHaveLength(0);
  });
  it('puts the slots back and says so when the save fails', async () => {
    const r = await open((call) => (call.method === 'PUT' ? failure : server(call)));
    await r.click('[data-flair="scholars_mate_loss"]');
    expect(preview(r)).toBe('🚶👑');
    expect(document.querySelector('.toast')?.textContent).toBe(t('app.common.error'));
  });
  it('shows the error screen when the flair cannot load', async () => {
    const r = await open(() => failure);
    expect(r.root.querySelector('.status-mark')).not.toBeNull();
  });
  it('describes every flair and dates the ones you have earned', async () => {
    const r = await open();
    const lines = (id: string) =>
      [...row(r, id).querySelectorAll('.primary, .earned')].map((el) => el.textContent);
    expect(lines('rank_1500')).toEqual(['Held a rating of 1500–1599', 'Earned Apr 2026']);
    expect(lines('en_passant_win')).toEqual([
      'Capture en passant and win the game',
      'Earned vs @tom_rook · Aug 12',
    ]);
    expect(lines('rank_1800')).toEqual(['Held a rating of 1800 or more']);
  });
  it('marks the dot of an empty slot as empty, and hides it from screen readers', async () => {
    const r = await open();
    const emojis = [...r.root.querySelectorAll('[data-slot] .flair-slot-emoji')];
    expect(emojis.map((el) => el.matches('.empty'))).toEqual([false, false, true]);
    // The dot only draws the empty slot; "Slot 3" is what a screen reader should say.
    expect(emojis.map((el) => el.getAttribute('aria-hidden'))).toEqual([null, null, 'true']);
  });
  it('selects a slot with a haptic, moves the ring to it and saves nothing', async () => {
    const r = await open();
    await r.click('[data-slot="1"]');
    expect(window.__tg!.haptics).toEqual(['selection']);
    expect(r.calls.filter((call) => call.method === 'PUT')).toHaveLength(0);
    const [first, second] = [0, 1].map((index) => r.root.querySelector(`[data-slot="${index}"]`)!);
    expect([first!.getAttribute('aria-pressed'), second!.getAttribute('aria-pressed')]).toEqual([
      'false',
      'true',
    ]);
  });
  it('moves the check, the highlight and the chips with the selected slot', async () => {
    const r = await open();
    const tile = (id: string) => row(r, id).querySelector('.flair-tile')!;
    expect(tile('rank_1500').matches('.here')).toBe(true);
    expect(tile('en_passant_win').matches('.here')).toBe(false);
    await r.click('[data-slot="1"]');
    expect(tile('rank_1500').matches('.here')).toBe(false);
    expect(row(r, 'rank_1500').querySelector('.tag')?.textContent).toBe('Slot 1');
    expect(row(r, 'rank_1500').querySelector('.flair-check')).toBeNull();
    expect(tile('en_passant_win').matches('.here')).toBe(true);
    expect(row(r, 'en_passant_win').querySelector('.flair-check')).not.toBeNull();
    expect(row(r, 'en_passant_win').querySelector('.tag')).toBeNull();
  });
  it('disables the locked rows and no others', async () => {
    const r = await open();
    const disabled = [...r.root.querySelectorAll<HTMLButtonElement>('[data-flair]')]
      .filter((button) => button.disabled)
      .map((button) => button.getAttribute('data-flair'));
    // Rows are listed by category, in `FLAIR_CATEGORIES` order, and in catalog order within each: a
    // flair added at the end of the catalog is still listed with its own category.
    expect(disabled).toEqual(
      FLAIR_CATEGORIES.flatMap((category) =>
        FLAIR.filter(
          (flair) =>
            flair.category === category && !EARNED.some((earned) => earned.id === flair.id),
        ).map((flair) => flair.id),
      ),
    );
  });
  it('groups the rows by category, in catalog order', async () => {
    const r = await open();
    const grouped = [...r.root.querySelectorAll('.section + .card')].map((card) =>
      [...card.querySelectorAll('[data-flair]')].map((el) => el.getAttribute('data-flair')),
    );
    expect(grouped).toEqual(
      FLAIR_CATEGORIES.map((category) =>
        FLAIR.filter((flair) => flair.category === category).map((flair) => flair.id),
      ),
    );
  });
  it('names you beside a 26 px avatar', async () => {
    const r = await open();
    const me = r.root.querySelector('.flair-me')!;
    expect(me.querySelector('.name')?.textContent).toBe('Alice');
    expect(me.querySelector('.avatar')?.getAttribute('style')).toContain('26px');
  });
  it('shows Loading until the flair arrives', async () => {
    const r = await open(() => new Promise<never>(() => undefined));
    expect(r.text()).toBe(t('app.common.loading'));
  });
  it('draws the flair it already has at once, then refreshes it', async () => {
    myFlair.value = { worn: ['rank_1500'], earned: EARNED };
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const r = renderApp(
      () => <FlairScreen />,
      async (call) => {
        await held;
        return server(call);
      },
    );
    await r.flush();
    expect(preview(r)).toBe('🚶');
    release();
    await r.flush();
    expect(preview(r)).toBe('🚶👑');
  });
  it('tries again from the error screen', async () => {
    let up = false;
    const r = await open((call) => (up ? server(call) : failure));
    up = true;
    await r.click('.btn');
    expect(r.root.querySelector('.title')?.textContent).toBe('Your flair');
  });
});

describe('the Flair route', () => {
  it('opens as a screen of the Settings tab, and back returns to Settings', async () => {
    const r = renderApp((app) => {
      app.router.land('settings', { name: 'settings' });
      return <App />;
    }, server);
    await r.flush();
    r.app.router.push({ name: 'flair' });
    await r.flush();
    expect(r.root.querySelector('.title')?.textContent).toBe('Your flair');
    expect(r.root.querySelector('[data-nav="settings"]')?.className).toContain('active');
    expect(window.__tg!.backButton.visible).toBe(true);
    r.app.router.back();
    await r.flush();
    expect(r.root.querySelector('.title')?.textContent).toBe('Settings');
  });
});
