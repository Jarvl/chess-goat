import { describe, expect, it, vi } from 'vitest';
import { GameCard } from '../src/ui/GameCard';
import { AFTER_E4 } from './support/gameFixtures';
import { renderApp } from './support/render';
import { gameSummary, playerRef } from './support/summaryFixtures';

// Counts every FEN chessground/fen's `read` is asked to parse, keyed by the fen string itself, so
// a test can tell whether one particular card's board re-rendered without the other's ticking
// re-renders (which are expected) muddying the count.
const { readCalls } = vi.hoisted(() => ({ readCalls: [] as string[] }));
vi.mock('chessground/fen', async () => {
  const actual = await vi.importActual<typeof import('chessground/fen')>('chessground/fen');
  return {
    ...actual,
    read: (fen: string) => {
      readCalls.push(fen);
      return actual.read(fen);
    },
  };
});

const mount = (
  game: ReturnType<typeof gameSummary>,
  context?: string,
  dim?: 'waiting' | 'finished',
) => {
  const opened: string[] = [];
  const r = renderApp(
    () => <GameCard game={game} context={context} dim={dim} onOpen={(id) => opened.push(id)} />,
    () => ({ status: 200, body: {} }),
  );
  return { r, opened };
};

describe('GameCard', () => {
  it('shows the opponent, the group, the terms and a gold pill on your move', async () => {
    const { r, opened } = mount(gameSummary({ fen: AFTER_E4, lastMove: 'e2e4' }), 'Chess Club');
    const card = r.root.querySelector<HTMLElement>('[data-game="GameAaaaaa"]')!;
    expect(card.className).not.toContain('dim');
    expect(card.querySelector('.name')!.textContent).toBe('Bob');
    expect(card.querySelector('.rating')!.textContent).toBe('1500?');
    expect(r.text()).toContain('Chess Club');
    expect(r.text()).toContain('1 day per move · Rated');
    expect(card.querySelector('.pill')!.className).toBe('pill yours');
    expect(card.querySelectorAll('.mini-board .lm')).toHaveLength(2);
    await r.click('[data-game="GameAaaaaa"]');
    expect(opened).toEqual(['GameAaaaaa']);
  });

  it('dims a game that is waiting on someone else', async () => {
    const { r } = mount(gameSummary({ yourTurn: false, sideToMove: 'black' }));
    expect(r.root.querySelector('.game-card')!.className).toContain('dim');
  });

  it('dims only finished games when asked to', async () => {
    const waiting = mount(
      gameSummary({ yourTurn: false, sideToMove: 'black' }),
      undefined,
      'finished',
    );
    expect(waiting.r.root.querySelector('.game-card')!.className).not.toContain('dim');
    const done = mount(
      gameSummary({
        status: 'finished',
        yourTurn: false,
        finishedAt: '2026-09-20T12:00:00.000Z',
        result: '1-0',
        endReason: 'resignation',
      }),
      undefined,
      'finished',
    );
    expect(done.r.root.querySelector('.game-card')!.className).toContain('dim');
  });

  it('turns the board for black and names both sides for a spectator', async () => {
    const asBlack = mount(
      gameSummary({ white: playerRef('2', 'Bob'), black: playerRef('1', 'Alice') }),
    );
    expect(asBlack.r.root.querySelector('[data-square]')!.getAttribute('data-square')).toBe('h1');

    const watching = mount(
      gameSummary({
        white: playerRef('3', 'Carol'),
        black: playerRef('4', 'Dan'),
        yourTurn: false,
      }),
    );
    expect(watching.r.root.querySelector('.name')!.textContent).toBe('Carol vs Dan');
    expect(watching.r.root.querySelector('.tag')!.textContent).toBe('Watching');
  });

  it('shows the bot with its level instead of a rating', async () => {
    const { r } = mount(
      gameSummary({ black: playerRef('9', 'Stockfish', { isBot: true }), engineLevel: 'club' }),
    );
    expect(r.root.querySelector('.rating')!.textContent).toBe('Club');
    expect(r.root.querySelector('img.avatar.bot')).not.toBeNull();
  });

  it('ticks every live row from one interval and stops it when they go', async () => {
    // Only setInterval/clearInterval/Date are faked: setTimeout stays real so renderApp's
    // flush() (which polls via real setTimeout) still drains Preact's deferred effects.
    vi.useFakeTimers({
      toFake: ['setInterval', 'clearInterval', 'Date'],
      now: new Date('2026-09-20T12:00:00.000Z'),
    });
    try {
      const deadlineAt = new Date(Date.now() + 5 * 3_600_000).toISOString();
      const gameA = gameSummary({ id: 'GameAaaaaa', deadlineAt });
      const gameB = gameSummary({ id: 'GameBbbbbb', deadlineAt });
      const r = renderApp(
        () => (
          <>
            <GameCard game={gameA} onOpen={() => {}} />
            <GameCard game={gameB} onOpen={() => {}} />
          </>
        ),
        () => ({ status: 200, body: {} }),
      );
      expect(vi.getTimerCount()).toBe(1);

      const before = Array.from(r.root.querySelectorAll('.pill')).map((el) => el.textContent);
      vi.advanceTimersByTime(1_000);
      await r.flush();
      const after = Array.from(r.root.querySelectorAll('.pill')).map((el) => el.textContent);
      expect(after).not.toEqual(before);

      renderApp(
        () => null,
        () => ({ status: 200, body: {} }),
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not re-render a finished card’s board on the shared tick', async () => {
    readCalls.length = 0;
    vi.useFakeTimers({
      toFake: ['setInterval', 'clearInterval', 'Date'],
      now: new Date('2026-09-20T12:00:00.000Z'),
    });
    try {
      const deadlineAt = new Date(Date.now() + 5 * 3_600_000).toISOString();
      // Distinct fens so `readCalls` can tell the two boards apart.
      const live = gameSummary({ id: 'GameAaaaaa', deadlineAt });
      const finished = gameSummary({
        id: 'GameBbbbbb',
        status: 'finished',
        result: '1-0',
        endReason: 'checkmate',
        fen: AFTER_E4,
      });
      const r = renderApp(
        () => (
          <>
            <GameCard game={live} onOpen={() => {}} />
            <GameCard game={finished} onOpen={() => {}} />
          </>
        ),
        () => ({ status: 200, body: {} }),
      );
      expect(readCalls.filter((fen) => fen === AFTER_E4)).toHaveLength(1);

      vi.advanceTimersByTime(1_000);
      await r.flush();

      // The live card's pill ticked (proving the interval still ran), but the finished card
      // never re-subscribed to it, so its board was never asked to re-parse its FEN.
      expect(r.root.querySelector('.pill')!.textContent).not.toBe('Your move · 5:00:00');
      expect(readCalls.filter((fen) => fen === AFTER_E4)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refreshes a stale shared `now` synchronously, so a remounted card’s first paint is current', async () => {
    vi.useFakeTimers({
      toFake: ['setInterval', 'clearInterval', 'Date'],
      now: new Date('2026-09-20T12:00:00.000Z'),
    });
    try {
      const deadlineAt = new Date(Date.now() + 5 * 3_600_000).toISOString();
      const game = gameSummary({ deadlineAt });

      // Mount once so the shared ticker starts, then unmount everything so it stops (0
      // subscribers) and leaves the shared `now` signal stale at this moment.
      renderApp(
        () => <GameCard game={game} onOpen={() => {}} />,
        () => ({ status: 200, body: {} }),
      );
      renderApp(
        () => null,
        () => ({ status: 200, body: {} }),
      );
      expect(vi.getTimerCount()).toBe(0);

      // Time passes with nobody subscribed.
      vi.advanceTimersByTime(10_000);

      // A fresh active card mounts: its very first paint (checked before any effect flushes)
      // must already reflect the current time, not the stale cached one.
      const r = renderApp(
        () => <GameCard game={game} onOpen={() => {}} />,
        () => ({ status: 200, body: {} }),
        { deferEffects: true },
      );
      expect(r.root.querySelector('.pill')!.textContent).toBe('Your move · 4:59:50');
    } finally {
      vi.useRealTimers();
    }
  });
});
