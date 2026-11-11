import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunnerReleaseRequest, RunnerTurn } from '@chess-goat/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createClient, NetworkError, type Client } from '../src/client.js';
import type { RunnerConfig } from '../src/config.js';
import { runLoop, type LoopDeps } from '../src/loop.js';
import { botDir } from '../src/paths.js';
import { sendJson, startServer, type Recorded, type TestServer } from './support/httpServer.js';

const HARNESS = fileURLToPath(new URL('./support/fakeHarness.mjs', import.meta.url));
const CREDENTIAL = 'runner-credential-Jk39qWzR';
const TOKEN = 'turn-token-Zq81xKfT';
const PERSONA = 'persona-text-Mm20dLcs';
const PROMPT = 'prompt-text-Yt66bNhe';
const MODEL_KEY = 'sk-model-key-Pw93mLrB';
const OUTPUT = 'DISTINCT-HARNESS-OUTPUT-4417';

const fast = { backoffBaseMs: 10, rateLimitWaitMs: 20 };

// Everything a test creates is torn down in afterEach, even when the test failed.
const servers: TestServer[] = [];
const dirs: string[] = [];
const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stopOne of stops.splice(0)) await stopOne();
  await Promise.all(servers.splice(0).map((s) => s.close()));
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const tmpDir = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-test-'));
  dirs.push(d);
  return d;
};
const start = async (...args: Parameters<typeof startServer>) => {
  const s = await startServer(...args);
  servers.push(s);
  return s;
};

const waitFor = async (cond: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 15));
  }
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

type Overrides = {
  concurrency?: number;
  harness?: string[];
  lean?: RunnerConfig['lean'];
};
const configFor = (server: string, o: Overrides = {}): RunnerConfig => ({
  server,
  credential: CREDENTIAL,
  runnerId: 1,
  preset: o.lean ? 'lean' : 'custom',
  custom: { command: process.execPath, args: [HARNESS, ...(o.harness ?? ['ok'])] },
  ...(o.lean ? { lean: o.lean } : {}),
  concurrency: o.concurrency ?? 2,
  leaseSeconds: 300,
});

let nextId = 1;
const turnFor = (origin: string, over: Partial<RunnerTurn> = {}): RunnerTurn => {
  const id = nextId++;
  return {
    id,
    claim_seq: 1,
    kind: 'move',
    bot: { id: 7, name: 'Botty' },
    persona: PERSONA,
    prompt: PROMPT,
    token: TOKEN,
    expires_at: new Date(Date.now() + 10_000).toISOString(),
    mcp_url: `${origin}/mcp`,
    ...over,
  };
};

type Fake = {
  server: TestServer;
  queue: RunnerTurn[];
  releases: () => RunnerReleaseRequest[];
  claims: () => Recorded[];
  /** Start times of each claim request */
  claimTimes: number[];
  open: { now: number; max: number };
};
type FakeOpts = {
  claim?: (n: number, res: import('node:http').ServerResponse) => boolean | Promise<boolean>;
  release?: (body: RunnerReleaseRequest, res: import('node:http').ServerResponse) => boolean;
  extra?: (req: Recorded, res: import('node:http').ServerResponse) => boolean;
};
/** A fake runner server: a queue of turns for /runner/claim, recording /runner/release. */
async function fakeServer(opts: FakeOpts = {}): Promise<Fake> {
  const queue: RunnerTurn[] = [];
  const claimTimes: number[] = [];
  const open = { now: 0, max: 0 };
  let n = 0;
  const server = await start(async (req, res) => {
    if (opts.extra?.(req, res)) return;
    if (req.path === '/runner/claim') {
      n++;
      claimTimes.push(Date.now());
      open.now++;
      open.max = Math.max(open.max, open.now);
      res.on('close', () => open.now--);
      if (opts.claim && (await opts.claim(n, res))) return;
      const turn = queue.shift();
      if (turn) return sendJson(res, 200, { turn });
      await new Promise((r) => setTimeout(r, 60)); // a short "long poll"
      if (!res.destroyed && !res.writableEnded) sendJson(res, 200, { turn: null });
      return;
    }
    if (req.path === '/runner/release') {
      if (opts.release?.(req.body as RunnerReleaseRequest, res)) return;
      return sendJson(res, 200, {});
    }
    res.writeHead(404);
    res.end();
  });
  return {
    server,
    queue,
    claimTimes,
    open,
    releases: () =>
      server.requests
        .filter((r) => r.path === '/runner/release')
        .map((r) => r.body as RunnerReleaseRequest),
    claims: () => server.requests.filter((r) => r.path === '/runner/claim'),
  };
}

