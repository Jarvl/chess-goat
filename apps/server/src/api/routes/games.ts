import {
  MoveRequestSchema,
  PremoveTreeRequestSchema,
  ShareRequestSchema,
  type PgnLinkDto,
} from '@chess-goat/shared';
import { eq } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import { challenges } from '../../db/schema';
import { createRematch } from '../../domain/challenges';
import { acceptDraw, claimDraw, declineDraw, offerDraw } from '../../domain/draws';
import {
  abortGame,
  loadGameDto,
  playMove,
  requireGameByPublicId,
  resign,
} from '../../domain/games';
import { buildGamePgn } from '../../domain/pgn';
import { setPremoveTree } from '../../domain/premoves';
import { sharePosition } from '../../domain/sharing';
import { challengeDtoRows, challengeToDto } from '../../domain/summaries';
import { requireGameAccess } from '../access';
import type { ApiContext, ApiEnv } from '../context';
import { publicIdParam } from '../middleware';
import { issueScopedToken } from '../session';
import { validate } from '../validate';

export function gamesRoutes(api: Hono<ApiEnv>, ctx: ApiContext): void {
  const { db } = ctx.deps;
  type Ctx = Context<ApiEnv>;
  const accessible = async (c: Ctx) => {
    const game = await requireGameByPublicId(db, publicIdParam(c, 'id'));
    await requireGameAccess(ctx, game, c.get('user'));
    return game;
  };
  const gameId = (c: Ctx) => publicIdParam(c, 'id');
  const userId = (c: Ctx) => c.get('user').id;

  api.get('/games/:id', async (c) => {
    const dto = await loadGameDto(db, await accessible(c), userId(c));
    ctx.metrics.gameOpens.inc({ role: dto.viewerRole });
    return c.json(dto);
  });

  api.post('/games/:id/moves', validate('json', MoveRequestSchema), async (c) => {
    const started = performance.now();
    const dto = await playMove(ctx.deps, {
      gameId: gameId(c),
      userId: userId(c),
      ...c.req.valid('json'),
    });
    ctx.metrics.movesTotal.inc();
    ctx.metrics.moveLatency.observe((performance.now() - started) / 1000);
    if (dto.status === 'finished' && dto.endReason)
      ctx.metrics.gamesFinished.inc({ end_reason: dto.endReason });
    return c.json(dto);
  });

  api.put('/games/:id/premoves', validate('json', PremoveTreeRequestSchema), async (c) =>
    c.json(
      await setPremoveTree(ctx.deps, {
        gameId: gameId(c),
        userId: userId(c),
        ...c.req.valid('json'),
      }),
    ),
  );

  api.post('/games/:id/draw/offer', async (c) =>
    c.json(await offerDraw(ctx.deps, { gameId: gameId(c), userId: userId(c) })),
  );
  api.post('/games/:id/draw/accept', async (c) =>
    c.json(await acceptDraw(ctx.deps, { gameId: gameId(c), userId: userId(c) })),
  );
  api.post('/games/:id/draw/decline', async (c) =>
    c.json(await declineDraw(ctx.deps, { gameId: gameId(c), userId: userId(c) })),
  );
  api.post('/games/:id/draw/claim', async (c) =>
    c.json(await claimDraw(ctx.deps, { gameId: gameId(c), userId: userId(c) })),
  );
  api.post('/games/:id/resign', async (c) =>
    c.json(await resign(ctx.deps, { gameId: gameId(c), userId: userId(c) })),
  );
  api.post('/games/:id/abort', async (c) =>
    c.json(await abortGame(ctx.deps, { gameId: gameId(c), userId: userId(c) })),
  );

  api.post('/games/:id/share', validate('json', ShareRequestSchema), async (c) => {
    const game = await accessible(c);
    await sharePosition(ctx.deps, {
      gameId: game.publicId,
      userId: userId(c),
      ply: c.req.valid('json').ply,
    });
    return c.json({ ok: true });
  });

  api.post('/games/:id/rematch', async (c) => {
    const game = await accessible(c);
    const challenge = await createRematch(ctx.deps, { gameId: game.id, userId: userId(c) });
    const [row] = await challengeDtoRows(db, eq(challenges.id, challenge.id), 1);
    return c.json(challengeToDto(row!, userId(c)));
  });

  // The app asks for a link and hands that to the browser or downloader, never its session token.
  api.post('/games/:id/pgn-link', async (c) => {
    const game = await accessible(c);
    const token = await issueScopedToken(
      ctx.config.SESSION_SECRET,
      c.get('user').id,
      `pgn:${game.publicId}`,
    );
    const dto: PgnLinkDto = {
      url: `/api/games/${game.publicId}/pgn?token=${encodeURIComponent(token)}`,
    };
    return c.json(dto);
  });

  api.get('/games/:id/pgn', async (c) => {
    const game = await accessible(c);
    c.header('Content-Type', 'application/x-chess-pgn; charset=utf-8');
    c.header('Content-Disposition', `attachment; filename="${game.publicId}.pgn"`);
    return c.body(await buildGamePgn(db, game));
  });
}
