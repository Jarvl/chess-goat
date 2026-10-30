import { ENGINE_LEVELS, type GameDto } from '@group-chess/shared';
import { describe, expect, it } from 'vitest';
import { App } from '../src/ui/App';
import { NewGame } from '../src/ui/screens/NewGame';
import { gameDto } from './support/gameFixtures';
import { renderApp } from './support/render';

const settings = { defaultTimePerMove: 86400, ratedDefault: true, allowOpenChallenges: true };

const bob = {
  id: '2',
  name: 'Bob',
  username: 'bob',
  rating: 1520,
  provisional: false,
  isBot: false,
  photoUrl: null,
  flair: [],
};

const players = { players: [bob], settings, bot: null };

const withBot = { players: [], settings, bot: { levels: [...ENGINE_LEVELS] } };

const withBotAndPlayers = { players: [bob], settings, bot: { levels: [...ENGINE_LEVELS] } };

const engineGame: GameDto = gameDto({ id: 'EnGiNeGam1', engineLevel: 'strong' });

/** Opponent rows (human, open-challenge or bot) currently showing `aria-pressed="true"`. */
function pressedOpponentRows(root: HTMLElement): Element[] {
  return [...root.querySelectorAll('[data-opponent], [data-testid="opponent-bot"]')].filter(
    (el) => el.getAttribute('aria-pressed') === 'true',
  );
}
const challenge = {
  id: 'ChalAaaaaa',
  challenger: {
    id: '1',
    name: 'Alice',
    username: 'alice',
    rating: 1500,
    provisional: true,
    isBot: false,
    photoUrl: null,
    flair: [],
  },
  opponent: null,
  timePerMove: 28800,
  challengerColour: 'white',
  rated: false,
  status: 'pending',
  createdAt: '2026-09-20T10:00:00.000Z',
  expiresAt: '2026-09-21T10:00:00.000Z',
  viewer: { canAccept: false, canDecline: false, canCancel: true },
};

