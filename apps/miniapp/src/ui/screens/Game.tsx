import { GameDtoSchema } from '@group-chess/shared';
import { useApp } from '../context';
import { GameView } from '../game/GameView';
import { useResource } from '../hooks';
import { ErrorScreen, Loading } from './Status';

export function Game(props: { gameId: string; hop?: boolean }) {
  const { client, prefetched } = useApp();
  const initial = prefetched.game?.id === props.gameId ? prefetched.game : undefined;
  if (initial) delete prefetched.game;
  const load = () => client.get(`/api/games/${props.gameId}`, GameDtoSchema);
  const game = useResource(`game:${props.gameId}`, load, initial);
  if (game.error) return <ErrorScreen onRetry={() => void game.reload()} />;
  if (!game.data) return <Loading />;
  return <GameView initial={game.data} onReload={load} hop={props.hop ?? false} />;
}
