import { t } from '@group-chess/shared';
import { serve, type ServerType } from '@hono/node-server';
import type { Bot } from 'grammy';
import type { Hono } from 'hono';
import { createApiApp } from './api/app';
import type { ApiContext, ApiEnv } from './api/context';
import { gameRoutes } from './api/routes/index';
import { staticAppRoutes } from './api/staticApp';
import { StreamGate } from './api/streams';
import { createBot } from './bot/bot';
import { RateLimiter } from './bot/rateLimit';
import { webhookRoutes } from './bot/webhook';
import { LocalBus } from './bus/bus';
import { startScanners } from './clock/scanners';
import type { Config, Role } from './config';
import { createDb } from './db/client';
import { runMigrations } from './db/migrate';
import { enqueueFlairBackfill } from './flair/backfill';
import type { Deps } from './domain/deps';
import type { Engine } from './engine/engine';
import { uciEngine } from './engine/uci';
import { loadFonts } from './images/fonts';
import {
  coreJobHandlers,
  engineJobHandlers,
  ensurePruneScheduled,
  lichessJobHandlers,
  sharePhotoJobHandlers,
  userPhotoJobHandlers,
  telegramJobHandlers,
} from './jobs/handlers';
import { JobWorker } from './jobs/worker';
import { createLogger } from './logger';
import { Metrics } from './metrics';
import { createTelegramApi, instrumentTelegramApi } from './telegram/client';
import { Membership } from './telegram/membership';

/** Spec §5.1 step 4; `chat_member` only arrives where the bot is an administrator. Tip jar spec §2.3. */
export const ALLOWED_UPDATES = [
  'message',
  'callback_query',
  'my_chat_member',
  'chat_member',
  'pre_checkout_query',
] as const;

/** Spec §5.1 step 3: three group commands, two private commands, nothing in the default scope. */
export const BOT_COMMANDS = {
  group: [
    { command: 'challenge', description: t('command.challenge.description') },
    { command: 'chess', description: t('command.chess.description') },
    { command: 'settings', description: t('command.settings.description') },
  ],
  private: [
    { command: 'start', description: t('command.start.description') },
    { command: 'paysupport', description: t('command.paysupport.description') },
  ],
} as const;

export type RunningServer = {
  port: number;
  app: Hono<ApiEnv>;
  /** The API's shared state, for the end-to-end harness to reset its rate limits between seeds. */
  ctx: ApiContext;
  /** Drops every open connection (SSE streams included); clients see a dead socket and reconnect. */
  closeConnections(): void;
  stop(): Promise<void>;
};

function listen(app: Hono<ApiEnv>, port: number): Promise<ServerType> {
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, () => resolve(server));
  });
}

/**
 * Boots the roles in `config.ROLES` (spec §4.2, §4.4): migrations first, then the HTTP app (health,
 * metrics, API when `api`, webhook when `bot`, the Mini App when `MINI_APP_DIR`), the job worker
 * when `jobs`, the scanners when `clock`, and finally the webhook registration or long polling.
 */
