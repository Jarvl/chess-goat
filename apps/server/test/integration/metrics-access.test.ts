import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApi, type TestApi } from '../helpers/api';
import { openTestDb } from '../helpers/db';

const { db, close } = openTestDb();
const TOKEN = 'm'.repeat(40);
let open: TestApi;
let guarded: TestApi;

beforeAll(async () => {
  open = await startTestApi(db, [], { METRICS_TOKEN: undefined });
  guarded = await startTestApi(db, [], { METRICS_TOKEN: TOKEN });
});
afterAll(async () => {
  await open.stop();
  await guarded.stop();
  await close();
});

const get = (api: TestApi, authorization?: string) =>
  api.request('GET', '/metrics', { headers: authorization ? { authorization } : {} });

describe('GET /metrics access', () => {
  it('hides /metrics when no token is configured', async () => {
    expect((await get(open)).status).toBe(404);
    expect((await get(open, `Bearer ${'x'.repeat(40)}`)).status).toBe(404);
  });

  it('hides /metrics from a missing, wrong or wrong-length token', async () => {
    expect((await get(guarded)).status).toBe(404);
    expect((await get(guarded, `Bearer ${'x'.repeat(40)}`)).status).toBe(404);
    expect((await get(guarded, 'Bearer short')).status).toBe(404);
    expect((await get(guarded, `Bearer ${'m'.repeat(41)}`)).status).toBe(404);
    expect((await get(guarded, `Bearer ${'é' + 'm'.repeat(39)}`)).status).toBe(404);
    expect((await get(guarded, `Basic ${'m'.repeat(40)}`)).status).toBe(404);
  });

  it('serves /metrics to the right bearer token', async () => {
    const res = await get(guarded, `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('moves_total');
  });
});
