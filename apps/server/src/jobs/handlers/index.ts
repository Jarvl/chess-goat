import type { Deps } from '../../domain/deps';
import type { JobHandlers } from '../types';
import { awardFlairHandler, backfillFlairHandler } from './flair';
import { ensurePruneScheduled, pruneHandler } from './prune';
import { rebuildRatingsHandler } from './rebuildRatings';

export { ensurePruneScheduled };
export { botRoundupJobHandlers, ensureBotRoundupScheduled } from './botRoundup';
export { engineJobHandlers, type EngineHandlerContext } from './engine';
export { lichessJobHandlers, LichessPacer, type LichessHandlerContext } from './lichess';
export { sharePhotoJobHandlers } from './sharePhoto';
export { userPhotoJobHandlers } from './userPhoto';
export { telegramJobHandlers } from './telegram';
export type { TelegramHandlerContext } from './telegramCall';

/** Handlers that need no Telegram or Lichess client; `main.ts` merges the others in. */
export function coreJobHandlers(deps: Deps): JobHandlers {
  return {
    award_flair: awardFlairHandler(deps),
    backfill_flair: backfillFlairHandler(deps),
    rebuild_ratings: rebuildRatingsHandler(deps),
    prune: pruneHandler(deps),
  };
}
