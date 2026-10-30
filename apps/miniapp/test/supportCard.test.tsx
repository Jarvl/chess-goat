import { beforeEach, describe, expect, it, vi } from 'vitest';
import { customStars, SupportCard } from '../src/ui/SupportCard';
import { toast } from '../src/ui/toast';
import { renderApp } from './support/render';
import type { FakeRoute } from './support/fakeFetch';

vi.mock('../src/ui/toast', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/ui/toast')>()),
  toast: vi.fn(),
}));

const INVOICE = 'https://t.me/$TestInvoice';
const mints: FakeRoute = ({ path }) =>
  path === '/api/tips' ? { status: 200, body: { url: INVOICE } } : { status: 404 };

const typeAmount = async (r: ReturnType<typeof renderApp>, value: string) => {
  const input = r.root.querySelector<HTMLInputElement>('[data-tip-input]')!;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await r.flush();
  return input;
};

beforeEach(() => {
  vi.mocked(toast).mockClear();
});

describe('customStars', () => {
  it.each([
    ['1', 1],
    ['250', 250],
    ['10000', 10_000],
  ])('reads %s as %s', (raw, stars) => {
    expect(customStars(raw)).toBe(stars);
  });

  it.each(['', '0', '10001', '12345'])('refuses %j', (raw) => {
    expect(customStars(raw)).toBeNull();
  });
});

