import { LaunchResponseSchema, LobbyDtoSchema, MeGamesDtoSchema } from '@chess-goat/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { challenges, games, groupMembers, users } from '../../src/db/schema';
import { touchMember } from '../../src/domain/members';
import { startTestApi, type TestApi } from '../helpers/api';
import { openTestDb, truncateAll } from '../helpers/db';
import {
  insertChallenge,
  insertGame,
  insertGroup,
  insertMove,
  insertUser,
} from '../helpers/fixtures';
import { signInitData } from '../helpers/initData';
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

const alice = { id: 11, first_name: 'Alice', username: 'alice' };
const launch = (fields: Parameters<typeof signInitData>[1]) =>
  api.request('POST', '/api/launch', {
    body: { initData: signInitData(api.config.BOT_TOKEN, fields) },
  });

describe('GET /api/me/games', () => {
  it('spans the groups the viewer can see, their own turn first, and leaves out the rest', async () => {
    const [viewer, opponent] = [await insertUser(db), await insertUser(db)];
    const club = await insertGroup(db, { title: 'Club' });
    const pub = await insertGroup(db, { title: 'Pub' });
    const stranger = await insertGroup(db, { title: 'Stranger' });
    const departed = await insertGroup(db, { title: 'Departed', botStatus: 'left' });
    for (const group of [club, pub, departed]) await touchMember(db, group.id, viewer.id);
    await touchMember(db, stranger.id, opponent.id);

    // Black to move, so this one is the viewer's turn and must sort first.
    const yours = await insertGame(db, pub.id, opponent.id, viewer.id, {
      fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
    });
    // White, with black to move: a game the viewer is in but is not waiting on.
    const theirs = await insertGame(db, club.id, viewer.id, opponent.id, {
      fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
    });
    // None of these belong on the home screen.
    await insertGame(db, club.id, viewer.id, opponent.id, {
      status: 'finished',
      result: '1-0',
      endReason: 'resignation',
      finishedAt: new Date(),
    });
    await insertGame(db, stranger.id, opponent.id, opponent.id);
    await insertGame(db, departed.id, viewer.id, opponent.id);

    const token = await api.sessionFor(viewer);
    const res = await api.request('GET', '/api/me/games', { token });
    expect(res.status).toBe(200);
    const body = MeGamesDtoSchema.parse(await res.json());
    expect(body.items.map((game) => game.id)).toEqual([yours.publicId, theirs.publicId]);
    expect(body.items[0]).toMatchObject({
      yourTurn: true,
      group: { id: pub.publicId, title: 'Pub' },
    });
    expect(body.items[1]).toMatchObject({
      yourTurn: false,
      group: { id: club.publicId, title: 'Club' },
    });
  });

  it('is empty for a user who is in no group', async () => {
    const token = await api.sessionFor(await insertUser(db));
    const res = await api.request('GET', '/api/me/games', { token });
    expect(MeGamesDtoSchema.parse(await res.json()).items).toEqual([]);
  });

  it('carries each game’s position, last move and bot flag for the list thumbnails', async () => {
    const viewer = await insertUser(db);
    const [engine] = await db.select().from(users).where(eq(users.isEngine, true));
    const club = await insertGroup(db, { title: 'Club' });
    await touchMember(db, club.id, viewer.id);
    const opened = await insertGame(db, club.id, viewer.id, engine!.id, {
      fen: AFTER_E4,
      plyCount: 1,
      engineLevel: 'club',
      timePerMove: null,
    });
    await insertMove(db, opened.id, 1, 'e2e4', 'e4', AFTER_E4);
    const fresh = await insertGame(db, club.id, engine!.id, viewer.id, {
      engineLevel: 'casual',
      timePerMove: null,
    });

    const token = await api.sessionFor(viewer);
    const res = await api.request('GET', '/api/me/games', { token });
    const body = MeGamesDtoSchema.parse(await res.json());
    const byId = new Map(body.items.map((game) => [game.id, game]));
    expect(byId.get(opened.publicId)).toMatchObject({
      fen: AFTER_E4,
      lastMove: 'e2e4',
      engineLevel: 'club',
      white: { isBot: false },
      black: { isBot: true },
    });
    expect(byId.get(fresh.publicId)).toMatchObject({
      lastMove: null,
      engineLevel: 'casual',
      white: { isBot: true },
      black: { isBot: false },
    });
  });
});

