import { countPremovePairs, sideToMove, t, type Colour } from '@chess-goat/shared';
import type { GameStore } from '../../state/game';
import { fenAt, moveLabel, nodeAt } from '../../state/premoveDraft';

function opponentOf(colour: Colour): Colour {
  return colour === 'white' ? 'black' : 'white';
}

/** The hint under the board: what the next move on the shown position would do. */
function hintFor(store: GameStore, viewer: Colour): string | null {
  const dto = store.dto.value;
  const name = dto[opponentOf(viewer)].name;
  const viewing = store.viewingPly.value;
  const waiting = store.waiting.value;
  if (viewing !== null) {
    if (waiting && viewing === dto.plyCount && store.building.value)
      return t('app.game.hint_before', { move: moveLabel(dto.fen, waiting.uci) });
    return t('app.game.hint_earlier');
  }
  if (!store.building.value) return sideToMove(dto.fen) === viewer ? t('app.game.hint_play') : null;
  const rootFen = store.rootFen.value;
  const tree = store.tree.value;
  const path = store.selected.value;
  if (path.length % 2 === 1) {
    // An opponent move is shown: the player answers it, or replaces the answer it has.
    const { node } = nodeAt(tree, path);
    if (node?.reply)
      return t('app.game.hint_replace', { move: moveLabel(fenAt(rootFen, path), node.reply) });
    return t('app.game.hint_reply', {
      move: moveLabel(fenAt(rootFen, path.slice(0, -1)), path[path.length - 1]!),
    });
  }
  const { level } = nodeAt(tree, path);
  return level.length > 0
    ? t('app.game.hint_branch', { name })
    : t('app.game.hint_opponent', { name });
}

/**
 * The status line (conditional premoves spec, The game screen, item 4): a pill saying where the
 * premoves stand, then one hint. `draft` says the screen holds changes not confirmed yet.
 */
export function PremoveStatus(props: { store: GameStore; draft: boolean }) {
  const { store } = props;
  const dto = store.dto.value;
  const viewer = dto.viewerRole;
  if (dto.status !== 'active' || (viewer !== 'white' && viewer !== 'black')) return null;
  const pairs = countPremovePairs(store.serverTree.value);
  const pill = props.draft
    ? t('app.game.pill_draft')
    : sideToMove(dto.fen) === viewer
      ? t('app.game.pill_your_move')
      : pairs === 1
        ? t('app.game.pill_saved_one')
        : pairs > 1
          ? t('app.game.pill_saved', { n: pairs })
          : t('app.game.pill_opponent', { name: dto[opponentOf(viewer)].name });
  let hint: string | null;
  try {
    hint = hintFor(store, viewer);
  } catch {
    // A selection the position no longer allows: say nothing rather than break the screen.
    hint = null;
  }
  return (
    <div class="premove-status">
      <span class="premove-pill">{pill}</span>
      {hint ? <span class="premove-hint">{hint}</span> : null}
    </div>
  );
}
