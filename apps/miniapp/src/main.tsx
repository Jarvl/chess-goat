import { decodeStartParam } from '@chess-goat/shared';
import { render } from 'preact';
import { createApiClient } from './api/client';
import { boot, relaunch } from './boot';
import { Router } from './router';
import { createTg } from './tg/webapp';
import { App } from './ui/App';
import { AppProvider, type AppContextValue } from './ui/context';
import './styles.css';

const tg = createTg();
// A launch from a chat link keeps its one-tap way back out; a profile launch has none to keep.
const router = new Router(tg, { closeFromRoot: decodeStartParam(tg.startParam) !== null });
const app: AppContextValue = {
  tg,
  router,
  prefetched: {},
  client: createApiClient({ onUnauthorized: () => relaunch(app) }),
};

render(
  <AppProvider value={app}>
    <App />
  </AppProvider>,
  document.getElementById('app')!,
);

void boot(app);
