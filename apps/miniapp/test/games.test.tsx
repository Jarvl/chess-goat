import type { MeGamesDto } from '@chess-goat/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { setYourMoveCount, yourMoveCount } from '../src/state/yourMove';
import { App } from '../src/ui/App';
import { Games } from '../src/ui/screens/Games';
import { renderApp } from './support/render';
import { gameSummary } from './support/summaryFixtures';

const summary = (id: string, group: string, yourTurn: boolean) => ({
  ...gameSummary({ id, plyCount: 3, sideToMove: 'black', yourTurn }),
  group: { id: group, title: group === 'GrOuPiDxYz' ? 'Chess Club' : 'Pub Team' },
});

const games: MeGamesDto = {
  items: [summary('GameBbbbbb', 'GrOuPiDxYz', true), summary('GameAaaaaa', 'OtHeRgRoUp', false)],
};

describe('Games', () => {
  it('lists your games across groups from the launch data, naming each one’s group', async () => {
    const r = renderApp(
      (app) => {
        app.prefetched.games = games;
        return <Games />;
      },
      () => ({ status: 200, body: games }),
    );
    await r.flush();
    expect(r.calls).toHaveLength(0);
    expect(
      [...r.root.querySelectorAll('[data-game]')].map((el) => el.getAttribute('data-game')),
    ).toEqual(['GameBbbbbb', 'GameAaaaaa']);
    expect(r.text()).toContain('Chess Club');
    expect(r.text()).toContain('Pub Team');
    expect(r.text()).toContain('Your move');
  });

  it('opens a game one level deep, so back returns to the list', async () => {
    const r = renderApp(
      (app) => {
        app.prefetched.games = games;
        app.router.land('games', { name: 'games' });
        return <Games />;
      },
      () => ({ status: 200, body: games }),
    );
    await r.flush();
    await r.click('[data-game="GameBbbbbb"]');
    expect(r.app.router.current.value).toEqual({ name: 'game', gameId: 'GameBbbbbb' });
    expect(r.app.router.back()).toBe(true);
    expect(r.app.router.current.value).toEqual({ name: 'games' });
  });

  it('points an empty home at the groups tab', async () => {
    const r = renderApp(
      (app) => {
        app.prefetched.games = { items: [] };
        app.router.land('games', { name: 'games' });
        return <Games />;
      },
      () => ({ status: 200, body: { items: [] } }),
    );
    await r.flush();
    await r.click('[data-action="browse-groups"]');
    expect(r.app.router.tab.value).toBe('groups');
    expect(r.app.router.current.value).toEqual({ name: 'groups' });
  });

  it('heads the list with the goat and a count of what is waiting', async () => {
    const r = renderApp(
      (app) => {
        app.prefetched.games = games;
        return <Games />;
      },
      () => ({ status: 200, body: games }),
    );
    await r.flush();
    expect(r.root.querySelector('img.goat-mark')?.getAttribute('src')).toMatch(/goat-mark/);
    expect(r.root.querySelector('.section')?.textContent).toBe('2 games · 1 your move');
    expect(r.root.querySelector('[data-game="GameAaaaaa"]')?.className).toContain('dim');
    expect(r.root.querySelector('[data-game="GameBbbbbb"]')?.className).not.toContain('dim');
  });
});

describe('TabBar', () => {
  it('moves between sections without deepening the stack, and hides where no session exists', async () => {
    const r = renderApp(
      (app) => {
        app.prefetched.games = { items: [] };
        app.router.land('games', { name: 'games' });
        return <App />;
      },
      () => ({ status: 200, body: { groups: [] } }),
    );
    await r.flush();
    expect(r.root.querySelector('[data-nav="games"]')?.className).toContain('active');

    await r.click('[data-nav="settings"]');
    expect(r.app.router.tab.value).toBe('settings');
    expect(r.app.router.stack.value).toHaveLength(1);
    expect(window.__tg!.backButton.visible).toBe(false);
    expect(window.__tg!.haptics).toContain('selection');

    r.app.router.land('groups', { name: 'locked', group: { id: 'GrOuPiDxYz', title: 'Club' } });
    await r.flush();
    expect(r.root.querySelector('[data-nav="games"]')).toBeNull();
  });
});

describe('the Games tab badge', () => {
  beforeEach(() => setYourMoveCount(0));

  // Rendered over the Groups screen on purpose: the badge's whole job is to be right while the
  // viewer is somewhere other than the list it came from. Landing on Games instead would have the
  // screen recount from its own list and overwrite whatever this set.
  const bar = (count: number) =>
    renderApp(
      (app) => {
        setYourMoveCount(count);
        app.router.land('groups', { name: 'groups' });
        return <App />;
      },
      () => ({ status: 200, body: { groups: [] } }),
    );

  it('shows the number of games waiting on you, over the games icon only', async () => {
    const r = bar(3);
    await r.flush();
    const badge = r.root.querySelector('[data-nav="games"] .nav-badge');
    expect(badge?.textContent).toBe('3');
    expect(r.root.querySelector('[data-nav="groups"] .nav-badge')).toBeNull();
    expect(r.root.querySelector('[data-nav="settings"] .nav-badge')).toBeNull();
    expect(r.root.querySelector('[data-nav="games"]')?.getAttribute('aria-label')).toBe(
      'Games, 3 waiting on you',
    );
  });

  it('shows no badge at all when nothing is waiting', async () => {
    const r = bar(0);
    await r.flush();
    expect(r.root.querySelector('.nav-badge')).toBeNull();
    // With no badge the tab is just its label, so it keeps no count in its accessible name.
    expect(r.root.querySelector('[data-nav="games"]')?.getAttribute('aria-label')).toBeNull();
  });

  it('caps the printed count so a long number cannot stretch the bar', async () => {
    const r = bar(120);
    await r.flush();
    expect(r.root.querySelector('.nav-badge')?.textContent).toBe('99+');
  });

  it('follows the count as it changes, without a re-render from the caller', async () => {
    const r = bar(1);
    await r.flush();
    expect(r.root.querySelector('.nav-badge')?.textContent).toBe('1');
    setYourMoveCount(2);
    await r.flush();
    expect(r.root.querySelector('.nav-badge')?.textContent).toBe('2');
    setYourMoveCount(0);
    await r.flush();
    expect(r.root.querySelector('.nav-badge')).toBeNull();
  });

  it('is recounted from the list the Games screen loads', async () => {
    setYourMoveCount(99);
    const r = renderApp(
      (app) => {
        app.router.land('games', { name: 'games' });
        return <App />;
      },
      () => ({ status: 200, body: games }),
    );
    await r.flush();
    // One of the two fixture games is the viewer's move.
    expect(yourMoveCount.value).toBe(1);
    expect(r.root.querySelector('.nav-badge')?.textContent).toBe('1');
  });
});