describe('POST /api/launch', () => {
  it('creates the user, issues a session and lands on the games home', async () => {
    const res = await launch({ user: alice });
    expect(res.status).toBe(200);
    const body = LaunchResponseSchema.parse(await res.json());
    expect(body.route.kind).toBe('home');
    expect(body.user).toEqual({ id: expect.any(String), name: '@alice', username: 'alice' });
    expect(body.askWriteAccess).toBe(true);
    expect(body.bot).toEqual({ username: 'TestChessBot', miniAppShortName: 'chess' });
    const me = await api.request('GET', '/api/me/groups', { token: body.token });
    expect(me.status).toBe(200);
  });

  it('counts the games waiting on the user for the Games badge, on any launch', async () => {
    const opponent = await insertUser(db);
    const club = await insertGroup(db, { title: 'Club' });
    const pub = await insertGroup(db, { title: 'Pub' });
    const stranger = await insertGroup(db, { title: 'Stranger' });
    const body = LaunchResponseSchema.parse(await (await launch({ user: alice })).json());
    const [viewer] = await db.select().from(users).where(eq(users.telegramUserId, alice.id));
    for (const group of [club, pub]) await touchMember(db, group.id, viewer!.id);
    await touchMember(db, stranger.id, opponent.id);

    const blackToMove = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
    // Two waiting on the viewer: one in each group they belong to.
    await insertGame(db, club.id, opponent.id, viewer!.id, { fen: blackToMove });
    const theirs = await insertGame(db, pub.id, opponent.id, viewer!.id, { fen: blackToMove });
    // None of these count: the opponent's turn, a finished game, and a group they are not in.
    await insertGame(db, club.id, viewer!.id, opponent.id, { fen: blackToMove });
    await insertGame(db, pub.id, opponent.id, viewer!.id, {
      fen: blackToMove,
      status: 'finished',
      result: '0-1',
      endReason: 'resignation',
      finishedAt: new Date(),
    });
    await insertGame(db, stranger.id, opponent.id, opponent.id, { fen: blackToMove });

    // A profile launch derives it from the games it already carries...
    const home = LaunchResponseSchema.parse(await (await launch({ user: alice })).json());
    expect(home.route.kind).toBe('home');
    expect(home.yourMove).toBe(2);

    // ...and a deep link into one game counts across every group instead.
    const deep = LaunchResponseSchema.parse(
      await (await launch({ user: alice, startParam: `g_${theirs.publicId}` })).json(),
    );
    expect(deep.route.kind).toBe('game');
    expect(deep.yourMove).toBe(2);
    expect(body.yourMove).toBe(0);
  });

  it('marks DMs allowed when init data says the user allows messages', async () => {
    await launch({ user: { ...alice, allows_write_to_pm: true } });
    const [user] = await db.select().from(users).where(eq(users.telegramUserId, alice.id));
    expect(user?.dmAllowed).toBe(true);
  });

  it('rejects tampered or stale init data with 401 and the error body', async () => {
    const good = signInitData(api.config.BOT_TOKEN, { user: alice });
    const res = await api.request('POST', '/api/launch', {
      body: { initData: good.replace('Alice', 'Alicf') },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: 'unauthorized', message: expect.any(String) },
    });
    const stale = signInitData(api.config.BOT_TOKEN, {
      user: alice,
      authDate: Math.floor(Date.now() / 1000) - 90_000,
    });
    expect((await api.request('POST', '/api/launch', { body: { initData: stale } })).status).toBe(
      401,
    );
  });

  it('opens a game link for a player, locks it for a stranger and shows it to a member', async () => {
    const group = await insertGroup(db);
    const white = await insertUser(db, { telegramUserId: 11 });
    const black = await insertUser(db, { telegramUserId: 22 });
    const game = await insertGame(db, group.id, white.id, black.id);
    const asPlayer = LaunchResponseSchema.parse(
      await (await launch({ user: alice, startParam: `g_${game.publicId}` })).json(),
    );
    expect(asPlayer.route).toMatchObject({
      kind: 'game',
      game: { id: game.publicId, viewerRole: 'white' },
    });
    const stranger = { id: 33, first_name: 'Sam' };
    const locked = LaunchResponseSchema.parse(
      await (await launch({ user: stranger, startParam: `g_${game.publicId}` })).json(),
    );
    expect(locked.route).toEqual({
      kind: 'locked',
      group: { id: group.publicId, title: group.title },
    });
    api.fake.members.set(33, 'member');
    // The denial is cached for a minute; pretend that minute has passed.
    await db.update(groupMembers).set({ verifiedAt: sql`now() - interval '2 minutes'` });
    const asMember = LaunchResponseSchema.parse(
      await (await launch({ user: stranger, startParam: `g_${game.publicId}` })).json(),
    );
    expect(asMember.route).toMatchObject({ kind: 'game', game: { viewerRole: 'spectator' } });
  });

  it('takes the start param from the body for a DM web_app launch, the signed one first', async () => {
    const group = await insertGroup(db);
    const white = await insertUser(db, { telegramUserId: 11 });
    const black = await insertUser(db, { telegramUserId: 22 });
    const game = await insertGame(db, group.id, white.id, black.id);
    const launchWith = (fields: Parameters<typeof signInitData>[1], startParam: string) =>
      api.request('POST', '/api/launch', {
        body: { initData: signInitData(api.config.BOT_TOKEN, fields), startParam },
      });
    const fromDm = LaunchResponseSchema.parse(
      await (await launchWith({ user: alice }, `g_${game.publicId}`)).json(),
    );
    expect(fromDm.route).toMatchObject({ kind: 'game', game: { id: game.publicId } });
    api.fake.members.set(11, 'member');
    const signed = LaunchResponseSchema.parse(
      await (
        await launchWith({ user: alice, startParam: `l_${group.publicId}` }, `g_${game.publicId}`)
      ).json(),
    );
    expect(signed.route.kind).toBe('lobby');
  });

  it('opens the lobby for a member and the settings for an admin', async () => {
    const group = await insertGroup(db);
    api.fake.members.set(11, 'member');
    const lobby = LaunchResponseSchema.parse(
      await (await launch({ user: alice, startParam: `l_${group.publicId}` })).json(),
    );
    expect(lobby.route.kind).toBe('lobby');
    if (lobby.route.kind === 'lobby')
      expect(LobbyDtoSchema.parse(lobby.route.lobby).isAdmin).toBe(false);
    const newGame = LaunchResponseSchema.parse(
      await (await launch({ user: alice, startParam: `n_${group.publicId}` })).json(),
    );
    expect(newGame.route).toMatchObject({
      kind: 'newGame',
      lobby: { group: { id: group.publicId } },
    });
    const notAdmin = LaunchResponseSchema.parse(
      await (await launch({ user: alice, startParam: `s_${group.publicId}` })).json(),
    );
    expect(notAdmin.route.kind).toBe('lobby');
    api.fake.admins = [11];
    api.ctx.membership.invalidateAdmins(group.id);
    const admin = LaunchResponseSchema.parse(
      await (await launch({ user: alice, startParam: `s_${group.publicId}` })).json(),
    );
    expect(admin.route).toMatchObject({
      kind: 'settings',
      settings: { group: { id: group.publicId }, botIsAdmin: false },
    });
  });
});

