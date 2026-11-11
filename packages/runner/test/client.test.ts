import { inspect } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunnerTurn } from '@chess-goat/shared';
import {
  NetworkError,
  RunnerRevokedError,
  ServerError,
  createClient,
  isAbort,
  type Client,
} from '../src/client';
import { sendJson, startServer, type Handler, type TestServer } from './support/httpServer';

const CRED = 'cgrun_secretcredential123';
const CODE = 'LINKCODE-9876';
const UA = 'goat-runner/test';

const turn: RunnerTurn = {
  id: 7,
  claim_seq: 1,
  kind: 'move',
  bot: { id: 3, name: 'Botty' },
  persona: null,
  prompt: 'play',
  token: 'turntoken',
  expires_at: '2030-01-01T00:00:00.000Z',
  mcp_url: 'http://x/mcp',
};

const rel = { turn_id: 7, claim_seq: 1, reason: 'exited' as const };

let servers: TestServer[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
});

async function setup(handler: Handler, extra: { server?: (u: string) => string } = {}) {
  const srv = await startServer(handler);
  servers.push(srv);
  const client = createClient({
    server: extra.server ? extra.server(srv.url) : srv.url,
    credential: CRED,
    userAgent: UA,
    retryBaseMs: 10,
  });
  return { srv, client };
}

const err = (code: string, message = 'nope', reason?: string) => ({
  error: { code, message, ...(reason ? { reason } : {}) },
});

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

describe('link', () => {
  it('round-trips without an authorization header', async () => {
    const { srv, client } = await setup((_r, res) =>
      sendJson(res, 200, { credential: 'c', runner_id: 4, preset: 'claude', server: 'http://s' }),
    );
    const out = await client.link({ code: CODE, label: 'laptop' });
    expect(out).toEqual({ credential: 'c', runner_id: 4, preset: 'claude', server: 'http://s' });
    const req = srv.requests[0]!;
    expect(req.method).toBe('POST');
    expect(req.path).toBe('/runner/link');
    expect(req.body).toEqual({ code: CODE, label: 'laptop' });
    expect(req.headers.authorization).toBeUndefined();
    expect(req.headers['content-type']).toBe('application/json');
    expect(req.headers['user-agent']).toBe(UA);
  });

  it('carries reason link_code_invalid', async () => {
    const { client } = await setup((_r, res) =>
      sendJson(res, 400, err('validation', 'bad code', 'link_code_invalid')),
    );
    const e = (await caught(client.link({ code: CODE }))) as ServerError;
    expect(e).toBeInstanceOf(ServerError);
    expect([e.status, e.code, e.reason, e.message]).toEqual([
      400,
      'validation',
      'link_code_invalid',
      'bad code',
    ]);
  });

  it('surfaces code, reason and message of a 409', async () => {
    const { client } = await setup((_r, res) =>
      sendJson(res, 409, err('limit_exceeded', 'too many', 'too_many_runners')),
    );
    const e = (await caught(client.link({ code: CODE }))) as ServerError;
    expect([e.status, e.code, e.reason, e.message]).toEqual([
      409,
      'limit_exceeded',
      'too_many_runners',
      'too many',
    ]);
  });

  it('gives ServerError(500, null, null, "HTTP 500") for a non-JSON 500', async () => {
    const { client } = await setup((_r, res) => {
      res.writeHead(500, { 'content-type': 'text/html' });
      res.end('<h1>oops</h1>');
    });
    const e = (await caught(client.link({ code: CODE }))) as ServerError;
    expect([e.status, e.code, e.reason, e.message]).toEqual([500, null, null, 'HTTP 500']);
  });

  it('turns a malformed 2xx body into status 502', async () => {
    const { client } = await setup((_r, res) => sendJson(res, 200, { credential: 1 }));
    const e = (await caught(client.link({ code: CODE }))) as ServerError;
    expect(e).toBeInstanceOf(ServerError);
    expect([e.status, e.code, e.reason]).toEqual([502, null, null]);
    expect(e.message).toBe('unexpected response from the server');
  });

  it('gives a NetworkError naming only the host when the connection is refused', async () => {
    const srv = await startServer(() => {});
    const url = srv.url;
    await srv.close();
    const client = createClient({ server: url, credential: CRED, userAgent: UA });
    const e = await caught(client.link({ code: CODE }));
    expect(e).toBeInstanceOf(NetworkError);
    expect((e as Error).message).toContain(`127.0.0.1:${srv.port}`);
    expect((e as Error).message).not.toContain('/runner');
  });
});

