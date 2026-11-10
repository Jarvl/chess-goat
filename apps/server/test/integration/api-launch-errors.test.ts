import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestApi, type TestApi } from '../helpers/api';
import { openTestDb, truncateAll } from '../helpers/db';
import { signInitData } from '../helpers/initData';

vi.mock('../../src/domain/users', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/domain/users')>('../../src/domain/users');
  return {
    ...actual,
    ensureUser: () => Promise.reject(new Error('database gone')),
  };
});

const { db, close } = openTestDb();
let api: TestApi;

beforeAll(async () => {
  api = await startTestApi(db);
});
beforeEach(async () => {
  await truncateAll(db);
});
afterAll(async () => {
  await api.stop();
  await close();
});

describe('POST /api/launch when the server fails', () => {
  it('answers 500 and counts the failure as a Mini App load error', async () => {
    const res = await api.request('POST', '/api/launch', {
      body: {
        initData: signInitData(api.config.BOT_TOKEN, {
          user: { id: 11, first_name: 'Alice', username: 'alice' },
        }),
      },
    });
    expect(res.status).toBe(500);
    const metrics = await api.ctx.metrics.registry.metrics();
    expect(metrics).toContain('miniapp_load_errors_total 1');
  });
});
