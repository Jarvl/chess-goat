import { describe, expect, it } from 'vitest';
import { session } from '../src/state/session';
import { Player } from '../src/ui/screens/Player';
import { renderApp } from './support/render';
import { gameSummary, playerRef } from './support/summaryFixtures';

const page = {
  player: {
    ...playerRef('2', '@bob', { rating: 1520, provisional: false }),
    gamesPlayed: 9,
    record: { wins: 5, draws: 1, losses: 3 },
  },
  headToHead: { wins: 2, draws: 0, losses: 1 },
  recentGames: [gameSummary({ id: 'GameRrrrrr' })],
  deleted: false,
  bot: null,
};

describe('Player', () => {
  it('heads the page with the avatar and record and lists recent games as cards', async () => {
    const r = renderApp(
      () => <Player groupId="GrOuPiDxYz" userId="2" />,
      () => ({ status: 200, body: page }),
    );
    await r.flush();
    expect(r.root.querySelector('.player-head .avatar')?.textContent).toBe('B');
    expect(r.root.querySelector('.title')?.textContent).toBe('@bob');
    expect(r.text()).toContain('5 W · 1 D · 3 L');
    expect(r.text()).toContain('Against you: 2 W · 0 D · 1 L');
    expect(r.root.querySelector('.game-card[data-game="GameRrrrrr"]')).not.toBeNull();
  });

  it('opens New game with this player picked from the Challenge button', async () => {
    const r = renderApp(
      () => <Player groupId="GrOuPiDxYz" userId="2" />,
      () => ({ status: 200, body: page }),
    );
    await r.flush();
    await r.click('[data-action="challenge"]');
    expect(r.app.router.current.value).toEqual({
      name: 'newGame',
      groupId: 'GrOuPiDxYz',
      opponentId: '2',
    });
  });

  it('offers no Challenge button on your own page', async () => {
    const r = renderApp(
      () => <Player groupId="GrOuPiDxYz" userId="2" />,
      () => ({ status: 200, body: page }),
    );
    session.value = { ...session.value!, user: { id: '2', name: '@bob', username: 'bob' } };
    await r.flush();
    expect(r.root.querySelector('[data-action="challenge"]')).toBeNull();
  });

  it('shows the player’s flair beside the name, outside the title', async () => {
    const worn = { ...page, player: { ...page.player, flair: ['draws_10'] } };
    const r = renderApp(
      () => <Player groupId="GrOuPiDxYz" userId="2" />,
      () => ({ status: 200, body: worn }),
    );
    await r.flush();
    expect(r.root.querySelector('.title')?.textContent).toBe('@bob');
    expect(r.root.querySelector('.player-name .flair')?.textContent).toBe('🤝');
    expect(r.root.querySelector('.title')?.nextElementSibling?.matches('.flair')).toBe(true);
  });

  describe('a bot', () => {
    const botPage = (isMine: boolean) => ({
      ...page,
      player: {
        ...page.player,
        name: '🤖 Rook (@owner)',
        botActivity: { lastActiveAt: null },
      },
      bot: { tagline: 'Loves endgames', owner: '@owner', lastActiveAt: null, isMine },
    });

    it('shows who runs it, its tagline and its activity', async () => {
      const r = renderApp(
        () => <Player groupId="GrOuPiDxYz" userId="2" />,
        () => ({ status: 200, body: botPage(false) }),
      );
      await r.flush();
      expect(r.text()).toContain('Run by @owner');
      expect(r.text()).toContain('Loves endgames');
      expect(r.text()).toContain('Not active yet');
    });

    it('opens New game with the bot from Challenge', async () => {
      const r = renderApp(
        () => <Player groupId="GrOuPiDxYz" userId="2" />,
        () => ({ status: 200, body: botPage(false) }),
      );
      await r.flush();
      await r.click('[data-action="challenge"]');
      expect(r.app.router.current.value).toEqual({
        name: 'newGame',
        groupId: 'GrOuPiDxYz',
        opponentId: '2',
      });
    });

    it('offers no Challenge button to the bot’s owner', async () => {
      const r = renderApp(
        () => <Player groupId="GrOuPiDxYz" userId="2" />,
        () => ({ status: 200, body: botPage(true) }),
      );
      await r.flush();
      expect(r.root.querySelector('[data-action="challenge"]')).toBeNull();
    });
  });

  it('offers Challenge for a live player but not a deleted one', async () => {
    const live = renderApp(
      () => <Player groupId="GrOuPiDxYz" userId="2" />,
      () => ({ status: 200, body: page }),
    );
    await live.flush();
    expect(live.root.querySelector('[data-action="challenge"]')).not.toBeNull();
    const gone = renderApp(
      () => <Player groupId="GrOuPiDxYz" userId="2" />,
      () => ({ status: 200, body: { ...page, deleted: true } }),
    );
    await gone.flush();
    expect(gone.root.querySelector('[data-action="challenge"]')).toBeNull();
  });
});