describe('claim', () => {
  it('returns a turn, sending the bearer credential and user agent', async () => {
    const { srv, client } = await setup((_r, res) => sendJson(res, 200, { turn }));
    const out = await client.claim(
      { wait_seconds: 0, lease_seconds: 60 },
      new AbortController().signal,
    );
    expect(out).toEqual(turn);
    const req = srv.requests[0]!;
    expect(req.path).toBe('/runner/claim');
    expect(req.body).toEqual({ wait_seconds: 0, lease_seconds: 60 });
    expect(req.headers.authorization).toBe(`Bearer ${CRED}`);
    expect(req.headers['user-agent']).toBe(UA);
    expect(req.headers.accept).toBe('application/json');
  });

  it('returns null when there is no turn', async () => {
    const { client } = await setup((_r, res) => sendJson(res, 200, { turn: null }));
    expect(await client.claim({}, new AbortController().signal)).toBeNull();
  });

  it('maps 401 to RunnerRevokedError', async () => {
    const { client } = await setup((_r, res) => sendJson(res, 401, err('unauthorized')));
    const e = await caught(client.claim({}, new AbortController().signal));
    expect(e).toBeInstanceOf(RunnerRevokedError);
    expect((e as Error).message).toBe('This runner was revoked; link again.');
  });

  it('maps 429 to ServerError with status 429', async () => {
    const { client } = await setup((_r, res) => sendJson(res, 429, err('rate_limited', 'slow')));
    const e = (await caught(client.claim({}, new AbortController().signal))) as ServerError;
    expect(e).toBeInstanceOf(ServerError);
    expect([e.status, e.code]).toEqual([429, 'rate_limited']);
  });

  it('turns a malformed body into status 502', async () => {
    const { client } = await setup((_r, res) => sendJson(res, 200, { turn: { id: 'x' } }));
    const e = (await caught(client.claim({}, new AbortController().signal))) as ServerError;
    expect(e.status).toBe(502);
  });

  it('rejects within a second with an abort error and the server sees the socket close', async () => {
    const { srv, client } = await setup(() => {
      /* hold the poll open */
    });
    const ac = new AbortController();
    const p = client.claim({ wait_seconds: 50 }, ac.signal);
    const pending = caught(p);
    const seen = Date.now() + 2000;
    while (srv.requests.length === 0 && Date.now() < seen) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(srv.requests).toHaveLength(1);
    const t0 = Date.now();
    ac.abort();
    const e = await pending;
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(isAbort(e)).toBe(true);
    expect(e).not.toBeInstanceOf(NetworkError);
    const deadline = Date.now() + 1000;
    while (srv.closedSockets() === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(srv.closedSockets()).toBeGreaterThan(0);
  });

  it('does not call a network failure an abort', async () => {
    const srv = await startServer(() => {});
    const url = srv.url;
    await srv.close();
    const client = createClient({ server: url, credential: CRED, userAgent: UA });
    const e = await caught(client.claim({}, new AbortController().signal));
    expect(e).toBeInstanceOf(NetworkError);
    expect(isAbort(e)).toBe(false);
  });
});

describe('release', () => {
  it('resolves on 204 with the bearer credential', async () => {
    const { srv, client } = await setup((_r, res) => {
      res.writeHead(204);
      res.end();
    });
    await expect(client.release(rel)).resolves.toBeUndefined();
    expect(srv.requests[0]!.path).toBe('/runner/release');
    expect(srv.requests[0]!.headers.authorization).toBe(`Bearer ${CRED}`);
    expect(srv.requests[0]!.body).toEqual(rel);
  });

  it('retries a 503 then succeeds', async () => {
    let n = 0;
    const { srv, client } = await setup((_r, res) => {
      if (++n < 3) return sendJson(res, 503, err('internal'));
      res.writeHead(204);
      res.end();
    });
    await client.release(rel);
    expect(srv.requests).toHaveLength(3);
  });

  it('retries after a dropped connection', async () => {
    let n = 0;
    const { srv, client } = await setup((_r, res, raw) => {
      if (++n < 2) return void raw.socket.destroy();
      res.writeHead(204);
      res.end();
    });
    await client.release(rel);
    expect(srv.requests).toHaveLength(2);
  });

  it('gives up after 5 attempts on a persistent 503 with the last ServerError', async () => {
    let n = 0;
    const { srv, client } = await setup((_r, res) =>
      sendJson(res, 503, err('internal', `try ${++n}`)),
    );
    const e = (await caught(client.release(rel))) as ServerError;
    expect(srv.requests).toHaveLength(5);
    expect(e).toBeInstanceOf(ServerError);
    expect([e.status, e.message]).toEqual([503, 'try 5']);
  });

  it('does not retry a 400', async () => {
    const { srv, client } = await setup((_r, res) => sendJson(res, 400, err('validation')));
    const e = (await caught(client.release(rel))) as ServerError;
    expect(e.status).toBe(400);
    expect(srv.requests).toHaveLength(1);
  });

  it('does not retry a 401, which means revoked', async () => {
    const { srv, client } = await setup((_r, res) => sendJson(res, 401, err('unauthorized')));
    expect(await caught(client.release(rel))).toBeInstanceOf(RunnerRevokedError);
    expect(srv.requests).toHaveLength(1);
  });

  it('cuts detail to 2,000 characters', async () => {
    const { srv, client } = await setup((_r, res) => {
      res.writeHead(204);
      res.end();
    });
    await client.release({ ...rel, reason: 'error', detail: 'x'.repeat(5000) });
    const sent = srv.requests[0]!.body as { detail: string };
    expect(sent.detail).toHaveLength(2000);
  });

  it('does not cut a surrogate pair in half', async () => {
    const { srv, client } = await setup((_r, res) => {
      res.writeHead(204);
      res.end();
    });
    await client.release({ ...rel, reason: 'error', detail: 'x'.repeat(1999) + '😀😀' });
    const sent = (srv.requests[0]!.body as { detail: string }).detail;
    expect(sent).toBe('x'.repeat(1999));
  });
});

describe('server URL', () => {
  it('refuses credentials in the URL', () => {
    expect(() => createClient({ server: 'http://user:pw@host/', userAgent: UA })).toThrow(
      'the server URL must not contain credentials',
    );
  });

  it('refuses a non-http protocol and garbage', () => {
    expect(() => createClient({ server: 'ftp://host', userAgent: UA })).toThrow();
    expect(() => createClient({ server: 'not a url', userAgent: UA })).toThrow();
  });

  it('keeps a path prefix and drops trailing slashes', async () => {
    const { srv, client } = await setup((_r, res) => sendJson(res, 200, { turn: null }), {
      server: (u) => `${u}/base///`,
    });
    await client.claim({}, new AbortController().signal);
    expect(srv.requests[0]!.path).toBe('/base/runner/claim');
  });
});

describe('redirects', () => {
  it.each(['link', 'claim', 'release'] as const)('never follows a 308 on %s', async (route) => {
    const target = await setup((_r, res) => sendJson(res, 401, err('unauthorized')));
    const { srv, client } = await setup((_r, res) => {
      res.writeHead(308, { location: `${target.srv.url}/runner/${route}` });
      res.end();
    });
    const call =
      route === 'link'
        ? client.link({ code: CODE })
        : route === 'claim'
          ? client.claim({}, new AbortController().signal)
          : client.release(rel);
    const e = await caught(call);
    expect(e).not.toBeInstanceOf(RunnerRevokedError);
    expect(e).toBeInstanceOf(ServerError);
    const se = e as ServerError;
    expect([se.status, se.code, se.reason]).toEqual([308, null, 'redirect']);
    expect(se.message).toBe('the server redirected; check the server URL (http or https?)');
    expect(target.srv.requests).toHaveLength(0);
    expect(srv.requests).toHaveLength(1);
  });
});

/** A server that answers with `status` and streams `chunk` forever until the client hangs up. */
async function endless(status: number, chunk: string) {
  let closed: () => void = () => {};
  const hungUp = new Promise<void>((r) => (closed = r));
  const { srv, client } = await setup((_r, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.on('close', closed);
    const timer = setInterval(() => res.write(chunk), 1);
    res.on('close', () => clearInterval(timer));
  });
  return { srv, client, hungUp };
}

describe('bounded bodies', () => {
  it('stops reading an oversized 2xx body and answers 502', async () => {
    const { client, hungUp } = await endless(200, 'x'.repeat(1024));
    const e = (await caught(client.claim({}, new AbortController().signal))) as ServerError;
    expect([e.status, e.message]).toEqual([502, 'unexpected response from the server']);
    await hungUp;
  });

  it('stops reading an oversized error body and answers HTTP <status>', async () => {
    const { client, hungUp } = await endless(500, 'x'.repeat(1024));
    const e = (await caught(client.link({ code: CODE }))) as ServerError;
    expect([e.status, e.code, e.reason, e.message]).toEqual([500, null, null, 'HTTP 500']);
    await hungUp;
  });

  it('accepts a 2xx body just under the cap', async () => {
    const big = { turn: { ...turn, prompt: 'p'.repeat(900_000) } };
    const { client } = await setup((_r, res) => sendJson(res, 200, big));
    expect((await client.claim({}, new AbortController().signal))?.prompt).toHaveLength(900_000);
  });
});

describe('server-controlled text', () => {
  it('turns control characters into single spaces', async () => {
    const { client } = await setup((_r, res) =>
      sendJson(res, 409, err('validation', 'a\u001b[31mred\nline\t\u007fend', 'r\neason')),
    );
    const e = (await caught(client.link({ code: CODE }))) as ServerError;
    expect(e.message).toBe('a [31mred line end');
    expect(e.reason).toBe('r eason');
  });

  it('cuts a long message to 500 and a long reason to 64', async () => {
    const { client } = await setup((_r, res) =>
      sendJson(res, 409, err('validation', 'm'.repeat(5000), 'r'.repeat(500))),
    );
    const e = (await caught(client.link({ code: CODE }))) as ServerError;
    expect(e.message).toHaveLength(500);
    expect(e.reason).toHaveLength(64);
  });

  it('redacts an echoed credential', async () => {
    const { client } = await setup((_r, res) =>
      sendJson(res, 409, err('validation', `bad ${CRED} and ${CRED}`, `x${CRED}`)),
    );
    const e = (await caught(client.release(rel))) as ServerError;
    expect(e.message).toBe('bad [redacted] and [redacted]');
    expect(e.reason).not.toContain(CRED);
  });
});

describe('minor behaviours', () => {
  it('release aborts during a backoff wait', async () => {
    const srv = await startServer((_r, res) => sendJson(res, 503, err('internal')));
    servers.push(srv);
    const client = createClient({
      server: srv.url,
      credential: CRED,
      userAgent: UA,
      retryBaseMs: 60_000,
    });
    const ac = new AbortController();
    const p = caught(client.release(rel, ac.signal));
    const until = Date.now() + 2000;
    while (srv.requests.length === 0 && Date.now() < until)
      await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 20));
    const t0 = Date.now();
    ac.abort();
    const e = await p;
    expect(isAbort(e)).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(srv.requests).toHaveLength(1);
  });

  it('release surfaces a 429 without retrying', async () => {
    const { srv, client } = await setup((_r, res) => sendJson(res, 429, err('rate_limited')));
    const e = (await caught(client.release(rel))) as ServerError;
    expect(e.status).toBe(429);
    expect(srv.requests).toHaveLength(1);
  });

  it('claim and release without a credential throw "not linked" before any request', async () => {
    const srv = await startServer((_r, res) => sendJson(res, 401, err('unauthorized')));
    servers.push(srv);
    const client = createClient({ server: srv.url, userAgent: UA });
    for (const call of [
      () => client.claim({}, new AbortController().signal),
      () => client.release(rel),
    ]) {
      const e = (await caught(call())) as Error;
      expect(e.message).toBe('not linked');
      expect(e).not.toBeInstanceOf(RunnerRevokedError);
    }
    expect(srv.requests).toHaveLength(0);
  });

  it('a 401 on link is a plain ServerError', async () => {
    const { client } = await setup((_r, res) => sendJson(res, 401, err('unauthorized', 'no')));
    const e = await caught(client.link({ code: CODE }));
    expect(e).toBeInstanceOf(ServerError);
    expect(e).not.toBeInstanceOf(RunnerRevokedError);
    expect((e as ServerError).status).toBe(401);
  });

  it('an empty 200 on claim is the 502 error', async () => {
    const { client } = await setup((_r, res) => {
      res.writeHead(200);
      res.end();
    });
    const e = (await caught(client.claim({}, new AbortController().signal))) as ServerError;
    expect([e.status, e.message]).toEqual([502, 'unexpected response from the server']);
  });

  it('drops query and fragment from the server URL', async () => {
    const { srv, client } = await setup((_r, res) => sendJson(res, 200, { turn: null }), {
      server: (u) => `${u}/base?x=1#frag`,
    });
    await client.claim({}, new AbortController().signal);
    expect(srv.requests[0]!.path).toBe('/base/runner/claim');
  });

  it('talks to an IPv6 literal server', async (ctx) => {
    let srv: TestServer;
    try {
      srv = await startServer((_r, res) => sendJson(res, 200, { turn: null }), '::1');
    } catch {
      return ctx.skip();
    }
    servers.push(srv);
    const client = createClient({ server: srv.url, credential: CRED, userAgent: UA });
    expect(await client.claim({}, new AbortController().signal)).toBeNull();
  });
});

