/**
 * A fake `window.Telegram.WebApp` for unit tests and for Playwright (`page.addInitScript`).
 * The function must stay self-contained: Playwright serialises its source into the page.
 *
 * Like the real `telegram-web-app.js`, every method and object exists on every version. Below a
 * method's minimum version the fake does what the real script does there — warns and does nothing,
 * or throws `WebAppMethodUnsupported` — and records the name in `unsupported`, which the global
 * check in `setup.ts` (and the e2e fixture) fails the test on. The minimum versions and behaviours
 * are the real script's, checked against the copy `@twa-dev/sdk@8.0.2` ships as
 * `src/telegram-web-apps.js` (fetch it with `npm pack @twa-dev/sdk@8.0.2` to re-check), not the
 * app's own feature table: copying the app's table would hide a mistake in it.
 */
export type FakeWebAppOptions = {
  version: string;
  initData: string;
  startParam?: string;
  colorScheme?: 'light' | 'dark';
  stableHeight?: number;
  /** What the user answers to `requestWriteAccess`. */
  writeAccess?: boolean;
  /** Makes `showPopup` throw this message instead of opening a popup, e.g. a client-side param
   * rejection (`WebAppPopupParamInvalid`) rather than the "already open" case. */
  popupError?: string;
  /** Makes `openInvoice` throw this message, e.g. `WebAppInvoiceUrlInvalid`. */
  invoiceError?: string;
};

export type FakeButton = {
  text: string;
  visible: boolean;
  progress: boolean;
  enabled: boolean;
  color?: string;
  textColor?: string;
};

export type FakeWebAppRecord = {
  calls: string[];
  /** Methods and objects the app used below the version that has them. */
  unsupported: string[];
  mainButton: FakeButton;
  secondaryButton: FakeButton;
  backButton: { visible: boolean };
  haptics: string[];
  /** URLs opened with `openLink`. */
  links: string[];
  /** URLs opened with `openTelegramLink`. */
  telegramLinks: string[];
  downloads: { url: string; file_name: string }[];
  closed: boolean;
  chrome: { header?: string; background?: string; bottomBar?: string };
  popups: {
    title?: string;
    message: string;
    buttons: { id?: string; type?: string; text?: string }[];
  }[];
  answerPopup(id: string): void;
  invoices: string[];
  answerInvoice(status: 'paid' | 'cancelled' | 'failed' | 'pending'): void;
  closingConfirmation: boolean;
  settingsButton: { visible: boolean };
  clickSettings(): void;
  clickMain(): void;
  clickSecondary(): void;
  clickBack(): void;
  emit(event: string, ...args: unknown[]): void;
  setStableHeight(height: number): void;
};

declare global {
  interface Window {
    __tg?: FakeWebAppRecord;
  }
}

