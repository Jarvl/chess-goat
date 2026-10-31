import {
  PgnLinkDtoSchema,
  ChallengeDtoSchema,
  GameDtoSchema,
  LobbyDtoSchema,
  PlayerPageDtoSchema,
} from '@chess-goat/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminActions, groupMembers, jobs, shares } from '../../src/db/schema';

import { avatarUrl, photoHash, storePhoto } from '../../src/domain/photos';
import { MAX_SHARES_PER_MINUTE } from '../../src/domain/sharing';
import { startTestApi, type TestApi } from '../helpers/api';
import { openTestDb, truncateAll } from '../helpers/db';
import { insertGame, insertUser, world, played } from '../helpers/fixtures';
import { FIXTURE_JPEG } from '../helpers/photos';
import { AFTER_E4 } from '../helpers/chess';

const { db, close } = openTestDb();
let api: TestApi;

beforeAll(async () => {
  api = await startTestApi(db);
});
beforeEach(async () => {
  await truncateAll(db);
  api.fake.reset();
  api.ctx.membership.clearCaches();
  api.ctx.rateLimiter.reset();
});
afterAll(async () => {
  await api.stop();
  await close();
});

/** world(), as the API sees it, with Dave outside the group, and everyone's session. */
async function members() {
  const people = await world(db, { game: false, telegramIds: true, verified: true });
  const dave = await insertUser(db, { telegramUserId: 44, firstName: 'Dave' });
  const tokens = {
    alice: await api.sessionFor(people.alice),
    bob: await api.sessionFor(people.bob),
    carol: await api.sessionFor(people.carol),
    dave: await api.sessionFor(dave),
  };
  return { ...people, dave, tokens };
}

const move = (token: string, gameId: string, uci: string, expectedPly: number) =>
  api.request('POST', `/api/games/${gameId}/moves`, {
    token,
    body: {
      uci,
      expectedPly,
      clientMoveId: `m-${uci}-${expectedPly}-${Math.random().toString(36).slice(2)}`,
    },
  });

