import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { runners, turnLeases, type UserRow } from '../../src/db/schema';
import { createOwnerToken } from '../../src/domain/ownerTokens';
import type { TestApi } from '../helpers/api';
import { openTestDb, truncateAll } from '../helpers/db';
import { insertBot, insertGame, insertGroup, insertUser } from '../helpers/fixtures';
import { callTool, mcpCall, resultText } from '../helpers/mcp';
import { claim, linkRunner, startTestRunner } from '../helpers/runner';

const { db, close } = openTestDb();
let api: TestApi;
let owner: UserRow;
let bot: UserRow;
let token: string;

beforeEach(async () => {
  if (api) await api.stop();
  await truncateAll(db);
  api = await startTestRunner(db);
  owner = await insertUser(db, { username: 'alice' });
  bot = await insertBot(db, owner, { firstName: 'Rook' });
  token = await db.transaction((tx) => createOwnerToken(tx, owner.id));
});
afterAll(async () => {
  await api?.stop();
  await close();
});

type Out = { bot: string; status: string; waitedSeconds: number };
const test = (args: Record<string, unknown> = {}) =>
  callTool<Out>(api.app, token, 'test_runner', { bot: bot.id, wait_seconds: 0, ...args });

/** A linked runner that is connected now. */
async function connectedRunner() {
  const linked = await linkRunner(api, owner);
  await db.update(runners).set({ lastSeenAt: new Date() }).where(eq(runners.id, linked.runnerId));
  return linked;
}
const practiceRow = async () =>
  (await db.select().from(turnLeases).where(eq(turnLeases.kind, 'practice')))[0];

const say = {
  no_runner:
    'No connected runner serves Rook. Call link_runner and run its command, then call test_runner again.',
  not_claimed:
    'A runner is connected but has not picked up the test yet. Call test_runner again in a moment.',
  claimed:
    "The runner started a session for Rook, but it has not answered yet. Slow models can take a few minutes: call test_runner again. If it stays here, run `goat-runner logs` on the runner's machine.",
  working: 'Rook is live: its runner started a session and the session reached Chess Goat.',
  failed:
    "The runner started a session for Rook, but it ended without reaching Chess Goat. Run `goat-runner logs` on the runner's machine to see why, fix it, then call test_runner again.",
};

