import { describe, expect, it } from 'vitest';
import { choiceDialog } from '../src/ui/dialog';
import { renderApp } from './support/render';

const ok = () => ({ status: 200, body: { ok: true } });
const ask = () =>
  choiceDialog({
    title: 'Move confirmations',
    message: 'Ask before a move is sent.',
    choices: [
      { value: 'always', label: 'Always' },
      { value: 'people', label: 'Only against people' },
      { value: 'never', label: 'Never' },
    ],
    current: 'people',
  });

describe('choiceDialog', () => {
  it("asks through Telegram's popup, marking the current choice", async () => {
    renderApp(() => null, ok);
    const answer = ask();
    expect(window.__tg!.popups.at(-1)).toEqual({
      title: 'Move confirmations',
      message: 'Ask before a move is sent.',
      buttons: [
        { id: 'always', type: 'default', text: 'Always' },
        { id: 'people', type: 'default', text: '✓ Only against people' },
        { id: 'never', type: 'default', text: 'Never' },
      ],
    });
    window.__tg!.answerPopup('never');
    expect(await answer).toBe('never');
  });

  it('reads a dismissed popup as no choice', async () => {
    renderApp(() => null, ok);
    const answer = ask();
    window.__tg!.answerPopup('');
    expect(await answer).toBeNull();
  });

  it('offers the choices in the page on clients without popups', async () => {
    const r = renderApp(() => null, ok, { version: '6.1' });
    const answer = ask();
    await r.flush();
    expect(document.querySelector('[data-choice="people"]')?.getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(document.querySelector('[data-choice="always"]')?.getAttribute('aria-checked')).toBe(
      'false',
    );
    await r.click('[data-choice="always"]');
    expect(await answer).toBe('always');
    expect(document.querySelector('[data-choice]')).toBeNull();
  });

  it('falls back to the page when the client rejects the popup, and Cancel dismisses', async () => {
    const r = renderApp(() => null, ok, { popupError: 'WebAppPopupParamInvalid' });
    const answer = ask();
    await r.flush();
    expect(document.querySelector('[data-choice="never"]')).not.toBeNull();
    await r.click('[data-dialog="cancel"]');
    expect(await answer).toBeNull();
  });
});
