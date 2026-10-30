import { describe, expect, it, vi } from 'vitest';
import { Router } from '../src/router';
import { createTg } from '../src/tg/webapp';
import { installFakeWebApp } from './support/fakeWebApp';

const setup = (closeFromRoot = false) => {
  installFakeWebApp({ version: '8.0', initData: 'user=x&hash=y' });
  const tg = createTg(window.Telegram!.WebApp);
  return { router: new Router(tg, { closeFromRoot }), record: window.__tg! };
};

describe('Router', () => {
  it('pushes, replaces and pops within a tab, showing the back button below the root', () => {
    const { router, record } = setup();
    router.select('groups');
    expect(router.current.value).toEqual({ name: 'groups' });
    expect(record.backButton.visible).toBe(false);

    router.push({ name: 'lobby', groupId: 'GrOuPiDxYz' });
    expect(record.backButton.visible).toBe(true);
    router.replace({ name: 'newGame', groupId: 'GrOuPiDxYz' });
    expect(router.current.value).toEqual({ name: 'newGame', groupId: 'GrOuPiDxYz' });

    expect(router.back()).toBe(true);
    expect(router.current.value).toEqual({ name: 'groups' });
    expect(record.backButton.visible).toBe(false);
    expect(record.closed).toBe(false);
  });

  it('starts on the games tab with a loading screen until a launch lands', () => {
    const { router, record } = setup();
    expect(router.tab.value).toBe('games');
    expect(router.current.value).toEqual({ name: 'loading' });
    expect(record.backButton.visible).toBe(false);
  });

  it('lands a launch one screen deep so the back button is free to close', () => {
    const { router, record } = setup(true);
    router.land('games', { name: 'game', gameId: 'AbCdEfGhIj' });
    expect(router.tab.value).toBe('games');
    expect(router.stack.value).toEqual([{ name: 'game', gameId: 'AbCdEfGhIj' }]);
    expect(record.backButton.visible).toBe(true);
    record.clickBack();
    expect(record.closed).toBe(true);
  });

  it('lands a screen on top of another, so back leads to the lower one before closing', () => {
    const { router, record } = setup(true);
    router.land('groups', { name: 'newGame', groupId: 'GrOuPiDxYz' }, [
      { name: 'lobby', groupId: 'GrOuPiDxYz' },
    ]);
    expect(router.stack.value).toEqual([
      { name: 'lobby', groupId: 'GrOuPiDxYz' },
      { name: 'newGame', groupId: 'GrOuPiDxYz' },
    ]);
    record.clickBack();
    expect(router.current.value).toEqual({ name: 'lobby', groupId: 'GrOuPiDxYz' });
    expect(record.closed).toBe(false);
    record.clickBack();
    expect(record.closed).toBe(true);
  });

  it('leaves closing to Telegram at the root of a profile launch', () => {
    const { router, record } = setup(false);
    router.land('games', { name: 'games' });
    expect(record.backButton.visible).toBe(false);
    expect(router.back()).toBe(false);
    expect(record.closed).toBe(false);
  });

  it('sends a deep-launched game home when its own tab is tapped', () => {
    const { router } = setup(true);
    router.land('games', { name: 'game', gameId: 'AbCdEfGhIj' });
    router.select('games');
    expect(router.current.value).toEqual({ name: 'games' });
  });

  it('keeps a stack per tab and resumes it on the way back', () => {
    const { router, record } = setup();
    router.land('groups', { name: 'groups' });
    router.push({ name: 'lobby', groupId: 'GrOuPiDxYz' });
    router.push({ name: 'game', gameId: 'AbCdEfGhIj' });

    router.select('games');
    expect(router.current.value).toEqual({ name: 'games' });
    expect(record.backButton.visible).toBe(false);

    router.select('groups');
    expect(router.current.value).toEqual({ name: 'game', gameId: 'AbCdEfGhIj' });
    expect(record.backButton.visible).toBe(true);
    record.clickBack();
    expect(router.current.value).toEqual({ name: 'lobby', groupId: 'GrOuPiDxYz' });
  });

  it('resumes a game reached from the switcher strip as a fresh arrival', () => {
    const { router } = setup();
    router.land('games', { name: 'games' });
    router.push({ name: 'game', gameId: 'AbCdEfGhIj' });
    router.replace({ name: 'game', gameId: 'OtherAaaaa', hop: true });
    router.select('groups');
    router.select('games');
    // Coming back from another section is not a hop: the strip takes a fresh order.
    expect(router.current.value).toEqual({ name: 'game', gameId: 'OtherAaaaa' });
  });

  it('seeds a tab at its root the first time it is selected', () => {
    const { router } = setup();
    router.select('settings');
    expect(router.tab.value).toBe('settings');
    expect(router.stack.value).toEqual([{ name: 'settings' }]);
  });

  it('hides the tab bar on the screens that exist without a session', () => {
    const { router } = setup();
    expect(router.showTabs.value).toBe(false); // loading
    router.land('groups', { name: 'locked', group: { id: 'GrOuPiDxYz', title: 'Club' } });
    expect(router.showTabs.value).toBe(false);
    router.land('games', { name: 'error' });
    expect(router.showTabs.value).toBe(false);
    router.land('games', { name: 'games' });
    expect(router.showTabs.value).toBe(true);
  });

  it('hides the tab bar on New game, where the MainButton owns the bottom edge', () => {
    const { router } = setup();
    router.land('groups', { name: 'lobby', groupId: 'GrOuPiDxYz' });
    expect(router.showTabs.value).toBe(true);
    router.push({ name: 'newGame', groupId: 'GrOuPiDxYz' });
    expect(router.showTabs.value).toBe(false);
    router.back();
    expect(router.showTabs.value).toBe(true);
  });

  it('hides the tab bar while a screen suppresses it', () => {
    const { router } = setup();
    router.land('games', { name: 'game', gameId: 'AbCdEfGhIj' });
    expect(router.showTabs.value).toBe(true);
    router.suppressTabs.value = true;
    expect(router.showTabs.value).toBe(false);
    router.suppressTabs.value = false;
    expect(router.showTabs.value).toBe(true);
  });
  describe('leave guard', () => {
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
    const guarded = (answer: boolean) => {
      const guard = vi.fn(() => Promise.resolve(answer));
      return guard;
    };

    it('keeps the stack when the guard says stay, on Back, close, a tab and push or replace', async () => {
      const { router, record } = setup(true);
      router.land('groups', { name: 'groups' });
      router.push({ name: 'game', gameId: 'AbCdEfGhIj' });
      const guard = guarded(false);
      router.leaveGuard = guard;
      record.clickBack();
      await flush();
      router.select('settings');
      await flush();
      router.push({ name: 'flair' });
      await flush();
      router.replace({ name: 'lobby', groupId: 'GrOuPiDxYz' });
      await flush();
      expect(guard).toHaveBeenCalledTimes(4);
      expect(router.tab.value).toBe('groups');
      expect(router.stack.value).toEqual([
        { name: 'groups' },
        { name: 'game', gameId: 'AbCdEfGhIj' },
      ]);
      router.back();
      record.clickBack();
      await flush();
      expect(record.closed).toBe(false);
    });

    it('pops, switches, pushes and replaces when the guard says leave', async () => {
      const { router, record } = setup();
      router.land('groups', { name: 'groups' });
      router.push({ name: 'game', gameId: 'AbCdEfGhIj' });
      router.leaveGuard = guarded(true);
      record.clickBack();
      await flush();
      expect(router.current.value).toEqual({ name: 'groups' });
      router.push({ name: 'game', gameId: 'AbCdEfGhIj' });
      await flush();
      expect(router.current.value).toEqual({ name: 'game', gameId: 'AbCdEfGhIj' });
      router.replace({ name: 'lobby', groupId: 'GrOuPiDxYz' });
      await flush();
      expect(router.current.value).toEqual({ name: 'lobby', groupId: 'GrOuPiDxYz' });
      router.select('settings');
      await flush();
      expect(router.tab.value).toBe('settings');
    });

    it('closes the app from the root once the guard says leave', async () => {
      const { router, record } = setup(true);
      router.land('games', { name: 'game', gameId: 'AbCdEfGhIj' });
      router.leaveGuard = guarded(true);
      record.clickBack();
      expect(record.closed).toBe(false);
      await flush();
      expect(record.closed).toBe(true);
    });

    it('asks one question at a time', async () => {
      const { router } = setup();
      router.land('groups', { name: 'groups' });
      const guard = vi.fn(() => Promise.resolve(true));
      router.leaveGuard = guard;
      router.select('settings');
      router.select('games');
      await flush();
      expect(guard).toHaveBeenCalledTimes(1);
      expect(router.tab.value).toBe('settings');
    });

    it('acts at once, in the same tick, with no guard', () => {
      const { router, record } = setup();
      router.land('groups', { name: 'groups' });
      router.push({ name: 'settings' });
      record.clickBack();
      expect(router.current.value).toEqual({ name: 'groups' });
      router.select('settings');
      expect(router.tab.value).toBe('settings');
    });

    it('leaves back() itself unguarded', () => {
      const { router } = setup();
      router.land('groups', { name: 'groups' });
      router.push({ name: 'settings' });
      router.leaveGuard = guarded(false);
      expect(router.back()).toBe(true);
    });
  });
});
