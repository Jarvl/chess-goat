import { MeGamesDtoSchema, type GameDto } from '@group-chess/shared';
import { useEffect, useState } from 'preact/hooks';
import { arrangeStrip, resetStrip, stripGames, type StripGame } from '../../state/switcher';
import { useApp } from '../context';

/**
 * The switcher strip's games for the game on screen, or null while it is hidden: to anyone
 * watching, and whenever the list holds no game but this one (game switcher spec). A game reached
 * from the strip itself (`hop`) keeps the order already shown; arriving from anywhere else starts
 * a fresh one.
 */
export function useStrip(current: GameDto, hop: boolean): StripGame[] | null {
  const { client } = useApp();
  // Before the first read, so a stale order from an earlier visit never paints.
  useState(() => {
    if (!hop) resetStrip();
  });
  useEffect(() => {
    void client
      .get('/api/me/games', MeGamesDtoSchema)
      .then((games) => {
        stripGames.value = arrangeStrip(stripGames.value, games.items, current.id);
      })
      .catch(() => undefined);
  }, []);
  const games = stripGames.value;
  const isPlayer = current.viewerRole === 'white' || current.viewerRole === 'black';
  if (!isPlayer || !games?.some((game) => game.id !== current.id)) return null;
  return games;
}