describe('SupportCard', () => {
  it('is not rendered on clients without invoices', () => {
    const r = renderApp(() => <SupportCard />, mints, { version: '6.0' });
    expect(r.root.querySelector('[data-card="support"]')).toBeNull();
  });

  it('tips a preset: posts the amount, opens the invoice, thanks on payment', async () => {
    const r = renderApp(() => <SupportCard />, mints);
    await r.click('[data-tip="250"]');
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toMatchObject({ method: 'POST', path: '/api/tips', body: { stars: 250 } });
    expect(window.__tg!.invoices).toEqual([INVOICE]);
    expect(window.__tg!.haptics).toContain('impact:light');
    window.__tg!.answerInvoice('paid');
    await r.flush();
    expect(window.__tg!.haptics).toContain('notification:success');
    expect(toast).toHaveBeenCalledWith('Thank you for supporting Chess Goat');
    expect(r.root.querySelector('[data-tip="250"]')?.classList.contains('on')).toBe(false);
  });

  it('gives each preset an accessible name in Stars, since the star glyph is aria-hidden', () => {
    const r = renderApp(() => <SupportCard />, mints);
    for (const [stars, label] of [
      [100, 'Tip 100 Stars'],
      [250, 'Tip 250 Stars'],
      [500, 'Tip 500 Stars'],
    ] as const) {
      expect(r.root.querySelector(`[data-tip="${stars}"]`)?.getAttribute('aria-label')).toBe(label);
    }
  });

  it('marks the in-flight preset aria-busy and keeps its accessible name', async () => {
    let release = (): void => undefined;
    const r = renderApp(
      () => <SupportCard />,
      () =>
        new Promise((resolve) => {
          release = () => resolve({ status: 200, body: { url: INVOICE } });
        }),
    );
    const button = r.root.querySelector<HTMLButtonElement>('[data-tip="100"]')!;
    button.click();
    await r.flush();
    expect(button.getAttribute('aria-label')).toBe('Tip 100 Stars');
    expect(button.getAttribute('aria-busy')).toBe('true');
    release();
    await r.flush();
    window.__tg!.answerInvoice('paid');
    await r.flush();
    expect(button.getAttribute('aria-busy')).toBeNull();
  });

  it('says so when the payment fails', async () => {
    const r = renderApp(() => <SupportCard />, mints);
    await r.click('[data-tip="100"]');
    window.__tg!.answerInvoice('failed');
    await r.flush();
    expect(window.__tg!.haptics).toContain('notification:error');
    expect(toast).toHaveBeenCalledWith("The payment didn't go through");
  });

  it.each(['cancelled', 'pending'] as const)(
    'stays quiet when the invoice ends %s',
    async (status) => {
      const r = renderApp(() => <SupportCard />, mints);
      await r.click('[data-tip="500"]');
      window.__tg!.answerInvoice(status);
      await r.flush();
      expect(toast).not.toHaveBeenCalled();
      expect(r.root.querySelector('[data-tip="500"]')?.classList.contains('on')).toBe(true);
      expect(window.__tg!.haptics.some((h) => h.startsWith('notification:'))).toBe(false);
    },
  );

  it('shows the generic error when the server cannot mint a link', async () => {
    const r = renderApp(
      () => <SupportCard />,
      () => ({ status: 500, body: { error: { code: 'internal', message: 'internal error' } } }),
    );
    await r.click('[data-tip="100"]');
    expect(window.__tg!.invoices).toEqual([]);
    expect(toast).toHaveBeenCalledWith('Something went wrong');
  });

  it('shows the generic error when the client refuses the invoice link', async () => {
    const r = renderApp(() => <SupportCard />, mints, { invoiceError: 'WebAppInvoiceUrlInvalid' });
    await r.click('[data-tip="100"]');
    expect(toast).toHaveBeenCalledWith('Something went wrong');
    expect(r.root.querySelector<HTMLButtonElement>('[data-tip="100"]')?.disabled).toBe(false);
  });

  it('ignores a second tap while a tip is in flight', async () => {
    // A function, not null: TypeScript would narrow a null-initialised `let` to `never` below.
    let release = (): void => undefined;
    const r = renderApp(
      () => <SupportCard />,
      () =>
        new Promise((resolve) => {
          release = () => resolve({ status: 200, body: { url: INVOICE } });
        }),
    );
    const first = r.root.querySelector<HTMLButtonElement>('[data-tip="100"]')!;
    const second = r.root.querySelector<HTMLButtonElement>('[data-tip="500"]')!;
    first.click();
    second.click(); // same tick: before any re-render
    await r.flush();
    await r.click('[data-tip="250"]');
    expect(r.calls).toHaveLength(1);
    expect(r.root.querySelector('[data-tip="100"] .tip-spinner')).not.toBeNull();
    release();
    await r.flush();
    expect(window.__tg!.invoices).toEqual([INVOICE]);
  });

  it('validates a custom amount before it can be tipped', async () => {
    const r = renderApp(() => <SupportCard />, mints);
    await r.click('[data-action="tip-custom"]');
    const submit = () => r.root.querySelector<HTMLButtonElement>('[data-action="tip-submit"]')!;
    const hint = () => r.root.querySelector('.tip-hint')!;
    expect(hint().textContent).toBe('Any whole number from 1 to 10,000');
    expect(submit().disabled).toBe(true);

    await typeAmount(r, '0');
    expect(hint().classList.contains('bad')).toBe(true);
    expect(hint().textContent).toBe('Enter between 1 and 10,000 Stars');
    expect(submit().disabled).toBe(true);

    await typeAmount(r, '123');
    expect(hint().classList.contains('ok')).toBe(true);
    expect(hint().textContent).toBe('Telegram shows the exact total before you pay');
    await r.click('[data-action="tip-submit"]');
    expect(r.calls[0]).toMatchObject({ path: '/api/tips', body: { stars: 123 } });
  });

  it('marks the custom input invalid and describes it by the hint', async () => {
    const r = renderApp(() => <SupportCard />, mints);
    await r.click('[data-action="tip-custom"]');
    const input = r.root.querySelector<HTMLInputElement>('[data-tip-input]')!;
    expect(input.getAttribute('aria-describedby')).toBe('tip-hint');
    expect(r.root.querySelector('#tip-hint')).not.toBeNull();
    expect(input.getAttribute('aria-invalid')).toBeNull();

    await typeAmount(r, '0');
    expect(input.getAttribute('aria-invalid')).toBe('true');

    await typeAmount(r, '123');
    expect(input.getAttribute('aria-invalid')).toBeNull();
  });

  it('keeps only digits from pasted text, at most five of them', async () => {
    const r = renderApp(() => <SupportCard />, mints);
    await r.click('[data-action="tip-custom"]');
    expect((await typeAmount(r, '1,000')).value).toBe('1000');
    expect(r.root.querySelector('.tip-hint')?.classList.contains('ok')).toBe(true);
    expect((await typeAmount(r, ' 250 ')).value).toBe('250');
    expect((await typeAmount(r, '1234567')).value).toBe('12345');
    expect(r.root.querySelector('.tip-hint')?.classList.contains('bad')).toBe(true);
  });

  it('opens the author chat from the card body', async () => {
    const r = renderApp(() => <SupportCard />, mints);
    await r.click('[data-action="support-author"]');
    expect(window.__tg!.telegramLinks).toEqual(['https://t.me/Jarvl']);
  });
});
