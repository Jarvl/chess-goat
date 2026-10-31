import { INITIAL_FEN } from '@chess-goat/shared';
import { describe, expect, it } from 'vitest';
import { Flair } from '../src/ui/Flair';
import { GameCard } from '../src/ui/GameCard';
import { PlayerBar } from '../src/ui/game/PlayerBar';
import { PlayerRow } from '../src/ui/rows';
import { gameDto } from './support/gameFixtures';
import { renderApp } from './support/render';
import { gameSummary, playerRef } from './support/summaryFixtures';

const ok = () => ({ status: 200, body: {} });

describe('<Flair>', () => {
  it('draws each known flair whole, in slot order, and reads out what they mean', () => {
    const flair = renderApp(
      () => <Flair ids={['rank_1200', 'promotion_win', 'retired_flair']} />,
      ok,
    ).root.querySelector('.flair')!;
    expect([...flair.children].map((child) => child.textContent)).toEqual(['🧑‍🦼', '♟️']);
    expect(flair.getAttribute('role')).toBe('img');
    expect(flair.getAttribute('aria-label')).toBe('Held a rating of 1200–1299, Promote a pawn');
  });
  it('keeps the order the player chose, not the catalog’s', () => {
    const flair = renderApp(
      () => <Flair ids={['promotion_win', 'rank_1200']} />,
      ok,
    ).root.querySelector('.flair')!;
    expect([...flair.children].map((child) => child.textContent)).toEqual(['♟️', '🧑‍🦼']);
  });
  it('draws nothing without a flair the catalog knows', () => {
    expect(renderApp(() => <Flair ids={[]} />, ok).root.querySelector('.flair')).toBeNull();
    expect(
      renderApp(() => <Flair ids={['retired_flair']} />, ok).root.querySelector('.flair'),
    ).toBeNull();
  });
});

describe('flair beside names', () => {
  it('follows the opponent’s name on a game card, and is absent from a card you only watch', () => {
    const bob = playerRef('2', 'Bob', { flair: ['en_passant_win', 'win_streak_5'] });
    const name = renderApp(
      () => <GameCard game={gameSummary({ black: bob })} onOpen={() => {}} />,
      ok,
    ).root.querySelector('.game-card .name')!;
    expect(name.textContent).toBe('Bob');
    expect(name.nextElementSibling?.matches('.flair')).toBe(true);
    expect(name.nextElementSibling?.textContent).toBe('👑🔥');
    const watched = gameSummary({
      white: playerRef('3', 'Carol', { flair: ['draws_10'] }),
      black: playerRef('4', 'Dan', { flair: ['draws_10'] }),
      yourTurn: false,
    });
    expect(
      renderApp(() => <GameCard game={watched} onOpen={() => {}} />, ok).root.querySelector(
        '.flair',
      ),
    ).toBeNull();
  });
  it('sits between the name and the rating on a player bar', () => {
    const dto = gameDto();
    const withFlair = { ...dto, black: { ...dto.black, flair: ['rank_1500'] } };
    const row = renderApp(
      () => <PlayerBar dto={withFlair} colour="black" fen={INITIAL_FEN} now={new Date()} />,
      ok,
    ).root.querySelector('.player-bar .name-row')!;
    expect([...row.children].map((child) => child.className)).toEqual(['name', 'flair', 'rating']);
    expect(row.querySelector('.name')?.textContent).toBe('Bob');
    expect(row.querySelector('.flair')?.textContent).toBe('🚶');
  });
  it('follows the name on a leaderboard row', () => {
    const entry = {
      ...playerRef('2', '@bob', { flair: ['draws_10'] }),
      gamesPlayed: 3,
      record: { wins: 1, draws: 1, losses: 1 },
    };
    const r = renderApp(
      () => <PlayerRow entry={entry} rank={2} you={false} onOpen={() => {}} />,
      ok,
    );
    expect(r.root.querySelector('.name-row .name')?.nextElementSibling?.textContent).toBe('🤝');
  });
  it('follows your name and “(you)” on your own leaderboard row', () => {
    const entry = {
      ...playerRef('1', 'Alice', { flair: ['draws_10'] }),
      gamesPlayed: 3,
      record: { wins: 1, draws: 1, losses: 1 },
    };
    const row = renderApp(
      () => <PlayerRow entry={entry} rank={1} you onOpen={() => {}} />,
      ok,
    ).root.querySelector('.name-row')!;
    expect([...row.children].map((child) => child.className)).toEqual(['name', 'flair', 'rating']);
    // "(you)" is part of the name's text, as in the prototype, so the two ellipsise together and
    // leave the flair and the rating whole.
    expect(row.querySelector('.name')?.textContent).toBe('Alice (you)');
  });
});
