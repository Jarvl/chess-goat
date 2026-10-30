import { INITIAL_FEN, legalDests, type MoveDto } from '@group-chess/shared';
import { effect } from '@preact/signals';
import { describe, expect, it } from 'vitest';
import { diffNotices, GameStore, positionAt } from '../src/state/game';
import { afterPlies, gameDto, pair, treeText } from './support/gameFixtures';

/** A minimal MoveDto for hand-crafted multi-ply fixtures; diffNotices only reads `.uci`. */
const move = (ply: number, uci: string): MoveDto => ({
  ply,
  uci,
  san: uci,
  fenAfter: '',
  playedAt: '2026-09-20T10:00:00.000Z',
});

describe('positionAt', () => {
  it('walks the move list with last move and check', () => {
    const game = afterPlies(4, { status: 'finished', result: '0-1', endReason: 'checkmate' });
    expect(positionAt(game, 0)).toMatchObject({ ply: 0, lastMove: null, check: false });
    expect(positionAt(game, 1)).toMatchObject({ ply: 1, lastMove: ['f2', 'f3'], check: false });
    expect(positionAt(game, 4)).toMatchObject({ ply: 4, lastMove: ['d8', 'h4'], check: true });
    expect(positionAt(game, 4).fen).toBe(game.fen);
  });
});

describe('GameStore', () => {
  it('lets only the player to move move, and only at the latest position', () => {
    const white = new GameStore(afterPlies(2, { viewerRole: 'white' }));
    expect(white.canMove.value).toBe(true);
    expect(white.dests.value.get('g1')).toEqual(['h3']); // f3 holds White's own pawn
    white.viewPly(1);
    expect(white.isLatest.value).toBe(false);
    expect(white.canMove.value).toBe(false);
    expect(white.dests.value.size).toBe(0);
    white.viewPly(null);
    expect(white.canMove.value).toBe(true);

    // The waiting player moves too: they build premoves.
    expect(new GameStore(afterPlies(2, { viewerRole: 'black' })).canMove.value).toBe(true);
    expect(new GameStore(afterPlies(2, { viewerRole: 'spectator' })).canMove.value).toBe(false);
    expect(
      new GameStore(
        afterPlies(4, {
          viewerRole: 'white',
          status: 'finished',
          result: '0-1',
          endReason: 'checkmate',
        }),
      ).canMove.value,
    ).toBe(false);
  });

  it('orients the board to the viewer and lets spectators flip', () => {
    expect(new GameStore(gameDto({ viewerRole: 'black' })).orientation.value).toBe('black');
    const spectator = new GameStore(gameDto({ viewerRole: 'spectator' }));
    expect(spectator.orientation.value).toBe('white');
    spectator.flip();
    expect(spectator.orientation.value).toBe('black');
  });

  it('applies newer states only and jumps to the latest position when the game moves on', () => {
    const store = new GameStore(afterPlies(1));
    store.viewPly(0);
    expect(store.apply(afterPlies(0))).toBe(false);
    expect(store.dto.value.plyCount).toBe(1);
    expect(store.apply(afterPlies(2))).toBe(true);
    expect(store.viewingPly.value).toBeNull();
    expect(store.position.value.ply).toBe(2);
  });

  it('keeps an earlier position on screen while the viewer is reading the game', () => {
    const store = new GameStore(afterPlies(3, { viewerRole: 'spectator' }));
    store.viewPly(1);
    store.apply(afterPlies(3, { version: 7, drawOffer: { by: 'white', atPly: 3 } }));
    expect(store.viewingPly.value).toBe(1);
  });
});

describe('diffNotices', () => {
  it('derives offers, declines, opponent moves and the end from consecutive states', () => {
    const base = afterPlies(2, { viewerRole: 'white' });
    expect(
      diffNotices(
        base,
        afterPlies(2, { viewerRole: 'white', version: 3, drawOffer: { by: 'black', atPly: 2 } }),
      ),
    ).toEqual(['draw_offered']);
    expect(
      diffNotices(
        afterPlies(2, { viewerRole: 'white', drawOffer: { by: 'white', atPly: 2 } }),
        afterPlies(2, { viewerRole: 'white', version: 3 }),
      ),
    ).toEqual(['draw_declined']);
    expect(
      diffNotices(afterPlies(1, { viewerRole: 'white' }), afterPlies(2, { viewerRole: 'white' })),
    ).toEqual(['opponent_moved']);
    expect(
      diffNotices(afterPlies(2, { viewerRole: 'white' }), afterPlies(3, { viewerRole: 'white' })),
    ).toEqual([]);
    expect(
      diffNotices(
        afterPlies(3, { viewerRole: 'black' }),
        afterPlies(4, {
          viewerRole: 'black',
          status: 'finished',
          result: '0-1',
          endReason: 'checkmate',
        }),
      ),
    ).toEqual(['finished']);
    expect(diffNotices(base, base)).toEqual([]);
  });
});