export async function startServer(
  config: Config,
  /**
   * Spec §6.2's seam, handed in rather than constructed. Production passes nothing and gets the
   * real binary; the end-to-end harness passes `fakeEngine`, which is what lets spec §11's "one
   * engine game seeded in the existing harness and played through" exist without a Stockfish
   * anywhere near a test runner.
   */
  injectedEngine?: Engine,
): Promise<RunningServer> {
  const log = createLogger(config.LOG_LEVEL);
  const has = (role: Role): boolean => config.ROLES.includes(role);
  const { reset } = await runMigrations(config.DATABASE_URL, {
    resetOnMismatch: config.DATABASE_RESET_ON_MISMATCH,
  });
  if (reset) log.warn('the database had migrations this build lacks, so it was wiped and rebuilt');
  const { db, close } = createDb(config.DATABASE_URL);
  // Backfill spec §3: flair not yet backfilled at this build's versions is queued; boot does not
  // wait for it.
  await enqueueFlairBackfill(db);
  const deps: Deps = { db, bus: new LocalBus(), log };
  const metrics = new Metrics({ db });

  const bot: Bot | null = has('bot') ? await createBot(deps, config) : null;
  const api = bot ? bot.api : createTelegramApi(config, { apiRoot: config.TELEGRAM_API_ROOT });
  instrumentTelegramApi(api, metrics);
  // Membership lookups get their own client without the message throttler (spec §4.3, §5.8).
  const lookupApi = createTelegramApi(config, {
    apiRoot: config.TELEGRAM_API_ROOT,
    throttle: false,
  });
  instrumentTelegramApi(lookupApi, metrics);
  const membership = new Membership(deps, lookupApi);
  const apiCtx: ApiContext = {
    deps,
    config,
    membership,
    metrics,
    streams: new StreamGate(),
    rateLimiter: new RateLimiter(120, 60_000),
    api,
    tipLimiter: new RateLimiter(10, 60_000),
  };

  const app = createApiApp(apiCtx, has('api') ? gameRoutes : []);
  if (bot && !config.TELEGRAM_POLLING) app.route('/', webhookRoutes(bot, deps, config, metrics));
  if (config.MINI_APP_DIR) app.route('/app', staticAppRoutes(config.MINI_APP_DIR));
  const server = await listen(app, config.PORT);
  const port = (server.address() as { port: number }).port;

  const engine = injectedEngine ?? uciEngine(config, log);
  if (has('jobs') && config.ENGINE_ENABLED) {
    const probed = await engine.probe();
    metrics.engineAvailable.set(probed.available ? 1 : 0);
    if (!probed.available) {
      // Spec §9: a missing binary must not take down human correspondence games.
      log.error('the engine binary did not answer; bot games will queue and then abort');
    } else {
      log.info({ version: probed.version }, 'engine available');
    }
  }

  let worker: JobWorker | null = null;
  if (has('jobs')) {
    await ensurePruneScheduled(db);
    // Snapshot spec §2.3: a missing font stops the boot here, not the first share.
    const fonts = await loadFonts();
    worker = new JobWorker({
      db,
      log,
      handlers: {
        ...coreJobHandlers(deps),
        ...telegramJobHandlers({ deps, api, config }),
        ...sharePhotoJobHandlers({ deps, api, config }, fonts),
        ...userPhotoJobHandlers({ deps, api, config }),
        ...lichessJobHandlers({ deps, config, metrics }),
        // Registered unconditionally: the handler owns the disabled case itself. An unhandled
        // kind is retried forever without counting an attempt (`jobs/worker.ts:117-123`), so a
        // game started while the engine was enabled and then disabled would stall permanently.
        ...engineJobHandlers({ deps, engine, config, metrics }),
      },
      workerId: `${process.pid}`,
      onFailed: (job) => metrics.jobsFailed.inc({ kind: job.kind }),
    });
    worker.start();
  }
  const scanners = has('clock') ? startScanners(deps) : null;

  let polling: Promise<void> | null = null;
  if (bot) {
    // Command registration is idempotent and not needed to serve traffic: a Telegram outage or a
    // 429 during a rolling restart must not keep the process from starting (spec §4.3 holds — the
    // one-off boot calls are not per-update traffic).
    try {
      await api.setMyCommands(BOT_COMMANDS.group, { scope: { type: 'all_group_chats' } });
      await api.setMyCommands(BOT_COMMANDS.private, { scope: { type: 'all_private_chats' } });
    } catch (error) {
      log.warn({ err: error }, 'could not register the bot commands; they keep their last value');
    }
    // The DM's Open button, set here rather than in BotFather so it follows PUBLIC_URL (a tunnel's
    // changes on every restart). Groups ignore it: there the way in is a card's direct link.
    try {
      await api.setChatMenuButton({
        menu_button: {
          type: 'web_app',
          text: t('button.menu'),
          web_app: { url: `${config.PUBLIC_URL.replace(/\/$/, '')}/app/` },
        },
      });
    } catch (error) {
      log.warn({ err: error }, 'could not set the menu button; it keeps its last value');
    }
    if (config.TELEGRAM_POLLING) {
      await api.deleteWebhook();
      polling = bot.start({ allowed_updates: [...ALLOWED_UPDATES] });
      polling.catch((error: unknown) => log.error({ err: error }, 'long polling stopped'));
    } else {
      // Telegram keeps the last registration, so a failure here (an outage, a 429 during a
      // rolling restart) must not stop the API from serving; it is logged loudly instead.
      try {
        await api.setWebhook(`${config.PUBLIC_URL.replace(/\/$/, '')}/telegram/webhook`, {
          secret_token: config.WEBHOOK_SECRET,
          allowed_updates: [...ALLOWED_UPDATES],
        });
      } catch (error) {
        log.error({ err: error }, 'could not register the webhook; the last registration stands');
      }
    }
  }
  log.info({ port, roles: config.ROLES, polling: polling !== null }, 'server started');

  return {
    port,
    app,
    ctx: apiCtx,
    closeConnections() {
      if ('closeAllConnections' in server) server.closeAllConnections();
    },
    async stop() {
      if (bot && polling) {
        await bot.stop();
        await polling.catch(() => undefined);
      }
      await scanners?.stop();
      await worker?.stop();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await close();
      log.info('server stopped');
    },
  };
}