describe('challenges and lobby', () => {
  it('creates, accepts and lists a game through the API', async () => {
    const { group, alice, bob, tokens } = await members();
    const created = await api.request('POST', `/api/groups/${group.publicId}/challenges`, {
      token: tokens.alice,
      body: { opponentId: String(bob.id), timePerMove: 3600, colour: 'white', rated: true },
    });
    expect(created.status).toBe(200);
    const challenge = ChallengeDtoSchema.parse(await created.json());
    expect(challenge.viewer).toEqual({ canAccept: false, canDecline: false, canCancel: true });
    const accepted = await api.request('POST', `/api/challenges/${challenge.id}/accept`, {
      token: tokens.bob,
    });
    expect(accepted.status).toBe(200);
    const game = GameDtoSchema.parse(await accepted.json());
    expect(game.white.id).toBe(String(alice.id));
    const lobby = LobbyDtoSchema.parse(
      await (
        await api.request('GET', `/api/groups/${group.publicId}`, { token: tokens.alice })
      ).json(),
    );
    expect(lobby.active.map((g) => [g.id, g.yourTurn])).toEqual([[game.id, true]]);
    expect(lobby.challenges).toEqual([]);
  });

  it('refuses the lobby to a non-member and lists known players for the picker', async () => {
    const { group, tokens } = await members();
    expect(
      (await api.request('GET', `/api/groups/${group.publicId}`, { token: tokens.dave })).status,
    ).toBe(403);
    const players = await (
      await api.request('GET', `/api/groups/${group.publicId}/players`, { token: tokens.alice })
    ).json();
    expect((players as { players: { name: string }[] }).players.map((p) => p.name).sort()).toEqual([
      'Bob',
      'Carol',
    ]);
    expect((players as { settings: unknown }).settings).toEqual({
      defaultTimePerMove: 259200,
      ratedDefault: true,
      allowOpenChallenges: true,
    });
  });

  it('pages finished games and serves a player page', async () => {
    const { group, alice, bob, tokens } = await members();
    for (let i = 0; i < 25; i += 1) {
      await insertGame(db, group.id, alice.id, bob.id, {
        status: 'finished',
        result: '1-0',
        endReason: 'resignation',
        finishedAt: new Date(Date.UTC(2026, 0, 1 + i)),
      });
    }
    const first = (await (
      await api.request('GET', `/api/groups/${group.publicId}/finished`, { token: tokens.alice })
    ).json()) as { items: unknown[]; nextCursor: string | null };
    expect(first.items).toHaveLength(20);
    expect(first.nextCursor).not.toBeNull();
    const second = (await (
      await api.request(
        'GET',
        `/api/groups/${group.publicId}/finished?cursor=${first.nextCursor}`,
        { token: tokens.alice },
      )
    ).json()) as { items: unknown[]; nextCursor: string | null };
    expect(second.items).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
    const page = PlayerPageDtoSchema.parse(
      await (
        await api.request('GET', `/api/groups/${group.publicId}/players/${bob.id}`, {
          token: tokens.alice,
        })
      ).json(),
    );
    expect(page.headToHead).toEqual({ wins: 25, draws: 0, losses: 0 });
    expect(page.recentGames).toHaveLength(10);
  });

  it('sends the thumbnail fields on the lobby and the player page too', async () => {
    const { group, alice, bob, tokens } = await members();
    const running = await insertGame(db, group.id, alice.id, bob.id);
    await played(db, running, ['e2e4']);
    const done = await insertGame(db, group.id, bob.id, alice.id, {
      status: 'finished',
      result: '1-0',
      endReason: 'resignation',
      finishedAt: new Date(),
    });
    const lobby = LobbyDtoSchema.parse(
      await (
        await api.request('GET', `/api/groups/${group.publicId}`, { token: tokens.alice })
      ).json(),
    );
    expect(lobby.active[0]).toMatchObject({
      id: running.publicId,
      fen: AFTER_E4,
      lastMove: 'e2e4',
      engineLevel: null,
      white: { isBot: false },
    });
    expect(lobby.finished.items[0]).toMatchObject({ id: done.publicId, lastMove: null });
    const page = PlayerPageDtoSchema.parse(
      await (
        await api.request('GET', `/api/groups/${group.publicId}/players/${bob.id}`, {
          token: tokens.alice,
        })
      ).json(),
    );
    expect(page.player.isBot).toBe(false);
    expect(page.recentGames.map((game) => game.lastMove)).toContain('e2e4');
  });
});