describe('GameStore building', () => {
  // After 1. f3 it is Black's move; White (the viewer) premoves.
  const waiting = () => afterPlies(1, { viewerRole: 'white' });

  it('builds only at the latest position', () => {
    // White waits after 2. g4; looking back at 1. f3 builds nothing there.
    const reading = new GameStore(afterPlies(3, { viewerRole: 'white' }));
    expect(reading.building.value).toBe(true);
    reading.viewPly(1);
    expect(reading.canMove.value).toBe(false);
  });

  it('applies a same-version state whose tree changed', () => {
    const store = new GameStore(waiting());
    const changed = afterPlies(1, {
      viewerRole: 'white',
      premoveTree: treeText(pair('e7e5', 'g2g4')),
    });
    expect(store.apply(changed)).toBe(true);
    expect(store.apply(changed)).toBe(false);
  });

  it('stays out of building while the player’s own move is still settling', () => {
    // The stream can show the opponent's turn before the POST /moves answers or while it retries.
    const store = new GameStore(waiting());
    store.moveBusy.value = true;
    expect(store.building.value).toBe(false);
    expect(store.canMove.value).toBe(false);
    expect(store.dests.value.size).toBe(0);
    store.moveBusy.value = false;
    expect(store.building.value).toBe(true);
  });
});

describe('diffNotices premoves', () => {
  // After 1. f3 it is Black's move; White (the viewer) owns the tree.
  const withTree = (premoveTree: string) => afterPlies(1, { viewerRole: 'white', premoveTree });
  /** Plies 1… of a hand-made game; the fen only decides whose turn it is (White's here). */
  const played = (...ucis: string[]) =>
    gameDto({
      viewerRole: 'white',
      plyCount: ucis.length,
      version: ucis.length,
      fen: INITIAL_FEN,
      moves: ucis.map((uci, index) => move(index + 1, uci)),
    });

  it('tells a played pair from a cancelled tree', () => {
    const before = withTree(treeText(pair('e7e5', 'g2g4')));
    expect(diffNotices(before, afterPlies(3, { viewerRole: 'white' }))).toEqual(['premove_played']);
    const missed = withTree(treeText(pair('d7d5', 'g2g4')));
    expect(diffNotices(missed, afterPlies(2, { viewerRole: 'white' }))).toEqual([
      'opponent_moved',
      'premoves_cancelled',
    ]);
  });

  it('counts every fired pair across a multi-ply jump, then flags the miss after them', () => {
    const before = withTree(
      treeText(pair('e7e5', 'g2g4', pair('e5e4', 'b1c3', pair('a7a6', 'a2a3')))),
    );
    const next = played('f2f3', 'e7e5', 'g2g4', 'e5e4', 'b1c3', 'd7d5');
    expect(diffNotices(before, next)).toEqual([
      'opponent_moved',
      'premove_played',
      'premoves_cancelled',
    ]);
  });

  it('cancels nothing when a line runs out', () => {
    const before = withTree(treeText(pair('e7e5', 'g2g4')));
    expect(diffNotices(before, played('f2f3', 'e7e5', 'g2g4', 'd8h4'))).toEqual([
      'opponent_moved',
      'premove_played',
    ]);
  });

  it('reads an unreadable tree as empty', () => {
    expect(diffNotices(withTree('!'), afterPlies(2, { viewerRole: 'white' }))).toEqual([
      'opponent_moved',
    ]);
  });

  it('reports a discarded draft only when the game moved on to a new ply and goes on', () => {
    const before = afterPlies(1, { viewerRole: 'white' });
    expect(
      diffNotices(before, afterPlies(2, { viewerRole: 'white' }), { discardedDraft: true }),
    ).toContain('premove_draft_discarded');
    expect(
      diffNotices(
        before,
        afterPlies(1, { viewerRole: 'white', version: 2, drawOffer: { by: 'black', atPly: 1 } }),
        { discardedDraft: true },
      ),
    ).not.toContain('premove_draft_discarded');
    // The result screen explains a game end.
    expect(
      diffNotices(before, afterPlies(1, { viewerRole: 'white', status: 'finished' }), {
        discardedDraft: true,
      }),
    ).toEqual(['finished']);
    expect(
      diffNotices(before, afterPlies(2, { viewerRole: 'white', status: 'finished' }), {
        discardedDraft: true,
      }),
    ).toEqual(['finished']);
    expect(diffNotices(before, afterPlies(2, { viewerRole: 'white' }))).not.toContain(
      'premove_draft_discarded',
    );
  });
});