describe('sessions and limits', () => {
  it('refuses requests without a valid session', async () => {
    expect((await api.request('GET', '/api/me/groups')).status).toBe(401);
    expect((await api.request('GET', '/api/me/groups', { token: 'garbage' })).status).toBe(401);
  });

  it('limits a user to 120 requests per minute', async () => {
    const user = await insertUser(db);
    const token = await api.sessionFor(user);
    let last = 0;
    for (let i = 0; i < 121; i += 1)
      last = (await api.request('GET', '/api/me/groups', { token })).status;
    expect(last).toBe(429);
  });

  it('rejects a body over 64 KB', async () => {
    const res = await api.request('POST', '/api/launch', {
      body: { initData: 'x'.repeat(70_000) },
    });
    expect(res.status).toBe(413);
  });
});

describe('me routes', () => {
  it('merges preferences and records the write-access answer', async () => {
    const user = await insertUser(db);
    const token = await api.sessionFor(user);
    const res = await api.request('PUT', '/api/me/prefs', {
      token,
      body: { prefs: { boardTheme: 'wood' }, writeAccess: { allowed: true } },
    });
    expect(await res.json()).toMatchObject({
      prefs: { boardTheme: 'wood', notifications: true },
      dmAllowed: true,
    });
    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row?.writeAccessAskedAt).not.toBeNull();
  });

  it('deletes my data: resigns games, cancels challenges, anonymises, and ends the session', async () => {
    const group = await insertGroup(db);
    const me = await insertUser(db, { telegramUserId: 11, firstName: 'Alice', username: 'alice' });
    const other = await insertUser(db, { telegramUserId: 22 });
    await touchMember(db, group.id, me.id);
    const game = await insertGame(db, group.id, me.id, other.id, {
      fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2',
      plyCount: 2,
    });
    await insertChallenge(db, group.id, me.id, other.id);
    const token = await api.sessionFor(me);
    expect((await api.request('DELETE', '/api/me', { token })).status).toBe(200);
    expect((await db.select().from(games).where(eq(games.id, game.id)))[0]).toMatchObject({
      status: 'finished',
      result: '0-1',
      endReason: 'resignation',
    });
    expect((await db.select().from(challenges))[0]?.status).toBe('cancelled');
    const [row] = await db.select().from(users).where(eq(users.id, me.id));
    expect(row).toMatchObject({
      telegramUserId: null,
      username: null,
      firstName: 'Deleted player',
      dmAllowed: false,
    });
    expect(row?.deletedAt).not.toBeNull();
    expect((await api.request('GET', '/api/me/groups', { token })).status).toBe(401);
  });

  it('accepts telemetry and counts it', async () => {
    const user = await insertUser(db);
    const token = await api.sessionFor(user);
    const res = await api.request('POST', '/api/telemetry', {
      token,
      body: { events: [{ kind: 'launch_failed', code: 'script' }] },
    });
    expect(res.status).toBe(200);
    expect(await api.ctx.metrics.render()).toContain('miniapp_load_errors_total 1');
  });

  it('saves a move confirmations choice and refuses an unknown one', async () => {
    const user = await insertUser(db);
    const token = await api.sessionFor(user);
    const saved = await api.request('PUT', '/api/me/prefs', {
      token,
      body: { prefs: { moveConfirmations: 'never' } },
    });
    expect(await saved.json()).toMatchObject({ prefs: { moveConfirmations: 'never' } });
    const refused = await api.request('PUT', '/api/me/prefs', {
      token,
      body: { prefs: { moveConfirmations: 'sometimes' } },
    });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: { code: 'validation' } });
  });
});
