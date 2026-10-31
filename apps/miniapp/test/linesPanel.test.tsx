import type { DraftNode } from '@chess-goat/shared';

import { describe, expect, it, vi } from 'vitest';
import { LinesPanel } from '../src/ui/game/LinesPanel';
import { renderApp } from './support/render';

const ROOT = 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3';
const ok = () => ({ status: 200, body: { ok: true } });

// 3…Nb4 4.d3 Nxd3+ 5.Bxd3 { d6 6.O-O | Qe7 6.O-O }
const TREE: DraftNode[] = [
  {
    move: 'c6b4',
    reply: 'd2d3',
    children: [
      {
        move: 'b4d3',
        reply: 'c4d3',
        children: [
          { move: 'd7d6', reply: 'e1g1', children: [] },
          { move: 'd8e7', reply: 'e1g1', children: [] },
        ],
      },
    ],
  },
];
const ROOT_LABEL = { label: '3.Bc4', caption: 'your move' };

function mount(
  selected: string[],
  handlers: { onSelect?: () => void; onRemove?: () => void } = {},
) {
  return renderApp(
    () => (
      <LinesPanel
        tree={TREE}
        rootFen={ROOT}
        owner="white"
        root={ROOT_LABEL}
        selected={selected}
        onSelect={handlers.onSelect ?? (() => {})}
        onRemove={handlers.onRemove ?? (() => {})}
      />
    ),
    ok,
  );
}

describe('LinesPanel', () => {
  it('renders the root chip and one block per line', async () => {
    const r = mount([]);
    const chip = r.root.querySelector('[data-path=""]')!;
    expect(chip.textContent).toContain('3.Bc4');
    expect(chip.textContent).toContain('your move');
    expect(r.root.querySelectorAll('.lines-block')).toHaveLength(3);
    const blocks = [...r.root.querySelectorAll('.lines-block')];
    expect(blocks.map((block) => block.getAttribute('data-depth'))).toEqual(['0', '1', '1']);
    expect(blocks.map((block) => block.classList.contains('split'))).toEqual([false, true, true]);
    expect(blocks[0]!.textContent?.replace(/\s+/g, '')).toBe('3…Nb44.d3Nxd3+5.Bxd3');
  });

  it('shows the ✕ only beside the selected token, inside its nowrap unit', async () => {
    const r = mount(['c6b4', 'd2d3', 'b4d3']);
    const buttons = r.root.querySelectorAll('[data-action="premove-remove"]');
    expect(buttons).toHaveLength(1);
    const remove = buttons[0]!;
    expect(remove.getAttribute('aria-label')).toBe('Remove');
    const unit = remove.closest('.lines-unit')!;
    expect(unit.querySelector('[data-path="c6b4,d2d3,b4d3"]')).not.toBeNull();
    expect(unit.querySelector('[aria-current="true"]')).not.toBeNull();
    expect(r.root.querySelectorAll('[aria-current="true"]')).toHaveLength(1);
  });

  it('shows no ✕ when the root chip is selected, and marks it current', async () => {
    const r = mount([]);
    expect(r.root.querySelector('[data-action="premove-remove"]')).toBeNull();
    expect(r.root.querySelector('[data-path=""]')!.getAttribute('aria-current')).toBe('true');
  });

  it('calls onSelect with the token path and the root chip with []', async () => {
    const onSelect = vi.fn();
    const r = mount(['c6b4'], { onSelect });
    await r.click('[data-path="c6b4,d2d3,b4d3,c4d3,d8e7"]');
    expect(onSelect).toHaveBeenLastCalledWith(['c6b4', 'd2d3', 'b4d3', 'c4d3', 'd8e7']);
    await r.click('[data-path=""]');
    expect(onSelect).toHaveBeenLastCalledWith([]);
  });

  it('calls onRemove from the ✕ and does not also select', async () => {
    const onSelect = vi.fn();
    const onRemove = vi.fn();
    const r = mount(['c6b4'], { onSelect, onRemove });
    await r.click('[data-action="premove-remove"]');
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('labels opponent moves and the owner replies apart', async () => {
    const r = mount([]);
    const mine = [...r.root.querySelectorAll('.lines-token.mine')].map((e) => e.textContent);
    const theirs = [...r.root.querySelectorAll('.lines-token:not(.mine)')].map(
      (e) => e.textContent,
    );
    expect(mine).toEqual(['d3', 'Bxd3', 'O-O', 'O-O']);
    expect(theirs).toEqual(['Nb4', 'Nxd3+', 'd6', 'Qe7']);
  });
});
