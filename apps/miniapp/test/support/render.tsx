import { render, type ComponentChildren } from 'preact';
import { act } from 'preact/test-utils';
import { createApiClient, type ApiClient } from '../../src/api/client';
import { Router } from '../../src/router';
import { prefs, session } from '../../src/state/session';
import { createTg, type Tg } from '../../src/tg/webapp';
import { AppProvider, type AppContextValue } from '../../src/ui/context';
import { Dialogs } from '../../src/ui/dialog';
import { resetToasts, Toasts } from '../../src/ui/toast';
import { fakeFetch, type FakeRoute } from './fakeFetch';
import { installFakeWebApp } from './fakeWebApp';

export type Rendered = {
  root: HTMLElement;
  app: AppContextValue;
  calls: ReturnType<typeof fakeFetch>['calls'];
  tg: Tg;
  flush(): Promise<void>;
  click(selector: string): Promise<void>;
  text(): string;
};

let lastRoot: HTMLElement | null = null;

/** Mounts `ui` with a fake Telegram (8.0), a fake fetch and a fresh router; the session is preset. */
export function renderApp(
  ui: (app: AppContextValue) => ComponentChildren,
  route: FakeRoute,
  options: {
    version?: string;
    closeFromRoot?: boolean;
    client?: ApiClient;
    writeAccess?: boolean;
    popupError?: string;
    tg?: Tg;
    invoiceError?: string;
  } = {},
): Rendered {
  installFakeWebApp({
    version: options.version ?? '8.0',
    initData: 'user=x&hash=y',
    writeAccess: options.writeAccess,
    popupError: options.popupError,
    invoiceError: options.invoiceError,
  });
  const tg = options.tg ?? createTg(window.Telegram!.WebApp);
  const { fetch, calls } = fakeFetch(route);
  const client = options.client ?? createApiClient({ fetch });
  client.setToken('jwt');
  session.value = {
    user: { id: '1', name: 'Alice', username: 'alice' },
    bot: { username: 'TestChessBot', miniAppShortName: 'chess' },
    launchedFrom: null,
  };
  prefs.value = {
    notifications: true,
    moveConfirmations: 'people',
    boardTheme: null,
    pieceSet: null,
  };
  const router = new Router(tg, { closeFromRoot: options.closeFromRoot ?? false });
  const app: AppContextValue = { tg, client, router, prefetched: {} };
  // Unmount the previous tree: its streams and timers stop. `act` runs its effect cleanups now,
  // which Preact otherwise defers until after the next paint.
  if (lastRoot) act(() => render(null, lastRoot!));
  document.body.innerHTML = '';
  resetToasts(); // a toast from a previous test's fixture must not bleed into this fresh mount
  const root = document.createElement('div');
  lastRoot = root;
  document.body.appendChild(root);
  render(
    <AppProvider value={app}>
      {ui(app)}
      <Toasts />
      <Dialogs />
    </AppProvider>,
    root,
  );
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return {
    root,
    app,
    calls,
    tg,
    flush,
    click: async (selector) => {
      const element =
        root.querySelector<HTMLElement>(selector) ?? document.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`no element for ${selector}`);
      element.click();
      await flush();
    },
    text: () => root.textContent ?? '',
  };
}
