import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '@chess-goat/shared';
import { Bots } from '../src/ui/screens/Bots';
import type { FakeRoute } from './support/fakeFetch';
import { renderApp } from './support/render';

const TOKEN = 'cgbot_abc';
const CREATED = '2026-05-01T12:00:00.000Z';
const writeText = vi.fn();

function server(initial: { createdAt: string; lastUsedAt: string | null } | null): FakeRoute {
  let state = initial;
  return ({ method }) => {
    if (method === 'POST') {
      state = { createdAt: CREATED, lastUsedAt: null };
      return { status: 200, body: { token: TOKEN, createdAt: CREATED } };
    }
    if (method === 'DELETE') {
      state = null;
      return { status: 200, body: { ok: true } };
    }
    return { status: 200, body: { token: state } };
  };
}
const writes = (r: ReturnType<typeof renderApp>) => r.calls.filter((c) => c.method !== 'GET');

beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});
afterEach(() => {
  document.querySelector('.toast')?.remove();
});

describe('Bots', () => {
  it('offers to create a token when there is none', async () => {
    const r = renderApp(() => <Bots />, server(null));
    await r.flush();
    expect(r.root.textContent).toContain(t('app.bots.token_none'));
    expect(r.root.textContent).toContain(t('app.bots.warning'));
    expect(r.root.querySelector('[data-action="create-token"]')).not.toBeNull();
  });

  it('shows a created token once and copies it', async () => {
    const r = renderApp(() => <Bots />, server(null));
    await r.flush();
    await r.click('[data-action="create-token"]');
    expect(writes(r)[0]).toMatchObject({ method: 'POST', path: '/api/me/owner-token' });
    expect(r.root.querySelector('[data-token]')?.textContent).toBe(TOKEN);
    expect(r.root.textContent).toContain(t('app.bots.shown_once'));
    await r.click('[data-action="copy-token"]');
    expect(writeText).toHaveBeenCalledWith(TOKEN);
    expect(document.querySelector('.toast')?.textContent).toBe(t('app.bots.copied'));
  });

  it('toasts an error when the clipboard refuses', async () => {
    writeText.mockRejectedValue(new Error('no'));
    const r = renderApp(() => <Bots />, server(null));
    await r.flush();
    await r.click('[data-action="create-token"]');
    await r.click('[data-action="copy-token"]');
    expect(document.querySelector('.toast')?.textContent).toBe(t('app.common.error'));
  });

  it('shows the dates of an existing token and confirms before replacing or revoking', async () => {
    const r = renderApp(() => <Bots />, server({ createdAt: CREATED, lastUsedAt: null }));
    await r.flush();
    expect(r.root.textContent).toContain('Created May 1, 2026');
    expect(r.root.textContent).toContain(t('app.bots.token_never_used'));
    await r.click('[data-action="rotate-token"]');
    expect(window.__tg!.popups.at(-1)?.message).toBe(t('app.bots.rotate_confirm'));
    window.__tg!.answerPopup('cancel');
    await r.flush();
    await r.click('[data-action="revoke-token"]');
    expect(window.__tg!.popups.at(-1)?.message).toBe(t('app.bots.revoke_confirm'));
    window.__tg!.answerPopup('cancel');
    await r.flush();
    expect(writes(r)).toHaveLength(0);
  });

  it('shows the last use when there is one', async () => {
    const r = renderApp(
      () => <Bots />,
      server({ createdAt: CREATED, lastUsedAt: '2026-06-02T08:00:00.000Z' }),
    );
    await r.flush();
    expect(r.root.textContent).toContain('Last used Jun 2, 2026');
  });

  it('replaces a token after confirming', async () => {
    const r = renderApp(() => <Bots />, server({ createdAt: CREATED, lastUsedAt: null }));
    await r.flush();
    await r.click('[data-action="rotate-token"]');
    window.__tg!.answerPopup('confirm');
    await r.flush();
    expect(writes(r)[0]).toMatchObject({ method: 'POST', path: '/api/me/owner-token' });
    expect(r.root.querySelector('[data-token]')?.textContent).toBe(TOKEN);
  });

  it('revokes after confirming and returns to the none state', async () => {
    const r = renderApp(() => <Bots />, server({ createdAt: CREATED, lastUsedAt: null }));
    await r.flush();
    await r.click('[data-action="revoke-token"]');
    window.__tg!.answerPopup('confirm');
    await r.flush();
    expect(writes(r)[0]).toMatchObject({ method: 'DELETE', path: '/api/me/owner-token' });
    expect(r.root.textContent).toContain(t('app.bots.token_none'));
    expect(r.root.querySelector('[data-action="create-token"]')).not.toBeNull();
  });

  it('toasts an error when a request fails', async () => {
    const r = renderApp(
      () => <Bots />,
      ({ method }) =>
        method === 'GET'
          ? { status: 200, body: { token: null } }
          : { status: 500, body: { error: { code: 'internal', message: 'boom' } } },
    );
    await r.flush();
    await r.click('[data-action="create-token"]');
    expect(document.querySelector('.toast')?.textContent).toBe(t('app.common.error'));
    expect(r.root.querySelector('[data-token]')).toBeNull();
  });

  it('does not keep the token after leaving and reopening', async () => {
    const route = server(null);
    const first = renderApp(() => <Bots />, route);
    await first.flush();
    await first.click('[data-action="create-token"]');
    expect(first.root.querySelector('[data-token]')).not.toBeNull();
    const second = renderApp(() => <Bots />, route);
    await second.flush();
    expect(second.root.querySelector('[data-token]')).toBeNull();
    expect(second.root.textContent).not.toContain(TOKEN);
  });
});
