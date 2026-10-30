import { useState } from 'preact/hooks';
import { describe, expect, it } from 'vitest';
import { useMainButton } from '../src/ui/hooks';
import { renderApp } from './support/render';

function Screen() {
  const [count, setCount] = useState(0);
  // A fresh handler every render, as the screens pass them.
  useMainButton({ text: 'Send', onClick: () => setCount((n) => n + 1), enabled: true });
  return (
    <button data-action="bump" onClick={() => setCount((n) => n + 1)}>
      {count}
    </button>
  );
}

describe('useMainButton', () => {
  it('binds the button once and keeps it shown across renders, calling the latest handler', async () => {
    const r = renderApp(
      () => <Screen />,
      () => ({ status: 200, body: {} }),
    );
    const shows = () => window.__tg!.calls.filter((c) => c === 'MainButton.show').length;
    const hides = () => window.__tg!.calls.filter((c) => c === 'MainButton.hide').length;
    expect(shows()).toBe(1);
    await r.click('[data-action="bump"]');
    await r.click('[data-action="bump"]');
    expect(r.text()).toBe('2');
    expect(hides()).toBe(0);
    expect(shows()).toBe(1);
    window.__tg!.clickMain();
    await r.flush();
    expect(r.text()).toBe('3');
  });
});
