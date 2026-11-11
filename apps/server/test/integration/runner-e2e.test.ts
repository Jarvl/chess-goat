import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve, type ServerType } from '@hono/node-server';
import { eq, gt } from 'drizzle-orm';
import { createClient, runLoop, type Client, type RunnerConfig } from 'goat-runner';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { challenges, games, moves, turnLeases, type UserRow } from '../../src/db/schema';
import { touchMember } from '../../src/domain/members';
import { createOwnerToken } from '../../src/domain/ownerTokens';
import type { TestApi } from '../helpers/api';
import { openTestDb, truncateAll } from '../helpers/db';
import {
  insertBot,
  insertChallenge,
  insertGame,
  insertGroup,
  insertUser,
} from '../helpers/fixtures';
import { callTool } from '../helpers/mcp';
import { startTestRunner } from '../helpers/runner';

// The real runner loop against the real endpoints, over HTTP on a loopback port. Only the agent
// harness is a stand-in (mcpHarness.mjs, or a fake model for the lean preset).
const HARNESS = fileURLToPath(new URL('../helpers/mcpHarness.mjs', import.meta.url));

const { db, close } = openTestDb();
let api: TestApi;
let httpServer: ServerType;
let base: string;
let owner: UserRow;
let ownerToken: string;
let scratch: string;
let fakeModel: Server | null;
/** The loops started by the test; afterEach stops and awaits each. */
let running: { stop: () => Promise<void> }[];
/** Requests the server is still handling; a handler may touch the database after its client left. */
let inflight = 0;

beforeEach(async () => {
  await truncateAll(db);
  api = await startTestRunner(db);
  // The port is known only once listening; turns carry /mcp under PUBLIC_URL.
  httpServer = await new Promise<ServerType>((resolve) => {
    const fetch = async (req: Request) => {
      inflight += 1;
      try {
        return await api.app.fetch(req);
      } finally {
        inflight -= 1;
      }
    };
    const s = serve({ fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s));
  });
  inflight = 0;
  base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  api.config.PUBLIC_URL = base;
  owner = await insertUser(db, { username: 'alice' });
  ownerToken = await db.transaction((tx) => createOwnerToken(tx, owner.id));
  scratch = await mkdtemp(join(tmpdir(), 'runner-e2e-'));
  fakeModel = null;
  running = [];
});

afterEach(async () => {
  for (const r of running) await r.stop();
  await new Promise<void>((resolve) => {
    httpServer.close(() => resolve());
    (httpServer as Server).closeAllConnections();
  });
  // Handlers of aborted claims finish their last writes here, not during the next truncate.
  for (let i = 0; i < 200 && inflight > 0; i++) await new Promise((r) => setTimeout(r, 25));
  if (fakeModel) {
    const model = fakeModel;
    await new Promise<void>((resolve) => {
      model.close(() => resolve());
      model.closeAllConnections();
    });
  }
  await api.stop();
  await rm(scratch, { recursive: true, force: true });
});
afterAll(close);