type Running = {
  result: Promise<'stopped' | 'revoked'>;
  ctl: AbortController;
  logs: string[];
  warns: string[];
  infos: string[];
  tmpRoot: string;
  data: string;
  stop(): Promise<'stopped' | 'revoked'>;
};
function startLoop(config: RunnerConfig, client: Client, extra: Partial<LoopDeps> = {}): Running {
  const ctl = new AbortController();
  const logs: string[] = [];
  const warns: string[] = [];
  const infos: string[] = [];
  const tmpRoot = tmpDir();
  const data = tmpDir();
  const result = runLoop(
    {
      client,
      config,
      dataDir: data,
      tmpRoot,
      timing: fast,
      log: {
        info: (l) => (infos.push(l), logs.push(`info ${l}`)),
        warn: (l) => (warns.push(l), logs.push(`warn ${l}`)),
      },
      ...extra,
    },
    ctl.signal,
  );
  const stop = () => {
    ctl.abort();
    return result;
  };
  stops.push(async () => void (await stop()));
  return { result, ctl, logs, warns, infos, tmpRoot, data, stop };
}
const realClient = (fake: Fake, config: RunnerConfig) =>
  createClient({
    server: config.server,
    credential: CREDENTIAL,
    userAgent: 'goat-runner-test',
    retryBaseMs: 5,
  });

/** A scripted in-memory client, for cases the HTTP fake cannot express. */
function stubClient(turns: RunnerTurn[]) {
  const released: RunnerReleaseRequest[] = [];
  const client: Client = {
    link: () => Promise.reject(new Error('unused')),
    async claim(_body, signal) {
      const t = turns.shift();
      if (t) return t;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 40);
        signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
      });
      return null;
    },
    async release(body) {
      released.push(body);
    },
  };
  return { client, released };
}

const noProcesses = (root: string) =>
  fs.readdirSync(root).filter((e) => e.startsWith('goat-runner-'));

