import { apiThrottler } from '@grammyjs/transformer-throttler';
import { Api, GrammyError } from 'grammy';
import type { Config } from '../config';
import type { Metrics } from '../metrics';

export type TelegramApi = Api;

/** One outbound client per process; the throttler implements Telegram's published limits. */
export function createTelegramApi(
  config: Pick<Config, 'BOT_TOKEN'>,
  options: { apiRoot?: string; throttle?: boolean } = {},
): Api {
  const api = new Api(config.BOT_TOKEN, options.apiRoot ? { apiRoot: options.apiRoot } : {});
  // Read-only lookups (getChatMember, getChatAdministrators) must not queue behind message pacing.
  if (options.throttle !== false) api.config.use(apiThrottler());
  return api;
}

export type TelegramFailure =
  | { kind: 'retry_after'; seconds: number }
  | { kind: 'not_modified' }
  | { kind: 'message_gone' }
  | { kind: 'blocked' }
  | { kind: 'chat_gone' }
  | { kind: 'migrated'; newChatId: number }
  | { kind: 'other'; description: string };

/** Maps Bot API failures to the handling table Non-Telegram errors return null. */
export function classifyTelegramError(error: unknown): TelegramFailure | null {
  if (!(error instanceof GrammyError)) return null;
  const description = error.description;
  const parameters = error.parameters;
  if (error.error_code === 429)
    return { kind: 'retry_after', seconds: parameters.retry_after ?? 5 };
  if (parameters.migrate_to_chat_id !== undefined) {
    return { kind: 'migrated', newChatId: parameters.migrate_to_chat_id };
  }
  if (/message is not modified/i.test(description)) return { kind: 'not_modified' };
  if (
    /message to edit not found|message can't be edited|message to delete not found|message_id_invalid/i.test(
      description,
    )
  ) {
    return { kind: 'message_gone' };
  }
  if (
    /bot was blocked by the user|user is deactivated|bot can't initiate conversation|bots can't send messages to bots/i.test(
      description,
    )
  ) {
    return { kind: 'blocked' };
  }
  if (
    /bot was kicked|chat not found|bot is not a member|group chat was deleted|have no rights to send|chat_write_forbidden|need administrator rights/i.test(
      description,
    )
  ) {
    return { kind: 'chat_gone' };
  }
  return { kind: 'other', description };
}
/** Counts every Bot API call by method and status, and every 429. */
export function instrumentTelegramApi(api: Api, metrics: Metrics): void {
  api.config.use(async (prev, method, payload, signal) => {
    const response = await prev(method, payload, signal);
    metrics.telegramCalls.inc({ method, status: response.ok ? 'ok' : String(response.error_code) });
    if (!response.ok && response.error_code === 429) metrics.telegram429.inc();
    return response;
  });
}