describe('GameStore premove drafts', () => {
  // After 1. f3 it is Black's move; White (the viewer) builds premoves.
  const opponentsTurn = (premoveTree = '') =>
    new GameStore(afterPlies(1, { viewerRole: 'white', premoveTree }));
  // After 1. f3 e5 it is White's own move.
  const ownTurn = () => new GameStore(afterPlies(2, { viewerRole: 'white' }));

  it('shows the server tree until the draft has edits', () => {
    const store = opponentsTurn(treeText(pair('e7e5', 'g2g4')));
    expect(store.serverTree.value).toEqual([pair('e7e5', 'g2g4')]);
    expect(store.tree.value).toBe(store.serverTree.value);
    store.draftTree.value = [{ move: 'd7d5', reply: null, children: [] }];
    expect(store.tree.value).toEqual([{ move: 'd7d5', reply: null, children: [] }]);
    store.draftTree.value = null;
    expect(store.tree.value).toEqual([pair('e7e5', 'g2g4')]);
    expect(opponentsTurn('!').serverTree.value).toEqual([]);
  });

  it('builds on the opponent’s turn, and on the own turn once a move waits', () => {
    // While the player's own move is still sending or retrying, see 'stays out of building …'.
    expect(opponentsTurn().building.value).toBe(true);

    const own = ownTurn();
    expect(own.building.value).toBe(false);
    own.waiting.value = { uci: 'g2g4', san: 'g4' };
    own.moveBusy.value = true; // waiting for Confirm counts as busy too
    expect(own.building.value).toBe(true);

    expect(new GameStore(afterPlies(1, { viewerRole: 'spectator' })).building.value).toBe(false);
    expect(
      new GameStore(afterPlies(1, { viewerRole: 'white', status: 'finished' })).building.value,
    ).toBe(false);
  });

  it('offers the opponent’s legal moves at the root, and the owner’s after an opponent move', () => {
    const store = opponentsTurn();
    const root = store.buildView.value;
    expect(root.canMove).toBe(true);
    expect(root.turn).toBe('black');
    expect(root.dests).toEqual(legalDests(store.dto.value.fen));
    expect(root.position.fen).toBe(store.dto.value.fen);
    expect(root.position.lastMove).toEqual(['f2', 'f3']);

    store.draftTree.value = [{ move: 'e7e5', reply: null, children: [] }];
    store.selected.value = ['e7e5'];
    const after = store.buildView.value;
    expect(after.turn).toBe('white');
    expect([...(after.dests.get('g2') ?? [])].sort()).toEqual(['g3', 'g4']);
    expect(after.dests.has('e5')).toBe(false);
    expect(after.position.lastMove).toEqual(['e7', 'e5']);
    expect(after.position.fen.split(' ')[0]).toBe(
      'rnbqkbnr/pppp1ppp/8/4p3/8/5P2/PPPPP1PP/RNBQKBNR',
    );
  });

  it('roots the tree after the waiting move, and lets the position before it be replayed', () => {
    const store = ownTurn();
    store.waiting.value = { uci: 'g2g4', san: 'g4' };
    expect(store.rootFen.value.split(' ').slice(0, 2)).toEqual([
      'rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR',
      'b',
    ]);
    expect(store.buildView.value.turn).toBe('black');
    expect(store.buildView.value.position.lastMove).toEqual(['g2', 'g4']);
    expect(store.timeline.value).toMatchObject({ plies: 2, rootIndex: 3, end: 3, at: 3 });

    expect(store.viewTimeline(2)).toBe(true);
    expect(store.viewingPly.value).toBe(2);
    const before = store.buildView.value;
    expect(before.canMove).toBe(true);
    expect(before.turn).toBe('white');
    expect(before.position.fen).toBe(store.dto.value.fen);
    expect(before.dests).toEqual(legalDests(store.dto.value.fen));

    expect(store.viewTimeline(1)).toBe(true);
    const earlier = store.buildView.value;
    expect(earlier.canMove).toBe(false);
    expect(earlier.dests.size).toBe(0);
    expect(earlier.position.ply).toBe(1);
    expect(store.viewTimeline(1)).toBe(false);

    expect(store.viewTimeline(3)).toBe(true);
    expect(store.viewingPly.value).toBeNull();
    expect(store.buildView.value.canMove).toBe(true);
  });

  it('steps along the line being viewed and comes back to the same branch', () => {
    const store = opponentsTurn();
    store.draftTree.value = [pair('e7e5', 'g2g4'), pair('d7d5', 'g2g3')];
    store.selected.value = ['d7d5', 'g2g3'];
    store.trail.value = ['d7d5', 'g2g3'];
    expect(store.timeline.value).toMatchObject({ rootIndex: 1, end: 3, at: 3 });
    expect(store.viewTimeline(1)).toBe(true);
    expect(store.selected.value).toEqual([]);
    expect(store.timeline.value.line).toEqual(['d7d5', 'g2g3']);
    expect(store.viewTimeline(2)).toBe(true);
    expect(store.selected.value).toEqual(['d7d5']);
    expect(store.buildView.value.position.lastMove).toEqual(['d7', 'd5']);
    expect(store.viewTimeline(0)).toBe(true);
    expect(store.viewingPly.value).toBe(0);
    expect(store.buildView.value.canMove).toBe(false);
    expect(store.viewTimeline(3)).toBe(true);
    expect(store.selected.value).toEqual(['d7d5', 'g2g3']);
  });

  it('tells premove changes from a waiting move', () => {
    const store = opponentsTurn(treeText(pair('e7e5', 'g2g4')));
    expect(store.draftDirty.value).toBe(false);
    store.draftTree.value = [pair('e7e5', 'g2g4'), { move: 'd7d5', reply: null, children: [] }];
    expect(store.premoveDraftChanged.value).toBe(false); // an unanswered move is not a premove
    store.draftTree.value = [pair('e7e5', 'g2g4'), pair('d7d5', 'g2g3')];
    expect(store.premoveDraftChanged.value).toBe(true);
    expect(store.draftDirty.value).toBe(true);

    const own = ownTurn();
    own.waiting.value = { uci: 'g2g4', san: 'g4' };
    expect(own.premoveDraftChanged.value).toBe(false);
    expect(own.draftDirty.value).toBe(true);
  });

  it('applies a changed server tree at the same ply, keeping the draft, and clears it on a new ply', () => {
    const store = opponentsTurn();
    store.draftTree.value = [pair('e7e5', 'g2g4')];
    store.selected.value = ['e7e5'];
    store.trail.value = ['e7e5', 'g2g4'];
    expect(
      store.apply(
        afterPlies(1, { viewerRole: 'white', premoveTree: treeText(pair('d7d5', 'g2g3')) }),
      ),
    ).toBe(true);
    expect(store.serverTree.value).toEqual([pair('d7d5', 'g2g3')]);
    expect(store.draftTree.value).toEqual([pair('e7e5', 'g2g4')]);
    expect(store.selected.value).toEqual(['e7e5']);

    store.apply(afterPlies(2, { viewerRole: 'white' }));
    expect(store.draftTree.value).toBeNull();
    expect(store.waiting.value).toBeNull();
    expect(store.selected.value).toEqual([]);
    expect(store.trail.value).toEqual([]);
  });

  it('resets the draft, and leaves the position before a waiting move once it is gone', () => {
    const store = ownTurn();
    store.waiting.value = { uci: 'g2g4', san: 'g4' };
    store.draftTree.value = [{ move: 'd8h4', reply: null, children: [] }];
    store.viewTimeline(2);
    store.resetDraft();
    expect(store.waiting.value).toBeNull();
    expect(store.draftTree.value).toBeNull();
    expect(store.viewingPly.value).toBeNull();
    expect(store.buildView.value.canMove).toBe(true); // the player's own move, as before
    expect(store.buildView.value.turn).toBe('white');
  });

  it('applies a new state in one batch, so no effect sees it beside the old draft', () => {
    const store = ownTurn();
    store.waiting.value = { uci: 'g1f3', san: 'Nf3' };
    const seen: [number, string | null][] = [];
    const dispose = effect(() => {
      seen.push([store.dto.value.plyCount, store.waiting.value?.uci ?? null]);
    });
    store.apply(afterPlies(3, { viewerRole: 'white' }));
    dispose();
    expect(seen).toEqual([
      [2, 'g1f3'],
      [3, null],
    ]);
  });

  it('reads a draft the codec refuses as changed instead of throwing', () => {
    const store = opponentsTurn();
    // More siblings than one count byte holds: encodePremoveTree throws on it.
    const wide = Array.from({ length: 219 }, () => pair('e7e5', 'g2g4'));
    store.draftTree.value = wide;
    expect(store.premoveDraftChanged.value).toBe(true);
    expect(store.draftDirty.value).toBe(true);
  });

  it('starts, snapshots and restores the waiting move with its draft', () => {
    const store = ownTurn();
    store.setWaiting({ uci: 'g1f3', san: 'Nf3' });
    store.draftTree.value = [pair('d8h4', 'f3h4')];
    store.selected.value = ['d8h4'];
    const snapshot = store.snapshotDraft();
    store.setWaiting({ uci: 'g1h3', san: 'Nh3' });
    expect(store.draftTree.value).toBeNull();
    expect(store.selected.value).toEqual([]);
    store.restoreDraft(snapshot);
    expect(store.waiting.value?.uci).toBe('g1f3');
    expect(store.selected.value).toEqual(['d8h4']);
  });

  it('keeps what still exists of the selection when the draft is dropped', () => {
    const store = opponentsTurn(treeText(pair('e7e5', 'g2g4')));
    store.draftTree.value = [
      { move: 'e7e5', reply: 'g2g4', children: [{ move: 'd8h4', reply: null, children: [] }] },
    ];
    store.selected.value = ['e7e5', 'g2g4', 'd8h4'];
    store.dropDraftTree();
    expect(store.selected.value).toEqual(['e7e5', 'g2g4']);
  });

  it('starts a draft on the server tree it was made on, once, and forgets it when the draft goes', () => {
    const store = opponentsTurn(treeText(pair('e7e5', 'g2g4')));
    store.editDraft([pair('e7e5', 'g2g4'), { move: 'd7d5', reply: null, children: [] }], ['d7d5']);
    const base = store.draftBase.value;
    expect(base).toMatchObject({ tree: treeText(pair('e7e5', 'g2g4')), ply: 1 });
    store.editDraft([pair('e7e5', 'g2g4'), pair('d7d5', 'g2g3')], ['d7d5', 'g2g3']);
    expect(store.draftBase.value).toBe(base);
    store.resetDraft();
    expect(store.draftBase.value).toBeNull();
    store.editDraft([pair('d7d5', 'g2g3')], ['d7d5', 'g2g3']);
    expect(store.draftBase.value?.draft).not.toBe(base?.draft);
    store.dropDraftTree();
    expect(store.draftBase.value).toBeNull();
  });

  it('restores a snapshot without undoing a save of the same draft', () => {
    const store = opponentsTurn();
    store.editDraft([pair('e7e5', 'g2g4')], ['e7e5', 'g2g4']);
    const snapshot = store.snapshotDraft();
    const saved = { ...store.draftBase.value!, tree: treeText(pair('e7e5', 'g2g4')) };
    store.draftBase.value = saved;
    store.restoreDraft(snapshot);
    expect(store.draftBase.value).toBe(saved);
    // A draft started since the snapshot goes back with it.
    const empty = new GameStore(afterPlies(1, { viewerRole: 'white' }));
    const before = empty.snapshotDraft();
    empty.editDraft([pair('e7e5', 'g2g4')], ['e7e5', 'g2g4']);
    empty.restoreDraft(before);
    expect(empty.draftBase.value).toBeNull();
    expect(empty.draftTree.value).toBeNull();
  });
});
