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
    const botPage = (isMine: boolean, findable = true) => ({
      ...page,
      player: {
        ...page.player,
        name: '🤖 Rook (@owner)',
        botActivity: { lastActiveAt: null },
      },
      bot: { tagline: 'Loves endgames', owner: '@owner', lastActiveAt: null, isMine, findable },
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

    it('offers the Taking challenges card to the owner only', async () => {
      const mine = renderApp(
        () => <Player groupId="GrOuPiDxYz" userId="2" />,
        () => ({ status: 200, body: botPage(true) }),
      );
      await mine.flush();
      expect(mine.root.querySelector('[data-action="announce"]')?.textContent).toBe(
        "Post 'Taking challenges' card",
      );
      const theirs = renderApp(
        () => <Player groupId="GrOuPiDxYz" userId="2" />,
        () => ({ status: 200, body: botPage(false) }),
      );
      await theirs.flush();
      expect(theirs.root.querySelector('[data-action="announce"]')).toBeNull();
    });

    it('posts the card and says so', async () => {
      const r = renderApp(
        () => <Player groupId="GrOuPiDxYz" userId="2" />,
        (call) =>
          call.method === 'POST'
            ? { status: 200, body: { ok: true } }
            : { status: 200, body: botPage(true) },
      );
      await r.flush();
      await r.click('[data-action="announce"]');
      await r.flush();
      expect(r.calls.at(-1)).toMatchObject({
        method: 'POST',
        path: '/api/groups/GrOuPiDxYz/bots/2/announce',
      });
      expect(r.root.querySelector('.toast')?.textContent).toBe('Posted to the group.');
    });

    it('explains the daily limit when it is refused', async () => {
      const r = renderApp(
        () => <Player groupId="GrOuPiDxYz" userId="2" />,
        (call) =>
          call.method === 'POST'
            ? {
                status: 429,
                body: {
                  error: { code: 'rate_limited', message: 'too soon', reason: 'announce_limit' },
                },
              }
            : { status: 200, body: botPage(true) },
      );
      await r.flush();
      await r.click('[data-action="announce"]');
      await r.flush();
      expect(r.root.querySelector('.toast')?.textContent).toBe(
        'You can post one of these per group each day.',
      );
    });

    it('says only "something went wrong" for any other refusal', async () => {
      const r = renderApp(
        () => <Player groupId="GrOuPiDxYz" userId="2" />,
        (call) =>
          call.method === 'POST'
            ? { status: 429, body: { error: { code: 'rate_limited', message: 'slow down' } } }
            : { status: 200, body: botPage(true) },
      );
      await r.flush();
      await r.click('[data-action="announce"]');
      await r.flush();
      expect(r.root.querySelector('.toast')?.textContent).toBe('Something went wrong');
    });

    it('offers no Challenge button for a bot that cannot be challenged here', async () => {
      const r = renderApp(
        () => <Player groupId="GrOuPiDxYz" userId="2" />,
        () => ({ status: 200, body: botPage(false, false) }),
      );
      await r.flush();
      expect(r.root.querySelector('[data-action="challenge"]')).toBeNull();
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
