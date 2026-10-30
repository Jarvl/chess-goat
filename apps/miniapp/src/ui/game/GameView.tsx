import {
  countPremovePairs,
  GameDtoSchema,
  PgnLinkDtoSchema,
  t,
  type Colour,
  type DraftNode,
  type EngineGameRequest,
  type GameDto,
  type PremoveTreeRequest,
} from '@group-chess/shared';
import { batch } from '@preact/signals';
import { h } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ApiError } from '../../api/client';
import { GameStream } from '../../api/stream';
import type { BoardAdapter } from '../../board/adapter';
import {
  isPromotion,
  promotionOverlayStyle,
  promotionPieces,
  type PromotionPiece,
} from '../../board/promotion';
import { diffNotices, GameStore, positionAt, type Notice } from '../../state/game';
import { fenAt, moveLabel, playAt, removeAt, type PlayResult } from '../../state/premoveDraft';
import { stripMinimized } from '../../state/switcher';
import { noteTurnChange } from '../../state/yourMove';
import {
  needsConfirmation,
  reduceMove,
  type MoveEffect,
  type MoveEvent,
  type MoveState,
} from '../../state/moveMachine';
import { noteServerTime, prefs } from '../../state/session';
import { useApp } from '../context';
import { confirmDialog } from '../dialog';
import { termsLabel } from '../format';
import { toast } from '../toast';
import { Board } from './Board';
import { GameSwitcher } from './GameSwitcher';
import { LinesPanel } from './LinesPanel';
import { MoveList } from './MoveList';
import { PlayerBar } from './PlayerBar';
import {
  colourAt,
  confirmMoveLabel,
  fingerprint,
  hasOpenMove,
  removedMessage,
  removeMessage,
  replaceReplyMessage,
  replaceWaitingMessage,
  samePath,
  sameTree,
  sanOf,
  sendable,
} from './premoveHelpers';
import { PremoveStatus } from './PremoveStatus';
import { useClock } from './useClock';
import { useStrip } from './useStrip';

/** A send answered within this shows nothing; a slower one greys the board under a spinner. */
const SLOW_SEND_MS = 1_000;
/** Telegram shows Confirm and Cancel itself; the page draws neither. */
const NO_IN_PAGE = { confirm: false, cancel: false };

const PIECE_CLASS: Record<PromotionPiece, string> = {
  q: 'queen',
  r: 'rook',
  b: 'bishop',
  n: 'knight',
};
const PIECE_LABEL = {
  q: 'app.game.piece.q',
  r: 'app.game.piece.r',
  b: 'app.game.piece.b',
  n: 'app.game.piece.n',
} as const;

