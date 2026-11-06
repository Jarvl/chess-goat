import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../config';
import { games } from '../../db/schema';
import type { Deps } from '../../domain/deps';
import { postsToChat, requireGameById } from '../../domain/games';
import { buildGamePgn } from '../../domain/pgn';
import type { Metrics } from '../../metrics';
import { enqueue } from '../queue';
import type { JobHandler, JobHandlers, JobResult } from '../types';

export type LichessHandlerContext = {
  deps: Deps;
  config: Pick<Config, 'LICHESS_API_URL' | 'LICHESS_TOKEN'>;
  metrics?: Metrics;
  fetch?: typeof fetch;
  /** Gap between requests; 2 s in production. */
  spacingMs?: number;
  /** Pause after a 429; 60 s in production. */
  pauseMs?: number;
};

const DEFAULT_SPACING_MS = 2_000;
const DEFAULT_PAUSE_MS = 60_000;
/** Spec §7.6: up to 8 attempts over 24 h, so three hours between attempts. */
const RETRY_SPACING_MS = 3 * 3_600_000;

/** "Only make one request at a time", spaced out, with a pause after a 429 (spec §7.6). Per process. */
export class LichessPacer {
  private inFlight = false;
  private notBefore = 0;

  constructor(private readonly spacingMs: number) {}

  /** Milliseconds until the next request may start; 0 means now. */
  wait(now = Date.now()): number {
    if (this.inFlight) return Math.max(this.spacingMs, 1_000);
    return Math.max(0, this.notBefore - now);
  }

  begin(): void {
    this.inFlight = true;
  }

  end(now = Date.now()): void {
    this.inFlight = false;
    this.notBefore = Math.max(this.notBefore, now + this.spacingMs);
  }

  pause(ms: number, now = Date.now()): void {
    this.notBefore = Math.max(this.notBefore, now + ms);
  }
}

const payloadSchema = z.object({ gameId: z.number().int() });
const importResponse = z.object({ url: z.url() });

/**
 * Counts an attempt three hours apart (spec §7.6: eight over 24 h); on the last one the game is
 * marked failed so the card keeps the fallback link.
 */
async function failed(
  ctx: LichessHandlerContext,
  job: { attempts: number; maxAttempts: number },
  gameId: number,
  error: string,
): Promise<JobResult> {
  if (job.attempts + 1 >= job.maxAttempts) {
    await ctx.deps.db
      .update(games)
      .set({ lichessImportStatus: 'failed' })
      .where(eq(games.id, gameId));
    ctx.metrics?.lichessImports.inc({ outcome: 'failed' });
    return { outcome: 'fail', error };
  }
  return { outcome: 'retry_attempt', delayMs: RETRY_SPACING_MS, error };
}

const lichessImport =
  (ctx: LichessHandlerContext, pacer: LichessPacer): JobHandler =>
  async ({ job, log }) => {
    const { gameId } = payloadSchema.parse(job.payload);
    const game = await requireGameById(ctx.deps.db, gameId);
    if (game.lichessImportStatus !== 'pending' || game.lichessUrl !== null)
      return { outcome: 'done' };
    const wait = pacer.wait();
    if (wait > 0) return { outcome: 'retry', delayMs: wait, error: 'lichess pacing' };
    const pgn = await buildGamePgn(ctx.deps.db, game);
    const pauseMs = ctx.pauseMs ?? DEFAULT_PAUSE_MS;
    const doFetch = ctx.fetch ?? fetch;
    pacer.begin();
    let response: Response;
    try {
      response = await doFetch(`${ctx.config.LICHESS_API_URL}/api/import`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
          ...(ctx.config.LICHESS_TOKEN
            ? { authorization: `Bearer ${ctx.config.LICHESS_TOKEN}` }
            : {}),
        },
        body: new URLSearchParams({ pgn }).toString(),
      });
    } catch (error) {
      pacer.end();
      const message = error instanceof Error ? error.message : String(error);
      return failed(ctx, job, game.id, `lichess unreachable: ${message}`);
    }
    pacer.end();
    if (response.status === 429) {
      // The kind pauses for a minute; the job itself counts the attempt like any other failure.
      pacer.pause(pauseMs);
      ctx.metrics?.lichessImports.inc({ outcome: 'rate_limited' });
      return failed(ctx, job, game.id, 'lichess 429');
    }
    if (!response.ok) return failed(ctx, job, game.id, `lichess HTTP ${response.status}`);
    const parsed = importResponse.safeParse(await response.json().catch(() => null));
    if (!parsed.success) return failed(ctx, job, game.id, 'lichess response without a url');
    await ctx.deps.db.transaction(async (tx) => {
      await tx
        .update(games)
        .set({ lichessUrl: parsed.data.url, lichessImportStatus: 'done' })
        .where(eq(games.id, game.id));
      // The card shows the Lichess link; a bot-vs-bot game has no card.
      if (postsToChat(game)) {
        await enqueue(tx, {
          kind: 'edit_card',
          payload: { gameId: game.id },
          dedupKey: `card:g:${game.publicId}`,
        });
      }
    });
    ctx.metrics?.lichessImports.inc({ outcome: 'done' });
    log.info({ gameId: game.id }, 'lichess import done');
    return { outcome: 'done' };
  };

export function lichessJobHandlers(ctx: LichessHandlerContext): JobHandlers {
  const pacer = new LichessPacer(ctx.spacingMs ?? DEFAULT_SPACING_MS);
  return { lichess_import: lichessImport(ctx, pacer) };
}
