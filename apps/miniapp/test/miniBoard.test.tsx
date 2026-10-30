import { INITIAL_FEN } from '@group-chess/shared';
import { describe, expect, it } from 'vitest';
import { MiniBoard } from '../src/ui/MiniBoard';
import { AFTER_E4 } from './support/gameFixtures';
import { renderApp } from './support/render';

const mount = (fen: string, lastMove: string | null, orientation: 'white' | 'black') =>
  renderApp(
    () => <MiniBoard fen={fen} lastMove={lastMove} orientation={orientation} />,
    () => ({ status: 200, body: {} }),
  );

describe('MiniBoard', () => {
  it('draws 64 squares from a8 with the pieces of the position', async () => {
    const r = mount(AFTER_E4, 'e2e4', 'white');
    const squares = [...r.root.querySelectorAll('[data-square]')];
    expect(squares).toHaveLength(64);
    expect(squares[0]!.getAttribute('data-square')).toBe('a8');
    expect(squares[0]!.classList.contains('l')).toBe(true);
    expect(r.root.querySelector('[data-square="a1"]')!.classList.contains('d')).toBe(true);
    expect(r.root.querySelector('[data-square="e4"] piece')!.getAttribute('class')).toBe(
      'pawn white',
    );
    expect(r.root.querySelector('[data-square="e2"] piece')).toBeNull();
    expect(r.root.querySelectorAll('piece')).toHaveLength(32);
  });

  it("tints the last move's two squares", async () => {
    const r = mount(AFTER_E4, 'e2e4', 'white');
    expect([...r.root.querySelectorAll('.lm')].map((el) => el.getAttribute('data-square'))).toEqual(
      ['e4', 'e2'],
    );
  });

  it('tints nothing before the first move', async () => {
    const r = mount(INITIAL_FEN, null, 'white');
    expect(r.root.querySelectorAll('.lm')).toHaveLength(0);
  });

  it('turns the board for black', async () => {
    const r = mount(INITIAL_FEN, null, 'black');
    expect(r.root.querySelector('[data-square]')!.getAttribute('data-square')).toBe('h1');
  });
});