/** Polls `read` until it returns something truthy; the error carries what the runner logged. */
async function eventually<T>(
  read: () => Promise<T | false | null | undefined>,
  logs: string[] = [],
  timeoutMs = 15_000,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting; runner log:\n${logs.join('\n')}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

type Runner = {
  loop: Promise<'stopped' | 'revoked'>;
  logs: string[];
  stop: () => Promise<void>;
};

/** Runs the loop in-process with short claim polls and a per-test folder. */
function startRunner(
  link: { credential: string; runner_id: number },
  provide: Pick<RunnerConfig, 'preset'> & Partial<RunnerConfig>,
): Runner {
  const config: RunnerConfig = {
    server: base,
    credential: link.credential,
    runnerId: link.runner_id,
    custom: { command: process.execPath, args: [HARNESS, '{mcp_config}', '{prompt_file}'] },
    concurrency: 2,
    leaseSeconds: 60,
    ...provide,
  };
  const real = createClient({ server: base, credential: link.credential, userAgent: 'e2e' });
  // The runner always asks for a 50 s poll; a short one keeps stop and revocation prompt.
  const client: Client = {
    ...real,
    claim: (body, signal) => real.claim({ ...body, wait_seconds: 1 }, signal),
  };
  const logs: string[] = [];
  const ctl = new AbortController();
  const loop = runLoop(
    {
      client,
      config,
      dataDir: join(scratch, 'data'),
      tmpRoot: scratch,
      log: { info: (l) => logs.push(l), warn: (l) => logs.push(`WARN ${l}`) },
      timing: { backoffBaseMs: 50, rateLimitWaitMs: 50 },
    },
    ctl.signal,
  );
  const runner: Runner = {
    loop,
    logs,
    stop: async () => {
      ctl.abort();
      await loop;
    },
  };
  running.push(runner);
  return runner;
}

/** link_runner as the owner's agent calls it, then /runner/link with the code, as the CLI does. */
async function link(args: Record<string, unknown> = {}) {
  const out = await callTool<{ code: string }>(api.app, ownerToken, 'link_runner', args);
  expect(out.isError).toBeFalsy();
  const client = createClient({ server: base, userAgent: 'e2e' });
  return client.link({ code: out.structuredContent!.code, harness: 'custom' });
}

async function group() {
  const row = await insertGroup(db);
  await touchMember(db, row.id, owner.id);
  return row;
}
async function botIn(groupId: number, firstName: string) {
  const bot = await insertBot(db, owner, { firstName, persona: `${firstName} plays solid chess.` });
  await touchMember(db, groupId, bot.id);
  return bot;
}
const gameRow = async (id: number) => (await db.select().from(games).where(eq(games.id, id)))[0]!;
const failedLeases = () => db.select().from(turnLeases).where(gt(turnLeases.failures, 0));

describe('goat-runner against the server', () => {
  it('links with a code from link_runner and passes test_runner', async () => {
    const bot = await insertBot(db, owner, { firstName: 'Rook' });
    const linked = await link();
    expect(linked).toMatchObject({ server: expect.any(String) });
    const runner = startRunner(linked, { preset: 'custom' });

    // The runner's claim polls make it connected; test_runner issues the practice turn and waits
    // for the session's hello.
    const out = await callTool<{ status: string }>(api.app, ownerToken, 'test_runner', {
      bot: bot.id,
      wait_seconds: 12,
    });
    expect(out.structuredContent!.status, runner.logs.join('\n')).toBe('working');
    const listed = await callTool<{ runners: { id: number; connected: boolean }[] }>(
      api.app,
      ownerToken,
      'list_runners',
    );
    expect(listed.structuredContent!.runners).toMatchObject([
      { id: linked.runner_id, connected: true },
    ]);
    expect(await failedLeases()).toEqual([]);
  });

  it('answers a challenge and plays a move for a bot', async () => {
    const g = await group();
    const bot = await botIn(g.id, 'Rook');
    const human = await insertUser(db, { username: 'bob' });
    await touchMember(db, g.id, human.id);
    // The human takes black, so the bot is white and moves as soon as it accepts.
    const challenge = await insertChallenge(db, g.id, human.id, bot.id, {
      challengerColour: 'black',
    });
    const runner = startRunner(await link(), { preset: 'custom' });

    const game = await eventually(async () => {
      const [row] = await db.select().from(games).where(eq(games.groupId, g.id));
      return row && row.plyCount >= 1 ? row : null;
    }, runner.logs);
    expect(game).toMatchObject({ whiteId: bot.id, blackId: human.id, plyCount: 1 });
    const [accepted] = await db.select().from(challenges).where(eq(challenges.id, challenge.id));
    expect(accepted!.status).toBe('accepted');
    // Both turns resolved: nothing left leased or failed for the bot.
    await eventually(
      async () =>
        (await db.select().from(turnLeases).where(eq(turnLeases.botId, bot.id))).length === 0,
      runner.logs,
    );
  });

  it('lets two bots of one owner play each other to move four', async () => {
    const g = await group();
    const rook = await botIn(g.id, 'Rook');
    const knight = await botIn(g.id, 'Knight');
    const runner = startRunner(await link(), { preset: 'custom' });
    const sent = await callTool(api.app, ownerToken, 'challenge_bot', {
      bot: rook.id,
      group: g.publicId,
      opponent_bot: knight.id,
      colour: 'white',
    });
    expect(sent.isError).toBeFalsy();

    // Eight plies: four moves each side, every one played by a harness session.
    const game = await eventually(
      async () => {
        const [row] = await db.select().from(games).where(eq(games.groupId, g.id));
        return row && row.plyCount >= 8 ? row : null;
      },
      runner.logs,
      22_000,
    );
    expect(game.whiteId).toBe(rook.id);
    expect(game.blackId).toBe(knight.id);
    expect(await failedLeases()).toEqual([]);
    const row = await gameRow(game.id);
    expect(row.status).toBe('active');
  }, 25_000);

  it('stops for good when the runner is revoked', async () => {
    const linked = await link();
    const runner = startRunner(linked, { preset: 'custom' });
    await eventually(
      async () => runner.logs.some((l) => l.includes('goat-runner started')),
      runner.logs,
    );
    const out = await callTool(api.app, ownerToken, 'revoke_runner', { runner: linked.runner_id });
    expect(out.isError).toBeFalsy();
    expect(await runner.loop).toBe('revoked');
  });

  it('plays through the lean preset against a fake model endpoint', async () => {
    const g = await group();
    const bot = await botIn(g.id, 'Rook');
    const human = await insertUser(db, { username: 'bob' });
    await touchMember(db, g.id, human.id);
    const game = await insertGame(db, g.id, bot.id, human.id);

    // A model that asks for make_move once, then says it is done.
    const requests: { messages: { role: string; content: string | null }[]; tools: unknown[] }[] =
      [];
    fakeModel = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(
          Buffer.concat(chunks).toString('utf8'),
        ) as (typeof requests)[number];
        requests.push(body);
        const answered = body.messages.some((m) => m.role === 'tool');
        const message = answered
          ? { role: 'assistant', content: 'Done.' }
          : {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'make_move', arguments: JSON.stringify({ move: 'e4' }) },
                },
              ],
            };
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message }] }));
      });
    });
    await new Promise<void>((resolve) => fakeModel!.listen(0, '127.0.0.1', resolve));
    const modelUrl = `http://127.0.0.1:${(fakeModel.address() as AddressInfo).port}`;

    const runner = startRunner(await link(), {
      preset: 'lean',
      lean: { baseUrl: modelUrl, model: 'fake' },
    });
    await eventually(async () => (await gameRow(game.id)).plyCount >= 1, runner.logs);
    const row = await gameRow(game.id);
    expect(row.plyCount).toBe(1);
    const [first] = await db.select().from(moves).where(eq(moves.gameId, game.id));
    expect(first).toMatchObject({ ply: 1, san: 'e4' });
    expect(requests[0]!.messages[0]!.content).toContain('Rook plays solid chess.');
    expect(requests[0]!.tools.length).toBeGreaterThan(0);
    await eventually(
      async () =>
        (await db.select().from(turnLeases).where(eq(turnLeases.botId, bot.id))).length === 0,
      runner.logs,
    );
    expect(await failedLeases()).toEqual([]);
  });
});
