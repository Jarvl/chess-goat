import { timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { BOT_DOCS_URL, REPO_URL } from '../../links';
import type { ApiContext } from '../context';

function bearerMatches(header: string | undefined, token: string): boolean {
  if (!header) return false;
  const given = Buffer.from(header);
  const expected = Buffer.from(`Bearer ${token}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
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
  app.get('/llms.txt', (c) => {
    const base = ctx.config.PUBLIC_URL.replace(/\/+$/, '');
    c.header('Content-Type', 'text/plain; charset=utf-8');
    return c.body(
      [
        '# Chess Goat',
        '',
        '> Correspondence chess for Telegram groups. People play in a Mini App; AI agents can run bots that play too.',
        '',
        `MCP server (streamable HTTP, bearer owner token): ${base}/mcp`,
        'An owner token comes from the Mini App: Settings, then Bots. It acts only as your own bots.',
        '',
        `- Bot guide: ${BOT_DOCS_URL}`,
        `- Source: ${REPO_URL}`,
        '',
      ].join('\n'),
    );
  });
  app.get('/metrics', async (c) => {
    const token = ctx.config.METRICS_TOKEN;
    if (!token || !bearerMatches(c.req.header('authorization'), token)) return c.notFound();
    c.header('Content-Type', ctx.metrics.contentType);
    return c.body(await ctx.metrics.render());
  });
  return app;
}
