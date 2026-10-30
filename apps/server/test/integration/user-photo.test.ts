import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { jobs, userPhotos, users, type UserRow } from '../../src/db/schema';
import { getPhotoBytes, getPhotoRow, photoHash, storePhoto } from '../../src/domain/photos';
import { requireUser } from '../../src/domain/users';
import { userPhotoJobHandlers } from '../../src/jobs/handlers/userPhoto';
import { enqueue } from '../../src/jobs/queue';
import type { JobWorker } from '../../src/jobs/worker';
import { createLogger } from '../../src/logger';

import { testConfig } from '../helpers/config';
import { openTestDb, testDeps, truncateAll } from '../helpers/db';
import type { FakeTelegram } from '../helpers/fakeTelegram';
import { insertUser } from '../helpers/fixtures';
import { FIXTURE_JPEG, OTHER_JPEG } from '../helpers/photos';
import { jobWorker } from '../helpers/worker';

const { db, close } = openTestDb();
const logLines: string[] = [];
const deps = {
  ...testDeps(db),
  log: createLogger('debug', { write: (line) => logLines.push(line) }),
};
const config = testConfig();
let fake: FakeTelegram;
let worker: JobWorker;

beforeAll(async () => {
  ({ fake, worker } = await jobWorker(deps, userPhotoJobHandlers, { throttle: false }));
});
beforeEach(async () => {
  await truncateAll(db);
  fake.reset();
  logLines.length = 0;
});
afterAll(async () => {
  await fake.stop();
  await close();
});

async function fetchFor(user: UserRow): Promise<void> {
  await enqueue(db, {
    kind: 'fetch_user_photo',
    payload: { userId: user.id },
    dedupKey: `photo:${user.id}`,
  });
  await worker.runOnce();
}

const photoJob = async () => {
  const [row] = await db.select().from(jobs).where(eq(jobs.kind, 'fetch_user_photo'));
  return row!;
};

async function withStoredPhoto(): Promise<UserRow> {
  const user = await insertUser(db);
  await storePhoto(db, user.id, { fileUniqueId: 'u-1', bytes: FIXTURE_JPEG });
  await db
    .update(userPhotos)
    .set({ checkedAt: sql`now() - interval '2 days'` })
    .where(eq(userPhotos.userId, user.id));
  return user;
}

async function expectOldPhotoKept(user: UserRow): Promise<void> {
  const job = await photoJob();
  expect(job.doneAt).toBeNull();
  expect(job.attempts).toBe(1);
  expect(job.lastError).toBeTruthy();
  expect((await getPhotoRow(db, user.id))?.hash).toBe(photoHash(FIXTURE_JPEG));
  expect((await requireUser(db, user.id)).photoHash).toBe(photoHash(FIXTURE_JPEG));
}

