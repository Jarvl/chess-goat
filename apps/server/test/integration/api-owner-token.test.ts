import {
  HTTP_STATUS_BY_ERROR_CODE,
  OkDtoSchema,
  OwnerTokenCreatedDtoSchema,
  OwnerTokenStatusDtoSchema,
} from '@chess-goat/shared';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { resolveOwnerToken } from '../../src/domain/ownerTokens';
import { startTestApi, type TestApi } from '../helpers/api';
import { openTestDb, truncateAll } from '../helpers/db';
import { insertUser } from '../helpers/fixtures';

const { db, close } = openTestDb();
let api: TestApi;

// A fresh app per case: the token rate limiter lives on the route instance.
beforeEach(async () => {
  if (api) await api.stop();
  await truncateAll(db);
  api = await startTestApi(db);
});
afterAll(async () => {
  await api?.stop();
  await close();
});

const status = async (token: string) =>
  OwnerTokenStatusDtoSchema.parse(
    await (await api.request('GET', '/api/me/owner-token', { token })).json(),
  );
const create = async (token: string) => {
  const res = await api.request('POST', '/api/me/owner-token', { token });
  expect(res.status).toBe(200);
  return OwnerTokenCreatedDtoSchema.parse(await res.json());
};

describe('owner token API', () => {
  it('reports no token before one is made', async () => {
    const session = await api.sessionFor(await insertUser(db));
    expect(await status(session)).toEqual({ token: null });
  });

  it('creates a cgbot_ token and then reports it', async () => {
    const session = await api.sessionFor(await insertUser(db));
    const created = await create(session);
    expect(created.token.startsWith('cgbot_')).toBe(true);
    const s = await status(session);
    expect(s.token?.createdAt).toBe(created.createdAt);
    expect(s.token?.lastUsedAt).toBeNull();
  });

  it('rotates on a second create', async () => {
    const user = await insertUser(db);
    const session = await api.sessionFor(user);
    const first = await create(session);
    const second = await create(session);
    expect(await resolveOwnerToken(db, first.token)).toBeNull();
    expect((await resolveOwnerToken(db, second.token))?.id).toBe(user.id);
  });

  it('revokes on delete', async () => {
    const session = await api.sessionFor(await insertUser(db));
    const { token } = await create(session);
    const res = await api.request('DELETE', '/api/me/owner-token', { token: session });
    expect(OkDtoSchema.parse(await res.json())).toEqual({ ok: true });
    expect(await status(session)).toEqual({ token: null });
    expect(await resolveOwnerToken(db, token)).toBeNull();
  });

  it('rate-limits the sixth create within a minute', async () => {
    const session = await api.sessionFor(await insertUser(db));
    for (let i = 0; i < 5; i++) await create(session);
    const res = await api.request('POST', '/api/me/owner-token', { token: session });
    expect(res.status).toBe(HTTP_STATUS_BY_ERROR_CODE.rate_limited);
  });

  it('is not a session: it opens no existing route', async () => {
    const session = await api.sessionFor(await insertUser(db));
    const { token } = await create(session);
    const bad = await api.request('GET', '/api/me/groups', { token: 'not-a-session' });
    const res = await api.request('GET', '/api/me/groups', { token });
    expect(res.status).toBe(bad.status);
    expect(res.status).toBe(401);
  });
});
