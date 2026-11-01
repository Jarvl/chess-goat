import { timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { ApiContext } from '../context';

function bearerMatches(header: string | undefined, token: string): boolean {
  const expected = `Bearer ${token}`;
  if (!header || header.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

export function healthRoutes(ctx: ApiContext): Hono {
  const app = new Hono();
  app.get('/healthz', (c) => c.text('ok'));
  app.get('/readyz', async (c) => {
    try {
      await ctx.deps.db.execute(sql`select 1`);
      return c.text('ok');
    } catch {
      return c.text('database unavailable', 503);
    }
  });
  app.get('/metrics', async (c) => {
    const token = ctx.config.METRICS_TOKEN;
    if (!token || !bearerMatches(c.req.header('authorization'), token)) return c.notFound();
    c.header('Content-Type', ctx.metrics.contentType);
    return c.body(await ctx.metrics.render());
  });
  return app;
}
