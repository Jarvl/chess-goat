/**
 * The end-to-end backend: the real server on a fake Bot API, plus a small seeding API that exists
 * only in this process. Started by Playwright's `webServer` (apps/miniapp/playwright.config.ts).
 */
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { INITIAL_FEN, toBase64Url } from '@group-chess/shared';
import { eq } from 'drizzle-orm';
import { games, ratings, userFlair, users } from '../../src/db/schema';
import { runMigrations } from '../../src/db/migrate';
import { touchMember } from '../../src/domain/members';
import { storePhoto } from '../../src/domain/photos';
import type { Engine } from '../../src/engine/engine';
import { startServer } from '../../src/main';
import { testConfig } from '../helpers/config';
import { openTestDb, truncateAll } from '../helpers/db';
import { fakeEngine } from '../helpers/fakeEngine';
import { FakeTelegram } from '../helpers/fakeTelegram';
import { insertGame, insertGroup, insertMove, insertUser } from '../helpers/fixtures';
import { FIXTURE_JPEG } from '../helpers/photos';

const APP_PORT = Number(process.env.E2E_APP_PORT ?? 4180);
const HARNESS_PORT = Number(process.env.E2E_HARNESS_PORT ?? 4181);
const MINI_APP_DIR = fileURLToPath(new URL('../../../miniapp/dist/', import.meta.url));
const CHAT = -1001000000099;