describe('NewGame', () => {
  it('posts the challenge with the chosen opponent, time, colour and rated flag', async () => {
    const r = renderApp(
      () => <NewGame groupId="GrOuPiDxYz" />,
      ({ method }) =>
        method === 'POST' ? { status: 200, body: challenge } : { status: 200, body: players },
    );
    await r.flush();
    expect(r.text()).toContain('Bob');
    await r.click('[data-opponent="2"]');
    await r.click('[data-time="28800"]');
    await r.click('[data-colour="white"]');
    await r.click('[data-rated]');
    window.__tg!.clickMain();
    await r.flush();
    const post = r.calls.find((c) => c.method === 'POST');
    expect(post?.path).toBe('/api/groups/GrOuPiDxYz/challenges');
    expect(post?.body).toEqual({
      opponentId: '2',
      timePerMove: 28800,
      colour: 'white',
      rated: false,
    });
    expect(r.app.router.current.value).toEqual({ name: 'lobby', groupId: 'GrOuPiDxYz' });
  });

  it('sends an open challenge with a null opponent and the group defaults', async () => {
    const r = renderApp(
      () => <NewGame groupId="GrOuPiDxYz" />,
      ({ method }) =>
        method === 'POST'
          ? { status: 200, body: challenge }
          : {
              status: 200,
              body: { ...players, settings: { ...settings, defaultTimePerMove: 259200 } },
            },
    );
    await r.flush();
    await r.click('[data-opponent="open"]');
    window.__tg!.clickMain();
    await r.flush();
    expect(r.calls.find((c) => c.method === 'POST')?.body).toEqual({
      opponentId: null,
      timePerMove: 259200,
      colour: 'random',
      rated: true,
    });
  });

  it('explains an empty picker', async () => {
    const r = renderApp(
      () => <NewGame groupId="GrOuPiDxYz" />,
      () => ({ status: 200, body: { players: [], settings, bot: null } }),
    );
    await r.flush();
    expect(r.text()).toContain('Reply to their message with /challenge');
  });

  it('starts with the opponent it was opened for already picked', async () => {
    const r = renderApp(
      () => <NewGame groupId="GrOuPiDxYz" opponentId="2" />,
      () => ({ status: 200, body: players }),
    );
    await r.flush();
    expect(r.root.querySelector('[data-opponent="2"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(window.__tg!.mainButton).toMatchObject({ text: 'Send challenge', enabled: true });
  });

  it('leaves the pick empty when that opponent is no longer in the group', async () => {
    const r = renderApp(
      () => <NewGame groupId="GrOuPiDxYz" opponentId="9" />,
      () => ({ status: 200, body: players }),
    );
    expect(pressedOpponentRows(r.root)).toHaveLength(0);
  });

  it('offers no open challenge when the group has them off', async () => {
    const r = renderApp(
      () => <NewGame groupId="GrOuPiDxYz" />,
      () => ({
        status: 200,
        body: { ...players, settings: { ...settings, allowOpenChallenges: false } },
      }),
    );
    expect(r.root.querySelector('[data-opponent="open"]')).toBeNull();
  });

  it('shows the bot row, and its levels once selected, when the picker offers one', async () => {
    const r = renderApp(
      () => <NewGame groupId="GrOuPiDxYz" />,
      () => ({ status: 200, body: withBot }),
    );
    await r.flush();
    expect(r.text()).toContain('Play the bot');
    expect(r.text()).not.toContain('Club');
    await r.click('[data-testid="opponent-bot"]');
    expect(r.text()).toContain('Club');
  });

  it('shows no bot row when the picker offers none', async () => {
    const r = renderApp(
      () => <NewGame groupId="GrOuPiDxYz" />,
      () => ({ status: 200, body: players }),
    );
    expect(r.text()).not.toContain('Play the bot');
  });

  it('forces rated off and disables the switch once the bot is selected', async () => {
    const r = renderApp(
      () => <NewGame groupId="GrOuPiDxYz" />,
      () => ({ status: 200, body: withBot }),
    );
    await r.flush();
    await r.click('[data-testid="opponent-bot"]');
    const rated = r.root.querySelector('[data-rated]') as HTMLButtonElement;
    expect(rated.getAttribute('aria-checked')).toBe('false');
    expect(rated.disabled).toBe(true);
  });

  it('shows no rating number anywhere in the level control', async () => {
    const r = renderApp(
      () => <NewGame groupId="GrOuPiDxYz" />,
      () => ({ status: 200, body: withBot }),
    );
    await r.flush();
    await r.click('[data-testid="opponent-bot"]');
    expect(r.text()).toContain('Club');
    expect(r.text()).not.toMatch(/\b\d{3,4}\b/);
  });

  it('offers no time control once the bot is selected, and offers one otherwise', async () => {
    const r = renderApp(
      () => <NewGame groupId="GrOuPiDxYz" />,
      () => ({ status: 200, body: withBotAndPlayers }),
    );
    await r.flush();
    // A human opponent keeps the choice.
    await r.click('[data-opponent="2"]');
    expect(r.root.querySelectorAll('[data-time]').length).toBeGreaterThan(0);
    // The bot cannot have a clock, so the control goes away rather than sitting there doing nothing.
    await r.click('[data-testid="opponent-bot"]');
    expect(r.root.querySelectorAll('[data-time]')).toHaveLength(0);
    expect(r.text()).toContain('no clock');
  });

  it('posts to the engine-games endpoint with the chosen level', async () => {
    const r = renderApp(
      () => <NewGame groupId="GrOuPiDxYz" />,
      ({ method }) =>
        method === 'POST' ? { status: 200, body: engineGame } : { status: 200, body: withBot },
    );
    await r.flush();
    await r.click('[data-testid="opponent-bot"]');
    await r.click('[data-testid="bot-level-strong"]');
    window.__tg!.clickMain();
    await r.flush();
    const post = r.calls.find((c) => c.method === 'POST');
    expect(post?.path).toBe('/api/groups/GrOuPiDxYz/engine-games');
    // toEqual is exact, so this also pins that no clock is sent: a bot game has none.
    expect(post?.body).toEqual({ level: 'strong', colour: 'random' });
    expect(r.app.router.current.value).toEqual({ name: 'game', gameId: 'EnGiNeGam1' });
  });

  it('picking the bot after a human clears the human and submits an engine game', async () => {
    const r = renderApp(
      () => <NewGame groupId="GrOuPiDxYz" />,
      ({ method }) =>
        method === 'POST'
          ? { status: 200, body: engineGame }
          : { status: 200, body: withBotAndPlayers },
    );
    await r.flush();
    await r.click('[data-opponent="2"]');
    await r.click('[data-testid="opponent-bot"]');
    expect(r.root.querySelector('[data-opponent="2"]')?.getAttribute('aria-pressed')).toBe('false');
    expect(r.root.querySelector('[data-testid="opponent-bot"]')?.getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(pressedOpponentRows(r.root)).toHaveLength(1);
    window.__tg!.clickMain();
    await r.flush();
    const post = r.calls.find((c) => c.method === 'POST');
    expect(post?.path).toBe('/api/groups/GrOuPiDxYz/engine-games');
  });

  it('picking a human after the bot clears the bot and submits a challenge', async () => {
    const r = renderApp(
      () => <NewGame groupId="GrOuPiDxYz" />,
      ({ method }) =>
        method === 'POST'
          ? { status: 200, body: challenge }
          : { status: 200, body: withBotAndPlayers },
    );
    await r.flush();
    await r.click('[data-testid="opponent-bot"]');
    await r.click('[data-opponent="2"]');
    expect(r.root.querySelector('[data-testid="opponent-bot"]')?.getAttribute('aria-pressed')).toBe(
      'false',
    );
    expect(r.root.querySelector('[data-opponent="2"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(pressedOpponentRows(r.root)).toHaveLength(1);
    // The level list is bot-only UI: once a human is picked it must not still be showing.
    expect(r.text()).not.toContain('Club');
    window.__tg!.clickMain();
    await r.flush();
    const post = r.calls.find((c) => c.method === 'POST');
    expect(post?.path).toBe('/api/groups/GrOuPiDxYz/challenges');
    expect(post?.body).toMatchObject({ opponentId: '2' });
  });

  it('names the main button for what it will do', async () => {
    const r = renderApp(
      () => <NewGame groupId="GrOuPiDxYz" />,
      () => ({ status: 200, body: withBotAndPlayers }),
    );
    await r.flush();
    expect(window.__tg!.mainButton).toMatchObject({ text: 'Send challenge', enabled: false });
    await r.click('[data-testid="opponent-bot"]');
    expect(window.__tg!.mainButton).toMatchObject({ text: 'Start game', enabled: true });
    await r.click('[data-opponent="2"]');
    expect(window.__tg!.mainButton.text).toBe('Send challenge');
    expect(window.__tg!.haptics).toContain('selection');
  });

  it('asks before closing while the form is open, and stops asking once it is left', async () => {
    const r = renderApp(
      (app) => {
        app.router.land('groups', { name: 'groups' });
        app.router.push({ name: 'newGame', groupId: 'GrOuPiDxYz' });
        return <App />;
      },
      () => ({ status: 200, body: withBotAndPlayers }),
    );
    await r.flush();
    expect(window.__tg!.closingConfirmation).toBe(true);
    expect(r.root.querySelector('[data-nav]')).toBeNull();
    r.app.router.back();
    await r.flush();
    expect(window.__tg!.closingConfirmation).toBe(false);
  });

  it('draws each opponent with an avatar and marks the pick', async () => {
    const r = renderApp(
      () => <NewGame groupId="GrOuPiDxYz" />,
      () => ({ status: 200, body: withBotAndPlayers }),
    );
    await r.flush();
    expect(r.root.querySelector('[data-testid="opponent-bot"] img.avatar.bot')).not.toBeNull();
    expect(r.root.querySelector('[data-opponent="2"] .avatar')?.textContent).toBe('B');
    expect(r.root.querySelector('[data-opponent="open"] .secondary')?.textContent).toBe(
      'Anyone in the group can accept',
    );
    await r.click('[data-opponent="2"]');
    expect(r.root.querySelector('[data-opponent="2"]')?.className).toContain('on');
    expect(r.root.querySelector('[data-opponent="2"] .radio.on')).not.toBeNull();
  });
});
