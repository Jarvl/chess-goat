import { OwnerRunnersDtoSchema } from '@chess-goat/shared';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { runners } from '../../src/db/schema';
import { startTestApi, type TestApi } from '../helpers/api';
import { openTestDb, truncateAll } from '../helpers/db';
import { insertBot, insertUser } from '../helpers/fixtures';

const { db, close } = openTestDb();
let api: TestApi;

beforeEach(async () => {
  if (api) await api.stop();
  await truncateAll(db);
  api = await startTestApi(db);
});
afterAll(async () => {
  await api?.stop();
  await close();
});

const insertRunner = async (ownerId: number, values: Partial<typeof runners.$inferInsert> = {}) =>
  (
    await db
      .insert(runners)
      .values({ ownerId, label: 'box', credentialHash: randomBytes(32), ...values })
      .returning()
  )[0]!;

describe('GET /api/me/runners', () => {
  it("lists the caller's runners and nobody else's", async () => {
    const owner = await insertUser(db);
    const other = await insertUser(db);
    const bot = await insertBot(db, owner);
    const seen = new Date();
    const live = await insertRunner(owner.id, {
      label: 'laptop',
      harness: 'claude',
      lastSeenAt: seen,
    });
    const idle = await insertRunner(owner.id, { label: 'desktop', botIds: [bot.id] });
    await insertRunner(other.id, { label: 'theirs' });
    const res = await api.request('GET', '/api/me/runners', { token: await api.sessionFor(owner) });
    expect(res.status).toBe(200);
    expect(OwnerRunnersDtoSchema.parse(await res.json()).runners).toEqual([
      {
        id: live.id,
        label: 'laptop',
        harness: 'claude',
        bots: 'all',
        connected: true,
        lastSeenAt: seen.toISOString(),
      },
      {
        id: idle.id,
        label: 'desktop',
        harness: null,
        bots: [bot.firstName],
        connected: false,
        lastSeenAt: null,
      },
    ]);
  });

  it('needs a session', async () => {
    expect((await api.request('GET', '/api/me/runners')).status).toBe(401);
  });
});

describe('DELETE /api/me/runners/:id', () => {
  it('deletes its own runner', async () => {
    const owner = await insertUser(db);
    const mine = await insertRunner(owner.id);
    const res = await api.request('DELETE', `/api/me/runners/${mine.id}`, {
      token: await api.sessionFor(owner),
    });
    expect(res.status).toBe(204);
    expect(await db.select().from(runners).where(eq(runners.id, mine.id))).toEqual([]);
  });

  it("404s on another owner's runner and leaves it", async () => {
    const owner = await insertUser(db);
    const other = await insertUser(db);
    const theirs = await insertRunner(other.id);
    const res = await api.request('DELETE', `/api/me/runners/${theirs.id}`, {
      token: await api.sessionFor(owner),
    });
    expect(res.status).toBe(404);
    expect(await db.select().from(runners).where(eq(runners.id, theirs.id))).toHaveLength(1);
  });

  it('404s on a missing runner', async () => {
    const res = await api.request('DELETE', '/api/me/runners/999999', {
      token: await api.sessionFor(await insertUser(db)),
    });
    expect(res.status).toBe(404);
  });

  it('400s on an id that is not a positive integer', async () => {
    const token = await api.sessionFor(await insertUser(db));
    for (const bad of ['abc', '0', '-1', '1.5'])
      expect((await api.request('DELETE', `/api/me/runners/${bad}`, { token })).status).toBe(400);
  });

  it('needs a session', async () => {
    expect((await api.request('DELETE', '/api/me/runners/1')).status).toBe(401);
  });
});
