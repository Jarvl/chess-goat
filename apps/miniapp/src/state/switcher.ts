import type { MeGamesDto } from '@group-chess/shared';
import { signal } from '@preact/signals';

/** One of the viewer's active games, as the Games tab lists it. */
export type StripGame = MeGamesDto['items'][number];

/**
 * The game switcher strip's games, in the order they are drawn (game switcher spec). Each switch
 * replaces the game screen, so the order lives here rather than in the screen: it is fixed when the
 * viewer arrives at a game from anywhere else and kept while they hop between games, so a
 * thumbnail never moves while they reach for it. Null until the first list arrives.
 */
export const stripGames = signal<StripGame[] | null>(null);

/** Forgets the order: the next list is taken in the server's order. */
export function resetStrip(): void {
  stripGames.value = null;
}

/**
 * Lays a fresh list over the order already shown. On arrival (`previous` null) the server's order
 * stands. After that every game keeps its slot with its fresh copy; a game that left the list (it
 * ended) drops out unless it is the one on screen, and a game that joined goes on the end.
 */
export function arrangeStrip(
  previous: readonly StripGame[] | null,
  fresh: readonly StripGame[],
  currentId: string,
): StripGame[] {
  if (previous === null) return [...fresh];
  const byId = new Map(fresh.map((game) => [game.id, game]));
  const kept = previous.flatMap((game) => {
    const next = byId.get(game.id);
    if (next) return [next];
    return game.id === currentId ? [game] : [];
  });
  const shown = new Set(previous.map((game) => game.id));
  return [...kept, ...fresh.filter((game) => !shown.has(game.id))];
}
