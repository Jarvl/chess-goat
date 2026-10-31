import type { MeGamesDto } from '@chess-goat/shared';
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

/**
 * Where the strip was scrolled, kept across hops like its order, so a thumbnail stays under the
 * thumb that reached for it. Null on arrival, when the strip centres the game on screen.
 */
export const stripScroll: { left: number | null } = { left: null };

/** Whether the docked strip is on screen, and how, so the app can lift toasts clear of it. */
export const dock = signal<'open' | 'minimized' | null>(null);

const MINIMIZED_KEY = 'switcher.minimized';

/** Whether the viewer minimized the strip on this device; open when storage is unreadable. */
export function loadStripMinimized(): boolean {
  try {
    return localStorage.getItem(MINIMIZED_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * The strip minimized behind its chevron: one choice for every game, remembered on this device
 * until the viewer opens it again (game switcher spec). Telegram has no setting for it, and it is
 * a convenience, so blocked storage only shortens it to this visit.
 */
export const stripMinimized = signal(loadStripMinimized());

export function setStripMinimized(minimized: boolean): void {
  stripMinimized.value = minimized;
  try {
    if (minimized) localStorage.setItem(MINIMIZED_KEY, '1');
    else localStorage.removeItem(MINIMIZED_KEY);
  } catch {
    // Private mode or blocked site data: the choice lasts this visit.
  }
}

/** Forgets the order: the next list is taken in the server's order. */
export function resetStrip(): void {
  stripGames.value = null;
  stripScroll.left = null;
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