describe('test_runner', () => {
  it('says no_runner when no runner is linked', async () => {
    const out = await test();
    expect(out.structuredContent).toMatchObject({ status: 'no_runner', waitedSeconds: 0 });
    expect(resultText(out)).toBe(say.no_runner);
  });

  it('says not_claimed for a connected runner that has not claimed', async () => {
    await connectedRunner();
    const out = await test();
    expect(out.structuredContent!.status).toBe('not_claimed');
    expect(resultText(out)).toBe(say.not_claimed);
  });

  it('says claimed once the runner holds the practice turn', async () => {
    const { credential } = await connectedRunner();
    await test();
    const { body } = await claim(api, credential);
    expect(body.turn).toMatchObject({
      kind: 'practice',
      prompt: 'This is a test. Call hello, then stop.',
    });
    const out = await test();
    expect(out.structuredContent!.status).toBe('claimed');
    expect(resultText(out)).toBe(say.claimed);
  });

  it('says working after hello, drops the row, and starts a fresh test next time', async () => {
    const { credential } = await connectedRunner();
    const first = await test();
    expect(first.structuredContent!.status).toBe('not_claimed');
    const turn = (await claim(api, credential)).body.turn!;
    const hello = await callTool(api.app, turn.token, 'hello');
    expect(resultText(hello)).toBe('Hello received. The test passed; stop.');
    expect(hello.structuredContent).toEqual({ ok: true });
    // Twice is fine.
    expect((await callTool(api.app, turn.token, 'hello')).isError).toBeFalsy();
    const out = await test();
    expect(out.structuredContent!.status).toBe('working');
    expect(resultText(out)).toBe(say.working);
    expect(await practiceRow()).toBeUndefined();
    expect((await test()).structuredContent!.status).toBe('not_claimed');
    expect(await practiceRow()).toBeDefined();
  });

  describe('failed', () => {
    // A new test_runner call replaces a failed test, so failure shows to a call that is waiting.
    const waitForClaim = async (credential: string) => {
      const waiting = test({ wait_seconds: 10 });
      await new Promise((resolve) => setTimeout(resolve, 300));
      const turn = (await claim(api, credential)).body.turn!;
      return { waiting, turn };
    };

    it('after the runner releases the turn without hello; it is never claimable again', async () => {
      const { credential } = await connectedRunner();
      const { waiting, turn } = await waitForClaim(credential);
      const res = await api.request('POST', '/runner/release', {
        token: credential,
        body: { turn_id: turn.id, claim_seq: turn.claim_seq, reason: 'exited' },
      });
      expect(res.status).toBe(204);
      const out = await waiting;
      expect(out.structuredContent!.status).toBe('failed');
      expect(resultText(out)).toBe(say.failed);
      expect((await claim(api, credential)).body.turn).toBeNull();
      // A new test starts a fresh row, which is claimable.
      const failedId = (await practiceRow())!.id;
      expect((await test()).structuredContent!.status).toBe('not_claimed');
      expect((await practiceRow())!.id).not.toBe(failedId);
      expect((await claim(api, credential)).body.turn).toMatchObject({ kind: 'practice' });
    });

    it('when the lease expires without hello', async () => {
      const { credential } = await connectedRunner();
      const { waiting, turn } = await waitForClaim(credential);
      await db
        .update(turnLeases)
        .set({ leasedUntil: new Date(Date.now() - 1000) })
        .where(eq(turnLeases.id, turn.id));
      expect((await waiting).structuredContent!.status).toBe('failed');
      expect((await claim(api, credential)).body.turn).toBeNull();
      expect((await practiceRow())!.failures).toBe(1);
      expect((await test()).structuredContent!.status).toBe('not_claimed');
      expect((await claim(api, credential)).body.turn).toMatchObject({ kind: 'practice' });
    });
  });

  it('reuses the same row while the test is not_claimed or claimed', async () => {
    const { credential } = await connectedRunner();
    await test();
    const id = (await practiceRow())!.id;
    await test();
    expect((await practiceRow())!.id).toBe(id);
    await claim(api, credential);
    await test();
    expect((await practiceRow())!.id).toBe(id);
    expect(await db.select().from(turnLeases)).toHaveLength(1);
  });

  it('is claimed ahead of a waiting move turn', async () => {
    const group = await insertGroup(db);
    const human = await insertUser(db);
    await insertGame(db, group.id, bot.id, human.id);
    const { credential } = await connectedRunner();
    await test();
    expect((await claim(api, credential)).body.turn!.kind).toBe('practice');
    expect((await claim(api, credential)).body.turn!.kind).toBe('move');
  });

  it('offers exactly hello on a practice turn, and no hello on a move turn', async () => {
    const group = await insertGroup(db);
    const human = await insertUser(db);
    await insertGame(db, group.id, bot.id, human.id);
    const { credential } = await connectedRunner();
    await test();
    const practice = (await claim(api, credential)).body.turn!;
    const names = async (t: string) =>
      (
        ((await mcpCall(api.app, t, 'tools/list')).response?.result?.tools ?? []) as {
          name: string;
        }[]
      ).map((tool) => tool.name);
    expect(await names(practice.token)).toEqual(['hello']);
    const move = (await claim(api, credential)).body.turn!;
    expect(await names(move.token)).not.toContain('hello');
    const reply = await mcpCall(api.app, move.token, 'tools/call', {
      name: 'hello',
      arguments: {},
    });
    expect(reply.response?.error ?? reply.response?.result?.isError).toBeTruthy();
  });

  it('returns as soon as hello arrives while it waits', async () => {
    const { credential } = await connectedRunner();
    const waiting = test({ wait_seconds: 20 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const turn = (await claim(api, credential)).body.turn!;
    await callTool(api.app, turn.token, 'hello');
    const out = await waiting;
    expect(out.structuredContent).toMatchObject({ status: 'working' });
    expect(out.structuredContent!.waitedSeconds).toBeLessThan(10);
  });

  it("refuses another owner's bot", async () => {
    const other = await insertUser(db, { username: 'mallory' });
    const theirs = await insertBot(db, other, { firstName: 'Bishop' });
    const out = await test({ bot: theirs.id });
    expect(out.isError).toBe(true);
    expect(resultText(out)).toContain('not found');
    expect(await practiceRow()).toBeUndefined();
  });
});