describe('games', () => {
  it("carries each player's photo url", async () => {
    const { group, alice, bob, tokens } = await members();
    await storePhoto(db, alice.id, { fileUniqueId: 'u-1', bytes: FIXTURE_JPEG });
    const game = await insertGame(db, group.id, alice.id, bob.id);
    const response = await api.request('GET', `/api/games/${game.publicId}`, {
      token: tokens.bob,
    });
    const dto = GameDtoSchema.parse(await response.json());
    expect(dto.white.photoUrl).toBe(avatarUrl(photoHash(FIXTURE_JPEG)));
    expect(dto.black.photoUrl).toBeNull();
  });

  it('plays moves and maps domain errors to statuses', async () => {
    const { group, alice, bob, tokens } = await members();
    const game = await insertGame(db, group.id, alice.id, bob.id);
    const ok = await move(tokens.alice, game.publicId, 'e2e4', 0);
    expect(ok.status).toBe(200);
    expect(GameDtoSchema.parse(await ok.json()).plyCount).toBe(1);
    const stale = await move(tokens.bob, game.publicId, 'e7e5', 0);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: 'stale_state' } });
    expect((await move(tokens.bob, game.publicId, 'e7e9', 1)).status).toBe(400);
    expect((await move(tokens.bob, game.publicId, 'e7e6', 1)).status).toBe(200);
    expect((await move(tokens.carol, game.publicId, 'd2d4', 2)).status).toBe(403);
    expect((await move(tokens.alice, game.publicId, 'e4e6', 2)).status).toBe(422);
  });

  it('offers and declines draws, resigns and aborts', async () => {
    const { group, alice, bob, tokens } = await members();
    const game = await insertGame(db, group.id, alice.id, bob.id);
    expect(
      (await api.request('POST', `/api/games/${game.publicId}/draw/offer`, { token: tokens.alice }))
        .status,
    ).toBe(200);
    expect(
      (await api.request('POST', `/api/games/${game.publicId}/draw/decline`, { token: tokens.bob }))
        .status,
    ).toBe(200);
    expect(
      (await api.request('POST', `/api/games/${game.publicId}/abort`, { token: tokens.bob }))
        .status,
    ).toBe(200);
    const second = await insertGame(db, group.id, alice.id, bob.id, {
      fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2',
      plyCount: 2,
    });
    const resigned = GameDtoSchema.parse(
      await (
        await api.request('POST', `/api/games/${second.publicId}/resign`, { token: tokens.alice })
      ).json(),
    );
    expect(resigned).toMatchObject({ status: 'finished', result: '0-1', endReason: 'resignation' });
    expect(resigned.analysisUrl).toBeUndefined();
  });

  it('accepts a draw offer, and refuses an accept with no offer to answer', async () => {
    const { group, alice, bob, tokens } = await members();
    const game = await insertGame(db, group.id, alice.id, bob.id);
    const accept = () =>
      api.request('POST', `/api/games/${game.publicId}/draw/accept`, { token: tokens.bob });
    const early = await accept();
    expect(early.status).toBe(403);
    expect(await early.json()).toMatchObject({ error: { code: 'forbidden' } });
    expect(
      (await api.request('POST', `/api/games/${game.publicId}/draw/offer`, { token: tokens.alice }))
        .status,
    ).toBe(200);
    const accepted = GameDtoSchema.parse(await (await accept()).json());
    expect(accepted).toMatchObject({
      status: 'finished',
      result: '1/2-1/2',
      endReason: 'draw_agreement',
    });
  });

  it('shares up to twenty positions a minute and serves the PGN', async () => {
    const { group, alice, bob, tokens } = await members();
    const game = await insertGame(db, group.id, alice.id, bob.id);
    await played(db, game, ['e2e4']);
    for (let i = 0; i < MAX_SHARES_PER_MINUTE; i++)
      expect(
        (
          await api.request('POST', `/api/games/${game.publicId}/share`, {
            token: tokens.carol,
            body: { ply: i % 2 },
          })
        ).status,
      ).toBe(200);
    expect(
      (
        await api.request('POST', `/api/games/${game.publicId}/share`, {
          token: tokens.carol,
          body: { ply: 0 },
        })
      ).status,
    ).toBe(429);
    expect(
      (
        await api.request('POST', `/api/games/${game.publicId}/share`, {
          token: tokens.alice,
          body: { ply: 5 },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api.request('POST', `/api/games/${game.publicId}/share`, {
          token: tokens.dave,
          body: { ply: 1 },
        })
      ).status,
    ).toBe(403);
    expect(await db.select().from(shares)).toHaveLength(MAX_SHARES_PER_MINUTE);
    expect((await db.select().from(jobs)).map((job) => job.kind)).toEqual(
      Array(MAX_SHARES_PER_MINUTE).fill('send_share_photo'),
    );
    const pgn = await api.request('GET', `/api/games/${game.publicId}/pgn`, {
      token: tokens.carol,
    });
    expect(pgn.headers.get('content-type')).toContain('application/x-chess-pgn');
    const text = await pgn.text();
    expect(text).toContain('[Event "Chess Goat"]');
    expect(text).toContain(`[Site "${group.title}"]`);
    expect(text).toContain('1. e4 *');
    expect(
      (await api.request('GET', `/api/games/${game.publicId}/pgn`, { token: tokens.dave })).status,
    ).toBe(403);
  });

  it('creates a rematch through the API', async () => {
    const { group, alice, bob, tokens } = await members();
    const game = await insertGame(db, group.id, alice.id, bob.id, {
      status: 'finished',
      result: '1-0',
      endReason: 'checkmate',
      finishedAt: new Date(),
    });
    const res = await api.request('POST', `/api/games/${game.publicId}/rematch`, {
      token: tokens.bob,
    });
    expect(res.status).toBe(200);
    expect(ChallengeDtoSchema.parse(await res.json())).toMatchObject({
      challengerColour: 'white',
      challenger: { id: String(bob.id) },
    });
  });

  it('serves the PGN through a short-lived link whose token opens nothing else', async () => {
    const { group, alice, bob, tokens } = await members();
    const game = await insertGame(db, group.id, alice.id, bob.id, {
      status: 'finished',
      result: '1-0',
      endReason: 'resignation',
      finishedAt: new Date(),
    });
    const other = await insertGame(db, group.id, bob.id, alice.id, { status: 'finished' });
    const link = await api.request('POST', `/api/games/${game.publicId}/pgn-link`, {
      token: tokens.carol,
    });
    expect(link.status).toBe(200);
    const { url } = PgnLinkDtoSchema.parse(await link.json());
    expect(url).toMatch(new RegExp(`^/api/games/${game.publicId}/pgn\\?token=`));
    const scoped = new URL(url, 'http://x').searchParams.get('token')!;
    expect(scoped).not.toBe(tokens.carol);
    const res = await api.request('GET', url);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('[Result "1-0"]');
    // The link's token is good for this one download only.
    expect(
      (await api.request('GET', `/api/games/${other.publicId}/pgn?token=${scoped}`)).status,
    ).toBe(401);
    expect(
      (await api.request('GET', `/api/games/${game.publicId}`, { token: scoped })).status,
    ).toBe(401);
    expect((await api.request('GET', `/api/me/groups`, { token: scoped })).status).toBe(401);
    // The session token itself never travels in a query string for a download.
    expect(
      (await api.request('GET', `/api/games/${game.publicId}/pgn?token=${tokens.carol}`)).status,
    ).toBe(401);
    expect((await api.request('GET', `/api/games/${game.publicId}/pgn`)).status).toBe(401);
    expect(
      (await api.request('POST', `/api/games/${game.publicId}/pgn-link`, { token: tokens.dave }))
        .status,
    ).toBe(403);
  });
});

