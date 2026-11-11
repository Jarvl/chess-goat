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
import { abortError, cleanText, isAbort, networkDetail, readLimited } from './http.js';

export { isAbort };

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

export type Client = {
  link(body: RunnerLinkRequest): Promise<RunnerLinkResponse>;
  claim(body: RunnerClaimRequest, signal: AbortSignal): Promise<RunnerTurn | null>;
  release(body: RunnerReleaseRequest, signal?: AbortSignal): Promise<void>;
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
const OK_BODY_MAX = 1024 * 1024;
const ERROR_BODY_MAX = 16 * 1024;
const MESSAGE_MAX = 500;
const CODE_MAX = 64;
const REDIRECT_MESSAGE = 'the server redirected; check the server URL (http or https?)';
const UNEXPECTED = 'unexpected response from the server';

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

/** Waits `ms`, or rejects with the abort error as soon as `signal` fires. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      done();
      reject(abortError());
    };
    const timer = setTimeout(() => {
      done();
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function createClient(opts: ClientOptions): Client {
  const url = parseServer(opts.server);
  const base = url.origin + url.pathname.replace(/\/+$/, '');
  const doFetch = opts.fetch ?? fetch;
  const retryBaseMs = opts.retryBaseMs ?? 1000;

  /** Server text made safe to show: no credential, no control characters, bounded. */
  function clean(text: string, max: number): string {
    const redacted = opts.credential ? text.split(opts.credential).join('[redacted]') : text;
    return cleanText(redacted, max);
  }

  /** One JSON POST; resolves with the status and raw text of a response, or throws. */
  async function post(
    route: string,
    body: unknown,
    auth: boolean,
    timeoutMs: number,
    caller?: AbortSignal,
  ): Promise<{ status: number; text: string | null }> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': opts.userAgent,
    };
    if (auth) headers.authorization = `Bearer ${opts.credential}`;
    const signal = caller
      ? AbortSignal.any([caller, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);
    try {
      const res = await doFetch(`${base}/runner/${route}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
        // A redirect can drop Authorization and read as a revocation; never follow one.
        redirect: 'manual',
      });
      const ok = res.status >= 200 && res.status <= 299;
      const redirect = res.status >= 300 && res.status <= 399;
      if (redirect) {
        await res.body?.cancel().catch(() => {});
        return { status: res.status, text: '' };
      }
      return {
        status: res.status,
        text: await readLimited(res, ok ? OK_BODY_MAX : ERROR_BODY_MAX),
      };
    } catch (error) {
      if (caller?.aborted) throw abortError();
      throw new NetworkError(url.host, networkDetail(error));
    }
  }

  function failure(status: number, text: string | null, revokable: boolean): Error {
    if (status >= 300 && status <= 399)
      return new ServerError(status, null, 'redirect', REDIRECT_MESSAGE);
    if (status === 401 && revokable) return new RunnerRevokedError();
    let parsed: ReturnType<typeof ApiErrorBodySchema.safeParse> | undefined;
    try {
      parsed = text === null ? undefined : ApiErrorBodySchema.safeParse(JSON.parse(text));
    } catch {
      parsed = undefined;
    }
    if (parsed?.success) {
      const { code, reason, message } = parsed.data.error;
      return new ServerError(
        status,
        clean(code, CODE_MAX),
        reason === undefined ? null : clean(reason, CODE_MAX),
        clean(message, MESSAGE_MAX),
      );
    }
    return new ServerError(status, null, null, `HTTP ${status}`);
  }

  function parseOk<T>(text: string | null, schema: ZodType<T>): T {
    let json: unknown;
    try {
      json = text === null ? undefined : JSON.parse(text);
    } catch {
      json = undefined;
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new ServerError(502, null, null, UNEXPECTED);
    return parsed.data;
  }

  return {
    async link(body) {
      const { status, text } = await post('link', body, false, LINK_TIMEOUT_MS);
      if (status < 200 || status > 299) throw failure(status, text, false);
      return parseOk(text, RunnerLinkResponseSchema);
    },

    async claim(body, signal) {
      if (!opts.credential) throw new Error('not linked');
      const timeout = ((body.wait_seconds ?? CLAIM_DEFAULT_WAIT_S) + CLAIM_MARGIN_S) * 1000;
      const { status, text } = await post('claim', body, true, timeout, signal);
      if (status < 200 || status > 299) throw failure(status, text, true);
      return parseOk(text, RunnerClaimResponseSchema).turn;
    },

    async release(body, signal) {
      if (!opts.credential) throw new Error('not linked');
      const sent = body.detail === undefined ? body : { ...body, detail: cut(body.detail) };
      for (let attempt = 1; ; attempt++) {
        let error: Error;
        try {
          const { status, text } = await post('release', sent, true, RELEASE_TIMEOUT_MS, signal);
          if (status >= 200 && status <= 299) return;
          error = failure(status, text, true);
        } catch (e) {
          error = e as Error;
        }
        const retryable =
          error instanceof NetworkError || (error instanceof ServerError && error.status >= 500);
        if (!retryable || attempt >= RELEASE_ATTEMPTS) throw error;
        await sleep(retryBaseMs * 2 ** (attempt - 1), signal);
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
