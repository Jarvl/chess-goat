import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runners, turnLeases, type UserRow } from '../../src/db/schema';
import { createLinkCode } from '../../src/domain/runners';
import { loadTurnView, renderTurnPrompt } from '../../src/domain/turnPrompt';
import { issueTurnToken } from '../../src/domain/turnTokens';
import { touchMember } from '../../src/domain/members';
import type { TestApi } from '../helpers/api';
import { openTestDb, truncateAll } from '../helpers/db';
import { insertBot, insertGroup, insertGame, insertUser } from '../helpers/fixtures';
import { callTool } from '../helpers/mcp';
import { playMoveDto } from '../helpers/moves';
import { claim, linkRunner, startTestRunner } from '../helpers/runner';

const { db, close } = openTestDb();
let api: TestApi;
let owner: UserRow;
/** The endpoint's clock; tests move it. */
let clock: Date;

beforeEach(async () => {
  if (api) await api.stop();
  await truncateAll(db);
  clock = new Date();
  api = await startTestRunner(db, {}, { now: () => clock });
  owner = await insertUser(db, { username: 'alice' });
});
afterAll(async () => {
  await api?.stop();
  await close();
});

type Json = {
  error: { code: string; message: string; reason?: string };
  credential: string;
  preset: string | null;
  server: string;
};
const json = async (res: Response) => (await res.json()) as Json;

const post = (path: string, body: unknown, token?: string, headers?: Record<string, string>) =>
  api.request('POST', path, { body, token, headers });

/** A game where `bot` (black, Rook) waits for human white's first move, or is to move if `botTurn`. */
async function game(botTurn = true) {
  const group = await insertGroup(db);
  await touchMember(db, group.id, owner.id);
  const bot = await insertBot(db, owner, {
    firstName: 'Rook',
    persona: 'Plays the Queen’s Gambit.',
  });
  const human = await insertUser(db, { username: 'bob' });
  await touchMember(db, group.id, human.id);
  const row = botTurn
    ? await insertGame(db, group.id, bot.id, human.id)
    : await insertGame(db, group.id, human.id, bot.id);
  return { bot, human, game: row };
}

describe('POST /runner/link', () => {
  it('trades a code for a credential, once', async () => {
    const { code } = await createLinkCode(
      db,
      owner.id,
      { label: 'Laptop', preset: 'claude' },
      new Date(),
    );
    const res = await post('/runner/link', { code, harness: 'claude-code' });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toMatchObject({
      preset: 'claude',
      server: expect.stringMatching(/^https?:\/\/[^/]+$/),
    });
    expect(body.credential).toMatch(/^cgrun_/);
    expect((await post('/runner/link', { code })).status).toBe(404);
  });

  it('the 11th link attempt in a minute from one address is 429', async () => {
    for (let i = 0; i < 10; i += 1)
      expect((await post('/runner/link', { code: 'AAAA-AAAA' })).status).toBe(404);
    const res = await post('/runner/link', { code: 'AAAA-AAAA' });
    expect(res.status).toBe(429);
    expect((await json(res)).error.code).toBe('rate_limited');
  });

  it('a wrong code and an expired code get the same 404 body', async () => {
    const wrong = await post('/runner/link', { code: 'AAAA-AAAA' });
    const { code } = await createLinkCode(db, owner.id, {}, new Date(Date.now() - 3_600_000));
    const expired = await post('/runner/link', { code });
    expect(wrong.status).toBe(404);
    expect(expired.status).toBe(404);
    const wrongBody = await json(wrong);
    expect(await json(expired)).toEqual(wrongBody);
    expect(wrongBody.error.reason).toBe('link_code_invalid');
  });

  it('ignores a bearer and rejects an invalid body with 400', async () => {
    const res = await post('/runner/link', { code: 5 }, 'cgrun_whatever');
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe('validation');
  });
});

