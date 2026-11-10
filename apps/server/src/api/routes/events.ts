import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { DomainError } from '../../domain/errors';
import { getGameDto, requireGameByPublicId } from '../../domain/games';
import { requireGameAccess } from '../access';
import type { ApiContext, ApiEnv } from '../context';
import { publicIdParam } from '../middleware';

const PING_MS = 20_000;

/** `state` snapshots keyed by version, `ping` every 20 s, token in the query string. */
export function eventsRoutes(api: Hono<ApiEnv>, ctx: ApiContext): void {
  api.get('/games/:id/events', async (c) => {
    const user = c.get('user');
    const publicId = publicIdParam(c, 'id');
    const game = await requireGameByPublicId(ctx.deps.db, publicId);
    await requireGameAccess(ctx, game, user);
    if (!ctx.streams.acquire(user.id))
      throw new DomainError('rate_limited', 'too many open streams', { reason: 'streams' });
    const lastEventId = Number(c.req.header('last-event-id') ?? Number.NaN);
    c.header('X-Accel-Buffering', 'no');
    ctx.metrics.sseStreams.inc();
    if (Number.isFinite(lastEventId)) ctx.metrics.sseReconnects.inc();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      ctx.streams.release(user.id);
      ctx.metrics.sseStreams.dec();
    };
    const response = streamSSE(
      c,
      async (stream) => {
        let chain = Promise.resolve();
        const send = () => {
          chain = chain
            .then(async () => {
              const dto = await getGameDto(ctx.deps, { gameId: publicId, viewerUserId: user.id });
              await stream.writeSSE({
                event: 'state',
                id: String(dto.version),
                data: JSON.stringify(dto),
              });
            })
            .catch(() => undefined);
          return chain;
        };
        // Subscribe before the first snapshot: a push landing while it is read must not be lost.
        // Owner-only premove pushes carry no new version, so nothing later would make up for one.
        // `chain` keeps the sends in order, so that push's state follows the snapshot.
        const unsubscribe = ctx.deps.bus.subscribe(publicId, (audience) => {
          if (audience && audience.userId !== user.id) return;
          void send();
        });
        // Always a snapshot on (re)connect: premove edits leave `version` alone, so a matching
        // Last-Event-ID no longer proves this device has the owner's current chain.
        await send();
        const ping = setInterval(
          () => void stream.writeSSE({ event: 'ping', data: '' }).catch(() => undefined),
          PING_MS,
        );
        // Hono links the request signal to the stream only on old Bun; link it here too, so a
        // dropped connection releases the slot whether the runtime cancels the body or the signal.
        const onSignalAbort = () => void stream.abort();
        c.req.raw.signal.addEventListener('abort', onSignalAbort, { once: true });
        await new Promise<void>((resolve) => stream.onAbort(resolve));
        c.req.raw.signal.removeEventListener('abort', onSignalAbort);
        clearInterval(ping);
        unsubscribe();
        release();
      },
      async () => {
        release();
      },
    );
    // Hono's helper sets no-cache; every response here wants no-store.
    response.headers.set('Cache-Control', 'no-store');
    return response;
  });
}
