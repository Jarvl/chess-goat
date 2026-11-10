import { Hono } from 'hono';
import { DomainError } from '../../domain/errors';
import { getPhotoBytes } from '../../domain/photos';
import type { ApiContext, ApiEnv } from '../context';

const AVATAR_FILE = /^([0-9a-f]{64})\.jpg$/;

/**
 * No session, because an `<img>` cannot send the bearer token. The name is the
 * photo's content hash, which cannot be guessed and changes with the photo, so a year's cache is safe.
 */
export function avatarRoutes(ctx: ApiContext): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();
  app.get('/avatars/:file', async (c) => {
    const hash = AVATAR_FILE.exec(c.req.param('file'))?.[1];
    if (!hash) throw new DomainError('not_found', 'unknown avatar');
    const bytes = await getPhotoBytes(ctx.deps.db, hash);
    if (!bytes) throw new DomainError('not_found', 'unknown avatar');
    return c.body(new Uint8Array(bytes), 200, {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
  });
  return app;
}
