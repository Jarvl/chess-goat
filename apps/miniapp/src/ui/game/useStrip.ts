import { MeGamesDtoSchema, type GameDto } from '@group-chess/shared';
import { useEffect, useState } from 'preact/hooks';
import { arrangeStrip, resetStrip, stripGames, type StripGame } from '../../state/switcher';
import { countYourMove } from '../../state/yourMove';
import { useApp } from '../context';

/** How often the strip reloads the list while a game is open and the app is in view. */
export const STRIP_REFRESH_MS = 30_000;

/**
 * The switcher strip's games for the game on screen, or null while it is hidden: to anyone
 * watching, and whenever the list holds no game but this one (game switcher spec). A game reached
 * from the strip itself (`hop`) keeps the order already shown; arriving from anywhere else starts
 * a fresh one. Only the game on screen has a live stream, so the list is reloaded every
 * `STRIP_REFRESH_MS` while the app is in view and as soon as it comes back; a failed load keeps
 * what is shown.
 */
export function useStrip(current: GameDto, hop: boolean): StripGame[] | null {
  const { client } = useApp();
  // Before the first read, so a stale order from an earlier visit never paints.
  useState(() => {
    if (!hop) resetStrip();
  });
  useEffect(() => {
    let live = true;
    const load = (): void => {
      void client
        .get('/api/me/games', MeGamesDtoSchema)
        .then((games) => {
          if (!live) return;
          stripGames.value = arrangeStrip(stripGames.value, games.items, current.id);
          // The full list outranks the badge's running count, as on the Games tab.
          countYourMove(games);
        })
        .catch(() => undefined);
    };
    const inView = (): boolean => document.visibilityState === 'visible';
    const onVisibility = (): void => {
      if (inView()) load();
    };
    load();
    const timer = setInterval(() => {
      if (inView()) load();
    }, STRIP_REFRESH_MS);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      live = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);
  const games = stripGames.value;
  const isPlayer = current.viewerRole === 'white' || current.viewerRole === 'black';
  if (!isPlayer || !games?.some((game) => game.id !== current.id)) return null;
  return games;
}