describe('fetch_user_photo', () => {
  it("stores the newest photo's small size", async () => {
    const user = await insertUser(db);
    fake.photos.set(user.telegramUserId!, { fileUniqueId: 'u-1', bytes: FIXTURE_JPEG });
    await fetchFor(user);
    const row = await getPhotoRow(db, user.id);
    expect(row?.fileUniqueId).toBe('u-1');
    expect(Buffer.compare(row!.bytes!, FIXTURE_JPEG)).toBe(0);
    expect((await requireUser(db, user.id)).photoHash).toBe(photoHash(FIXTURE_JPEG));
    expect(fake.callsTo('getFile')[0]?.body.file_id).toBe(`small-${user.telegramUserId}`);
    expect((await photoJob()).doneAt).not.toBeNull();
  });

  it('records no photo without downloading', async () => {
    const user = await insertUser(db);
    await fetchFor(user);
    expect(await getPhotoRow(db, user.id)).toMatchObject({
      fileUniqueId: null,
      hash: null,
      bytes: null,
    });
    expect((await requireUser(db, user.id)).photoHash).toBeNull();
    expect(fake.callsTo('getFile')).toHaveLength(0);
  });

  it('only touches checked_at when the photo is unchanged', async () => {
    const user = await withStoredPhoto();
    const before = (await getPhotoRow(db, user.id))!.checkedAt;
    fake.photos.set(user.telegramUserId!, { fileUniqueId: 'u-1', bytes: OTHER_JPEG });
    await fetchFor(user);
    const row = await getPhotoRow(db, user.id);
    expect(fake.callsTo('getFile')).toHaveLength(0);
    expect(row!.checkedAt.getTime()).toBeGreaterThan(before.getTime());
    expect(row?.hash).toBe(photoHash(FIXTURE_JPEG));
  });

  it('replaces a changed photo', async () => {
    const user = await withStoredPhoto();
    fake.photos.set(user.telegramUserId!, { fileUniqueId: 'u-2', bytes: OTHER_JPEG });
    await fetchFor(user);
    expect((await getPhotoRow(db, user.id))?.hash).toBe(photoHash(OTHER_JPEG));
    expect((await requireUser(db, user.id)).photoHash).toBe(photoHash(OTHER_JPEG));
  });

  it('clears a photo the user removed', async () => {
    const user = await withStoredPhoto();
    await fetchFor(user);
    expect(await getPhotoRow(db, user.id)).toMatchObject({ hash: null, bytes: null });
    expect((await requireUser(db, user.id)).photoHash).toBeNull();
    expect(await getPhotoBytes(db, photoHash(FIXTURE_JPEG))).toBeNull();
  });

  it('refuses a download that is not a JPEG', async () => {
    const user = await withStoredPhoto();
    fake.photos.set(user.telegramUserId!, { fileUniqueId: 'u-2', bytes: Buffer.from('<svg/>') });
    await fetchFor(user);
    await expectOldPhotoKept(user);
  });

  it('refuses a download of 64 KB or more', async () => {
    const user = await withStoredPhoto();
    fake.photos.set(user.telegramUserId!, {
      fileUniqueId: 'u-2',
      bytes: Buffer.concat([FIXTURE_JPEG, Buffer.alloc(65_536)]),
    });
    await fetchFor(user);
    await expectOldPhotoKept(user);
  });

  it('keeps the old photo when the download fails', async () => {
    const user = await withStoredPhoto();
    fake.photos.set(user.telegramUserId!, { fileUniqueId: 'u-2', bytes: OTHER_JPEG });
    fake.fileStatus = 500;
    await fetchFor(user);
    await expectOldPhotoKept(user);
  });

  it('waits out a 429', async () => {
    const user = await insertUser(db);
    fake.failNext('getUserProfilePhotos', {
      error_code: 429,
      description: 'Too Many Requests: retry after 3',
      parameters: { retry_after: 3 },
    });
    await fetchFor(user);
    const job = await photoJob();
    expect(job.doneAt).toBeNull();
    expect(job.attempts).toBe(0);
    const [{ ahead }] = (await db.execute(
      sql`select extract(epoch from run_at - now())::float as ahead from jobs where id = ${job.id}`,
    )) as unknown as [{ ahead: number }];
    expect(ahead).toBeGreaterThan(1);
    expect(ahead).toBeLessThanOrEqual(3);
    expect(await getPhotoRow(db, user.id)).toBeNull();
  });

  it('treats a 400 as no photo', async () => {
    const user = await withStoredPhoto();
    fake.failNext('getUserProfilePhotos', {
      error_code: 400,
      description: 'Bad Request: user not found',
    });
    await fetchFor(user);
    expect(await getPhotoRow(db, user.id)).toMatchObject({ hash: null, bytes: null });
    expect((await photoJob()).doneAt).not.toBeNull();
  });

  it('writes nothing for a deleted user', async () => {
    const user = await insertUser(db, { deletedAt: new Date() });
    await fetchFor(user);
    expect(await getPhotoRow(db, user.id)).toBeNull();
    expect(fake.calls).toHaveLength(0);
  });

  it('writes nothing for the engine user', async () => {
    const [engine] = await db.select().from(users).where(eq(users.isEngine, true));
    await fetchFor(engine!);
    expect(await getPhotoRow(db, engine!.id)).toBeNull();
    expect(fake.calls).toHaveLength(0);
  });

  it('writes nothing if the user is deleted while the photo downloads', async () => {
    const user = await insertUser(db);
    fake.photos.set(user.telegramUserId!, { fileUniqueId: 'u-1', bytes: FIXTURE_JPEG });
    fake.onFile = () =>
      db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, user.id));
    await fetchFor(user);
    expect(fake.callsTo('file')).toHaveLength(1);
    expect(await getPhotoRow(db, user.id)).toBeNull();
    expect((await requireUser(db, user.id)).photoHash).toBeNull();
  });

  it('never logs or stores the bot token', async () => {
    const user = await withStoredPhoto();
    fake.photos.set(user.telegramUserId!, { fileUniqueId: 'u-2', bytes: OTHER_JPEG });
    fake.fileStatus = 500;
    await fetchFor(user);
    expect((await photoJob()).lastError).not.toContain(config.BOT_TOKEN);
    expect(logLines.join('\n')).not.toContain(config.BOT_TOKEN);
  });
});