const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
const AFTER_E4_E5 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2';
const FOOLS_MATE = [
  ['f2f3', 'f3', 'rnbqkbnr/pppppppp/8/8/8/5P2/PPPPP1PP/RNBQKBNR b KQkq - 0 1'],
  ['e7e5', 'e5', 'rnbqkbnr/pppp1ppp/8/4p3/8/5P2/PPPPP1PP/RNBQKBNR w KQkq e6 0 2'],
  ['g2g4', 'g4', 'rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq g3 0 2'],
  ['d8h4', 'Qh4#', 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3'],
] as const;
/** White pawn on e7, black king on d8: e7e8 promotes with check. */
const PROMOTION_FEN = '3k4/4P3/8/8/8/8/8/4K3 w - - 0 1';

/**
 * The engine the server plays with: the fake one, unless a spec scripts its next replies or holds
 * it "thinking" (`POST /engine`) — a bot answers within moments, so a spec that builds premoves on
 * the bot's turn holds it until they are saved, then releases it.
 */
function scriptedEngine(): Engine & {
  script(options: { replies?: string[]; hold?: boolean }): void;
  reset(): void;
} {
  const fallback = fakeEngine();
  let replies: string[] = [];
  let held: { promise: Promise<void>; release: () => void } | null = null;
  const release = () => {
    held?.release();
    held = null;
  };
  return {
    async bestMove(fen, level, deadlineMs) {
      while (held) await held.promise;
      const uci = replies.shift();
      return uci ? { uci } : fallback.bestMove(fen, level, deadlineMs);
    },
    probe: () => fallback.probe(),
    script(options) {
      if (options.replies) replies = [...options.replies];
      if (options.hold === false) release();
      if (options.hold && !held) {
        let open!: () => void;
        const promise = new Promise<void>((resolve) => {
          open = resolve;
        });
        held = { promise, release: open };
      }
    },
    reset() {
      replies = [];
      release();
    },
  };
}

type Scenario =
  'none' | 'fresh' | 'opening' | 'promotion' | 'finished' | 'ranked' | 'several' | 'crowd';
type SeedRequest = {
  scenario: Scenario;
  prefs?: Record<string, Record<string, unknown>>;
  groupTitle?: string;
  bobName?: string;
  /** Gives Alice a stored Telegram photo (profile photos spec). */
  alicePhoto?: boolean;
  /** Alice and Bob each earn and wear three flair, all earned in the seeded game. Needs a game. */
  flair?: boolean;
};

/** What `flair: true` seeds (flair spec §7): earned and worn, in slot order. */
const SEEDED_FLAIR = {
  alice: ['rank_1400', 'en_passant_win', 'win_streak_5'],
  bob: ['rank_1200', 'promotion_win', 'scholars_mate_loss'],
} as const;

const TELEGRAM_USERS = {
  alice: { id: 11, first_name: 'Alice', username: 'alice' },
  bob: { id: 22, first_name: 'Bob', username: 'bob' },
  carol: { id: 33, first_name: 'Carol', username: 'carol' },
} as const;

async function main(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL must be set for the e2e harness');
  await runMigrations(url);
  const { db, close } = openTestDb();
  await truncateAll(db);
  const fake = await FakeTelegram.start();
  const engine = scriptedEngine();
  for (const user of Object.values(TELEGRAM_USERS)) fake.members.set(user.id, 'member');
  fake.admins = [TELEGRAM_USERS.alice.id];
  const server = await startServer(
    testConfig({
      TELEGRAM_API_ROOT: fake.url,
      PORT: APP_PORT,
      PUBLIC_URL: `http://127.0.0.1:${APP_PORT}`,
      MINI_APP_DIR,
      DATABASE_URL: url,
      LOG_LEVEL: 'warn',
      // On, so spec §11's "one engine game seeded in the existing harness and played through" can
      // exist: with the flag off, the endpoint refuses and the handler never runs.
      ENGINE_ENABLED: true,
    }),
    // The engine is injected, so nothing here — the boot probe included — spawns a real `stockfish`
    // process (global constraint: no test may spawn a binary, no CI runner installs one).
    engine,
  );

  const seed = async (request: SeedRequest) => {
    await truncateAll(db);
    fake.reset();
    engine.reset();
    // Ids restart with the truncate, so every seed's Alice is the same user to the rate limiters:
    // without this, a whole run's requests add up against her, as the integration tests avoid too.
    server.ctx.rateLimiter.reset();
    server.ctx.tipLimiter.reset();
    for (const user of Object.values(TELEGRAM_USERS)) fake.members.set(user.id, 'member');
    fake.admins = [TELEGRAM_USERS.alice.id];
    const group = await insertGroup(db, {
      telegramChatId: CHAT,
      title: request.groupTitle ?? 'Chess Club',
      botStatus: 'administrator',
      botIsAdmin: true,
    });
    const rows: Record<
      string,
      { id: number; telegram: (typeof TELEGRAM_USERS)[keyof typeof TELEGRAM_USERS] }
    > = {};
    for (const [name, telegram] of Object.entries(TELEGRAM_USERS)) {
      // Bob's display name is his @username when he has one; a long `bobName` (Review Focus 5's
      // long-display-name check) needs that username cleared so the long first name shows instead.
      const bobRenamed = name === 'bob' && request.bobName;
      const row = await insertUser(db, {
        telegramUserId: telegram.id,
        firstName: bobRenamed ? request.bobName! : telegram.first_name,
        username: bobRenamed ? null : telegram.username,
      });
      const patch = request.prefs?.[name];
      if (patch) await db.update(users).set({ prefs: patch }).where(eq(users.id, row.id));
      await touchMember(db, group.id, row.id, { verified: true });
      rows[name] = { id: row.id, telegram };
    }
    const alice = rows.alice!.id;
    const bob = rows.bob!.id;
    if (request.alicePhoto) {
      // Checked just now, so Alice's launch queues no fetch; the fake agrees if one runs anyway.
      await storePhoto(db, alice, { fileUniqueId: 'e2e', bytes: FIXTURE_JPEG });
      fake.photos.set(TELEGRAM_USERS.alice.id, { fileUniqueId: 'e2e', bytes: FIXTURE_JPEG });
    }
    let game: { id: number; publicId: string } | null = null;
    if (request.scenario === 'fresh')
      game = await insertGame(db, group.id, alice, bob, { fen: INITIAL_FEN });
    if (request.scenario === 'opening') {
      const row = await insertGame(db, group.id, alice, bob, { fen: AFTER_E4_E5, plyCount: 2 });
      await insertMove(db, row.id, 1, 'e2e4', 'e4', AFTER_E4);
      await insertMove(db, row.id, 2, 'e7e5', 'e5', AFTER_E4_E5);
      game = row;
    }
    if (request.scenario === 'several') {
      // Two of Alice's games (game switcher spec): 1.e4 e5 against Bob, hers to move, then 1.e4
      // against Carol, Carol's to move.
      const row = await insertGame(db, group.id, alice, bob, { fen: AFTER_E4_E5, plyCount: 2 });
      await insertMove(db, row.id, 1, 'e2e4', 'e4', AFTER_E4);
      await insertMove(db, row.id, 2, 'e7e5', 'e5', AFTER_E4_E5);
      const carol = await insertGame(db, group.id, alice, rows.carol!.id, {
        fen: AFTER_E4,
        plyCount: 1,
      });
      await insertMove(db, carol.id, 1, 'e2e4', 'e4', AFTER_E4);
      game = row;
    }
    if (request.scenario === 'crowd') {
      // Nine of Alice's games, more than a phone's strip shows at once (game switcher spec): the
      // first five hers to move, the rest her opponents'.
      for (let index = 0; index < 9; index += 1) {
        const opponent = index % 2 === 0 ? bob : rows.carol!.id;
        const yours = index < 5;
        const row = await insertGame(db, group.id, alice, opponent, {
          fen: yours ? INITIAL_FEN : AFTER_E4,
          plyCount: yours ? 0 : 1,
        });
        if (!yours) await insertMove(db, row.id, 1, 'e2e4', 'e4', AFTER_E4);
        game ??= row;
      }
    }
    if (request.scenario === 'promotion')
      game = await insertGame(db, group.id, alice, bob, { fen: PROMOTION_FEN, plyCount: 6 });
    if (request.scenario === 'finished') {
      const row = await insertGame(db, group.id, alice, bob, {
        fen: FOOLS_MATE[3][2],
        plyCount: 4,
        status: 'finished',
        result: '0-1',
        endReason: 'checkmate',
        finishedAt: new Date(),
      });
      for (const [index, [uci, san, fen]] of FOOLS_MATE.entries())
        await insertMove(db, row.id, index + 1, uci, san, fen);
      game = row;
    }
    if (request.scenario === 'ranked') {
      game = await insertGame(db, group.id, alice, bob, { fen: INITIAL_FEN });
      await db.insert(ratings).values([
        {
          groupId: group.id,
          userId: alice,
          rating: 1540,
          rd: 60,
          volatility: 0.06,
          gamesPlayed: 6,
          wins: 4,
          draws: 1,
          losses: 1,
        },
        {
          groupId: group.id,
          userId: bob,
          rating: 1510,
          rd: 60,
          volatility: 0.06,
          gamesPlayed: 6,
          wins: 1,
          draws: 1,
          losses: 4,
        },
      ]);
    }
    if (request.flair && game) {
      const gameId = game.id;
      const earnedAt = new Date();
      for (const [name, ids] of Object.entries(SEEDED_FLAIR)) {
        const userId = rows[name]!.id;
        await db
          .insert(userFlair)
          .values(ids.map((flairId) => ({ userId, flairId, gameId, earnedAt })));
        await db
          .update(users)
          .set({ flairWorn: [...ids] })
          .where(eq(users.id, userId));
      }
    }
    return {
      group: { id: group.id, publicId: group.publicId },
      users: rows,
      game: game ? { id: game.id, publicId: game.publicId } : null,
    };
  };

  const harness = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = chunks.length
        ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as SeedRequest)
        : null;
      const reply = (status: number, json: unknown) => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(json));
      };
      const path = req.url ?? '/';
      void (async () => {
        try {
          if (path === '/health') return reply(200, { ok: true });
          if (path === '/reset') {
            await truncateAll(db);
            fake.reset();
            return reply(200, { ok: true });
          }
          if (path === '/seed' && body) return reply(200, await seed(body));
          if (path === '/engine' && body) {
            engine.script(body as { replies?: string[]; hold?: boolean });
            return reply(200, { ok: true });
          }
          if (path === '/telegram/calls') return reply(200, fake.calls);
          if (path === '/connections/close') {
            server.closeConnections();
            return reply(200, { ok: true });
          }
          const match = /^\/games\/([A-Za-z0-9]{10})$/.exec(path);
          if (match) {
            const [row] = await db.select().from(games).where(eq(games.publicId, match[1]!));
            return reply(
              row ? 200 : 404,
              row
                ? {
                    status: row.status,
                    fen: row.fen,
                    plyCount: row.plyCount,
                    result: row.result,
                    premoveTree: toBase64Url(row.premoveTree),
                  }
                : {},
            );
          }
          reply(404, { error: 'unknown harness route' });
        } catch (error) {
          reply(500, { error: error instanceof Error ? error.message : String(error) });
        }
      })();
    });
  });
  await new Promise<void>((resolve) => harness.listen(HARNESS_PORT, '127.0.0.1', () => resolve()));
  console.log(
    `e2e harness: app http://127.0.0.1:${APP_PORT}/app/ harness http://127.0.0.1:${HARNESS_PORT}`,
  );

  const shutdown = async (): Promise<void> => {
    await new Promise<void>((resolve) => harness.close(() => resolve()));
    await server.stop();
    await fake.stop();
    await close();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}

void main();