export function installFakeWebApp(options: FakeWebAppOptions): void {
  const atLeast = (version: string, minimum: string): boolean => {
    const a = version.split('.').map((p) => Number.parseInt(p, 10) || 0);
    const b = minimum.split('.').map((p) => Number.parseInt(p, 10) || 0);
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      const x = a[i] ?? 0;
      const y = b[i] ?? 0;
      if (x !== y) return x > y;
    }
    return true;
  };
  let pendingPopup: ((id: string) => void) | null = null;
  let pendingInvoice: ((status: string) => void) | null = null;
  const record: FakeWebAppRecord = {
    calls: [],
    unsupported: [],
    mainButton: { text: '', visible: false, progress: false, enabled: true },
    secondaryButton: { text: '', visible: false, progress: false, enabled: true },
    backButton: { visible: false },
    haptics: [],
    links: [],
    telegramLinks: [],
    downloads: [],
    closed: false,
    chrome: {},
    popups: [],
    invoices: [],
    answerInvoice: (status) => {
      const answer = pendingInvoice;
      pendingInvoice = null;
      answer?.(status);
    },
    closingConfirmation: false,
    settingsButton: { visible: false },
    answerPopup: (id) => {
      const answer = pendingPopup;
      pendingPopup = null;
      answer?.(id);
    },
    clickSettings: () => {
      for (const cb of [...handlers.settings]) cb();
    },
    clickMain: () => {
      for (const cb of [...handlers.main]) cb();
    },
    clickSecondary: () => {
      for (const cb of [...handlers.secondary]) cb();
    },
    clickBack: () => {
      for (const cb of [...handlers.back]) cb();
    },
    emit: (event, ...args) => {
      for (const cb of [...(listeners[event] ?? [])]) cb(...args);
    },
    setStableHeight: (height) => {
      webApp.viewportStableHeight = height;
      webApp.viewportHeight = height;
      record.emit('viewportChanged', { isStateStable: true });
    },
  };
  const handlers = {
    main: [] as (() => void)[],
    secondary: [] as (() => void)[],
    back: [] as (() => void)[],
    settings: [] as (() => void)[],
  };
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  /** True when `name` is below `minimum` on this client; records it as an unsupported use. */
  const missing = (minimum: string, name: string): boolean => {
    if (atLeast(options.version, minimum)) return false;
    record.unsupported.push(name);
    return true;
  };
  /** The real script's answer to a method it throws for below its version. */
  const unsupportedMethod = (minimum: string, name: string): void => {
    if (missing(minimum, name)) throw new Error('WebAppMethodUnsupported');
  };
  const removeFrom = (list: (() => void)[], cb: () => void) => {
    const at = list.indexOf(cb);
    if (at >= 0) list.splice(at, 1);
  };
  // `minimum` is null for the main button, which every version has. The real script has no version
  // check on the secondary button, but a client older than 7.10 ignores it, so using it there is
  // recorded as unsupported all the same: the player would see nothing.
  const button = (
    state: FakeButton,
    list: (() => void)[],
    name: string,
    minimum: string | null,
  ) => {
    const gone = (method: string) => minimum !== null && missing(minimum, `${name}.${method}`);
    return {
      get isVisible() {
        return state.visible;
      },
      setText: (text: string) => {
        if (gone('setText')) return;
        state.text = text;
        record.calls.push(`${name}.setText:${text}`);
      },
      show: () => {
        if (gone('show')) return;
        state.visible = true;
        record.calls.push(`${name}.show`);
      },
      hide: () => {
        if (gone('hide')) return;
        state.visible = false;
        record.calls.push(`${name}.hide`);
      },
      onClick: (cb: () => void) => {
        if (gone('onClick')) return;
        list.push(cb);
      },
      offClick: (cb: () => void) => {
        if (gone('offClick')) return;
        removeFrom(list, cb);
      },
      showProgress: () => {
        if (gone('showProgress')) return;
        state.progress = true;
      },
      hideProgress: () => {
        if (gone('hideProgress')) return;
        state.progress = false;
      },
      enable: () => {
        if (gone('enable')) return;
        state.enabled = true;
      },
      disable: () => {
        if (gone('disable')) return;
        state.enabled = false;
      },
      setParams: (params: { color?: string; text_color?: string }) => {
        if (gone('setParams')) return;
        if (params.color) state.color = params.color;
        if (params.text_color) state.textColor = params.text_color;
        record.calls.push(`${name}.setParams`);
      },
    };
  };
  /** The back and settings buttons: shown or hidden, with click handlers, from `minimum`. */
  const visibilityButton = (
    state: { visible: boolean },
    list: (() => void)[],
    name: string,
    minimum: string,
  ) => ({
    get isVisible() {
      return state.visible;
    },
    show: () => {
      if (missing(minimum, `${name}.show`)) return;
      state.visible = true;
      record.calls.push(`${name}.show`);
    },
    hide: () => {
      if (missing(minimum, `${name}.hide`)) return;
      state.visible = false;
      record.calls.push(`${name}.hide`);
    },
    onClick: (cb: () => void) => {
      if (missing(minimum, `${name}.onClick`)) return;
      list.push(cb);
    },
    offClick: (cb: () => void) => {
      if (missing(minimum, `${name}.offClick`)) return;
      removeFrom(list, cb);
    },
  });
  const params = new URLSearchParams(options.initData);
  const rawUser = params.get('user');
  const parseUser = (raw: string): unknown => {
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  };
  const webApp: Record<string, unknown> & { viewportStableHeight: number; viewportHeight: number } =
    {
      initData: options.initData,
      initDataUnsafe: {
        start_param: options.startParam,
        user: rawUser ? parseUser(rawUser) : undefined,
      },
      version: options.version,
      platform: 'android',
      colorScheme: options.colorScheme ?? 'light',
      themeParams: {},
      viewportStableHeight: options.stableHeight ?? 720,
      viewportHeight: options.stableHeight ?? 720,
      isExpanded: false,
      ready: () => record.calls.push('ready'),
      expand: () => {
        webApp.isExpanded = true;
        record.calls.push('expand');
      },
      close: () => {
        record.closed = true;
        record.calls.push('close');
      },
      isVersionAtLeast: (v: string) => atLeast(options.version, v),
      onEvent: (event: string, cb: (...args: unknown[]) => void) => {
        (listeners[event] ??= []).push(cb);
      },
      offEvent: (event: string, cb: (...args: unknown[]) => void) => {
        const list = listeners[event] ?? [];
        const at = list.indexOf(cb);
        if (at >= 0) list.splice(at, 1);
      },
      openLink: (url: string) => {
        record.links.push(url);
        record.calls.push(`openLink:${url}`);
      },
      openTelegramLink: (url: string) => {
        record.telegramLinks.push(url);
        record.calls.push(`openTelegramLink:${url}`);
      },
      BackButton: visibilityButton(record.backButton, handlers.back, 'BackButton', '6.1'),
      SettingsButton: visibilityButton(
        record.settingsButton,
        handlers.settings,
        'SettingsButton',
        '6.10',
      ),
      MainButton: button(record.mainButton, handlers.main, 'MainButton', null),
      SecondaryButton: button(
        record.secondaryButton,
        handlers.secondary,
        'SecondaryButton',
        '7.10',
      ),
      HapticFeedback: {
        impactOccurred: (style: string) => {
          if (!missing('6.1', 'HapticFeedback')) record.haptics.push(`impact:${style}`);
        },
        notificationOccurred: (type: string) => {
          if (!missing('6.1', 'HapticFeedback')) record.haptics.push(`notification:${type}`);
        },
        selectionChanged: () => {
          if (!missing('6.1', 'HapticFeedback')) record.haptics.push('selection');
        },
      },
      setHeaderColor: (color: string) => {
        if (missing('6.1', 'setHeaderColor')) return;
        record.chrome.header = color;
        record.calls.push(`setHeaderColor:${color}`);
      },
      setBackgroundColor: (color: string) => {
        if (missing('6.1', 'setBackgroundColor')) return;
        record.chrome.background = color;
        record.calls.push(`setBackgroundColor:${color}`);
      },
      setBottomBarColor: (color: string) => {
        if (missing('7.10', 'setBottomBarColor')) return;
        record.chrome.bottomBar = color;
        record.calls.push(`setBottomBarColor:${color}`);
      },
      enableClosingConfirmation: () => {
        if (missing('6.2', 'enableClosingConfirmation')) return;
        record.closingConfirmation = true;
        record.calls.push('enableClosingConfirmation');
      },
      disableClosingConfirmation: () => {
        if (missing('6.2', 'disableClosingConfirmation')) return;
        record.closingConfirmation = false;
        record.calls.push('disableClosingConfirmation');
      },
      disableVerticalSwipes: () => {
        if (missing('7.7', 'disableVerticalSwipes')) return;
        record.calls.push('disableVerticalSwipes');
      },
      enableVerticalSwipes: () => {
        if (missing('7.7', 'enableVerticalSwipes')) return;
        record.calls.push('enableVerticalSwipes');
      },
      openInvoice: (url: string, cb?: (status: string) => void) => {
        unsupportedMethod('6.1', 'openInvoice');
        if (options.invoiceError) throw new Error(options.invoiceError);
        if (pendingInvoice !== null) throw new Error('WebAppInvoiceOpened');
        record.invoices.push(url);
        record.calls.push(`openInvoice:${url}`);
        pendingInvoice = cb ?? (() => undefined);
      },
      showPopup: (params: FakeWebAppRecord['popups'][number], cb?: (id: string) => void) => {
        unsupportedMethod('6.2', 'showPopup');
        if (options.popupError) throw new Error(options.popupError);
        if (pendingPopup !== null) throw new Error('WebAppPopupOpened');
        record.popups.push(params);
        record.calls.push(`showPopup:${params.message}`);
        pendingPopup = cb ?? null;
      },
      requestWriteAccess: (cb?: (granted: boolean) => void) => {
        unsupportedMethod('6.9', 'requestWriteAccess');
        record.calls.push('requestWriteAccess');
        cb?.(options.writeAccess === true);
      },
      downloadFile: (
        request: { url: string; file_name: string },
        cb?: (accepted: boolean) => void,
      ) => {
        unsupportedMethod('8.0', 'downloadFile');
        record.downloads.push(request);
        record.calls.push(`downloadFile:${request.file_name}`);
        cb?.(true);
      },
    };
  (window as unknown as { Telegram: unknown }).Telegram = { WebApp: webApp };
  window.__tg = record;
}
