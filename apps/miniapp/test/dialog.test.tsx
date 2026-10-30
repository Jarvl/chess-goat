import { describe, expect, it } from 'vitest';
import { confirmDialog, infoDialog } from '../src/ui/dialog';
import { renderApp } from './support/render';

const mount = (version: string, options: { popupError?: string } = {}) =>
  renderApp(
    () => null,
    () => ({ status: 200, body: {} }),
    { version, ...options },
  );

describe('confirmDialog', () => {
  it('asks through Telegram’s native popup from 6.2', async () => {
    mount('6.2');
    const answer = confirmDialog('Resign this game?', { confirmLabel: 'Resign', danger: true });
    expect(window.__tg!.popups.at(-1)).toEqual({
      message: 'Resign this game?',
      buttons: [
        { id: 'cancel', type: 'cancel' },
        { id: 'confirm', type: 'destructive', text: 'Resign' },
      ],
    });
    expect(document.querySelector('.dialog')).toBeNull();
    window.__tg!.answerPopup('confirm');
    expect(await answer).toBe(true);
  });

  it('treats a dismissed popup as no', async () => {
    mount('8.0');
    const answer = confirmDialog('Abort this game?');
    window.__tg!.answerPopup('');
    expect(await answer).toBe(false);
  });

  it('refuses a second popup while one is open, resolving it as no', async () => {
    mount('8.0');
    const first = confirmDialog('Resign this game?');
    const second = confirmDialog('Abort this game?');
    expect(await second).toBe(false);
    expect(window.__tg!.popups).toHaveLength(1);
    window.__tg!.answerPopup('confirm');
    expect(await first).toBe(true);
  });

  it('falls back to the in-page sheet below 6.2', async () => {
    const r = mount('6.1');
    const answer = confirmDialog('Delete your data?', { confirmLabel: 'Delete', danger: true });
    await r.flush();
    expect(document.querySelector('.dialog p')?.textContent).toBe('Delete your data?');
    await r.click('[data-dialog="confirm"]');
    expect(await answer).toBe(true);
  });

  it('falls back to the in-page sheet when the client rejects the popup call itself', async () => {
    // Unlike WebAppPopupOpened (another popup mid-flight, read as "no"), a param rejection is
    // the client refusing the call, not the user answering it.
    const r = mount('8.0', { popupError: 'WebAppPopupParamInvalid' });
    const answer = confirmDialog('Delete your data?', { confirmLabel: 'Delete', danger: true });
    await r.flush();
    expect(window.__tg!.popups).toHaveLength(0);
    expect(document.querySelector('.dialog p')?.textContent).toBe('Delete your data?');
    await r.click('[data-dialog="confirm"]');
    expect(await answer).toBe(true);
  });
});

describe('confirmDialog with a cancel label', () => {
  it('names the cancel button with a native default button, and reads it as no', async () => {
    mount('8.0');
    const answer = confirmDialog('Your move hasn’t been sent and will be lost.', {
      title: 'Leave this game?',
      confirmLabel: 'Leave',
      cancelLabel: 'Stay',
      danger: true,
    });
    expect(window.__tg!.popups.at(-1)).toEqual({
      title: 'Leave this game?',
      message: 'Your move hasn’t been sent and will be lost.',
      buttons: [
        { id: 'cancel', type: 'default', text: 'Stay' },
        { id: 'confirm', type: 'destructive', text: 'Leave' },
      ],
    });
    window.__tg!.answerPopup('cancel');
    expect(await answer).toBe(false);
  });

  it('names the in-page cancel button too', async () => {
    const r = mount('6.1');
    const answer = confirmDialog('Leave?', { confirmLabel: 'Leave', cancelLabel: 'Stay' });
    await r.flush();
    expect(document.querySelector('[data-dialog="cancel"]')?.textContent).toBe('Stay');
    await r.click('[data-dialog="cancel"]');
    expect(await answer).toBe(false);
  });
});

describe('infoDialog', () => {
  it('shows a titled message with a single OK', async () => {
    mount('8.0');
    const done = infoDialog('Pieces by …', 'About Chess Goat');
    expect(window.__tg!.popups.at(-1)).toEqual({
      title: 'About Chess Goat',
      message: 'Pieces by …',
      buttons: [{ id: 'confirm', type: 'ok' }],
    });
    window.__tg!.answerPopup('confirm');
    await done;
  });

  it('shows the same in the page below 6.2, without a cancel button', async () => {
    const r = mount('6.1');
    void infoDialog('Pieces by …', 'About Chess Goat');
    await r.flush();
    expect(document.querySelector('.dialog strong')?.textContent).toBe('About Chess Goat');
    expect(document.querySelector('[data-dialog="cancel"]')).toBeNull();
    expect(document.querySelector('[data-dialog="confirm"]')?.textContent).toBe('OK');
  });
});