describe('runLoop', () => {
  it('runs a turn, releases it as exited with a fixed summary, logs one clean line', async () => {
    const fake = await fakeServer();
    const config = configFor(fake.server.url, { harness: ['chatty'] });
    const turn = turnFor(fake.server.url);
    fake.queue.push(turn);
    const run = startLoop(config, realClient(fake, config));
    await waitFor(() => fake.releases().length === 1);
    await run.stop();

    const [rel] = fake.releases();
    expect(rel).toMatchObject({ turn_id: turn.id, claim_seq: 1, reason: 'exited' });
    expect(rel!.detail).toMatch(/^custom exited; exit 0; \d+ s$/);
    expect(JSON.stringify(fake.server.requests)).not.toContain(OUTPUT);
    expect(run.infos).toContain('Botty: move turn, exited in 0 s');
    expect(run.logs.join('\n')).not.toContain(OUTPUT);
    expect(run.warns).toEqual([]);
    expect(run.infos[0]).toBe(
      `goat-runner started: server ${fake.server.url}, preset custom, up to 2 sessions`,
    );
    expect(run.infos.at(-1)).toBe('goat-runner stopped');
    expect(noProcesses(run.tmpRoot)).toEqual([]);
    expect(fs.statSync(botDir(run.data, 7)).isDirectory()).toBe(true);
    const claim = fake.claims()[0]!;
    expect(claim.body).toEqual({ wait_seconds: 50, lease_seconds: 300 });
  });

  it('a failing harness: exit code and last output are logged, the summary carries neither', async () => {
    const fake = await fakeServer();
    const config = configFor(fake.server.url, { harness: ['fail'] });
    fake.queue.push(turnFor(fake.server.url));
    const run = startLoop(config, realClient(fake, config));
    await waitFor(() => fake.releases().length === 1);
    await run.stop();
    expect(fake.releases()[0]).toMatchObject({
      reason: 'exited',
      detail: expect.stringMatching(/^custom exited; exit 3; \d+ s$/),
    });
    expect(JSON.stringify(fake.server.requests)).not.toContain('nope');
    expect(run.infos).toContain('Botty: move turn, exited in 0 s, exit 3');
    expect(run.warns).toEqual(['Botty: last output: nope ']);
    expect(noProcesses(run.tmpRoot)).toEqual([]);
  });

  it('keeps a bot name with control characters to one clean line', async () => {
    const { client, released } = stubClient([
      turnFor('http://localhost:1', {
        bot: { id: 7, name: 'Bo\nt\u001b[31m\u2028x'.padEnd(100, 'z') },
      }),
    ]);
    const run = startLoop(configFor('http://localhost:1'), client);
    await waitFor(() => released.length === 1);
    await run.stop();
    const line = run.infos.find((l) => l.includes('move turn'))!;
    expect(line).toMatch(/^Bo t \[31m x/);
    expect(line.indexOf(': move turn')).toBe(64);
    // eslint-disable-next-line no-control-regex
    expect(run.logs.every((l) => !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(l))).toBe(true);
  });

  it('refuses an mcp_url on another origin without starting a process', async () => {
    const dir = tmpDir();
    const marker = path.join(dir, 'ran');
    const origin = 'http://localhost:1';
    const { client, released } = stubClient([
      turnFor(origin, { mcp_url: 'http://localhost:2/mcp' }),
      turnFor(origin, { mcp_url: 'not a url' }),
    ]);
    const run = startLoop(configFor(origin, { harness: ['marker', marker] }), client);
    await waitFor(() => released.length === 2);
    await run.stop();
    expect(released.map((r) => [r.reason, r.detail])).toEqual([
      ['error', 'refused: mcp_url origin'],
      ['error', 'refused: mcp_url origin'],
    ]);
    expect(fs.existsSync(marker)).toBe(false);
    expect(run.warns[0]).toBe(
      'Botty: turn refused, the server gave an MCP address on another origin',
    );
  });

  it('refuses plain http to a host that is not loopback', async () => {
    const dir = tmpDir();
    const marker = path.join(dir, 'ran');
    const origin = 'http://runner.example.test';
    const { client, released } = stubClient([turnFor(origin)]);
    const run = startLoop(configFor(origin, { harness: ['marker', marker] }), client);
    await waitFor(() => released.length === 1);
    await run.stop();
    expect(released[0]).toMatchObject({ reason: 'error', detail: 'refused: insecure mcp_url' });
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('skips a turn with 2 s left: released as timeout, no process', async () => {
    const marker = path.join(tmpDir(), 'ran');
    const origin = 'http://localhost:1';
    const { client, released } = stubClient([
      turnFor(origin, { expires_at: new Date(Date.now() + 2000).toISOString() }),
      turnFor(origin, { expires_at: 'garbage' }),
    ]);
    const run = startLoop(configFor(origin, { harness: ['marker', marker] }), client);
    await waitFor(() => released.length === 2);
    await run.stop();
    expect(released[0]).toMatchObject({ reason: 'timeout' });
    expect(released[0]!.detail).toMatch(/^skipped: \d{4} ms left$/);
    expect(released[1]).toMatchObject({ reason: 'timeout', detail: 'skipped: NaN ms left' });
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('a writeFiles that throws releases as error and leaves no temp folder', async () => {
    const marker = path.join(tmpDir(), 'ran');
    const origin = 'http://localhost:1';
    // A prompt that is not a string makes the file write throw.
    const bad = { ...turnFor(origin), prompt: undefined as unknown as string };
    const { client, released } = stubClient([bad]);
    const run = startLoop(configFor(origin, { harness: ['marker', marker] }), client);
    await waitFor(() => released.length === 1);
    await run.stop();
    expect(released[0]).toMatchObject({ reason: 'error', detail: 'could not prepare the session' });
    expect(noProcesses(run.tmpRoot)).toEqual([]);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('a hanging harness is stopped at the time limit and released as timeout; temp folder gone', async () => {
    const fake = await fakeServer();
    const config = configFor(fake.server.url, { harness: ['hang'] });
    const turn = turnFor(fake.server.url, { expires_at: new Date(Date.now() + 800).toISOString() });
    fake.queue.push(turn);
    const run = startLoop(config, realClient(fake, config), { timing: { ...fast, minLeftMs: 0 } });
    await waitFor(() => fake.releases().length === 1);
    await run.stop();
    expect(fake.releases()[0]).toMatchObject({ reason: 'timeout' });
    expect(fake.releases()[0]!.detail).toMatch(/^custom timeout; exit none; \d+ s$/);
    expect(noProcesses(run.tmpRoot)).toEqual([]);
    expect(run.warns).toHaveLength(1); // the failed-session "last output" line
    expect(run.warns[0]).toContain('last output: hanging');
  });

  it('never runs more than `concurrency` sessions and releases all five', async () => {
    const fake = await fakeServer();
    const config = configFor(fake.server.url, { harness: ['nap', '250'], concurrency: 2 });
    for (let i = 0; i < 5; i++)
      fake.queue.push(turnFor(fake.server.url, { bot: { id: 10 + i, name: `b${i}` } }));
    let running = 0;
    let max = 0;
    const run = startLoop(config, realClient(fake, config), {
      hooks: {
        onTurnStart: () => (running++, (max = Math.max(max, running))),
        onTurnEnd: () => running--,
      },
    });
    await waitFor(() => fake.releases().length === 5);
    await run.stop();
    expect(max).toBe(2);
    expect(new Set(fake.releases().map((r) => r.turn_id)).size).toBe(5);
    expect(fake.releases().every((r) => r.reason === 'exited')).toBe(true);
  });

  it('with concurrency 1, no claim is open while a session runs', async () => {
    const fake = await fakeServer();
    const config = configFor(fake.server.url, { harness: ['nap', '400'], concurrency: 1 });
    fake.queue.push(turnFor(fake.server.url));
    let from = 0;
    let to = 0;
    const run = startLoop(config, realClient(fake, config), {
      hooks: { onTurnStart: () => (from = Date.now()), onTurnEnd: () => (to = Date.now()) },
    });
    await waitFor(() => fake.releases().length === 1);
    await waitFor(() => fake.claimTimes.length >= 3);
    await run.stop();
    expect(to - from).toBeGreaterThanOrEqual(300);
    expect(fake.claimTimes.filter((t) => t > from && t < to)).toEqual([]);
    expect(fake.open.max).toBe(1);
  });

  it('waits out a 429 on claim without a log line, then carries on', async () => {
    const fake = await fakeServer({
      claim: (n, res) => {
        if (n > 2) return false;
        sendJson(res, 429, { error: { code: 'rate_limited', message: 'slow down' } });
        return true;
      },
    });
    const config = configFor(fake.server.url);
    fake.queue.push(turnFor(fake.server.url));
    const run = startLoop(config, realClient(fake, config));
    await waitFor(() => fake.releases().length === 1);
    await run.stop();
    expect(fake.claims().length).toBeGreaterThanOrEqual(3);
    expect(run.warns).toEqual([]);
    expect(run.logs.filter((l) => /unreachable|connected again/.test(l))).toEqual([]);
  });

  it('an unreachable server logs one warn, recovery logs one info', async () => {
    const fake = await fakeServer({
      claim: (n, res) => {
        if (n > 3) return false;
        res.socket?.destroy();
        return true;
      },
    });
    const config = configFor(fake.server.url);
    fake.queue.push(turnFor(fake.server.url));
    const run = startLoop(config, realClient(fake, config));
    await waitFor(() => fake.releases().length === 1);
    await run.stop();
    expect(run.warns.filter((l) => l.startsWith('server unreachable: '))).toHaveLength(1);
    expect(run.warns.at(-1)).toMatch(/^server unreachable: .*; retrying$/);
    expect(run.warns).toHaveLength(1);
    expect(run.infos.filter((l) => l === 'connected again')).toHaveLength(1);
  });

  it('a 401 on claim ends the loop as revoked, aborts the running session, releases nothing', async () => {
    const pidFile = path.join(tmpDir(), 'pid');
    const fake = await fakeServer({
      claim: async (n, res) => {
        if (n === 1) return false;
        await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8') !== ''); // the session is up
        sendJson(res, 401, { error: { code: 'unauthorized', message: 'revoked' } });
        return true;
      },
    });
    const config = configFor(fake.server.url, { harness: ['pidhang', pidFile], concurrency: 2 });
    fake.queue.push(turnFor(fake.server.url));
    const run = startLoop(config, realClient(fake, config));
    expect(await run.result).toBe('revoked');
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    expect(alive(pid)).toBe(false);
    expect(fake.releases()).toEqual([]);
    expect(run.warns.at(-1)).toBe('goat-runner stopped: this runner was revoked');
    const claimsAfter = fake.claims().length;
    await new Promise((r) => setTimeout(r, 150));
    expect(fake.claims().length).toBe(claimsAfter);
  });

  it('a 401 on release ends the loop as revoked', async () => {
    const fake = await fakeServer({
      release: (_b, res) => (
        sendJson(res, 401, { error: { code: 'unauthorized', message: 'x' } }),
        true
      ),
    });
    const config = configFor(fake.server.url);
    fake.queue.push(turnFor(fake.server.url));
    fake.queue.push(turnFor(fake.server.url));
    const run = startLoop(config, realClient(fake, config));
    expect(await run.result).toBe('revoked');
    expect(fake.releases()).toHaveLength(1);
  });

  it('a release that keeps failing is logged and the loop carries on', async () => {
    const fake = await fakeServer({
      release: (body, res) => {
        if (body.turn_id !== first) return false;
        res.writeHead(500);
        res.end();
        return true;
      },
    });
    const config = configFor(fake.server.url, { concurrency: 1 });
    const t1 = turnFor(fake.server.url);
    const first = t1.id;
    fake.queue.push(t1, turnFor(fake.server.url, { bot: { id: 8, name: 'Second' } }));
    const run = startLoop(config, realClient(fake, config));
    await waitFor(() => fake.releases().some((r) => r.turn_id !== first));
    await run.stop();
    expect(fake.releases().filter((r) => r.turn_id === first)).toHaveLength(5);
    expect(
      run.warns.filter((l) => l.startsWith('Botty: could not report the turn: ')),
    ).toHaveLength(1);
    expect(run.infos).toContain('Second: move turn, exited in 0 s');
  });

  it('on abort: stops claiming, kills the session, releases "runner stopping"', async () => {
    const pidFile = path.join(tmpDir(), 'pid');
    const fake = await fakeServer();
    const config = configFor(fake.server.url, { harness: ['pidhang', pidFile] });
    fake.queue.push(turnFor(fake.server.url));
    const run = startLoop(config, realClient(fake, config));
    await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8') !== '');
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    const t0 = Date.now();
    expect(await run.stop()).toBe('stopped');
    expect(Date.now() - t0).toBeLessThan(8000);
    expect(alive(pid)).toBe(false);
    expect(fake.releases()).toEqual([
      expect.objectContaining({ reason: 'timeout', detail: 'runner stopping' }),
    ]);
    expect(noProcesses(run.tmpRoot)).toEqual([]);
    const n = fake.claims().length;
    await new Promise((r) => setTimeout(r, 150));
    expect(fake.claims().length).toBe(n);
  });

  it('an unexpected fault in one turn is logged and released as error; the loop continues', async () => {
    const origin = 'http://localhost:1';
    const { client, released } = stubClient([turnFor(origin), turnFor(origin)]);
    let first = true;
    const run = startLoop(configFor(origin), client, {
      hooks: {
        onTurnStart: () => {
          if (first) {
            first = false;
            throw new Error('boom\nsecond line');
          }
        },
      },
    });
    await waitFor(() => released.length === 2);
    await run.stop();
    expect(released[0]).toMatchObject({ reason: 'error', detail: 'internal error' });
    expect(released[1]).toMatchObject({ reason: 'exited' });
    expect(run.warns).toContain('Botty: internal error: boom second line');
  });

  it('treats an unexpected exception from claim like a network error', async () => {
    let n = 0;
    const released: RunnerReleaseRequest[] = [];
    const client: Client = {
      link: () => Promise.reject(new Error('unused')),
      claim: async () => {
        if (++n === 1) throw new TypeError('odd');
        if (n === 2) throw new NetworkError('x', 'down');
        await new Promise((r) => setTimeout(r, 20));
        return null;
      },
      release: async (b) => void released.push(b),
    };
    const run = startLoop(configFor('http://localhost:1'), client);
    await waitFor(() => n >= 4);
    await run.stop();
    expect(run.warns.filter((l) => l.startsWith('server unreachable'))).toHaveLength(1);
    expect(run.infos).toContain('connected again');
  });

  it('the lean preset runs through the model endpoint and the MCP server on one origin', async () => {
    const chats: Recorded[] = [];
    let modelStep = 0;
    const fake = await fakeServer({
      extra: (req, res) => {
        if (req.path === '/v1/chat/completions') {
          chats.push(req);
          const message =
            modelStep++ === 0
              ? {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'c1',
                      type: 'function',
                      function: { name: 'make_move', arguments: '{"san":"e4"}' },
                    },
                  ],
                }
              : { role: 'assistant', content: 'done' };
          sendJson(res, 200, { choices: [{ message }] });
          return true;
        }
        if (req.path === '/mcp') {
          const body = req.body as { id: number; method: string };
          const result =
            body.method === 'tools/list'
              ? {
                  tools: [
                    {
                      name: 'make_move',
                      description: 'move',
                      inputSchema: { type: 'object', properties: {} },
                    },
                  ],
                }
              : { content: [{ type: 'text', text: 'ok' }], isError: false };
          sendJson(res, 200, { jsonrpc: '2.0', id: body.id, result });
          return true;
        }
        return false;
      },
    });
    process.env.LOOP_TEST_MODEL_KEY = MODEL_KEY;
    stops.push(async () => void delete process.env.LOOP_TEST_MODEL_KEY);
    const config = configFor(fake.server.url, {
      lean: { baseUrl: `${fake.server.url}/v1`, model: 'tiny', apiKeyEnv: 'LOOP_TEST_MODEL_KEY' },
    });
    fake.queue.push(turnFor(fake.server.url));
    const run = startLoop(config, realClient(fake, config));
    await waitFor(() => fake.releases().length === 1);
    await run.stop();

    expect(fake.releases()[0]).toMatchObject({ reason: 'exited' });
    expect(fake.releases()[0]!.detail).toMatch(/^lean exited; exit 0; \d+ s$/);
    expect(chats).toHaveLength(2);
    const mcpCalls = fake.server.requests.filter((r) => r.path === '/mcp');
    expect(mcpCalls.some((r) => (r.body as { method: string }).method === 'tools/call')).toBe(true);

    const text = (r: Recorded) => JSON.stringify([r.headers, r.body]);
    const runnerSide = fake.server.requests.filter((r) => r.path.startsWith('/runner/'));
    const secretsForServer = [TOKEN, PERSONA, PROMPT, MODEL_KEY];
    for (const s of secretsForServer) {
      expect(run.logs.join('\n')).not.toContain(s);
      // The runner-protocol bodies carry none of them (the claim response is not a request).
      expect(
        runnerSide
          .filter((r) => r.path === '/runner/release')
          .map(text)
          .join(''),
      ).not.toContain(s);
    }
    expect(run.logs.join('\n')).not.toContain(CREDENTIAL);
    // The runner credential and the turn token never reach the model; the API key goes only there.
    for (const r of chats) {
      expect(text(r)).not.toContain(CREDENTIAL);
      expect(text(r)).not.toContain(TOKEN);
      expect(r.headers.authorization).toBe(`Bearer ${MODEL_KEY}`);
    }
    for (const r of [...runnerSide, ...mcpCalls]) expect(text(r)).not.toContain(MODEL_KEY);
    for (const r of mcpCalls) expect(text(r)).not.toContain(CREDENTIAL);
  });
});
