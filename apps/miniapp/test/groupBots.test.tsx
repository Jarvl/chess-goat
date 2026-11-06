import type { BotLobbyDto } from '@chess-goat/shared';
import { t } from '@chess-goat/shared';
import { describe, expect, it } from 'vitest';
import { GroupBots } from '../src/ui/screens/GroupBots';
import { renderApp } from './support/render';
import { gameSummary, playerRef } from './support/summaryFixtures';

const botGame = (id: string, status: 'active' | 'finished') =>
  gameSummary({
    id,
    status,
    white: playerRef('7', '🤖 Rook (@zed)'),
    black: playerRef('8', '🤖 Pawn (@zed)'),
    yourTurn: false,
    finishedAt: status === 'finished' ? '2026-09-20T12:00:00.000Z' : null,
    result: status === 'finished' ? '1-0' : null,
    endReason: status === 'finished' ? 'resignation' : null,
  });

const full: BotLobbyDto = {
  live: [botGame('LiveAaaaaa', 'active')],
  standings: [
    {
      ...playerRef('7', '🤖 Rook (@zed)'),
      rating: 1650,
      provisional: false,
      gamesPlayed: 4,
      record: { wins: 3, draws: 1, losses: 0 },
    },
  ],
  recent: [botGame('DoneBbbbbb', 'finished')],
};

const open = (body: BotLobbyDto) =>
  renderApp(
    () => <GroupBots groupId="GrOuPiDxYz" />,
    ({ path }) => {
      if (path === '/api/groups/GrOuPiDxYz/bot-lobby') return { status: 200, body };
      return { status: 404, body: {} };
    },
  );

describe('GroupBots', () => {
  it('renders the live games, the standings and the recent games', async () => {
    const r = open(full);
    await r.flush();
    const text = r.text();
    expect(text).toContain(t('app.group_bots.live'));
    expect(text).toContain(t('app.group_bots.standings'));
    expect(text).toContain(t('app.group_bots.recent'));
    expect(r.root.querySelector('[data-game="LiveAaaaaa"]')).not.toBeNull();
    expect(r.root.querySelector('[data-game="DoneBbbbbb"]')).not.toBeNull();
    expect(text).toContain('1650');
    expect(text).not.toContain(t('app.group_bots.empty'));
  });

  it('opens the game screen when a live game is tapped', async () => {
    const r = open(full);
    await r.flush();
    await r.click('[data-game="LiveAaaaaa"]');
    expect(r.app.router.current.value).toEqual({ name: 'game', gameId: 'LiveAaaaaa' });
  });

  it('opens a bot standing row on the player screen', async () => {
    const r = open(full);
    await r.flush();
    await r.click('[data-player="7"]');
    expect(r.app.router.current.value).toEqual({
      name: 'player',
      groupId: 'GrOuPiDxYz',
      userId: '7',
    });
  });

  it('says there are no bot games yet when all three are empty, and still offers browsing', async () => {
    const r = open({ live: [], standings: [], recent: [] });
    await r.flush();
    expect(r.text()).toContain(t('app.group_bots.empty'));
    await r.click('[data-action="browse-bots"]');
    expect(r.app.router.current.value).toEqual({ name: 'botBrowser', groupId: 'GrOuPiDxYz' });
  });
});
