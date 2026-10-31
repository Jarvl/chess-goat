import { GameDtoSchema } from '@chess-goat/shared';
import { stripGames } from '../../state/switcher';
import { useApp } from '../context';
import { GameSwitcher } from '../game/GameSwitcher';
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
  if (!game.data) {
    // A game opened from the switcher strip keeps the strip on screen while it loads, so it never
    // blinks out from under the thumb that tapped it (game switcher spec).
    const strip = props.hop ? stripGames.value : null;
    return (
      <>
        <Loading />
        {strip ? <GameSwitcher games={strip} currentId={props.gameId} /> : null}
      </>
    );
  }
  return <GameView initial={game.data} onReload={load} hop={props.hop ?? false} />;
}