describe('NetworkError detail', () => {
  it('says "connection refused" for a refused connection', async () => {
    const srv = await startServer(() => {});
    const url = srv.url;
    await srv.close();
    const client = createClient({ server: url, credential: CRED, userAgent: UA });
    const e = (await caught(client.link({ code: CODE }))) as Error;
    expect(e).toBeInstanceOf(NetworkError);
    expect(e.message).toBe(`could not reach 127.0.0.1:${srv.port}: connection refused`);
  });

  it('says "host not found" for an unresolvable host', async () => {
    const client = createClient({ server: 'http://goat.invalid', credential: CRED, userAgent: UA });
    const e = (await caught(client.link({ code: CODE }))) as Error;
    expect(e).toBeInstanceOf(NetworkError);
    expect(e.message).toBe('could not reach goat.invalid: host not found');
  });

  it.each([
    ['ECONNRESET', 'connection reset'],
    ['CERT_HAS_EXPIRED', 'certificate not trusted'],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'certificate not trusted'],
    ['EWHATEVER', 'connection failed'],
  ])('maps %s to "%s", also when nested', async (code, text) => {
    const fake = (async () => {
      throw new TypeError('fetch failed', { cause: { cause: { code, message: CRED } } });
    }) as unknown as typeof fetch;
    const client = createClient({
      server: 'http://h.test',
      credential: CRED,
      userAgent: UA,
      fetch: fake,
    });
    const e = (await caught(client.link({ code: CODE }))) as Error;
    expect(e.message).toBe(`could not reach h.test: ${text}`);
  });
});

