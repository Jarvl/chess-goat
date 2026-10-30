import { useApp } from './context';
import { Dialogs } from './dialog';
import { FlairScreen } from './screens/Flair';
import { Game } from './screens/Game';
import { Games } from './screens/Games';
import { GroupSettings } from './screens/GroupSettings';
import { Groups } from './screens/Groups';
import { Leaderboard } from './screens/Leaderboard';
import { Lobby } from './screens/Lobby';
import { NewGame } from './screens/NewGame';
import { Player } from './screens/Player';
import { Settings } from './screens/Settings';
import { ErrorScreen, Loading, Locked, Reopen } from './screens/Status';
import { TabBar } from './TabBar';
import { Toasts } from './toast';

function Screen() {
  const { router } = useApp();
  const route = router.current.value;
  switch (route.name) {
    case 'loading':
      return <Loading />;
    case 'error':
      return <ErrorScreen onRetry={() => window.location.reload()} />;
    case 'reopen':
      return <Reopen />;
    case 'locked':
      return <Locked group={route.group} />;
    case 'games':
      return <Games />;
    case 'groups':
      return <Groups />;
    case 'lobby':
      return <Lobby key={route.groupId} groupId={route.groupId} scope={route.scope} />;
    case 'leaderboard':
      return <Leaderboard key={route.groupId} groupId={route.groupId} />;
    case 'newGame':
      return (
        <NewGame
          key={`${route.groupId}:${route.opponentId ?? ''}`}
          groupId={route.groupId}
          opponentId={route.opponentId}
        />
      );
    case 'game':
      return <Game key={route.gameId} gameId={route.gameId} hop={route.hop === true} />;
    case 'player':
      return (
        <Player
          key={`${route.groupId}:${route.userId}`}
          groupId={route.groupId}
          userId={route.userId}
        />
      );
    case 'settings':
      return <Settings />;
    case 'flair':
      return <FlairScreen />;
    case 'groupSettings':
      return <GroupSettings key={route.groupId} groupId={route.groupId} />;
  }
}

export function App() {
  const { router } = useApp();
  return (
    <>
      <div class={router.showTabs.value ? 'app with-tabbar' : 'app'}>
        <Screen />
      </div>
      <TabBar />
      <Toasts />
      <Dialogs />
    </>
  );
}