describe('GET /api/games/:id/events', () => {
  const readChunk = async (res: Response) => {
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    reader.releaseLock();
    return new TextDecoder().decode(value);
  };

  it('sends the state on connect and again after a move', async () => {
    const { group, alice, bob, carol, tokens } = await members();
    const game = await insertGame(db, group.id, alice.id, bob.id);
    const controller = new AbortController();
    const res = await api.request(
      'GET',
      `/api/games/${game.publicId}/events?token=${tokens.carol}`,
      { signal: controller.signal },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const first = decoder.decode((await reader.read()).value);
    expect(first).toContain('event: state');
    expect(first).toContain('id: 0');
    await move(tokens.alice, game.publicId, 'e2e4', 0);
    let received = '';
    while (!received.includes('id: 1')) received += decoder.decode((await reader.read()).value);
    expect(received).toContain('"plyCount":1');
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.ctx.streams.count(carol.id)).toBe(0);
  });

  it('refuses the stream to a non-member and caps open streams at four per user', async () => {
    const { group, alice, bob, carol, tokens } = await members();
    const game = await insertGame(db, group.id, alice.id, bob.id);
    expect(
      (await api.request('GET', `/api/games/${game.publicId}/events?token=${tokens.dave}`)).status,
    ).toBe(403);
    const controllers = Array.from({ length: 4 }, () => new AbortController());
    for (const controller of controllers) {
      const res = await api.request(
        'GET',
        `/api/games/${game.publicId}/events?token=${tokens.carol}`,
        { signal: controller.signal },
      );
      expect(res.status).toBe(200);
      await readChunk(res);
    }
    const fifth = await api.request(
      'GET',
      `/api/games/${game.publicId}/events?token=${tokens.carol}`,
    );
    expect(fifth.status).toBe(429);
    for (const controller of controllers) controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.ctx.streams.count(carol.id)).toBe(0);
  });

  it('delivers an owner-only publish to that user’s streams and no one else’s', async () => {
    const { group, alice, bob, tokens } = await members();
    const game = await insertGame(db, group.id, alice.id, bob.id);
    const open = async (token: string) => {
      const controller = new AbortController();
      const res = await api.request('GET', `/api/games/${game.publicId}/events?token=${token}`, {
        signal: controller.signal,
      });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      const events: string[] = [];
      let buffer = '';
      void (async () => {
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) return;
            buffer += decoder.decode(value);
            let cut = buffer.indexOf('\n\n');
            while (cut >= 0) {
              events.push(buffer.slice(0, cut));
              buffer = buffer.slice(cut + 2);
              cut = buffer.indexOf('\n\n');
            }
          }
        } catch {
          // aborted
        }
      })();
      return { events, close: () => controller.abort() };
    };
    const bobPhone = await open(tokens.bob);
    const bobLaptop = await open(tokens.bob);
    const aliceStream = await open(tokens.alice);
    const carolStream = await open(tokens.carol);
    await new Promise((resolve) => setTimeout(resolve, 50));
    api.deps.bus.publish(game.publicId, { userId: bob.id });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const states = (s: { events: string[] }) => s.events.filter((e) => e.includes('event: state'));
    expect(states(bobPhone)).toHaveLength(2);
    expect(states(bobLaptop)).toHaveLength(2);
    expect(states(aliceStream)).toHaveLength(1);
    expect(states(carolStream)).toHaveLength(1);
    for (const stream of [bobPhone, bobLaptop, aliceStream, carolStream]) stream.close();
  });
});

