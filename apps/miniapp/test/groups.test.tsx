import type { MeGroupsDto } from '@chess-goat/shared';
import { describe, expect, it } from 'vitest';
import { Groups } from '../src/ui/screens/Groups';
import { renderApp } from './support/render';

const groups: MeGroupsDto = {
  groups: [
    { id: 'GrOuPiDxYz', title: 'Friday Chess Club', activeGames: 4, yourMove: 2 },
    { id: 'OtHeRgRoUp', title: 'Family', activeGames: 1, yourMove: 0 },
  ],
};

describe('Groups', () => {
  it('lists each group with its initials, counts and a badge only when games wait on you', async () => {
    const r = renderApp(
      (app) => {
        app.router.land('groups', { name: 'groups' });
        return <Groups />;
      },
      () => ({ status: 200, body: groups }),
    );
    await r.flush();
    const [club, family] = [...r.root.querySelectorAll('[data-group]')];
    expect(club!.querySelector('.avatar.group')?.textContent).toBe('FC');
    expect(club!.textContent).toContain('4 active · 2 your move');
    expect(club!.querySelector('.count-badge')?.textContent).toBe('2');
    expect(family!.querySelector('.count-badge')).toBeNull();
    await r.click('[data-group="GrOuPiDxYz"]');
    expect(r.app.router.current.value).toEqual({ name: 'lobby', groupId: 'GrOuPiDxYz' });
  });
});
