import {
  ApiErrorBodySchema,
  RunnerClaimResponseSchema,
  RunnerLinkResponseSchema,
  type RunnerClaimRequest,
  type RunnerLinkRequest,
  type RunnerLinkResponse,
  type RunnerReleaseRequest,
  type RunnerTurn,
} from '@chess-goat/shared';
import type { ZodType } from 'zod';

// Errors here carry status, code and reason only: never a body, header or request, which hold
// the credential, link codes and turn tokens.

export class RunnerRevokedError extends Error {
  constructor() {
    super('This runner was revoked; link again.');
    this.name = 'RunnerRevokedError';
  }
}

export class ServerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    readonly reason: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'ServerError';
  }
}

/** The server could not be reached, or the connection broke or timed out. */
export class NetworkError extends Error {
  constructor(host: string, what: string) {
    super(`could not reach ${host}: ${what}`);
    this.name = 'NetworkError';
  }
}

export function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export type Client = {
  link(body: RunnerLinkRequest): Promise<RunnerLinkResponse>;
  claim(body: RunnerClaimRequest, signal: AbortSignal): Promise<RunnerTurn | null>;
  release(body: RunnerReleaseRequest): Promise<void>;
};

export type ClientOptions = {
  server: string;
  credential?: string;
  userAgent: string;
  fetch?: typeof fetch;
  /** Wait before the first `release` retry; doubles each time (a test seam). */
  retryBaseMs?: number;
};

const LINK_TIMEOUT_MS = 30_000;
const RELEASE_TIMEOUT_MS = 30_000;
const CLAIM_DEFAULT_WAIT_S = 50;
const CLAIM_MARGIN_S = 15;
const RELEASE_ATTEMPTS = 5;
const DETAIL_MAX = 2000;

function parseServer(server: string): URL {
  let url: URL;
  try {
    url = new URL(server);
  } catch {
    throw new Error('the server URL is not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('the server URL must be http or https');
  }
  if (url.username || url.password) throw new Error('the server URL must not contain credentials');
  return url;
}

function abortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createClient(opts: ClientOptions): Client {
  const url = parseServer(opts.server);
  const base = url.origin + url.pathname.replace(/\/+$/, '');
  const doFetch = opts.fetch ?? fetch;
  const retryBaseMs = opts.retryBaseMs ?? 1000;

  /** One JSON POST; resolves with the status and raw text of a response, or throws. */
  async function post(
    route: string,
    body: unknown,
    auth: boolean,
    timeoutMs: number,
    caller?: AbortSignal,
  ): Promise<{ status: number; text: string }> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': opts.userAgent,
    };
    if (auth && opts.credential) headers.authorization = `Bearer ${opts.credential}`;
    const signal = caller
      ? AbortSignal.any([caller, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);
    try {
      const res = await doFetch(`${base}/runner/${route}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      });
      return { status: res.status, text: await res.text() };
    } catch (error) {
      if (caller?.aborted) throw abortError();
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      throw new NetworkError(url.host, timedOut ? 'timed out' : 'connection failed');
    }
  }

  function failure(status: number, text: string, revokable: boolean): Error {
    if (status === 401 && revokable) return new RunnerRevokedError();
    let parsed: ReturnType<typeof ApiErrorBodySchema.safeParse> | undefined;
    try {
      parsed = ApiErrorBodySchema.safeParse(JSON.parse(text));
    } catch {
      parsed = undefined;
    }
    if (parsed?.success) {
      const { code, reason, message } = parsed.data.error;
      return new ServerError(status, code, reason ?? null, message);
    }
    return new ServerError(status, null, null, `HTTP ${status}`);
  }

  function parseOk<T>(text: string, schema: ZodType<T>): T {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new ServerError(502, null, null, 'unexpected response from the server');
    }
    return parsed.data;
  }

  return {
    async link(body) {
      const { status, text } = await post('link', body, false, LINK_TIMEOUT_MS);
      if (status < 200 || status > 299) throw failure(status, text, false);
      return parseOk(text, RunnerLinkResponseSchema);
    },

    async claim(body, signal) {
      const timeout = ((body.wait_seconds ?? CLAIM_DEFAULT_WAIT_S) + CLAIM_MARGIN_S) * 1000;
      const { status, text } = await post('claim', body, true, timeout, signal);
      if (status < 200 || status > 299) throw failure(status, text, true);
      return parseOk(text, RunnerClaimResponseSchema).turn;
    },

    async release(body) {
      const sent = body.detail === undefined ? body : { ...body, detail: cut(body.detail) };
      for (let attempt = 1; ; attempt++) {
        let error: Error;
        try {
          const { status, text } = await post('release', sent, true, RELEASE_TIMEOUT_MS);
          if (status >= 200 && status <= 299) return;
          error = failure(status, text, true);
        } catch (e) {
          error = e as Error;
        }
        const retryable =
          error instanceof NetworkError || (error instanceof ServerError && error.status >= 500);
        if (!retryable || attempt >= RELEASE_ATTEMPTS) throw error;
        await sleep(retryBaseMs * 2 ** (attempt - 1));
      }
    },
  };
}

/** At most 2,000 UTF-16 units, which is what the server's zod `max` counts; never splits a pair. */
function cut(detail: string): string {
  if (detail.length <= DETAIL_MAX) return detail;
  let end = DETAIL_MAX;
  const last = detail.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return detail.slice(0, end);
}