describe('admin routes', () => {
  it('guards settings, blocks and voids behind the admin check and audits them', async () => {
    const { group, alice, bob, tokens } = await members();
    expect(
      (await api.request('GET', `/api/groups/${group.publicId}/settings`, { token: tokens.carol }))
        .status,
    ).toBe(403);
    api.fake.admins = [33];
    api.ctx.membership.invalidateAdmins(group.id);
    expect(
      (await api.request('GET', `/api/groups/${group.publicId}/settings`, { token: tokens.carol }))
        .status,
    ).toBe(200);
    const updated = await api.request('PUT', `/api/groups/${group.publicId}/settings`, {
      token: tokens.carol,
      body: { ratedDefault: false },
    });
    expect(
      ((await updated.json()) as { settings: { ratedDefault: boolean } }).settings.ratedDefault,
    ).toBe(false);
    expect(
      (
        await api.request('PUT', `/api/groups/${group.publicId}/settings`, {
          token: tokens.carol,
          body: { cardTopicMode: 'fixed' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api.request('POST', `/api/groups/${group.publicId}/blocks`, {
          token: tokens.carol,
          body: { userId: String(bob.id) },
        })
      ).status,
    ).toBe(200);
    expect(
      (await db.select().from(groupMembers).where(eq(groupMembers.userId, bob.id)))[0]?.blockedAt,
    ).not.toBeNull();
    expect(
      (
        await api.request('DELETE', `/api/groups/${group.publicId}/blocks/${bob.id}`, {
          token: tokens.carol,
        })
      ).status,
    ).toBe(200);
    const game = await insertGame(db, group.id, alice.id, bob.id);
    const voided = GameDtoSchema.parse(
      await (
        await api.request('POST', `/api/games/${game.publicId}/void`, { token: tokens.carol })
      ).json(),
    );
    expect(voided).toMatchObject({ voided: true, endReason: 'voided' });
    expect(
      (await db.select().from(adminActions).orderBy(adminActions.id)).map((row) => row.action),
    ).toEqual(['settings', 'block', 'unblock', 'void']);
    expect(
      (await api.request('POST', `/api/games/${game.publicId}/void`, { token: tokens.alice }))
        .status,
    ).toBe(403);
  });
});

describe('unknown ids', () => {
  it('answers 404 for a well-formed unknown id and for a malformed one', async () => {
    const { tokens } = await members();
    expect(
      (await api.request('GET', '/api/games/zzzzzzzzzz', { token: tokens.alice })).status,
    ).toBe(404);
    expect((await api.request('GET', '/api/games/not-an-id', { token: tokens.alice })).status).toBe(
      404,
    );
  });

  it('answers 404, not 500, for a malformed user id in a path', async () => {
    const { group, tokens } = await members();
    api.fake.admins = [33];
    const player = await api.request('GET', `/api/groups/${group.publicId}/players/abc`, {
      token: tokens.alice,
    });
    expect(player.status).toBe(404);
    const unblock = await api.request('DELETE', `/api/groups/${group.publicId}/blocks/abc`, {
      token: tokens.carol,
    });
    expect(unblock.status).toBe(404);
    expect(await unblock.json()).toMatchObject({ error: { code: 'not_found' } });
  });
});