export function GameView(props: {
  initial: GameDto;
  onReload: () => Promise<GameDto>;
  /** Reached from the switcher strip, which keeps its order. */
  hop?: boolean;
}) {
  const { client, tg, router } = useApp();
  const store = useMemo(() => new GameStore(props.initial), [props.initial.id]);
  const adapterRef = useRef<BoardAdapter | null>(null);
  const moveRef = useRef<MoveState>({ kind: 'idle' });
  const [moveState, setMoveState] = useState<MoveState>({ kind: 'idle' });
  const [promotion, setPromotion] = useState<{
    orig: string;
    dest: string;
    /** The side whose pawn promotes: the opponent's, for one of their moves in the tree. */
    colour: Colour;
    /** Where it was dropped; anything different by pick time voids the pick. */
    at: string;
    tree: DraftNode[];
  } | null>(null);
  const [slowSend, setSlowSend] = useState(false);
  // True from a drop that waits for Confirm move until that move settles (sent, cancelled or
  // rejected): the bar stays up through the send, and the tab bar stays hidden (move confirmations spec).
  const [confirming, setConfirming] = useState(false);
  // Which of Confirm and Cancel this client has no Telegram button for, so the page draws them.
  const [inPage, setInPage] = useState(NO_IN_PAGE);
  // Confirm premoves is on its way to the server.
  const [confirmingPremoves, setConfirmingPremoves] = useState(false);
  const confirmingPremovesRef = useRef(false);
  // A save with confirmations off is running (conditional premoves spec, Sending it).
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const now = useClock(store);
  const dto = store.dto.value;
  const gameId = dto.id;
  const isPlayer = dto.viewerRole === 'white' || dto.viewerRole === 'black';
  const premovePath = `/api/games/${gameId}/premoves`;
  const strip = useStrip(dto, props.hop ?? false);

  // Read at each use, so a setting changed mid-game applies from the next move.
  const confirmsNow = (): boolean =>
    needsConfirmation(prefs.value.moveConfirmations, store.dto.value);
  const opponentName = (): string => {
    const current = store.dto.value;
    return current[current.viewerRole === 'black' ? 'white' : 'black'].name;
  };
  const syncLocked = (): void => {
    const kind = moveRef.current.kind;
    store.locked.value = kind === 'sending' || kind === 'retry' || confirmingPremovesRef.current;
  };

  const notify = useCallback(
    (notice: Notice) => {
      if (notice === 'opponent_moved' || notice === 'draw_offered') tg.haptic('light');
      if (notice === 'draw_declined') toast(t('app.game.draw_declined'));
      if (notice === 'finished') tg.hapticNotify('success');
      if (notice === 'premove_played') tg.haptic('light');
      if (notice === 'premoves_cancelled') {
        toast(t('app.game.premoves_cancelled'));
        tg.hapticNotify('warning');
      }
      if (notice === 'premove_draft_discarded')
        toast(t('app.game.premove_draft_discarded', { name: opponentName() }));
    },
    [tg, store],
  );
  // applyState is defined before dispatch; it reaches the machine through this ref.
  const dispatchRef = useRef<(event: MoveEvent) => void>(() => undefined);
  const applyState = useCallback(
    (next: GameDto) => {
      const previous = store.dto.value;
      noteServerTime(next.serverTime);
      // Unconfirmed premove changes that a new ply or a game end throws away; never a draft that
      // is on its way to the server with a move or with Confirm premoves.
      const discardedDraft =
        needsConfirmation(prefs.value.moveConfirmations, previous) &&
        store.premoveDraftChanged.value &&
        !store.locked.value;
      // A draft with nothing unsaved in it follows a tree changed on another device.
      const draft = store.draftTree.value;
      const followServer =
        draft !== null &&
        !savingRef.current &&
        !confirmingPremovesRef.current &&
        sendable(draft) === previous.premoveTree;
      if (!store.apply(next)) return;
      const samePly = next.plyCount === previous.plyCount && next.status === previous.status;
      if (samePly && followServer && next.premoveTree !== previous.premoveTree) {
        store.dropDraftTree();
      }
      noteTurnChange(previous, next);
      for (const notice of diffNotices(previous, next, { discardedDraft })) notify(notice);
      // Spec §6.3: a check buzzes, whichever side gave it.
      if (next.plyCount > previous.plyCount && positionAt(next, next.plyCount).check)
        tg.hapticNotify('warning');
      // A move waiting for Confirm move is void once the game has moved on (the server would
      // reject its expectedPly anyway): take it off the board and the buttons.
      if (moveRef.current.kind === 'pendingConfirm' && !samePly)
        dispatchRef.current({ type: 'cancel' });
    },
    [store, notify, tg],
  );

  // Live updates for running games (spec §6.4); finished games are static.
  useEffect(() => {
    if (dto.status !== 'active') return;
    const stream = new GameStream({
      url: client.url(`/api/games/${gameId}/events`, { token: client.token ?? '' }),
      refresh: () => client.get(`/api/games/${gameId}`, GameDtoSchema),
      onState: applyState,
      onFailure: () =>
        void client
          .post('/api/telemetry', { events: [{ kind: 'sse_failed' }] })
          .catch(() => undefined),
    });
    stream.start();
    return () => stream.stop();
  }, [client, gameId, dto.status, applyState]);

  const restore = useCallback(() => {
    adapterRef.current?.cancelMove();
    adapterRef.current?.setPosition({
      ...store.boardView.value,
      orientation: store.orientation.value,
      turnColour: store.boardTurn.value,
    });
  }, [store]);

  /**
   * A refused premove request, which always carried changes the player confirmed or completed:
   * reload, and say why they are gone when another device changed the tree or the opponent moved.
   */
  const reloadAfterRefusal = async (error: unknown, expectedPly: number): Promise<void> => {
    try {
      const fresh = await props.onReload();
      applyState(fresh);
      // A finished game has its result screen to explain it.
      if (fresh.status !== 'active') return;
      // The server keeps why it refused to itself; an unchanged ply means the tree changed under us.
      if (fresh.plyCount !== expectedPly)
        toast(t('app.game.premove_draft_discarded', { name: opponentName() }));
      else if (error instanceof ApiError && error.code === 'stale_state')
        toast(t('app.game.premoves_changed'));
    } catch {
      // The stream brings the state back when the connection does.
    }
  };

  // Confirmations off (conditional premoves spec, Sending it): every completed change saves at
  // once, one save at a time. Each save names the tree its draft builds on (the last tree the
  // server confirmed for it), so another device's tree is refused, never overwritten. A change
  // made while a save runs is saved as soon as that one settles; one made on a draft that started
  // over meanwhile (the opponent moved) is sent against its own base, at its own ply.
  const wantedTreeRef = useRef<{ tree: readonly DraftNode[]; draft: number } | null>(null);
  const saveTree = async (tree: readonly DraftNode[]): Promise<void> => {
    const started = store.draftBase.value;
    if (!started) return;
    wantedTreeRef.current = { tree, draft: started.draft };
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      for (let wanted = wantedTreeRef.current; wanted; wanted = wantedTreeRef.current) {
        const base = store.draftBase.value;
        // The draft this change was made in is gone (a new ply, a refusal): nothing to save.
        if (!base || base.draft !== wanted.draft) break;
        const text = sendable(wanted.tree);
        if (text === base.tree) break;
        if (text === null) {
          // Kept on screen, never sent (spec, The tree).
          toast(t('app.game.premove_too_big'));
          break;
        }
        const body: PremoveTreeRequest = {
          baseHash: await fingerprint(base.tree),
          tree: text,
          expectedPly: base.ply,
        };
        let saved: GameDto;
        try {
          saved = await client.put(premovePath, body, GameDtoSchema);
        } catch (error) {
          // The draft started over while this save ran: a newer change goes on its own base.
          if (store.draftBase.value?.draft !== base.draft) continue;
          if (error instanceof ApiError && error.status === 413) {
            toast(t('app.game.premove_too_big'));
            break;
          }
          store.dropDraftTree();
          restore();
          if (error instanceof ApiError && error.isNetwork) toast(t('app.common.offline'));
          else await reloadAfterRefusal(error, base.ply);
          break;
        }
        if (store.draftBase.value?.draft === base.draft)
          store.draftBase.value = { ...base, tree: saved.premoveTree };
        applyState(saved);
        tg.haptic('light');
      }
    } finally {
      wantedTreeRef.current = null;
      savingRef.current = false;
      setSaving(false);
    }
  };
  /** A completed change: saved at once with confirmations off, held for Confirm otherwise. */
  const completed = (): void => {
    if (!confirmsNow()) void saveTree(store.tree.value);
  };
  const edit = (tree: DraftNode[], path: string[]): void => store.editDraft(tree, path);

  // The effect runner closes over this render's props and callbacks; `dispatch` stays stable and
  // always calls the latest one.
  const runEffectRef = useRef<(effect: MoveEffect) => void>(() => undefined);
  const dispatch = useCallback(
    (event: MoveEvent) => {
      const confirm = needsConfirmation(prefs.value.moveConfirmations, store.dto.value);
      const before = moveRef.current;
      const { state, effects } = reduceMove(before, event, { confirm });
      moveRef.current = state;
      setMoveState(state);
      batch(() => {
        store.moveBusy.value = state.kind !== 'idle';
        syncLocked();
        if (state.kind === 'pendingConfirm') {
          // The machine's waiting move is the draft's: the tree is built on top of it.
          if (store.waiting.value?.uci !== state.move.uci) {
            store.setWaiting({
              uci: state.move.uci,
              san: sanOf(store.dto.value.fen, state.move.uci),
            });
          }
        } else if (state.kind === 'idle' && before.kind !== 'idle') {
          // Cancelled, sent or refused: the draft goes with the move.
          store.resetDraft();
        }
      });
      if (state.kind === 'pendingConfirm') setConfirming(true);
      else if (state.kind === 'idle') setConfirming(false);
      for (const effect of effects) runEffectRef.current(effect);
    },
    [store],
  );
  dispatchRef.current = dispatch;

  const runEffect = (effect: MoveEffect): void => {
    switch (effect.type) {
      case 'send': {
        void client
          .post(`/api/games/${gameId}/moves`, effect.move, GameDtoSchema)
          .then((next) => {
            applyState(next);
            dispatch({ type: 'sent' });
            tg.haptic('light');
          })
          .catch((error: unknown) => {
            if (error instanceof ApiError && error.isNetwork)
              dispatch({ type: 'networkError', now: Date.now() });
            else if (error instanceof ApiError && error.status === 413) {
              // The tree made the request too big: the move waits again, with its draft.
              toast(t('app.game.premove_too_big'));
              dispatch({ type: 'tooBig' });
            } else dispatch({ type: 'rejected' });
          });
        return;
      }
      case 'restore':
        restore();
        return;
      case 'reload':
        void props
          .onReload()
          .then(applyState)
          .catch(() => undefined);
        return;
      case 'telemetryRetry':
        void client
          .post('/api/telemetry', { events: [{ kind: 'move_retry' }] })
          .catch(() => undefined);
        return;
    }
  };

  runEffectRef.current = runEffect;

  /** Confirm move: the move and the tree built on it, in one request. */
  const confirmMove = (): void => {
    if (moveRef.current.kind !== 'pendingConfirm') return;
    const text = sendable(store.tree.value);
    if (text === null) {
      toast(t('app.game.premove_too_big'));
      return;
    }
    dispatch({ type: 'confirm', premoveTree: text });
  };
  /** Confirm premoves (the opponent's turn): the draft replaces the tree it was started on. */
  const confirmPremoves = async (): Promise<void> => {
    if (confirmingPremovesRef.current || moveRef.current.kind !== 'idle') return;
    if (!store.premoveDraftChanged.value) return;
    const text = sendable(store.tree.value);
    if (text === null) {
      toast(t('app.game.premove_too_big'));
      return;
    }
    const base = store.draftBase.value?.tree ?? store.dto.value.premoveTree;
    const expectedPly = store.dto.value.plyCount;
    confirmingPremovesRef.current = true;
    setConfirmingPremoves(true);
    syncLocked();
    try {
      const body: PremoveTreeRequest = {
        baseHash: await fingerprint(base),
        tree: text,
        expectedPly,
      };
      const saved = await client.put(premovePath, body, GameDtoSchema);
      applyState(saved);
      // Confirmed: the server's tree is the draft now, less any opponent move left unanswered.
      if (store.dto.value.plyCount === expectedPly) store.dropDraftTree();
      tg.haptic('light');
    } catch (error) {
      if (error instanceof ApiError && error.status === 413) toast(t('app.game.premove_too_big'));
      else if (error instanceof ApiError && error.isNetwork) toast(t('app.common.offline'));
      else {
        store.resetDraft();
        restore();
        await reloadAfterRefusal(error, expectedPly);
      }
    } finally {
      confirmingPremovesRef.current = false;
      setConfirmingPremoves(false);
      syncLocked();
    }
  };
  /** Cancel on the opponent's turn: the premove changes since the last save go. */
  const cancelDraft = (): void => {
    store.resetDraft();
    restore();
  };
  // Telegram's buttons keep their handlers between renders; they call the latest of these.
  const actionsRef = useRef({ confirmMove, confirmPremoves, cancelDraft });
  actionsRef.current = { confirmMove, confirmPremoves, cancelDraft };

  // Retry timer: wake the machine when the backoff elapses.
  useEffect(() => {
    if (moveState.kind !== 'retry') return;
    const timer = setTimeout(
      () => dispatch({ type: 'tick', now: Date.now() }),
      Math.max(0, moveState.nextAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [moveState, dispatch]);

  // A send that outlasts SLOW_SEND_MS veils the board until the move settles, retries included.
  useEffect(() => {
    if (moveState.kind === 'idle') {
      setSlowSend(false);
      return;
    }
    if (moveState.kind !== 'sending' || slowSend) return;
    const timer = setTimeout(() => setSlowSend(true), SLOW_SEND_MS);
    return () => clearTimeout(timer);
  }, [moveState.kind, slowSend]);

  // The bottom bar (conditional premoves spec, Sending it: confirmations on): Confirm move with the
  // premoves on top of it, or Confirm premoves on the opponent's turn, each beside Cancel.
  const confirmOn = needsConfirmation(prefs.value.moveConfirmations, dto);
  const premoveDraftOpen =
    confirmOn && moveState.kind === 'idle' && store.premoveDraftChanged.value;
  const pairs = moveState.kind === 'pendingConfirm' ? countPremovePairs(store.tree.value) : 0;
  const confirmLabel =
    moveState.kind === 'pendingConfirm' ? confirmMoveLabel(pairs) : t('app.game.confirm_premoves');
  const onConfirm = (): void => {
    if (moveRef.current.kind === 'pendingConfirm') actionsRef.current.confirmMove();
    else void actionsRef.current.confirmPremoves();
  };
  const onCancel = (): void => {
    if (moveRef.current.kind === 'pendingConfirm') dispatch({ type: 'cancel' });
    else actionsRef.current.cancelDraft();
  };
  // A send that needed no confirmation shows no bar: the main button resizes the viewport, and
  // the board with it, so flashing it on every move makes the page jump. After a Confirm the bar
  // is already up, so it stays, with a spinner, until the request settles.
  useEffect(() => {
    const ask = moveState.kind === 'pendingConfirm' || (premoveDraftOpen && !confirmingPremoves);
    if (ask) {
      const main = tg.setMainButton({ text: confirmLabel, onClick: onConfirm });
      const secondary = tg.setSecondaryButton({ text: t('app.game.cancel'), onClick: onCancel });
      setInPage({ confirm: !main, cancel: !secondary });
      return;
    }
    tg.setSecondaryButton(null);
    setInPage(NO_IN_PAGE);
    if (moveState.kind === 'retry') {
      tg.setMainButton({
        text: t('app.game.retry'),
        onClick: () => dispatch({ type: 'retryNow' }),
      });
      return;
    }
    const sendingConfirmed = (moveState.kind === 'sending' && confirming) || confirmingPremoves;
    tg.setMainButton(
      sendingConfirmed
        ? { text: t('app.game.sending'), onClick: () => undefined, progress: true }
        : null,
    );
  }, [
    moveState.kind,
    confirming,
    confirmingPremoves,
    premoveDraftOpen,
    confirmLabel,
    tg,
    dispatch,
  ]);
  // Telegram's bar takes about the space the tab bar frees, so the board keeps its size while a
  // draft is open; and no tab tap can leave it unsent (move confirmations spec).
  const hideTabs = confirming || confirmingPremoves || (confirmOn && store.draftDirty.value);
  useEffect(() => {
    router.suppressTabs.value = hideTabs;
  }, [router, hideTabs]);
  // An unconfirmed draft (the waiting move alone counts) is asked about before any way out of the
  // game, and Telegram asks before closing the app. With confirmations off there is never a draft
  // to lose. Both are put back when the draft goes or the screen does.
  // Not once Confirm was tapped: the request is on its way (or retrying) and leaving does not
  // withdraw it, so there is nothing left to lose.
  const confirmedAway =
    ((moveState.kind === 'sending' || moveState.kind === 'retry') && confirming) ||
    confirmingPremoves;
  const guarded = confirmOn && store.draftDirty.value && !confirmedAway;
  useEffect(() => {
    if (!guarded) return undefined;
    router.leaveGuard = () => {
      const moveWaiting = store.waiting.value !== null;
      const premoves = store.premoveDraftChanged.value;
      const message = moveWaiting
        ? premoves
          ? t('app.game.leave_move_premoves')
          : t('app.game.leave_move')
        : t('app.game.leave_premoves');
      return confirmDialog(message, {
        title: t('app.game.leave_title'),
        confirmLabel: t('app.game.leave'),
        cancelLabel: t('app.game.stay'),
        danger: true,
      });
    };
    tg.setClosingConfirmation(true);
    return () => {
      router.leaveGuard = null;
      tg.setClosingConfirmation(false);
    };
  }, [guarded, router, tg, store]);
  // Leaving the screen (a tab, Back, Telegram's Settings item, another game) discards the draft
  // with the component; this puts Telegram's buttons and the tab bar back. Minimising keeps it.
  useEffect(
    () => () => {
      tg.setMainButton(null);
      tg.setSecondaryButton(null);
      router.suppressTabs.value = false;
    },
    [tg, router],
  );

  /** Where a drop lands; a promotion pick made anywhere else no longer applies. */
  const dropContext = (): string =>
    [
      store.dto.value.plyCount,
      store.dto.value.status,
      store.building.value,
      store.viewingPly.value,
      store.waiting.value?.uci,
      store.selected.value.join(','),
    ].join('|');

  /** Replace a reply in the tree (spec, Building it): previewed, then asked. */
  const replaceInTree = async (
    path: readonly string[],
    uci: string,
    result: PlayResult,
  ): Promise<void> => {
    const replaced = result.replaced!;
    const snapshot = store.snapshotDraft();
    const ply = store.dto.value.plyCount;
    const fen = fenAt(store.rootFen.value, path);
    const message = replaceReplyMessage(fen, replaced.old, uci, replaced.dropped);
    edit(result.tree, result.path);
    const yes = await confirmDialog(message, {
      confirmLabel: t('app.game.premove_replace'),
      danger: true,
    });
    // The game moved on, or the draft went, while the popup was open: nothing left to answer.
    if (store.dto.value.plyCount !== ply || store.draftTree.value !== result.tree) return;
    if (store.locked.value) {
      // The draft was sent as it stood before this change; it cannot take the change any more.
      store.restoreDraft(snapshot);
      restore();
      return;
    }
    if (!yes) {
      store.restoreDraft(snapshot);
      restore();
      return;
    }
    tg.haptic('light');
    completed();
  };

  /** Replace the waiting move from the position before it (spec, Building it). */
  const replaceWaiting = async (uci: string): Promise<void> => {
    const waiting = store.waiting.value;
    if (!waiting || moveRef.current.kind !== 'pendingConfirm') {
      restore();
      return;
    }
    if (uci === waiting.uci) {
      // The same move again just goes back to it.
      batch(() => {
        store.viewingPly.value = null;
        store.selected.value = [];
      });
      return;
    }
    const fen = store.dto.value.fen;
    const next = { uci, san: sanOf(fen, uci) };
    const premoves = countPremovePairs(store.tree.value);
    if (premoves === 0) {
      store.setWaiting(next);
      dispatch({ type: 'replace', uci });
      return;
    }
    const snapshot = store.snapshotDraft();
    const ply = store.dto.value.plyCount;
    const message = replaceWaitingMessage(fen, waiting, uci, premoves);
    store.setWaiting(next);
    const yes = await confirmDialog(message, {
      confirmLabel: t('app.game.premove_replace'),
      danger: true,
    });
    if (
      store.dto.value.plyCount !== ply ||
      moveRef.current.kind !== 'pendingConfirm' ||
      store.waiting.value !== next
    )
      return;
    if (!yes) {
      store.restoreDraft(snapshot);
      restore();
      return;
    }
    dispatch({ type: 'replace', uci });
  };

  /** A move on the premove board: the opponent's or the player's, at the selected position. */
  const playInTree = (uci: string): void => {
    const path = store.selected.value;
    let result: PlayResult;
    try {
      result = playAt(store.tree.value, path, uci);
    } catch {
      restore();
      return;
    }
    if (result.kind === 'navigate') {
      store.selected.value = result.path;
      return;
    }
    if (result.kind === 'replace') {
      void replaceInTree(path, uci, result);
      return;
    }
    edit(result.tree, result.path);
    tg.haptic('light');
    if (result.kind === 'reply') completed();
  };

  const play = (uci: string): void => {
    if (!store.building.value) {
      dispatch({ type: 'drop', uci, expectedPly: store.dto.value.plyCount });
      return;
    }
    // The only earlier position that takes a move is the one before the waiting move.
    if (store.viewingPly.value !== null) void replaceWaiting(uci);
    else playInTree(uci);
  };

  const onDrop = (orig: string, dest: string, meta: { captured: boolean }): void => {
    pickedRef.current = null;
    const kind = moveRef.current.kind;
    const view = store.buildView.value;
    if (kind === 'sending' || kind === 'retry' || !view.canMove) {
      restore();
      return;
    }
    if (!store.building.value) tg.haptic(meta.captured ? 'medium' : 'light');
    if (isPromotion(view.position.fen, orig, dest)) {
      setPromotion({ orig, dest, colour: view.turn, at: dropContext(), tree: store.tree.value });
      return;
    }
    play(`${orig}${dest}`);
  };
  const promote = (piece: PromotionPiece | null): void => {
    const pending = promotion;
    setPromotion(null);
    if (!pending) return;
    // The picker opened for the position it was dropped on; a state from the stream (a reply, a
    // tree from another device) can change it before the piece is picked. Playing now would add a
    // move the player never chose it for (fix round 1), so treat it like Cancel instead.
    if (!piece || pending.at !== dropContext() || !sameTree(pending.tree, store.tree.value)) {
      restore();
      return;
    }
    play(`${pending.orig}${pending.dest}${piece}`);
  };
  // The player's own piece last tapped. Chessground reports every tapped square, the target of a
  // click-click move included, before the move itself: a tap on an opponent piece that the picked
  // piece can take is a capture, not a premove.
  const pickedRef = useRef<string | null>(null);
  /** A tap on the board: back from an earlier position, or a nudge to move first. */
  const onSelect = (square: string): void => {
    const current = store.dto.value;
    const picked = pickedRef.current;
    pickedRef.current = null;
    if (store.viewingPly.value !== null && !store.buildView.value.canMove) {
      store.viewPly(null);
      tg.hapticSelection();
      return;
    }
    const viewer = current.viewerRole;
    if (viewer !== 'white' && viewer !== 'black') return;
    if (store.building.value || !store.canMove.value || moveRef.current.kind !== 'idle') return;
    const owner = colourAt(current.fen, square);
    if (owner === viewer) {
      // A second tap on the same piece puts it down again.
      pickedRef.current = picked === square ? null : square;
      return;
    }
    const capture = picked !== null && (store.dests.value.get(picked) ?? []).includes(square);
    if (owner !== null && !capture)
      toast(t('app.game.premove_own_first', { name: opponentName() }));
  };
  /** Shows a move of the tree, or its root. */
  const selectPath = (path: string[]): void => {
    if (store.viewingPly.value === null && samePath(path, store.selected.value)) return;
    batch(() => {
      store.viewingPly.value = null;
      store.selected.value = path;
    });
    tg.hapticSelection();
  };
  /** ✕ on the selected premove (spec, Building it): asks, then removes it and what follows. */
  const removeSelected = async (): Promise<void> => {
    const path = store.selected.value;
    // A draft on its way to the server is what it sends; removing from it now would change nothing.
    if (path.length === 0 || store.viewingPly.value !== null || store.locked.value) return;
    const tree = store.tree.value;
    const ply = store.dto.value.plyCount;
    let label: string;
    let after: number;
    try {
      label = moveLabel(fenAt(store.rootFen.value, path.slice(0, -1)), path[path.length - 1]!);
      after = removeAt(tree, path).removedMoves;
    } catch {
      return;
    }
    const message = removeMessage(label, after);
    if (
      !(await confirmDialog(message, { confirmLabel: t('app.game.premove_remove'), danger: true }))
    )
      return;
    // The tree can fire or change on another device while the popup is open; the move asked
    // about may then be gone or mean something else, so the answer no longer applies.
    if (
      store.dto.value.plyCount !== ply ||
      store.locked.value ||
      !sameTree(store.tree.value, tree) ||
      !samePath(store.selected.value, path)
    )
      return;
    const removed = removeAt(tree, path);
    edit(removed.tree, removed.path);
    toast(removedMessage(label, after));
    completed();
  };

  const action = async (path: string, body: unknown = {}): Promise<void> => {
    try {
      applyState(await client.post(`/api/games/${gameId}/${path}`, body, GameDtoSchema));
    } catch (error) {
      if (error instanceof ApiError && error.isNetwork) toast(t('app.common.offline'));
      else
        void props
          .onReload()
          .then(applyState)
          .catch(() => undefined);
    }
  };
  const share = async (): Promise<void> => {
    try {
      await client.post(`/api/games/${gameId}/share`, { ply: store.position.value.ply });
      toast(t('app.game.shared', { group: dto.group.title }));
    } catch (error) {
      toast(
        error instanceof ApiError && error.code === 'rate_limited'
          ? t('app.game.share_limit')
          : t('app.common.error'),
      );
    }
  };
  const resign = async (): Promise<void> => {
    if (
      await confirmDialog(t('app.game.resign_confirm'), {
        confirmLabel: t('app.game.resign'),
        danger: true,
      })
    )
      await action('resign');
  };
  const offerDraw = async (): Promise<void> => {
    if (
      await confirmDialog(t('app.game.offer_draw_confirm'), {
        confirmLabel: t('app.game.offer_draw'),
      })
    )
      await action('draw/offer');
  };
  const abort = async (): Promise<void> => {
    if (
      await confirmDialog(t('app.game.abort_confirm'), {
        confirmLabel: t('app.game.abort'),
        danger: true,
      })
    )
      await action('abort');
  };
  const rematch = async (): Promise<void> => {
    try {
      if (dto.engineLevel !== null) {
        const body: EngineGameRequest = { level: dto.engineLevel, colour: 'random' };
        const next = await client.post(
          `/api/groups/${dto.group.id}/engine-games`,
          body,
          GameDtoSchema,
        );
        // In place like a hop: the switcher strip keeps its order and takes the new game on.
        router.replace({ name: 'game', gameId: next.id, hop: true });
        return;
      }
      await client.post(`/api/games/${gameId}/rematch`, {});
      toast(t('app.game.rematch_sent'));
      router.replace({ name: 'lobby', groupId: dto.group.id });
    } catch {
      toast(t('app.common.error'));
    }
  };
  const analyse = (): void => {
    const url = dto.lichessUrl ?? dto.analysisUrl;
    if (url) tg.openLink(url);
  };
  // The download goes to Telegram's downloader or the system browser, so it carries a short-lived
  // link token from the server, never the session token (spec §9).
  const pgn = async (): Promise<void> => {
    try {
      const link = await client.post(`/api/games/${gameId}/pgn-link`, {}, PgnLinkDtoSchema);
      const url = new URL(client.url(link.url), window.location.origin).toString();
      if (!tg.downloadFile(url, `${gameId}.pgn`)) tg.openLink(url);
    } catch {
      toast(t('app.common.error'));
    }
  };

  const orientation = store.orientation.value;
  const top: Colour = orientation === 'white' ? 'black' : 'white';
  const offer = dto.drawOffer;
  const myColour = isPlayer ? (dto.viewerRole as Colour) : null;
  const canOffer = isPlayer && dto.status === 'active' && !offer;
  const offerFromOpponent = isPlayer && offer !== null && offer.by !== myColour;
  const claimable =
    isPlayer && dto.status === 'active' && (dto.claims.threefold || dto.claims.fiftyMove);
  const busy = moveState.kind !== 'idle';
  const playing = isPlayer && dto.status === 'active';
  const finished = dto.status === 'finished';
  // Draw waits for the second move, when the last slot turns from Abort to Resign, and the bot
  // never takes one (spec §8).
  const early = dto.plyCount < 2;
  const drawOpen = canOffer && !early && dto.engineLevel === null;
  // Unconfirmed changes: with confirmations on, the waiting move, premove edits and an opponent
  // move still waiting for its reply; with them off, only a change that has not saved.
  const draftShown = confirmOn
    ? store.draftDirty.value || hasOpenMove(store.draftTree.value ?? [])
    : store.premoveDraftChanged.value && !saving;
  // The ✕ is gone while the draft is on its way to the server: it is sent as it stands.
  const removable = !store.locked.value;
  const askOpen = moveState.kind === 'pendingConfirm' || (premoveDraftOpen && !confirmingPremoves);
  const moveButtons = askOpen && (inPage.confirm || inPage.cancel);
  const waiting = store.waiting.value;
  const linesRoot = waiting
    ? { label: moveLabel(dto.fen, waiting.uci), caption: t('app.game.lines_your_move') }
    : { label: t('app.game.lines_now'), caption: t('app.game.lines_now_caption') };

  // Material counts real moves up to the shown ply: never a pending move or a shown premove.
  const shownFen = store.position.value.fen;
  const { end, at } = store.timeline.value;
  const view = (index: number): void => {
    if (store.viewTimeline(index)) tg.hapticSelection();
  };
  // The fill runs green to the real position, then blue through a shown premove (see styles.css).
  const percent = (index: number): string => `${end ? +((index / end) * 100).toFixed(3) : 0}%`;

  return (
    <div
      class={
        strip
          ? stripMinimized.value
            ? 'game with-switcher switcher-minimized'
            : 'game with-switcher'
          : 'game'
      }
    >
      <div class="game-meta">
        {t('app.game.meta', {
          group: dto.group.title,
          terms: termsLabel(dto.timePerMove, dto.rated),
        })}
      </div>
      <PlayerBar dto={dto} colour={top} fen={shownFen} now={now} />
      <Board
        store={store}
        onMove={onDrop}
        onReady={(adapter) => (adapterRef.current = adapter)}
        onSelect={onSelect}
      >
        {slowSend || moveState.kind === 'retry' ? (
          <div class="board-veil" role="status" aria-label={t('app.game.sending')}>
            <span class="spinner" />
          </div>
        ) : null}
        {promotion ? (
          <div
            class="promotion"
            style={promotionOverlayStyle(promotion.dest, orientation)}
            role="dialog"
            aria-label={t('app.game.promotion')}
          >
            {promotionPieces().map((piece) => (
              <button
                key={piece}
                data-promote={piece}
                class={`cg-wrap ${PIECE_CLASS[piece]} ${promotion.colour}`}
                aria-label={t(PIECE_LABEL[piece])}
                onClick={() => promote(piece)}
              >
                {h('piece', {
                  class: `${PIECE_CLASS[piece]} ${promotion.colour}`,
                })}
              </button>
            ))}
            <button
              data-promote="cancel"
              aria-label={t('app.game.cancel')}
              onClick={() => promote(null)}
            >
              ✕
            </button>
          </div>
        ) : null}
      </Board>
      <PlayerBar dto={dto} colour={orientation} fen={shownFen} now={now} />
      <MoveList store={store} onRemove={removable ? () => void removeSelected() : undefined} />
      {/* One slider in every game: the real moves, the waiting move, then the premove line viewed. */}
      <div class="replay-controls">
        <button
          class="pill-btn"
          data-action="prev"
          disabled={end === 0}
          onClick={() => view(at - 1)}
        >
          ◀
        </button>
        <input
          type="range"
          class={at > dto.plyCount ? 'premove' : undefined}
          min={0}
          max={end}
          value={at}
          disabled={end === 0}
          style={{ '--real': percent(Math.min(at, dto.plyCount)), '--at': percent(at) }}
          onInput={(event) => view(Number(event.currentTarget.value))}
        />
        <button
          class="pill-btn"
          data-action="next"
          disabled={end === 0}
          onClick={() => view(at + 1)}
        >
          ▶
        </button>
      </div>
      <PremoveStatus store={store} draft={draftShown} />
      {playing && store.building.value ? (
        <LinesPanel
          tree={store.tree.value}
          rootFen={store.rootFen.value}
          owner={myColour!}
          root={linesRoot}
          selected={store.selected.value}
          onSelect={selectPath}
          onRemove={removable ? () => void removeSelected() : undefined}
        />
      ) : null}
      {offerFromOpponent && dto.status === 'active' ? (
        <div class="banner">
          <span class="grow">{t('app.game.draw_offer_from', { name: dto[offer!.by].name })}</span>
          <button
            class="pill-btn primary"
            data-action="accept-draw"
            onClick={() => void action('draw/accept')}
          >
            {t('button.accept')}
          </button>
          <button
            class="pill-btn"
            data-action="decline-draw"
            onClick={() => void action('draw/decline')}
          >
            {t('button.decline')}
          </button>
        </div>
      ) : null}
      {isPlayer && offer && offer.by === myColour && dto.status === 'active' ? (
        <div class="banner soft">{t('app.game.draw_offered')}</div>
      ) : null}
      {moveButtons || claimable ? (
        <div class="toolbar">
          {askOpen && inPage.confirm ? (
            <button class="pill-btn primary" data-action="confirm-move" onClick={onConfirm}>
              {confirmLabel}
            </button>
          ) : null}
          {askOpen && inPage.cancel ? (
            <button class="pill-btn" data-action="cancel-move" onClick={onCancel}>
              {t('app.game.cancel')}
            </button>
          ) : null}
          {claimable ? (
            <button
              class="pill-btn"
              data-action="claim-draw"
              disabled={busy}
              onClick={() => void action('draw/claim')}
            >
              {t('app.game.claim_draw')}
            </button>
          ) : null}
        </div>
      ) : null}
      {playing ? (
        // Four fixed slots, so the row never wraps or changes height: the Draw slot dims once an
        // offer is out, and the last one reads Abort until the second move, then Resign.
        <div class="icon-bar">
          <button class="bar-btn" data-action="share" onClick={() => void share()}>
            <ShareIcon />
            {t('app.game.share_to_group')}
          </button>
          <button class="bar-btn" data-action="flip" onClick={() => store.flip()}>
            <FlipIcon />
            {t('app.game.flip')}
          </button>
          <button
            class="bar-btn"
            data-action="offer-draw"
            disabled={busy || !drawOpen}
            onClick={() => void offerDraw()}
          >
            <span class="icon-glyph" aria-hidden="true">
              ½
            </span>
            {offer?.by === myColour ? t('app.game.draw_sent') : t('app.game.draw')}
          </button>
          {early ? (
            <button
              class="bar-btn danger"
              data-action="abort"
              disabled={busy}
              onClick={() => void abort()}
            >
              <FlagIcon />
              {t('app.game.abort')}
            </button>
          ) : (
            <button
              class="bar-btn danger"
              data-action="resign"
              disabled={busy}
              onClick={() => void resign()}
            >
              <FlagIcon />
              {t('app.game.resign')}
            </button>
          )}
        </div>
      ) : finished ? (
        // The same four slots after the game, Share still first so it does not move.
        <div class="icon-bar">
          <button class="bar-btn" data-action="share" onClick={() => void share()}>
            <ShareIcon />
            {t('app.game.share_to_group')}
          </button>
          <button
            class="bar-btn"
            data-action="analyse"
            disabled={!dto.lichessUrl && !dto.analysisUrl}
            onClick={analyse}
          >
            <AnalyzeIcon />
            {t('app.game.analyze')}
          </button>
          <button class="bar-btn" data-action="pgn" onClick={() => void pgn()}>
            <DownloadIcon />
            {t('app.game.pgn')}
          </button>
          {isPlayer && !dto.voided ? (
            <button class="bar-btn accent" data-action="rematch" onClick={() => void rematch()}>
              <RematchIcon />
              {t('app.game.rematch')}
            </button>
          ) : null}
        </div>
      ) : (
        // A spectator of a live game has only these two, so they split the bar between them.
        <div class="icon-bar two">
          <button class="bar-btn" data-action="share" onClick={() => void share()}>
            <ShareIcon />
            {t('app.game.share_to_group')}
          </button>
          <button class="bar-btn" data-action="flip" onClick={() => store.flip()}>
            <FlipIcon />
            {t('app.game.flip')}
          </button>
        </div>
      )}
      {/* Docked just above the tab bar, where a thumb reaches it (game switcher spec). */}
      {strip ? <GameSwitcher games={strip} currentId={dto.id} live={dto} /> : null}
    </div>
  );
}

const ICON = {
  width: 22,
  height: 22,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': 2,
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round',
  'aria-hidden': 'true',
} as const;

function ShareIcon() {
  return (
    <svg {...ICON}>
      <path d="M12 3v12M7 8l5-5 5 5M5 13v7h14v-7" />
    </svg>
  );
}

function FlipIcon() {
  return (
    <svg {...ICON}>
      <path d="M7 20V4M3 8l4-4 4 4M17 4v16M13 16l4 4 4-4" />
    </svg>
  );
}

function AnalyzeIcon() {
  return (
    <svg {...ICON}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l5 5" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg {...ICON}>
      <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
    </svg>
  );
}

function RematchIcon() {
  return (
    <svg {...ICON}>
      <path d="M4 12a8 8 0 0 1 13.7-5.6L20 9M20 4v5h-5M20 12a8 8 0 0 1-13.7 5.6L4 15M4 20v-5h5" />
    </svg>
  );
}

function FlagIcon() {
  return (
    <svg {...ICON}>
      <path d="M5 21V4M5 4h11l-2 4 2 4H5" />
    </svg>
  );
}
