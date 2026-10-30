import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  avatarUrl,
  deletePhoto,
  getPhotoBytes,
  getPhotoRow,
  photoHash,
  storePhoto,
} from '../../src/domain/photos';
import { requireUser } from '../../src/domain/users';
import { openTestDb, truncateAll } from '../helpers/db';
import { insertUser } from '../helpers/fixtures';
import { FIXTURE_JPEG } from '../helpers/photos';

const { db, close } = openTestDb();

beforeEach(() => truncateAll(db));
afterAll(() => close());

describe('photo storage', () => {
  it('stores the same bytes for two users', async () => {
    const alice = await insertUser(db);
    const bob = await insertUser(db);
    await storePhoto(db, alice.id, { fileUniqueId: 'a', bytes: FIXTURE_JPEG });
    await storePhoto(db, bob.id, { fileUniqueId: 'b', bytes: FIXTURE_JPEG });
    expect((await requireUser(db, bob.id)).photoHash).toBe(photoHash(FIXTURE_JPEG));
    const bytes = await getPhotoBytes(db, photoHash(FIXTURE_JPEG));
    expect(Buffer.compare(bytes!, FIXTURE_JPEG)).toBe(0);
  });

  it('deletes the photo and clears the hash', async () => {
    const user = await insertUser(db);
    await storePhoto(db, user.id, { fileUniqueId: 'u-1', bytes: FIXTURE_JPEG });
    await deletePhoto(db, user.id);
    expect(await getPhotoRow(db, user.id)).toBeNull();
    expect((await requireUser(db, user.id)).photoHash).toBeNull();
    expect(await getPhotoBytes(db, photoHash(FIXTURE_JPEG))).toBeNull();
  });

  it('builds the avatar url from a hash', () => {
    expect(avatarUrl('a'.repeat(64))).toBe(`/api/avatars/${'a'.repeat(64)}.jpg`);
  });
});
