import type { GameDto, GroupSettingsDto, LobbyDto, MeGamesDto } from '@chess-goat/shared';
import { createContext } from 'preact';
import { useContext } from 'preact/hooks';
import type { ApiClient } from '../api/client';
import type { Router } from '../router';
import type { Tg } from '../tg/webapp';

/** Data that arrived with the launch response, consumed once by the first screen (spec §6.1). */
export type Prefetched = {
  game?: GameDto;
  lobby?: LobbyDto;
  settings?: GroupSettingsDto;
  games?: MeGamesDto;
};

export type AppContextValue = {
  tg: Tg;
  client: ApiClient;
  router: Router;
  prefetched: Prefetched;
};

export const AppContext = createContext<AppContextValue | null>(null);
export const AppProvider = AppContext.Provider;

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error('AppProvider is missing');
  return value;
}