describe('secrets in errors', () => {
  it('no error kind contains the credential, the link code or a turn token', async () => {
    const TOKEN = 'TURNTOKEN-distinctive-777';
    const dead = await startServer(() => {});
    const deadUrl = dead.url;
    await dead.close();
    const cases: Array<() => Promise<unknown>> = [];
    const add = async (h: Handler, call: (c: Client) => Promise<unknown>) => {
      const { client } = await setup(h);
      cases.push(() => call(client));
    };
    const noAbort = () => new AbortController().signal;
    await add(
      (_r, res) => sendJson(res, 401, err('unauthorized')),
      (c) => c.claim({}, noAbort()),
    );
    await add(
      (_r, res) => sendJson(res, 401, err('unauthorized')),
      (c) => c.release(rel),
    );
    await add(
      (_r, res) => sendJson(res, 409, err('validation', 'bad')),
      (c) => c.link({ code: CODE }),
    );
    await add(
      (_r, res) => sendJson(res, 409, err('validation', `echo ${CRED}`, CRED)),
      (c) => c.link({ code: CODE }),
    );
    await add(
      (_r, res) => {
        res.writeHead(500);
        res.end(`${CRED} ${CODE} ${TOKEN}`);
      },
      (c) => c.link({ code: CODE }),
    );
    await add(
      (_r, res) => {
        res.writeHead(200);
        res.end(`{"credential":"${CRED}"}`);
      },
      (c) => c.link({ code: CODE }),
    );
    await add(
      (_r, res) => sendJson(res, 200, { turn: { ...turn, id: 'x', token: TOKEN } }),
      (c) => c.claim({}, noAbort()),
    );
    await add(
      (_r, res) => {
        res.writeHead(307, { location: `http://example.invalid/?${CRED}` });
        res.end();
      },
      (c) => c.claim({}, noAbort()),
    );
    const net = createClient({ server: deadUrl, credential: CRED, userAgent: UA, retryBaseMs: 10 });
    cases.push(() => net.link({ code: CODE }));
    cases.push(() => net.release(rel));
    const ac = new AbortController();
    await add(
      () => {},
      (c) => {
        const p = c.claim({}, ac.signal);
        setTimeout(() => ac.abort(), 30);
        return p;
      },
    );
    const unlinked = createClient({ server: deadUrl, userAgent: UA });
    cases.push(() => unlinked.claim({}, noAbort()));

    for (const run of cases) {
      const e = (await caught(run())) as Error;
      for (const text of [
        String(e),
        e.message,
        JSON.stringify(e, Object.getOwnPropertyNames(e)),
        inspect(e, { depth: 5 }),
      ]) {
        for (const secret of [CRED, CODE, TOKEN]) expect(text).not.toContain(secret);
      }
    }
  });
});
