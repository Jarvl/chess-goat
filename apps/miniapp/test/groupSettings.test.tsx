import type { GroupSettingsDto, LobbyDto } from '@group-chess/shared';
import { describe, expect, it } from 'vitest';
import { GroupSettings } from '../src/ui/screens/GroupSettings';
import { renderApp } from './support/render';
import { playerRef } from './support/summaryFixtures';

const dto: GroupSettingsDto = {
  group: { id: 'GrOuPiDxYz', title: 'Chess Club' },
  settings: {
    defaultTimePerMove: 86400,
    ratedDefault: true,
    allowOpenChallenges: true,
    cardTopicMode: 'origin',
    fixedTopicId: null,
  },
  blocked: [playerRef('3', 'Carol')],
  botIsAdmin: true,
  isForum: true,
};
const lobby: LobbyDto = {
  group: dto.group,
  isAdmin: true,
  settings: { defaultTimePerMove: 86400, ratedDefault: true, allowOpenChallenges: true },
  active: [],
  finished: { items: [], nextCursor: null },
  challenges: [],
  players: [{ ...playerRef('2', 'Bob'), gamesPlayed: 1, record: { wins: 1, draws: 0, losses: 0 } }],
};

describe('GroupSettings', () => {
  const route = ({ path, method }: { path: string; method: string }) => {
    if (method === 'PUT') return { status: 200, body: dto };
    if (path.endsWith('/settings')) return { status: 200, body: dto };
    if (path.endsWith('/blocks/3') || path.endsWith('/blocks'))
      return { status: 200, body: { ok: true } };
    return { status: 200, body: lobby };
  };

  it('saves only the changed fields and refuses a fixed topic without an id', async () => {
    const r = renderApp(() => <GroupSettings groupId="GrOuPiDxYz" />, route);
    await r.flush();
    expect(r.root.querySelector('.card [data-setting="defaultTimePerMove"] .tile')).not.toBeNull();
    await r.click('[data-setting="ratedDefault"]');
    await r.click('[data-topic="fixed"]');
    await r.click('[data-setting="defaultTimePerMove"] [data-time="3600"]');
    expect(window.__tg!.haptics).toContain('selection');
    expect(window.__tg!.mainButton.enabled).toBe(false);
    const input = r.root.querySelector<HTMLInputElement>('[data-setting="fixedTopicId"]')!;
    input.value = '42';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await r.flush();
    expect(window.__tg!.mainButton.enabled).toBe(true);
    window.__tg!.clickMain();
    await r.flush();
    const put = r.calls.find((c) => c.method === 'PUT');
    expect(put?.path).toBe('/api/groups/GrOuPiDxYz/settings');
    expect(put?.body).toEqual({
      defaultTimePerMove: 3600,
      ratedDefault: false,
      cardTopicMode: 'fixed',
      fixedTopicId: 42,
    });
  });

  it('unblocks and blocks players', async () => {
    const r = renderApp(() => <GroupSettings groupId="GrOuPiDxYz" />, route);
    await r.flush();
    expect(r.text()).toContain('Carol');
    await r.click('[data-unblock="3"]');
    expect(r.calls.find((c) => c.method === 'DELETE')?.path).toBe(
      '/api/groups/GrOuPiDxYz/blocks/3',
    );
    await r.click('[data-block="2"]');
    expect(window.__tg!.popups.at(-1)?.message).toBe('Block Bob?');
    window.__tg!.answerPopup('confirm');
    await r.flush();
    const post = r.calls.find((c) => c.method === 'POST');
    expect(post).toMatchObject({ path: '/api/groups/GrOuPiDxYz/blocks', body: { userId: '2' } });
  });
});
