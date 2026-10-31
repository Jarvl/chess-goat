import { FLAIR } from '@chess-goat/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApiClient } from '../src/api/client';
import {
  loadMyFlair,
  myFlair,
  saveWornFlair,
  unlockedPercent,
  wearFlair,
} from '../src/state/flair';
import { flairEarnedLabel } from '../src/ui/format';
import { fakeFetch, type FakeRoute } from './support/fakeFetch';

const EARNED = [{ id: 'rank_1500', earnedAt: '2026-04-10T12:00:00.000Z', opponent: '@tom' }];
const failure = { status: 500, body: { error: { code: 'internal', message: 'boom' } } };
const clientFor = (route: FakeRoute) => {
  const client = createApiClient({ fetch: fakeFetch(route).fetch });
  client.setToken('jwt');
  return client;
};
beforeEach(() => {
  myFlair.value = { worn: [], earned: EARNED };
});

describe('wearFlair', () => {
  it('puts a flair in the chosen slot and closes up the empty slots', () => {
    expect(wearFlair([], 2, 'rank_1500')).toEqual(['rank_1500']);
    expect(wearFlair(['rank_1500'], 1, 'draws_10')).toEqual(['rank_1500', 'draws_10']);
    expect(wearFlair(['rank_1500', 'draws_10'], 0, 'en_passant_win')).toEqual([
      'en_passant_win',
      'draws_10',
    ]);
  });
  it('empties the slot when the flair is already in it', () =>
    expect(wearFlair(['rank_1500', 'draws_10'], 0, 'rank_1500')).toEqual(['draws_10']));
  it('swaps when the flair is worn in another slot', () =>
    expect(wearFlair(['rank_1500', 'draws_10', 'en_passant_win'], 0, 'en_passant_win')).toEqual([
      'en_passant_win',
      'draws_10',
      'rank_1500',
    ]));
  it('moves a flair into an empty selected slot and closes up the slot it left', () =>
    expect(wearFlair(['rank_1500', 'draws_10'], 2, 'rank_1500')).toEqual([
      'draws_10',
      'rank_1500',
    ]));
  it('leaves the list it was given alone', () => {
    const worn = ['rank_1500', 'draws_10'];
    wearFlair(worn, 0, 'draws_10');
    expect(worn).toEqual(['rank_1500', 'draws_10']);
  });
});

describe('unlockedPercent', () => {
  const earning = (ids: readonly string[]) =>
    ids.map((id) => ({ id, earnedAt: '2026-04-10T12:00:00.000Z', opponent: '@tom' }));
  it('counts the earned flair the catalog knows, out of the whole catalog', () => {
    const earned = earning(['rank_1500', 'en_passant_win', 'draws_10', 'retired_flair']);
    // Three of the four are in the catalog, whatever its size (21% of the 14 at launch).
    expect(unlockedPercent({ worn: [], earned })).toBe(Math.round((100 * 3) / FLAIR.length));
  });
  it('is 0 with nothing earned and 100 with every flair in the catalog earned', () => {
    expect(unlockedPercent({ worn: [], earned: [] })).toBe(0);
    const everything = FLAIR.map((flair) => flair.id);
    expect(unlockedPercent({ worn: [], earned: earning(everything) })).toBe(100);
    // An id the catalog no longer has cannot take the share past 100.
    expect(unlockedPercent({ worn: [], earned: earning([...everything, 'retired_flair']) })).toBe(
      100,
    );
  });
});

