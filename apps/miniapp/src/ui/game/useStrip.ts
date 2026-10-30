import { MeGamesDtoSchema, type GameDto } from '@group-chess/shared';
import { useEffect, useState } from 'preact/hooks';
import { arrangeStrip, resetStrip, stripGames, type StripGame } from '../../state/switcher';
import { countYourMove, turnChangesSeen } from '../../state/yourMove';
import { useApp } from '../context';

/** How often the strip reloads the list while a game is open and the app is in view. */
export const STRIP_REFRESH_MS = 30_000;

/**
 * The switcher strip's games for the game on screen, or null while it is hidden: to anyone
 * watching, and whenever the list holds no game but this one (game switcher spec). A game reached
 * from the strip itself (`hop`) keeps the order already shown; arriving from anywhere else starts
 * a fresh one. Only the game on screen has a live stream, so the list is reloaded every
 * `STRIP_REFRESH_MS` while the app is in view and as soon as it comes back; a failed load keeps
 * what is shown, and a load overtaken by a newer one is dropped. Spectators load nothing.
 */
export function useStrip(current: GameDto, hop: boolean): StripGame[] | null {
  const { client } = useApp();
  // Before the first read, so a stale order from an earlier visit never paints.
  useState(() => {
    if (!hop) resetStrip();
  });
  const isPlayer = current.viewerRole === 'white' || current.viewerRole === 'black';
  useEffect(() => {
    if (!isPlayer) return;
    let live = true;
    let latest = 0;
    const load = (): void => {
      const request = (latest += 1);
      const turns = turnChangesSeen();
      void client
        .get('/api/me/games', MeGamesDtoSchema)
        .then((games) => {
          if (!live || request !== latest) return;
          stripGames.value = arrangeStrip(stripGames.value, games.items, current.id);
          // The full list outranks the badge's running count, as on the Games tab, unless a turn
          // changed while it was on its way: then the running count is the newer of the two.
          if (turnChangesSeen() === turns) countYourMove(games);
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
  if (!isPlayer || !games?.some((game) => game.id !== current.id)) return null;
  return games;
}
