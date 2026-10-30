import type { Config } from '../../src/config';
import type { Deps } from '../../src/domain/deps';
import type { TelegramHandlerContext } from '../../src/jobs/handlers/telegramCall';
import type { JobHandlers } from '../../src/jobs/types';
import { JobWorker } from '../../src/jobs/worker';
import { createTelegramApi } from '../../src/telegram/client';
import { testConfig } from './config';
import { FakeTelegram } from './fakeTelegram';

/**
 * A fake Telegram and a job worker whose handlers talk to it. The caller resets the fake between
 * tests and stops it after them.
 */
export async function jobWorker(
  deps: Deps,
  makeHandlers: (ctx: TelegramHandlerContext) => JobHandlers,
  options: { throttle?: boolean; config?: Partial<Config> } = {},
): Promise<{ fake: FakeTelegram; worker: JobWorker; config: Config }> {
  const fake = await FakeTelegram.start();
  const config = testConfig({ ...options.config, TELEGRAM_API_ROOT: fake.url });
  const api = createTelegramApi(config, {
    apiRoot: fake.url,
    ...(options.throttle === false ? { throttle: false } : {}),
  });
  const worker = new JobWorker({
    db: deps.db,
    log: deps.log,
    handlers: makeHandlers({ deps, api, config }),
    workerId: 'test',
  });
  return { fake, worker, config };
}
