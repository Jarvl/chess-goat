import type { Db } from '../../src/db/client';
import type { Config } from '../../src/config';
import type { UserRow } from '../../src/db/schema';
import { createLinkCode } from '../../src/domain/runners';
import { mcpRoutes } from '../../src/mcp/routes';
import { runnerRoutes, type RunnerEndpointOptions } from '../../src/runner/routes';
import type { RunnerClaimRequest, RunnerClaimResponse } from '@chess-goat/shared';
import { startTestApi, type TestApi } from './api';

/** A test API with `/mcp` and `/runner` mounted beside `/api`, as `main.ts` mounts them. */
export async function startTestRunner(
  db: Db,
  configOverrides: Partial<Config> = {},
  opts: RunnerEndpointOptions = {},
): Promise<TestApi> {
  const api = await startTestApi(db, undefined, configOverrides);
  api.app.route('/', mcpRoutes(api.ctx));
  api.app.route('/', runnerRoutes(api.ctx, opts));
  return api;
}

/** Makes a link code for `owner` and redeems it over HTTP; returns the runner's credential. */
export async function linkRunner(
  api: TestApi,
  owner: Pick<UserRow, 'id'>,
  input: { botIds?: number[] } = {},
): Promise<{ credential: string; runnerId: number }> {
  const { code } = await createLinkCode(api.deps.db, owner.id, input, new Date());
  const res = await api.request('POST', '/runner/link', { body: { code } });
  if (res.status !== 200) throw new Error(`link failed: HTTP ${res.status}`);
  const body = (await res.json()) as { credential: string; runner_id: number };
  return { credential: body.credential, runnerId: body.runner_id };
}

/** `POST /runner/claim`; the response and its parsed body. */
export async function claim(
  api: TestApi,
  credential: string,
  body: RunnerClaimRequest = { wait_seconds: 0 },
  signal?: AbortSignal,
): Promise<{ status: number; res: Response; body: RunnerClaimResponse }> {
  const res = await api.request('POST', '/runner/claim', { token: credential, body, signal });
  const text = await res.text();
  return { status: res.status, res, body: (text ? JSON.parse(text) : null) as RunnerClaimResponse };
}
