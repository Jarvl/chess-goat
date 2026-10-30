import type { LobbyDto } from '@group-chess/shared';
import { describe, expect, it } from 'vitest';
import { App } from '../src/ui/App';
import { Lobby } from '../src/ui/screens/Lobby';
import { Leaderboard } from '../src/ui/screens/Leaderboard';
import { gameDto } from './support/gameFixtures';
import { renderApp } from './support/render';
import { gameSummary, playerRef } from './support/summaryFixtures';

const ref = (id: string, name: string) => playerRef(id, name);
const summary = (id: string, yourTurn: boolean, status: 'active' | 'finished' = 'active') =>
  gameSummary({
    id,
    plyCount: 3,
    sideToMove: 'black',
    yourTurn,
    status,
    finishedAt: status === 'finished' ? '2026-09-20T12:00:00.000Z' : null,
    result: status === 'finished' ? '1-0' : null,
    endReason: status === 'finished' ? 'resignation' : null,
  });

const watching = gameSummary({
  id: 'GameWwwwww',
  white: playerRef('3', 'Carol'),
  black: playerRef('4', 'Dan'),
  yourTurn: false,
});

const board = (ids: string[]) =>
  ids.map((id, index) => ({
    ...playerRef(id, id === '1' ? 'Alice' : `P${id}`),
    rating: 1600 - index * 10,
    provisional: false,
    gamesPlayed: 9,
    record: { wins: 5, draws: 1, losses: 3 },
  }));

const lobby: LobbyDto = {
  group: { id: 'GrOuPiDxYz', title: 'Chess Club' },
  isAdmin: true,
  settings: { defaultTimePerMove: 86400, ratedDefault: true, allowOpenChallenges: true },
  active: [summary('GameAaaaaa', false), summary('GameBbbbbb', true), watching],
  finished: { items: [summary('GameCccccc', false, 'finished')], nextCursor: null },
  challenges: [
    {
      id: 'ChalAaaaaa',
      challenger: ref('2', 'Bob'),
      opponent: ref('1', 'Alice'),
      timePerMove: 86400,
      challengerColour: 'random',
      rated: true,
      status: 'pending',
      createdAt: '2026-09-20T10:00:00.000Z',
      expiresAt: '2026-09-21T10:00:00.000Z',
      viewer: { canAccept: true, canDecline: true, canCancel: false },
    },
  ],
  players: board(['2', '1', '5']),
};

const open = (data: LobbyDto, route?: Parameters<typeof renderApp>[1]) =>
  renderApp(
    (app) => {
      app.prefetched.lobby = data;
      app.router.land('groups', { name: 'lobby', groupId: 'GrOuPiDxYz' });
      return <App />;
    },
    route ?? (() => ({ status: 200, body: data })),
  );
const ids = (root: HTMLElement) =>
  [...root.querySelectorAll('[data-game]')].map((el) => el.getAttribute('data-game'));