describe('authentication', () => {
  it('refuses an owner token, a turn token, a session JWT and nothing at /runner/claim', async () => {
    const { bot } = await game();
    const turnToken = issueTurnToken(api.config.SESSION_SECRET, {
      leaseId: 1,
      botId: bot.id,
      seq: 1,
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    const jwt = await api.sessionFor(owner);
    for (const token of ['cgbot_' + 'a'.repeat(43), turnToken, jwt, undefined]) {
      for (const path of ['/runner/claim', '/runner/release']) {
        const res = await post(path, { turn_id: 1, claim_seq: 1, reason: 'exited' }, token);
        expect(res.status).toBe(401);
        expect(res.headers.get('www-authenticate')).toBe('Bearer');
        expect((await json(res)).error.message).toBe('a valid token is required');
      }
    }
  });
});

describe('POST /runner/claim', () => {
  it('links, claims a move turn, and the returned token plays the move over /mcp', async () => {
    const { bot, game: g } = await game();
    const { credential } = await linkRunner(api, owner);
    const { status, body } = await claim(api, credential);
    expect(status).toBe(200);
    const turn = body.turn!;
    expect(turn).toMatchObject({
      kind: 'move',
      claim_seq: 1,
      bot: { id: bot.id, name: 'Rook' },
      persona: 'Plays the Queen’s Gambit.',
      mcp_url: `${api.config.PUBLIC_URL.replace(/\/+$/, '')}/mcp`,
    });
    const [lease] = await db.select().from(turnLeases).where(eq(turnLeases.id, turn.id));
    expect(Date.parse(turn.expires_at)).toBe(lease!.leasedUntil!.getTime() - 10_000);
    const view = await loadTurnView(db, lease!, bot);
    expect(turn.prompt).toBe(renderTurnPrompt(view));

    const out = await callTool(api.app, turn.token, 'make_move', { move: 'e4' });
    expect(out.isError).toBeFalsy();
    expect(out.structuredContent).toMatchObject({ ply: 1, yourTurn: false });
    expect(g.id).toBeTruthy();
    expect((await claim(api, credential)).body).toEqual({ turn: null });
  });

  it('waits, then returns the turn when the opponent moves', async () => {
    const { bot, human, game: g } = await game(false);
    const { credential } = await linkRunner(api, owner);
    const pending = claim(api, credential, { wait_seconds: 5 });
    await new Promise((r) => setTimeout(r, 300));
    await playMoveDto(api.deps, {
      gameId: g.publicId,
      userId: human.id,
      uci: 'e2e4',
      expectedPly: 0,
    });
    const { body } = await pending;
    expect(body.turn).toMatchObject({ kind: 'move', bot: { id: bot.id } });
  });

  it('returns { turn: null } after wait_seconds with nothing to do', async () => {
    await game(false);
    const { credential } = await linkRunner(api, owner);
    const started = Date.now();
    const { status, body } = await claim(api, credential, { wait_seconds: 1 });
    expect(status).toBe(200);
    expect(body).toEqual({ turn: null });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it('touches lastSeenAt at the start and at the end of a poll', async () => {
    await game(false);
    const { credential, runnerId } = await linkRunner(api, owner);
    const start = new Date(clock.getTime() + 3_600_000);
    clock = start;
    const seen = async () =>
      (await db.select().from(runners).where(eq(runners.id, runnerId)))[0]!.lastSeenAt;
    const pending = claim(api, credential, { wait_seconds: 1 });
    await vi.waitFor(async () => expect(await seen()).toEqual(start));
    const end = new Date(start.getTime() + 45_000);
    clock = end;
    await pending;
    expect(await seen()).toEqual(end);
  });

  it('a fifth concurrent claim is 429, and an aborted claim frees its slot', async () => {
    await game(false);
    const { credential } = await linkRunner(api, owner);
    const aborts = Array.from({ length: 4 }, () => new AbortController());
    const open = aborts.map((a) =>
      claim(api, credential, { wait_seconds: 30 }, a.signal).catch(() => null),
    );
    await new Promise((r) => setTimeout(r, 300));
    const fifth = await claim(api, credential, { wait_seconds: 0 });
    expect(fifth.status).toBe(429);
    expect((fifth.body as unknown as { error: { code: string } }).error.code).toBe('rate_limited');
    aborts[0]!.abort();
    await open[0];
    await new Promise((r) => setTimeout(r, 100));
    expect((await claim(api, credential, { wait_seconds: 0 })).status).toBe(200);
    for (const a of aborts) a.abort();
    await Promise.all(open);
  });

  it('rejects an invalid body with 400 and a body over 16 KB with 413', async () => {
    const { credential } = await linkRunner(api, owner);
    const bad = await post('/runner/claim', { wait_seconds: 99 }, credential);
    expect(bad.status).toBe(400);
    expect((await json(bad)).error.code).toBe('validation');
    const big = await post('/runner/claim', { pad: 'x'.repeat(17 * 1024) }, credential);
    expect(big.status).toBe(413);
  });
});

describe('POST /runner/release', () => {
  const release = (token: string, turn: { id: number; claim_seq: number }, extra = {}) =>
    post(
      '/runner/release',
      { turn_id: turn.id, claim_seq: turn.claim_seq, reason: 'error', ...extra },
      token,
    );

  it('makes the turn claimable again only after 60 s', async () => {
    await game();
    const { credential } = await linkRunner(api, owner);
    const turn = (await claim(api, credential)).body.turn!;
    expect((await release(credential, turn)).status).toBe(204);
    expect((await claim(api, credential)).body.turn).toBeNull();
    clock = new Date(clock.getTime() + 30_000);
    expect((await claim(api, credential)).body.turn).toBeNull();
    clock = new Date(clock.getTime() + 31_000);
    const again = (await claim(api, credential)).body.turn;
    expect(again).toMatchObject({ id: turn.id, claim_seq: 2 });
  });

  it('for an already-played turn is 204 and counts no failure', async () => {
    await game();
    const { credential } = await linkRunner(api, owner);
    const turn = (await claim(api, credential)).body.turn!;
    await callTool(api.app, turn.token, 'make_move', { move: 'e4' });
    expect((await release(credential, turn, { reason: 'exited' })).status).toBe(204);
    // The played turn's lease is gone or kept; either way nothing failed.
    const leases = await db.select().from(turnLeases).where(eq(turnLeases.id, turn.id));
    expect(leases.every((lease) => lease.failures === 0)).toBe(true);
  });

  it('with a stale claim_seq leaves the current lease intact, and logs ids and reason only', async () => {
    await game();
    const { credential } = await linkRunner(api, owner);
    const turn = (await claim(api, credential)).body.turn!;
    const info = vi.spyOn(api.deps.log, 'info');
    const res = await release(
      credential,
      { id: turn.id, claim_seq: turn.claim_seq + 1 },
      { detail: 'SECRET-DETAIL' },
    );
    expect(res.status).toBe(204);
    const [lease] = await db.select().from(turnLeases).where(eq(turnLeases.id, turn.id));
    expect(lease!.runnerId).not.toBeNull();
    expect(lease!.failures).toBe(0);
    expect(JSON.stringify(info.mock.calls)).not.toContain('SECRET-DETAIL');
    expect(info).toHaveBeenCalledWith(
      { runnerId: lease!.runnerId, leaseId: turn.id, reason: 'error' },
      expect.any(String),
    );
  });
});
