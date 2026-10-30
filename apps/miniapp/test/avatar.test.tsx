import { signal } from '@preact/signals';
import { describe, expect, it } from 'vitest';
import { Avatar, GroupAvatar } from '../src/ui/Avatar';
import { renderApp } from './support/render';

describe('Avatar', () => {
  it('draws a coloured initial for a person and the goat mark for the bot', async () => {
    const r = renderApp(
      () => (
        <>
          <Avatar player={{ id: '7', name: '@maya', isBot: false, photoUrl: null }} size={40} />
          <Avatar player={{ id: '9', name: 'Stockfish', isBot: true, photoUrl: null }} size={34} />
          <GroupAvatar group={{ id: 'GrOuPiDxYz', title: 'Friday Chess Club' }} size={56} />
        </>
      ),
      () => ({ status: 200, body: {} }),
    );
    const [person, bot, group] = [...r.root.querySelectorAll('.avatar')] as HTMLElement[];
    expect(person!.textContent).toBe('M');
    // happy-dom may keep the hex or serialise it as rgb(); either is the palette's red.
    expect(person!.getAttribute('style')).toMatch(/#e17076|rgb\(225, 112, 118\)/);
    expect(bot!.tagName).toBe('IMG');
    expect(bot!.getAttribute('src')).toMatch(/goat-mark/);
    expect(group!.className).toContain('group');
    expect(group!.textContent).toBe('FC');
  });

  const maya = (photoUrl: string | null) => ({ id: '7', name: '@maya', isBot: false, photoUrl });
  const noFetch = () => ({ status: 200, body: {} });

  it('lays the photo over the initial', async () => {
    const r = renderApp(() => <Avatar player={maya('/api/avatars/x.jpg')} size={40} />, noFetch);
    const photo = r.root.querySelector('span.avatar img.photo') as HTMLImageElement;
    expect(photo.getAttribute('src')).toBe('/api/avatars/x.jpg');
    expect(photo.getAttribute('alt')).toBe('');
    expect(r.root.querySelector('span.avatar')!.textContent).toBe('M');
  });

  it('falls back to the initial when the photo fails', async () => {
    const r = renderApp(() => <Avatar player={maya('/api/avatars/x.jpg')} size={40} />, noFetch);
    r.root.querySelector('img.photo')!.dispatchEvent(new Event('error'));
    await r.flush();
    expect(r.root.querySelector('img.photo')).toBeNull();
    expect(r.root.querySelector('span.avatar')!.textContent).toBe('M');
  });

  it('shows a new photo after an earlier one failed', async () => {
    const url = signal('/a.jpg');
    // Read inside a component, so the signal re-renders it; renderApp calls `ui` outside one.
    const Host = () => <Avatar player={maya(url.value)} size={40} />;
    const r = renderApp(() => <Host />, noFetch);
    r.root.querySelector('img.photo')!.dispatchEvent(new Event('error'));
    await r.flush();
    url.value = '/b.jpg';
    await r.flush();
    expect(r.root.querySelector('img.photo')?.getAttribute('src')).toBe('/b.jpg');
  });

  it("draws exactly today's avatar without a photo", async () => {
    const r = renderApp(() => <Avatar player={maya(null)} size={40} />, noFetch);
    const avatar = r.root.querySelector('span.avatar')!;
    expect(avatar.querySelector('img')).toBeNull();
    expect(avatar.textContent).toBe('M');
    expect(avatar.getAttribute('style')).toMatch(/#e17076|rgb\(225, 112, 118\)/);
  });

  it("keeps the bot's mark even with a photo url", async () => {
    const r = renderApp(
      () => (
        <Avatar
          player={{ id: '9', name: 'Stockfish', isBot: true, photoUrl: '/x.jpg' }}
          size={34}
        />
      ),
      noFetch,
    );
    expect(r.root.querySelector('img.avatar.bot')?.getAttribute('src')).toMatch(/goat-mark/);
    expect(r.root.querySelector('img.photo')).toBeNull();
  });
});
