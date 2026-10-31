import { ApiErrorBodySchema, type ErrorCode } from '@chess-goat/shared';
import type { ZodType } from 'zod';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | 'network',
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get isNetwork(): boolean {
    return this.code === 'network';
  }
}

export type ApiClientOptions = {
  /** Origin prefix; empty means same origin. */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Runs once per request on a 401; resolves a fresh token (a relaunch) or null to give up. */
  onUnauthorized?: () => Promise<string | null>;
};

export type RequestOptions<T> = { body?: unknown; schema?: ZodType<T>; auth?: boolean };

export interface ApiClient {
  readonly token: string | null;
  setToken(token: string | null): void;
  request<T = unknown>(method: string, path: string, options?: RequestOptions<T>): Promise<T>;
  get<T>(path: string, schema: ZodType<T>): Promise<T>;
  post<T = unknown>(path: string, body: unknown, schema?: ZodType<T>): Promise<T>;
  put<T = unknown>(path: string, body: unknown, schema?: ZodType<T>): Promise<T>;
  del<T = unknown>(path: string, schema?: ZodType<T>): Promise<T>;
  url(path: string, query?: Record<string, string>): string;
}

/** Spec §6.1 step 6 and §9: bearer token in memory, spec error bodies, one relaunch on 401. */
export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const baseUrl = (options.baseUrl ?? '').replace(/\/$/, '');
  const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  let token: string | null = null;

  const url = (path: string, query?: Record<string, string>): string => {
    const params = query ? new URLSearchParams(query).toString() : '';
    return `${baseUrl}${path}${params ? `?${params}` : ''}`;
  };

  async function once(
    method: string,
    path: string,
    body: unknown,
    auth: boolean,
  ): Promise<{ response: Response; json: unknown }> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (auth && token) headers.authorization = `Bearer ${token}`;
    let response: Response;
    try {
      response = await fetchImpl(url(path), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new ApiError(0, 'network', error instanceof Error ? error.message : 'network error');
    }
    const text = await response.text();
    let json: unknown = undefined;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    return { response, json };
  }

  const client: ApiClient = {
    get token() {
      return token;
    },
    setToken(next) {
      token = next;
    },
    async request<T>(method: string, path: string, requestOptions: RequestOptions<T> = {}) {
      const auth = requestOptions.auth ?? true;
      let { response, json } = await once(method, path, requestOptions.body, auth);
      if (response.status === 401 && auth && options.onUnauthorized) {
        const fresh = await options.onUnauthorized();
        if (fresh) {
          token = fresh;
          ({ response, json } = await once(method, path, requestOptions.body, auth));
        }
      }
      if (!response.ok) {
        const parsed = ApiErrorBodySchema.safeParse(json);
        if (parsed.success) {
          throw new ApiError(response.status, parsed.data.error.code, parsed.data.error.message);
        }
        throw new ApiError(response.status, 'internal', `HTTP ${response.status}`);
      }
      return (requestOptions.schema ? requestOptions.schema.parse(json) : json) as T;
    },
    get: (path, schema) => client.request('GET', path, { schema }),
    post: (path, body, schema) => client.request('POST', path, { body, schema }),
    put: (path, body, schema) => client.request('PUT', path, { body, schema }),
    del: (path, schema) => client.request('DELETE', path, { schema }),
    url,
  };
  return client;
}
