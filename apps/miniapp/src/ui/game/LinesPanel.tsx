import { t, type Colour, type DraftNode } from '@chess-goat/shared';
import { Fragment } from 'preact';
import { useEffect, useMemo, useRef } from 'preact/hooks';
import { linesModel } from '../../state/premoveLines';

/**
 * Every premove branch at once, in standard notation. Opponent moves are grey, the owner's replies
 * bold blue; the selected move is filled and followed by the ✕ that removes it.
 */
export function LinesPanel(props: {
  tree: readonly DraftNode[];
  rootFen: string;
  owner: Colour;
  root: { label: string; caption: string };
  selected: readonly string[];
  onSelect: (path: string[]) => void;
  /** Without one, the selected move has no ✕ (the draft is on its way to the server). */
  onRemove?: () => void;
}) {
  const { tree, rootFen, owner, selected } = props;
  const blocks = useMemo(() => linesModel(tree, rootFen, owner), [tree, rootFen, owner]);
  const panel = useRef<HTMLDivElement>(null);
  const key = selected.join(',');
  // Keeps the selected move in view by scrolling the panel only, never the page.
  useEffect(() => {
    const element = panel.current;
    const current = element?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!element || !current) return;
    const outer = element.getBoundingClientRect();
    const inner = current.getBoundingClientRect();
    if (inner.top < outer.top) element.scrollTop += inner.top - outer.top;
    else if (inner.bottom > outer.bottom) element.scrollTop += inner.bottom - outer.bottom;
  }, [key, blocks]);
  return (
    <div class="lines-panel" ref={panel}>
      <button
        class="lines-root"
        data-path=""
        aria-current={key === '' ? 'true' : 'false'}
        onClick={() => props.onSelect([])}
      >
        <span class="lines-root-label">{props.root.label}</span>
        <span class="lines-root-caption">{props.root.caption}</span>
      </button>
      {blocks.map((block) => (
        <div
          key={block.tokens[0]!.path.join(',')}
          class={block.split ? 'lines-block split' : 'lines-block'}
          data-depth={block.depth}
        >
          {block.tokens.map((token) => {
            const path = token.path.join(',');
            const current = path === key;
            return (
              <Fragment key={path}>
                <span class="lines-unit">
                  {token.number ? <span class="lines-number">{token.number}</span> : null}
                  <button
                    class={token.mine ? 'lines-token mine' : 'lines-token'}
                    data-path={path}
                    aria-current={current ? 'true' : 'false'}
                    onClick={() => props.onSelect(token.path)}
                  >
                    {token.san}
                  </button>
                  {current && props.onRemove ? (
                    <button
                      class="lines-remove"
                      data-action="premove-remove"
                      aria-label={t('app.game.premove_remove')}
                      onClick={props.onRemove}
                    >
                      ✕
                    </button>
                  ) : null}
                </span>{' '}
              </Fragment>
            );
          })}
        </div>
      ))}
    </div>
  );
}