describe('Lobby', () => {
  it('heads the lobby with the group, its counts and the admin gear', async () => {
    const r = open(lobby);
    await r.flush();
    expect(r.calls).toHaveLength(0);
    expect(r.root.querySelector('.title')?.textContent).toBe('Chess Club');
    expect(r.root.querySelector('.avatar.group')?.textContent).toBe('CC');
    expect(r.text()).toContain('3 active · 1 your move');
    expect(r.root.querySelector('[data-action="group-settings"]')).not.toBeNull();
    expect(r.text()).toContain('Bob challenges you');
  });

  it('heads the games with Yours and Others, yours first', async () => {
    const r = open(lobby);
    await r.flush();
    const head = r.root.querySelector('.games-head')!;
    expect(head.querySelector('h2')?.textContent).toBe('Games');
    expect([...head.querySelectorAll('.segmented button')].map((b) => b.textContent)).toEqual([
      'Yours',
      'Others',
    ]);
    expect(ids(r.root)).toEqual(['GameBbbbbb', 'GameAaaaaa', 'GameCccccc']);
    await r.click('[data-scope="others"]');
    expect(ids(r.root)).toEqual(['GameWwwwww']);
    expect(r.root.querySelector('[data-game="GameWwwwww"] .tag')?.textContent).toBe('Watching');
    expect(r.text()).toContain('Nobody else has finished a game here yet.');
    expect(window.__tg!.haptics).toContain('selection');
  });

  it('keeps Others selected coming back from a game, but not on a fresh visit', async () => {
    const r = open(lobby);
    await r.flush();
    await r.click('[data-scope="others"]');
    r.app.router.push({ name: 'game', gameId: 'GameWwwwww' });
    await r.flush();
    r.app.router.back();
    await r.flush();
    expect(ids(r.root)).toEqual(['GameWwwwww']);
    // A fresh visit: a new lobby screen on the stack.
    r.app.router.push({ name: 'lobby', groupId: 'GrOuPiDxYz' });
    await r.flush();
    expect(ids(r.root)).toEqual(['GameBbbbbb', 'GameAaaaaa', 'GameCccccc']);
  });

  it('nudges the viewer to challenge someone when they have no game running', async () => {
    const r = open({ ...lobby, active: [watching] });
    await r.flush();
    expect(r.text()).toContain('You have no active games. Challenge someone!');
  });

  it('dims finished games only, not active ones waiting on someone else', async () => {
    const r = open(lobby);
    await r.flush();
    const cls = (id: string) => r.root.querySelector(`[data-game="${id}"]`)!.className;
    expect(cls('GameAaaaaa')).not.toContain('dim');
    expect(cls('GameCccccc')).toContain('dim');
  });

  it('says when nobody else has a game running', async () => {
    const r = open({ ...lobby, active: lobby.active.filter((g) => g.id !== 'GameWwwwww') });
    await r.flush();
    await r.click('[data-scope="others"]');
    expect(r.text()).toContain('Nobody else has a game running here.');
  });

  it('ranks the viewer on the leaderboard chip and opens the leaderboard', async () => {
    const r = open(lobby);
    await r.flush();
    const chip = r.root.querySelector('[data-action="leaderboard"]')!;
    expect(chip.textContent).toContain('#2');
    expect(chip.textContent).toContain('Leaderboard · 1590');
    expect(chip.textContent).toContain('5 W · 1 D · 3 L · of 3 ranked players');
    await r.click('[data-action="leaderboard"]');
    expect(r.app.router.current.value).toEqual({ name: 'leaderboard', groupId: 'GrOuPiDxYz' });
  });

  it('offers a plain chip when the viewer is not ranked, and none on an empty board', async () => {
    const unranked = open({ ...lobby, players: board(['2']) });
    await unranked.flush();
    const chip = unranked.root.querySelector('[data-action="leaderboard"]')!;
    expect(chip.textContent).not.toContain('#');
    expect(chip.textContent).toContain('1 ranked player');
    const empty = open({ ...lobby, players: [] });
    await empty.flush();
    expect(empty.root.querySelector('[data-action="leaderboard"]')).toBeNull();
  });

  it('says you have no finished games only once every page is loaded', async () => {
    const othersOnly = { items: [{ ...watching, status: 'finished' as const }], nextCursor: 'c1' };
    const paged = open({ ...lobby, finished: othersOnly });
    await paged.flush();
    expect(paged.text()).not.toContain("You haven't finished a game here yet.");
    expect(paged.root.querySelector('[data-action="more"]')).not.toBeNull();
    const done = open({ ...lobby, finished: { ...othersOnly, nextCursor: null } });
    await done.flush();
    expect(done.text()).toContain("You haven't finished a game here yet.");
  });

  it('tells the user when the next page of finished games cannot be loaded', async () => {
    const paged = { ...lobby, finished: { ...lobby.finished, nextCursor: 'c1' } };
    const r = open(paged, ({ path }) =>
      path.includes('/finished?cursor=')
        ? { status: 500, body: { error: { code: 'internal', message: 'boom' } } }
        : { status: 200, body: paged },
    );
    await r.flush();
    await r.click('[data-action="more"]');
    expect(r.calls.at(-1)?.path).toBe('/api/groups/GrOuPiDxYz/finished?cursor=c1');
    expect(document.querySelector('.toast')?.textContent).toBe('Something went wrong');
    expect(r.root.querySelector<HTMLButtonElement>('[data-action="more"]')?.disabled).toBe(false);
  });

  it('accepts a challenge through the API and opens the game', async () => {
    const r = renderApp(
      () => <Lobby groupId="GrOuPiDxYz" />,
      ({ path, method }) =>
        method === 'POST' && path === '/api/challenges/ChalAaaaaa/accept'
          ? { status: 200, body: gameDto({ id: 'GameNnnnnn' }) }
          : { status: 200, body: lobby },
    );
    await r.flush();
    expect(r.calls.map((c) => c.path)).toEqual(['/api/groups/GrOuPiDxYz']);
    await r.click('[data-accept="ChalAaaaaa"]');
    expect(r.calls.at(-1)?.path).toBe('/api/challenges/ChalAaaaaa/accept');
    expect(r.app.router.current.value).toEqual({ name: 'game', gameId: 'GameNnnnnn' });
    expect(r.app.prefetched.game?.id).toBe('GameNnnnnn');
  });

  it('opens a game row and the new game screen', async () => {
    const r = renderApp(
      () => <Lobby groupId="GrOuPiDxYz" />,
      () => ({ status: 200, body: lobby }),
    );
    await r.flush();
    await r.click('[data-game="GameAaaaaa"]');
    expect(r.app.router.current.value).toEqual({ name: 'game', gameId: 'GameAaaaaa' });
    r.app.router.back();
    await r.click('[data-action="new-game"]');
    expect(r.app.router.current.value).toMatchObject({ name: 'newGame', groupId: 'GrOuPiDxYz' });
  });
});

describe('Leaderboard', () => {
  it('ranks the group, marks you, and opens a player', async () => {
    const r = renderApp(
      (app) => {
        app.router.land('groups', { name: 'leaderboard', groupId: 'GrOuPiDxYz' });
        return <Leaderboard groupId="GrOuPiDxYz" />;
      },
      () => ({ status: 200, body: lobby }),
    );
    await r.flush();
    expect(r.calls.map((c) => c.path)).toEqual(['/api/groups/GrOuPiDxYz']);
    expect(r.root.querySelector('.subtitle')?.textContent).toBe('Chess Club · rated games only');
    const rows = [...r.root.querySelectorAll('[data-player]')];
    expect(rows.map((row) => row.getAttribute('data-player'))).toEqual(['2', '1', '5']);
    expect(rows[0]!.querySelector('.rank')?.className).toContain('first');
    expect(rows[1]!.className).toContain('you');
    expect(rows[1]!.textContent).toContain('(you)');
    await r.click('[data-player="5"]');
    expect(r.app.router.current.value).toEqual({
      name: 'player',
      groupId: 'GrOuPiDxYz',
      userId: '5',
    });
  });
});
