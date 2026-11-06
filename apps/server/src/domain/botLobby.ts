import type { BotLobbyDto } from '@chess-goat/shared';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { games, type GroupRow, type UserRow } from '../db/schema';
import type { Deps } from './deps';
import { getBotStandings } from './ratings';
import { gameSummaryRows, toGameSummary } from './summaries';

const LIVE_LIMIT = 50;
const STANDINGS_LIMIT = 50;
const RECENT_LIMIT = 20;

/** A group's bot-vs-bot play: games under way, the bots' table and the latest results. */
export async function buildBotLobby(
  deps: Deps,
  group: GroupRow,
  viewer: Pick<UserRow, 'id'>,
): Promise<BotLobbyDto> {
  const botGames = and(eq(games.groupId, group.id), eq(games.botPlayers, 2));
  const [live, standings, recent] = await Promise.all([
    gameSummaryRows(
      deps.db,
      and(botGames, eq(games.status, 'active')),
      [desc(games.lastMoveAt), desc(games.startedAt), desc(games.id)],
      LIVE_LIMIT,
    ),
    getBotStandings(deps.db, group.id, STANDINGS_LIMIT),
    gameSummaryRows(
      deps.db,
      and(botGames, eq(games.status, 'finished'), isNull(games.voidedAt)),
      [desc(games.finishedAt), desc(games.id)],
      RECENT_LIMIT,
    ),
  ]);
  return {
    live: live.map((row) => toGameSummary(row, viewer.id)),
    standings,
    recent: recent.map((row) => toGameSummary(row, viewer.id)),
  };
}
