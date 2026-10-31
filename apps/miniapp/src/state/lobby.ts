import type { GameSummary, LeaderboardEntry, LobbyDto } from '@chess-goat/shared';

/** The lobby's two views: the viewer's own games, or the games they are not in. */
export type LobbyScope = 'mine' | 'others';

export function plays(game: GameSummary, viewerId: string | null): boolean {
  return viewerId !== null && (game.white.id === viewerId || game.black.id === viewerId);
}

/** The lists for a scope; active games waiting on the viewer come first (PRD §8.2). */
export function scopedGames(
  data: Pick<LobbyDto, 'active' | 'finished'>,
  scope: LobbyScope,
  viewerId: string | null,
): { active: GameSummary[]; finished: GameSummary[] } {
  const keep = (game: GameSummary) => plays(game, viewerId) === (scope === 'mine');
  const active = data.active.filter(keep).sort((a, b) => Number(b.yourTurn) - Number(a.yourTurn));
  return { active, finished: data.finished.items.filter(keep) };
}

/** The viewer's place on the leaderboard, from 1; null when they are not on it. */
export function rankOf(
  players: LeaderboardEntry[],
  viewerId: string | null,
): { rank: number; entry: LeaderboardEntry } | null {
  const index = viewerId === null ? -1 : players.findIndex((entry) => entry.id === viewerId);
  return index < 0 ? null : { rank: index + 1, entry: players[index]! };
}
