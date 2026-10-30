import { describe, expect, it } from 'vitest';
import { themeVariables } from '../src/tg/theme';
import type { TelegramWebApp } from '../src/tg/types';
import { createTg, FEATURE_MIN_VERSION, versionAtLeast, type Tg } from '../src/tg/webapp';
import { installFakeWebApp, type FakeWebAppOptions } from './support/fakeWebApp';

const raw = () => (window as unknown as { Telegram: { WebApp: TelegramWebApp } }).Telegram.WebApp;
const tgFor = (options: Partial<FakeWebAppOptions> & { version: string }) => {
  installFakeWebApp({ initData: 'user=%7B%22id%22%3A1%7D&hash=x', ...options });
  return createTg(raw());
};

describe('versionAtLeast', () => {
  it('compares numerically, so 7.10 is newer than 7.9', () => {
    expect(versionAtLeast('7.10', '7.9')).toBe(true);
    expect(versionAtLeast('7.9', '7.10')).toBe(false);
    expect(versionAtLeast('8.0', '8.0')).toBe(true);
    expect(versionAtLeast('6.0', '6.1')).toBe(false);
  });
});

describe('createTg', () => {
  it('gates every capability by the client version', () => {
    const old = tgFor({ version: '6.0' });
    const fresh = tgFor({ version: '8.0' });
    for (const feature of Object.keys(
      FEATURE_MIN_VERSION,
    ) as (keyof typeof FEATURE_MIN_VERSION)[]) {
      expect(old.supports(feature)).toBe(false);
      expect(fresh.supports(feature)).toBe(true);
    }
  });

  // Each call below its minimum must not reach the client: the global check in support/setup.ts
  // fails the test if the fake recorded an unsupported call.
  it.each<{ feature: string; below: string; call: (tg: Tg) => unknown; returns: unknown }>([
    { feature: 'haptics', below: '6.0', call: (tg) => tg.haptic('light'), returns: undefined },
    {
      feature: 'the back button',
      below: '6.0',
      call: (tg) => tg.setBackButton(true, () => undefined),
      returns: undefined,
    },
    {
      feature: 'header and background colours',
      below: '6.0',
      call: (tg) => tg.setChromeColor('secondary_bg_color'),
      returns: undefined,
    },
    {
      feature: 'the bottom bar colour',
      below: '7.9',
      call: (tg) => tg.setChromeColor('secondary_bg_color'),
      returns: undefined,
    },
    {
      feature: 'closing confirmation',
      below: '6.1',
      call: (tg) => tg.setClosingConfirmation(true),
      returns: undefined,
    },
    {
      feature: 'the vertical swipe lock',
      below: '7.6',
      call: (tg) => tg.disableVerticalSwipes(),
      returns: false,
    },
    {
      feature: 'the secondary button',
      below: '7.9',
      call: (tg) => tg.setSecondaryButton({ text: 'Cancel', onClick: () => undefined }),
      returns: false,
    },
    {
      feature: 'the popup',
      below: '6.1',
      call: (tg) => tg.showPopup({ message: 'x', buttons: [] }),
      returns: null,
    },
    {
      feature: 'the invoice',
      below: '6.0',
      call: (tg) => tg.openInvoice('https://t.me/$x'),
      returns: null,
    },
    {
      feature: 'write access',
      below: '6.8',
      call: (tg) => tg.requestWriteAccess(),
      returns: null,
    },
    {
      feature: 'file downloads',
      below: '7.11',
      call: (tg) => tg.downloadFile('https://x/g.pgn', 'g.pgn'),
      returns: false,
    },
  ])('does not call $feature below its minimum version', async ({ below, call, returns }) => {
    const tg = tgFor({ version: below, writeAccess: true });
    expect(await call(tg)).toBe(returns);
  });

  it('keeps the settings button hidden on 6.10, where the SDK has it but the app does not', () => {
    let taps = 0;
    tgFor({ version: '6.10' }).onSettingsButton(() => (taps += 1));
    window.__tg!.clickSettings();
    expect(taps).toBe(0);
    expect(window.__tg!.settingsButton.visible).toBe(false);
    expect(window.__tg!.unsupported).toEqual([]);
  });

  it('shows the back button from 6.1', () => {
    tgFor({ version: '6.1' }).setBackButton(true, () => undefined);
    expect(window.__tg!.backButton.visible).toBe(true);
  });

  it('disables vertical swipes from 7.7', () => {
    expect(tgFor({ version: '7.7' }).disableVerticalSwipes()).toBe(true);
    expect(window.__tg!.calls).toContain('disableVerticalSwipes');
  });

  it('binds one handler at a time to the main button', () => {
    const tg = tgFor({ version: '8.0' });
    let first = 0;
    let second = 0;
    tg.setMainButton({ text: 'One', onClick: () => (first += 1) });
    tg.setMainButton({ text: 'Two', onClick: () => (second += 1), progress: true });
    window.__tg!.clickMain();
    expect([first, second]).toEqual([0, 1]);
    expect(window.__tg!.mainButton).toMatchObject({ text: 'Two', visible: true, progress: true });
    tg.setMainButton(null);
    expect(window.__tg!.mainButton.visible).toBe(false);
  });

  it('offers the secondary button from 7.10', () => {
    const tg = tgFor({ version: '7.10' });
    let clicks = 0;
    expect(tg.setSecondaryButton({ text: 'Cancel', onClick: () => (clicks += 1) })).toBe(true);
    window.__tg!.clickSecondary();
    expect(clicks).toBe(1);
    expect(window.__tg!.secondaryButton).toMatchObject({ text: 'Cancel', visible: true });
  });

  it('forwards haptics from 6.1', () => {
    const tg = tgFor({ version: '6.1' });
    tg.haptic('medium');
    tg.hapticNotify('warning');
    expect(window.__tg!.haptics).toEqual(['impact:medium', 'notification:warning']);
  });

  it('answers write access with the client answer from 6.9', async () => {
    expect(await tgFor({ version: '6.9', writeAccess: true }).requestWriteAccess()).toBe(true);
    expect(await tgFor({ version: '6.9', writeAccess: false }).requestWriteAccess()).toBe(false);
  });

  it('downloads files from 8.0', () => {
    expect(tgFor({ version: '8.0' }).downloadFile('https://x/g.pgn', 'g.pgn')).toBe(true);
    expect(window.__tg!.downloads).toEqual([{ url: 'https://x/g.pgn', file_name: 'g.pgn' }]);
  });

  it('shows and hides the back button with a single handler', () => {
    const tg = tgFor({ version: '8.0' });
    let backs = 0;
    tg.setBackButton(true, () => (backs += 1));
    tg.setBackButton(true, () => (backs += 10));
    window.__tg!.clickBack();
    expect(backs).toBe(10);
    tg.setBackButton(false, () => undefined);
    expect(window.__tg!.backButton.visible).toBe(false);
  });

  it('reports viewport changes', () => {
    const tg = tgFor({ version: '8.0', stableHeight: 700 });
    const seen: number[] = [];
    const off = tg.onViewportChanged((height) => seen.push(height));
    window.__tg!.setStableHeight(640);
    off();
    window.__tg!.setStableHeight(600);
    expect(seen).toEqual([640]);
  });

  it('colours the header and background from 6.1 and the bottom bar from 7.10', () => {
    tgFor({ version: '7.9' }).setChromeColor('secondary_bg_color');
    expect(window.__tg!.chrome).toEqual({
      header: 'secondary_bg_color',
      background: 'secondary_bg_color',
    });
    tgFor({ version: '7.10' }).setChromeColor('secondary_bg_color');
    expect(window.__tg!.chrome.bottomBar).toBe('secondary_bg_color');
  });

  it('paints the main button', () => {
    tgFor({ version: '8.0' }).setMainButtonColors('#2e7d4f', '#ffffff');
    expect(window.__tg!.mainButton).toMatchObject({ color: '#2e7d4f', textColor: '#ffffff' });
  });

  it('confirms closing from 6.2', () => {
    const tg = tgFor({ version: '6.2' });
    tg.setClosingConfirmation(true);
    expect(window.__tg!.closingConfirmation).toBe(true);
    tg.setClosingConfirmation(false);
    expect(window.__tg!.closingConfirmation).toBe(false);
  });

  it('shows the settings button from 7.0 and routes its taps until unsubscribed', () => {
    let taps = 0;
    const off = tgFor({ version: '7.0' }).onSettingsButton(() => (taps += 1));
    expect(window.__tg!.settingsButton?.visible).toBe(true);
    window.__tg!.clickSettings();
    off();
    window.__tg!.clickSettings();
    expect(taps).toBe(1);
    expect(window.__tg!.settingsButton?.visible).toBe(false);
  });

  it('forwards selection haptics from 6.1 and opens Telegram and web links each their own way', () => {
    const tg = tgFor({ version: '6.1' });
    tg.hapticSelection();
    tg.openTelegramLink('https://t.me/Jarvl');
    tg.openLink('https://github.com/Jarvl');
    expect(window.__tg!.haptics).toEqual(['selection']);
    expect(window.__tg!.telegramLinks).toEqual(['https://t.me/Jarvl']);
    expect(window.__tg!.links).toEqual(['https://github.com/Jarvl']);
  });

  it('is a null client outside Telegram', () => {
    const tg = createTg(null);
    expect(tg.available).toBe(false);
    expect(tg.supports('haptics')).toBe(false);
    expect(tg.setMainButton({ text: 'x', onClick: () => undefined })).toBe(false);
    expect(tg.initData).toBe('');
  });

  it('reports deactivation only from 8.0, until unsubscribed', () => {
    let seen = 0;
    tgFor({ version: '7.10' }).onDeactivated(() => (seen += 1));
    window.__tg!.emit('deactivated');
    expect(seen).toBe(0);
    const off = tgFor({ version: '8.0' }).onDeactivated(() => (seen += 1));
    window.__tg!.emit('deactivated');
    off();
    window.__tg!.emit('deactivated');
    expect(seen).toBe(1);
  });

  it('opens an invoice and resolves its final status', async () => {
    const tg = tgFor({ version: '6.1' });
    const status = tg.openInvoice('https://t.me/$x');
    expect(window.__tg!.invoices).toEqual(['https://t.me/$x']);
    window.__tg!.answerInvoice('paid');
    expect(await status).toBe('paid');
  });

  it('rejects when the client refuses to open the invoice', async () => {
    const tg = tgFor({ version: '8.0', invoiceError: 'WebAppInvoiceUrlInvalid' });
    await expect(tg.openInvoice('nope')).rejects.toThrow('WebAppInvoiceUrlInvalid');
  });
});

describe('themeVariables', () => {
  it('takes Telegram colours and falls back per scheme', () => {
    const dark = themeVariables({ bg_color: '#101010' }, 'dark');
    expect(dark['--bg']).toBe('#101010');
    expect(dark['--text']).toBe('#ffffff');
    const light = themeVariables({}, 'light');
    expect(light['--bg']).toBe('#ffffff');
    expect(light['--button']).toBe('#2481cc');
  });

  it('lays the Chess Goat accents over Telegram’s neutrals, per scheme', () => {
    const light = themeVariables({ bg_color: '#fafafa', secondary_bg_color: '#eeeeee' }, 'light');
    expect(light['--card']).toBe('#fafafa');
    expect(light['--page']).toBe('#eeeeee');
    expect(light['--acc']).toBe('#2e7d4f');
    expect(light['--move']).toBe('#e0b94a');
    expect(light['--bl']).toBe('#f0ead2');
    const dark = themeVariables({}, 'dark');
    expect(dark['--page']).toBe('#131b23');
    expect(dark['--card']).toBe('#18222d');
    expect(dark['--acc']).toBe('#4cbb7a');
    expect(dark['--acc-ink']).toBe('#06200f');
  });
});
