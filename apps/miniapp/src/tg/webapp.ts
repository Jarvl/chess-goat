import type { TelegramButton, TelegramWebApp, ThemeParams } from './types';

export type Feature =
  | 'haptics'
  | 'writeAccess'
  | 'verticalSwipes'
  | 'secondaryButton'
  | 'downloadFile'
  | 'headerColor'
  | 'bottomBarColor'
  | 'popup'
  | 'closingConfirmation'
  | 'settingsButton'
  | 'activation'
  | 'invoice'
  | 'backButton';

/** Spec §6.6: the first Bot API version that has each capability. */
export const FEATURE_MIN_VERSION: Record<Feature, string> = {
  haptics: '6.1',
  writeAccess: '6.9',
  verticalSwipes: '7.7',
  secondaryButton: '7.10',
  downloadFile: '8.0',
  headerColor: '6.1',
  bottomBarColor: '7.10',
  popup: '6.2',
  closingConfirmation: '6.2',
  settingsButton: '7.0',
  activation: '8.0',
  invoice: '6.1',
  backButton: '6.1',
};

export function versionAtLeast(version: string, minimum: string): boolean {
  const a = version.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const b = minimum.split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

export type HapticImpact = 'light' | 'medium' | 'heavy';
export type HapticNotification = 'success' | 'warning' | 'error';
export type InvoiceStatus = 'paid' | 'cancelled' | 'failed' | 'pending';

export type ButtonSpec = {
  text: string;
  onClick: () => void;
  /** Shows the spinner and disables the button while true. */
  progress?: boolean;
  enabled?: boolean;
};

export type PopupButton = {
  id: string;
  type: 'default' | 'ok' | 'close' | 'cancel' | 'destructive';
  text?: string;
};

export type PopupParams = { title?: string; message: string; buttons: PopupButton[] };

export interface Tg {
  /** False in a plain browser: every capability is off and buttons are rendered in-page. */
  readonly available: boolean;
  readonly version: string;
  readonly platform: string;
  readonly initData: string;
  readonly startParam: string | null;
  readonly colorScheme: 'light' | 'dark';
  readonly themeParams: ThemeParams;
  readonly stableHeight: number;
  supports(feature: Feature): boolean;
  ready(): void;
  expand(): void;
  close(): void;
  /** True when the client supports it and it was called. */
  disableVerticalSwipes(): boolean;
  haptic(kind: HapticImpact): void;
  hapticNotify(kind: HapticNotification): void;
  /** False when the client has no such button; the caller renders one in the page. */
  setMainButton(spec: ButtonSpec | null): boolean;
  setSecondaryButton(spec: ButtonSpec | null): boolean;
  setBackButton(visible: boolean, onClick: () => void): void;
  /** null when the client cannot ask (below 6.9). */
  requestWriteAccess(): Promise<boolean | null>;
  openLink(url: string): void;
  /** False when the client cannot download (below 8.0); the caller opens the link instead. */
  downloadFile(url: string, fileName: string): boolean;
  onViewportChanged(callback: (stableHeight: number) => void): () => void;
  onThemeChanged(callback: () => void): () => void;
  /** Header and background (6.1) and bottom bar (7.10) take this theme colour; a no-op below. */
  setChromeColor(key: 'bg_color' | 'secondary_bg_color'): void;
  /** Colours Telegram's MainButton; the client keeps the colours across show and hide. */
  setMainButtonColors(color: string, textColor: string): void;
  /**
   * Telegram's native alert (6.2+): resolves the pressed button's id, or null when dismissed.
   * Returns null instead of a promise when the client has none, so the caller renders its own.
   */
  showPopup(params: PopupParams): Promise<string | null> | null;
  /** Asks before a swipe or Close discards the page (6.2+); a no-op below. */
  setClosingConfirmation(enabled: boolean): void;
  /** Shows Telegram's Settings menu item (7.0+) and routes its taps here; returns the undo. */
  onSettingsButton(callback: () => void): () => void;
  /** Telegram minimising or backgrounding the app (8.0+); a no-op below. Returns the undo. */
  onDeactivated(callback: () => void): () => void;
  hapticSelection(): void;
  /** A t.me link, opened inside Telegram. */
  openTelegramLink(url: string): void;
  /**
   * Telegram's payment sheet (6.1+): resolves the invoice's final status, or rejects when the
   * client refuses the link. Returns null instead of a promise when the client has none.
   */
  openInvoice(url: string): Promise<InvoiceStatus> | null;
}

class ButtonBinding {
  private handler: (() => void) | null = null;

  constructor(private readonly button: TelegramButton | undefined) {}

  set(spec: ButtonSpec | null): boolean {
    const { button } = this;
    if (!button) return false;
    if (this.handler) button.offClick(this.handler);
    this.handler = null;
    if (!spec) {
      button.hide();
      return true;
    }
    this.handler = spec.onClick;
    button.setText(spec.text);
    button.onClick(spec.onClick);
    if (spec.enabled === false) button.disable();
    else button.enable();
    if (spec.progress) button.showProgress(false);
    else button.hideProgress();
    button.show();
    return true;
  }
}

function nullTg(): Tg {
  return {
    available: false,
    version: '0.0',
    platform: 'unknown',
    initData: '',
    startParam: null,
    colorScheme:
      typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light',
    themeParams: {},
    stableHeight: typeof window === 'undefined' ? 0 : window.innerHeight,
    supports: () => false,
    ready: () => undefined,
    expand: () => undefined,
    close: () => undefined,
    disableVerticalSwipes: () => false,
    haptic: () => undefined,
    hapticNotify: () => undefined,
    setMainButton: () => false,
    setSecondaryButton: () => false,
    setBackButton: () => undefined,
    requestWriteAccess: () => Promise.resolve(null),
    openLink: (url) => {
      window.open(url, '_blank', 'noopener');
    },
    downloadFile: () => false,
    onViewportChanged: () => () => undefined,
    onThemeChanged: () => () => undefined,
    setChromeColor: () => undefined,
    setMainButtonColors: () => undefined,
    showPopup: () => null,
    setClosingConfirmation: () => undefined,
    onSettingsButton: () => () => undefined,
    onDeactivated: () => () => undefined,
    hapticSelection: () => undefined,
    openTelegramLink: (url) => {
      window.open(url, '_blank', 'noopener');
    },
    openInvoice: () => null,
  };
}

/** Wraps the real `window.Telegram.WebApp`; without one (a plain browser) every capability is off. */
export function createTg(
  raw: TelegramWebApp | null | undefined = typeof window === 'undefined'
    ? null
    : window.Telegram?.WebApp,
): Tg {
  if (!raw) return nullTg();
  const supports = (feature: Feature): boolean =>
    versionAtLeast(raw.version, FEATURE_MIN_VERSION[feature]);
  const main = new ButtonBinding(raw.MainButton);
  const secondary = new ButtonBinding(
    supports('secondaryButton') ? raw.SecondaryButton : undefined,
  );
  let backHandler: (() => void) | null = null;
  return {
    available: true,
    get version() {
      return raw.version;
    },
    get platform() {
      return raw.platform;
    },
    get initData() {
      return raw.initData;
    },
    get startParam() {
      // A direct link signs it into initData; a DM's `web_app` button can only put it in the URL.
      return (
        raw.initDataUnsafe?.start_param ??
        new URLSearchParams(window.location.search).get('startapp')
      );
    },
    get colorScheme() {
      return raw.colorScheme === 'dark' ? 'dark' : 'light';
    },
    get themeParams() {
      return raw.themeParams ?? {};
    },
    get stableHeight() {
      return raw.viewportStableHeight || window.innerHeight;
    },
    supports,
    ready: () => raw.ready(),
    expand: () => raw.expand(),
    close: () => raw.close(),
    disableVerticalSwipes() {
      if (!supports('verticalSwipes') || !raw.disableVerticalSwipes) return false;
      raw.disableVerticalSwipes();
      return true;
    },
    haptic(kind) {
      if (supports('haptics')) raw.HapticFeedback?.impactOccurred(kind);
    },
    hapticNotify(kind) {
      if (supports('haptics')) raw.HapticFeedback?.notificationOccurred(kind);
    },
    setMainButton: (spec) => main.set(spec),
    setSecondaryButton: (spec) => secondary.set(spec),
    setBackButton(visible, onClick) {
      if (!supports('backButton')) return;
      if (backHandler) raw.BackButton.offClick(backHandler);
      backHandler = onClick;
      raw.BackButton.onClick(onClick);
      if (visible) raw.BackButton.show();
      else raw.BackButton.hide();
    },
    requestWriteAccess() {
      if (!supports('writeAccess') || !raw.requestWriteAccess) return Promise.resolve(null);
      return new Promise((resolve) => raw.requestWriteAccess!((granted) => resolve(granted)));
    },
    openLink: (url) => raw.openLink(url),
    downloadFile(url, fileName) {
      if (!supports('downloadFile') || !raw.downloadFile) return false;
      raw.downloadFile({ url, file_name: fileName });
      return true;
    },
    onViewportChanged(callback) {
      const handler = (): void => callback(raw.viewportStableHeight || window.innerHeight);
      raw.onEvent('viewportChanged', handler);
      return () => raw.offEvent('viewportChanged', handler);
    },
    onThemeChanged(callback) {
      raw.onEvent('themeChanged', callback);
      return () => raw.offEvent('themeChanged', callback);
    },
    setChromeColor(key) {
      if (supports('headerColor')) {
        raw.setHeaderColor?.(key);
        raw.setBackgroundColor?.(key);
      }
      if (supports('bottomBarColor')) raw.setBottomBarColor?.(key);
    },
    setMainButtonColors: (color, textColor) =>
      raw.MainButton.setParams?.({ color, text_color: textColor }),
    showPopup(params) {
      if (!supports('popup') || !raw.showPopup) return null;
      return new Promise((resolve, reject) => {
        try {
          raw.showPopup!(params, (buttonId) => resolve(buttonId ? buttonId : null));
        } catch (error) {
          if (error instanceof Error && error.message === 'WebAppPopupOpened') {
            // A popup is already open: the second caller reads "no".
            resolve(null);
          } else {
            // Any other failure (e.g. WebAppPopupParamInvalid) means the client rejected the
            // call, not the user declining; let the caller fall back to the in-page sheet.
            reject(error);
          }
        }
      });
    },
    setClosingConfirmation(enabled) {
      if (!supports('closingConfirmation')) return;
      if (enabled) raw.enableClosingConfirmation?.();
      else raw.disableClosingConfirmation?.();
    },
    onSettingsButton(callback) {
      const button = supports('settingsButton') ? raw.SettingsButton : undefined;
      if (!button) return () => undefined;
      button.onClick(callback);
      button.show();
      return () => {
        button.offClick(callback);
        button.hide();
      };
    },
    onDeactivated(callback) {
      if (!supports('activation')) return () => undefined;
      raw.onEvent('deactivated', callback);
      return () => raw.offEvent('deactivated', callback);
    },
    hapticSelection() {
      if (supports('haptics')) raw.HapticFeedback?.selectionChanged();
    },
    openTelegramLink: (url) => raw.openTelegramLink(url),
    openInvoice(url) {
      if (!supports('invoice') || !raw.openInvoice) return null;
      // A synchronous throw (WebAppInvoiceOpened, WebAppInvoiceUrlInvalid) rejects the promise.
      return new Promise((resolve) => raw.openInvoice!(url, resolve));
    },
  };
}