describe('saveWornFlair', () => {
  it('shows the new list at once and keeps the server’s answer', async () => {
    const client = clientFor(({ body }) => ({
      status: 200,
      body: { worn: (body as { worn: string[] }).worn, earned: EARNED },
    }));
    const saving = saveWornFlair(client, ['rank_1500']);
    expect(myFlair.value?.worn).toEqual(['rank_1500']);
    expect(await saving).toBe(true);
    expect(myFlair.value).toEqual({ worn: ['rank_1500'], earned: EARNED });
  });
  it('puts the previous list back and answers false when the save fails', async () => {
    const client = clientFor(() => ({
      status: 500,
      body: { error: { code: 'internal', message: 'boom' } },
    }));
    expect(await saveWornFlair(client, ['rank_1500'])).toBe(false);
    expect(myFlair.value?.worn).toEqual([]);
  });
  it('keeps the last tap when saves answer out of order', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const client = clientFor(async ({ body }) => {
      const worn = (body as { worn: string[] }).worn;
      if (worn.length === 1) await held;
      return { status: 200, body: { worn, earned: EARNED } };
    });
    const first = saveWornFlair(client, ['rank_1500']);
    const second = saveWornFlair(client, []);
    await second;
    release();
    await first;
    expect(myFlair.value?.worn).toEqual([]);
  });
  it('keeps what the server answers even when it differs from what was asked', async () => {
    // An award can fill a free slot while the save is in flight (spec §6).
    const awarded = [
      ...EARNED,
      { id: 'draws_10', earnedAt: '2026-05-01T12:00:00.000Z', opponent: '@maya' },
    ];
    const client = clientFor(() => ({
      status: 200,
      body: { worn: ['rank_1500', 'draws_10'], earned: awarded },
    }));
    expect(await saveWornFlair(client, ['rank_1500'])).toBe(true);
    expect(myFlair.value).toEqual({ worn: ['rank_1500', 'draws_10'], earned: awarded });
  });
  it('puts back the list from just before the failed save, and keeps what was earned', async () => {
    const kept = clientFor(({ body }) => ({
      status: 200,
      body: { worn: (body as { worn: string[] }).worn, earned: EARNED },
    }));
    await saveWornFlair(kept, ['rank_1500']);
    expect(
      await saveWornFlair(
        clientFor(() => failure),
        ['rank_1500', 'draws_10'],
      ),
    ).toBe(false);
    expect(myFlair.value).toEqual({ worn: ['rank_1500'], earned: EARNED });
  });
  it('lets an older save fail quietly once a newer one has taken over', async () => {
    let fail!: () => void;
    const held = new Promise<void>((resolve) => (fail = resolve));
    const client = clientFor(async ({ body }) => {
      const worn = (body as { worn: string[] }).worn;
      if (worn[0] === 'rank_1500') {
        await held;
        return failure;
      }
      return { status: 200, body: { worn, earned: EARNED } };
    });
    const first = saveWornFlair(client, ['rank_1500']);
    const second = saveWornFlair(client, ['draws_10']);
    expect(await second).toBe(true);
    fail();
    expect(await first).toBe(true);
    expect(myFlair.value?.worn).toEqual(['draws_10']);
  });
});

describe('loadMyFlair', () => {
  it('fetches the viewer’s flair, keeps it in the signal and returns it', async () => {
    const flair = { worn: ['rank_1500'], earned: EARNED };
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: flair }));
    const client = createApiClient({ fetch });
    client.setToken('jwt');
    myFlair.value = null;
    expect(await loadMyFlair(client)).toEqual(flair);
    expect(myFlair.value).toEqual(flair);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/api/me/flair' });
  });
  it('leaves the flair it already has when the load fails', async () => {
    const before = myFlair.value;
    await expect(loadMyFlair(clientFor(() => failure))).rejects.toThrow();
    expect(myFlair.value).toBe(before);
  });
});

describe('flairEarnedLabel', () => {
  const now = new Date('2026-09-29T12:00:00.000Z');
  const at = (earnedAt: string, opponent: string) => ({ earnedAt, opponent });
  it('dates a rung by month and year', () =>
    expect(flairEarnedLabel('rank', at('2026-01-14T12:00:00.000Z', '@tom'), now)).toBe(
      'Earned Jan 2026',
    ));
  it('dates anything else by its game, month first, with the year only when it is not this one', () => {
    expect(flairEarnedLabel('feat', at('2026-08-12T12:00:00.000Z', '@tom_rook'), now)).toBe(
      'Earned vs @tom_rook · Aug 12',
    );
    expect(flairEarnedLabel('dubious', at('2026-09-03T12:00:00.000Z', '@maya'), now)).toBe(
      'Earned vs @maya · Sep 3',
    );
    expect(flairEarnedLabel('feat', at('2025-12-30T12:00:00.000Z', '@maya'), now)).toBe(
      'Earned vs @maya · Dec 30, 2025',
    );
  });
});
