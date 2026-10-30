import {
  applyMove,
  GameDtoSchema,
  imaginedBoard,
  isPremovePromotion,
  PgnLinkDtoSchema,
  sideToMove,
  t,
  type Colour,
  type EngineGameRequest,
  type GameDto,
} from '@group-chess/shared';
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
import { sameList } from '../../state/premoves';
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
import { MoveList } from './MoveList';
import { PlayerBar } from './PlayerBar';
import { useClock } from './useClock';

/** A send answered within this shows nothing; a slower one greys the board under a spinner. */
const SLOW_SEND_MS = 1_000;
/** Telegram shows Confirm move and Cancel itself; the page draws neither. */
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

/**
 * Pushes the position after a move that just went to `pendingConfirm`, so the frozen board shows
 * what is being confirmed instead of chessground's own drop display: the picked promotion piece,
 * an en passant capture with the pawn removed, a check highlight. Pushes nothing when `uci` turns
 * out illegal (e.g. a malformed test fixture); the board stays as chessground left it.
 */
function pushPendingPosition(
  adapter: BoardAdapter | null,
  fen: string,
  uci: string,
  orientation: Colour,
): void {
  const result = applyMove(fen, [], uci);
  if (!result.legal) return;
  adapter?.setPosition({
    fen: result.fenAfter,
    lastMove: [uci.slice(0, 2), uci.slice(2, 4)],
    check: result.check,
    orientation,
    turnColour: sideToMove(result.fenAfter),
  });
}

export function GameView(props: { initial: GameDto; onReload: () => Promise<GameDto> }) {
  const { client, tg, router } = useApp();
  const store = useMemo(() => new GameStore(props.initial), [props.initial.id]);
  const adapterRef = useRef<BoardAdapter | null>(null);
  const moveRef = useRef<MoveState>({ kind: 'idle' });
  const [moveState, setMoveState] = useState<MoveState>({ kind: 'idle' });
  const [promotion, setPromotion] = useState<{
    orig: string;
    dest: string;
    premove: boolean;
    ply: number;
    /** The chain the piece was dropped onto; a different one by pick time voids the pick. */
    base: string[];
  } | null>(null);
  const [slowSend, setSlowSend] = useState(false);
  // True from a drop that waits for Confirm move until that move settles (sent, cancelled or
  // rejected): the bar stays up through the send, and the tab bar stays hidden (move confirmations spec).
  const [confirming, setConfirming] = useState(false);
  // Which of Confirm move and Cancel this client has no Telegram button for, so the page draws them.
  const [inPage, setInPage] = useState(NO_IN_PAGE);
  const now = useClock(store);
  const dto = store.dto.value;
  const gameId = dto.id;
  const isPlayer = dto.viewerRole === 'white' || dto.viewerRole === 'black';

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
    },
    [tg],
  );
  // applyState is defined before dispatch; it reaches the machine through this ref.
  const dispatchRef = useRef<(event: MoveEvent) => void>(() => undefined);
  const applyState = useCallback(
    (next: GameDto) => {
      const previous = store.dto.value;
      noteServerTime(next.serverTime);
      if (!store.apply(next)) return;
      noteTurnChange(previous, next);
      for (const notice of diffNotices(previous, next)) notify(notice);
      // Spec §6.3: a check buzzes, whichever side gave it.
      if (next.plyCount > previous.plyCount && positionAt(next, next.plyCount).check)
        tg.hapticNotify('warning');
      // A move waiting for Confirm move is void once the game has moved on (the server would
      // reject its expectedPly anyway): take it off the board and the buttons.
      if (
        moveRef.current.kind === 'pendingConfirm' &&
        (next.plyCount !== previous.plyCount || next.status !== previous.status)
      )
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

  // Premoves spec, Queuing: optimistic compare-and-set edits, saved one at a time. An edit made
  // while a save runs goes on screen at once and is saved as soon as that one settles.
  const wantedPremovesRef = useRef<string[] | null>(null);
  const editPremoves = async (next: string[], step: number | null): Promise<void> => {
    const previousStep = store.premoveStep.value;
    store.optimisticPremoves.value = next;
    store.premoveStep.value = step;
    wantedPremovesRef.current = next;
    if (store.premoveSending.value) return;
    // Every edit made from here until the loop ends builds on the chain the previous save
    // confirmed, so that is what each save compares against.
    let confirmed = store.dto.value.premoves;
    const expectedPly = store.dto.value.plyCount;
    store.premoveSending.value = true;
    try {
      while (wantedPremovesRef.current && !sameList(wantedPremovesRef.current, confirmed)) {
        const target = wantedPremovesRef.current;
        const body = { base: confirmed, premoves: target, expectedPly };
        const saved = await client.put(`/api/games/${gameId}/premoves`, body, GameDtoSchema);
        confirmed = saved.premoves;
        applyState(saved);
        tg.haptic('light');
      }
      wantedPremovesRef.current = null;
      store.optimisticPremoves.value = null;
    } catch (error) {
      wantedPremovesRef.current = null;
      store.optimisticPremoves.value = null;
      store.premoveStep.value = previousStep;
      restore();
      if (error instanceof ApiError && error.isNetwork) {
        toast(t('app.common.offline'));
        return;
      }
      try {
        const fresh = await props.onReload();
        applyState(fresh);
        // The server keeps why it refused to itself; an unchanged ply means the chain changed under us.
        if (
          error instanceof ApiError &&
          error.code === 'stale_state' &&
          fresh.status === 'active' &&
          fresh.plyCount === expectedPly
        )
          toast(t('app.game.premoves_changed'));
      } catch {
        // The stream brings the state back when the connection does.
      }
    } finally {
      store.premoveSending.value = false;
    }
  };

  // The effect runner closes over this render's props and callbacks; `dispatch` stays stable and
  // always calls the latest one.
  const runEffectRef = useRef<(effect: MoveEffect) => void>(() => undefined);
  const dispatch = useCallback(
    (event: MoveEvent) => {
      // Read at each drop, so a setting changed mid-game applies from the next move.
      const confirm = needsConfirmation(prefs.value.moveConfirmations, store.dto.value);
      const { state, effects } = reduceMove(moveRef.current, event, { confirm });
      moveRef.current = state;
      setMoveState(state);
      store.moveBusy.value = state.kind !== 'idle';
      if (state.kind === 'pendingConfirm') {
        setConfirming(true);
        pushPendingPosition(
          adapterRef.current,
          store.dto.value.fen,
          state.move.uci,
          store.orientation.value,
        );
      } else if (state.kind === 'idle') setConfirming(false);
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
            else dispatch({ type: 'rejected' });
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

  // Telegram buttons per machine state (spec §6.3, move confirmations spec). A send that needed
  // no confirmation shows none: the main button resizes the viewport, and the board with it, so
  // flashing it on every move makes the page jump. After Confirm move the bar is already up, so
  // it stays, with a spinner, until the move settles.
  useEffect(() => {
    switch (moveState.kind) {
      case 'pendingConfirm': {
        const main = tg.setMainButton({
          text: t('app.game.confirm_move'),
          onClick: () => dispatch({ type: 'confirm' }),
        });
        const secondary = tg.setSecondaryButton({
          text: t('app.game.cancel'),
          onClick: () => dispatch({ type: 'cancel' }),
        });
        setInPage({ confirm: !main, cancel: !secondary });
        return;
      }
      case 'sending':
        tg.setSecondaryButton(null);
        tg.setMainButton(
          confirming
            ? { text: t('app.game.sending'), onClick: () => undefined, progress: true }
            : null,
        );
        setInPage(NO_IN_PAGE);
        return;
      case 'retry':
        tg.setSecondaryButton(null);
        tg.setMainButton({
          text: t('app.game.retry'),
          onClick: () => dispatch({ type: 'retryNow' }),
        });
        setInPage(NO_IN_PAGE);
        return;
      case 'idle':
        tg.setMainButton(null);
        tg.setSecondaryButton(null);
        setInPage(NO_IN_PAGE);
        return;
    }
  }, [moveState.kind, confirming, tg, dispatch]);
  // Telegram's bar takes about the space the tab bar frees, so the board keeps its size while a
  // move waits; and no tab tap can leave the move unsent (move confirmations spec).
  useEffect(() => {
    router.suppressTabs.value = confirming;
  }, [router, confirming]);
  // Minimising (Telegram 8.0) is leaving too: a waiting move is dropped. Once sent, cancel is a no-op.
  useEffect(() => tg.onDeactivated(() => dispatch({ type: 'cancel' })), [tg, dispatch]);
  // Leaving the screen (a tab, Back, Telegram's Settings item, another game) discards a waiting
  // move with the component; this puts Telegram's buttons and the tab bar back.
  useEffect(
    () => () => {
      tg.setMainButton(null);
      tg.setSecondaryButton(null);
      router.suppressTabs.value = false;
    },
    [tg, router],
  );

  const onDrop = (orig: string, dest: string, meta: { captured: boolean }): void => {
    if (moveRef.current.kind !== 'idle') {
      restore();
      return;
    }
    if (store.premoveMode.value) {
      const board = imaginedBoard(
        store.dto.value.fen,
        store.premoves.value,
        store.dto.value.viewerRole as Colour,
      );
      if (isPremovePromotion(board, orig, dest)) {
        setPromotion({
          orig,
          dest,
          premove: true,
          ply: store.dto.value.plyCount,
          base: store.premoves.value,
        });
        return;
      }
      void editPremoves([...store.premoves.value, `${orig}${dest}`], null);
      return;
    }
    tg.haptic(meta.captured ? 'medium' : 'light');
    if (isPromotion(store.dto.value.fen, orig, dest)) {
      setPromotion({
        orig,
        dest,
        premove: false,
        ply: store.dto.value.plyCount,
        base: store.premoves.value,
      });
      return;
    }
    dispatch({ type: 'drop', uci: `${orig}${dest}`, expectedPly: store.dto.value.plyCount });
  };
  const promote = (piece: PromotionPiece | null): void => {
    const pending = promotion;
    setPromotion(null);
    if (!pending) return;
    if (!piece) {
      restore();
      return;
    }
    // The picker opened for the turn it was dropped on; a reply from the stream while it was open
    // can flip premove mode or advance the ply before the piece is picked. Sending now would land a
    // move the player never chose it for (fix round 1), so treat it like Cancel instead.
    if (pending.premove !== store.premoveMode.value || pending.ply !== store.dto.value.plyCount) {
      restore();
      return;
    }
    if (pending.premove) {
      // Likewise a chain changed by another device while the picker was open: the pawn was dropped
      // onto the old one, so appending to the new chain would queue a premove nobody chose.
      if (!sameList(store.premoves.value, pending.base)) {
        restore();
        return;
      }
      void editPremoves([...pending.base, `${pending.orig}${pending.dest}${piece}`], null);
      return;
    }
    dispatch({
      type: 'drop',
      uci: `${pending.orig}${pending.dest}${piece}`,
      expectedPly: store.dto.value.plyCount,
    });
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
  const removePremove = async (step: number): Promise<void> => {
    const chain = store.premoves.value;
    const ply = store.dto.value.plyCount;
    const after = chain.length - step;
    const message =
      after === 0
        ? t('app.game.premove_remove_confirm')
        : after === 1
          ? t('app.game.premove_remove_confirm_next')
          : t('app.game.premove_remove_confirm_rest', { n: after });
    if (
      !(await confirmDialog(message, { confirmLabel: t('app.game.premove_remove'), danger: true }))
    )
      return;
    // The chain can fire or change on another device while the popup is open; step k of that
    // chain is not the premove that was asked about, so the answer no longer applies.
    if (!sameList(store.premoves.value, chain) || store.dto.value.plyCount !== ply) return;
    await editPremoves(chain.slice(0, step - 1), step - 1);
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
        router.replace({ name: 'game', gameId: next.id });
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
  const moveButtons = moveState.kind === 'pendingConfirm' && (inPage.confirm || inPage.cancel);

  // Material counts real moves up to the shown ply: never a pending move or a shown premove.
  const shownFen = store.position.value.fen;
  const { end, at } = store.timeline.value;
  const view = (index: number): void => {
    if (store.viewTimeline(index)) tg.hapticSelection();
  };
  // The fill runs green to the real position, then blue through a shown premove (see styles.css).
  const percent = (index: number): string => `${end ? +((index / end) * 100).toFixed(3) : 0}%`;

  return (
    <div class="game">
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
        frozen={moveState.kind === 'pendingConfirm'}
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
                class={`cg-wrap ${PIECE_CLASS[piece]} ${dto.viewerRole === 'black' ? 'black' : 'white'}`}
                aria-label={t(PIECE_LABEL[piece])}
                onClick={() => promote(piece)}
              >
                {h('piece', {
                  class: `${PIECE_CLASS[piece]} ${dto.viewerRole === 'black' ? 'black' : 'white'}`,
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
      <MoveList
        store={store}
        locked={moveState.kind === 'pendingConfirm'}
        onRemove={() => void removePremove(store.shownStep.value)}
      />
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
          {moveState.kind === 'pendingConfirm' && inPage.confirm ? (
            <button
              class="pill-btn primary"
              data-action="confirm-move"
              onClick={() => dispatch({ type: 'confirm' })}
            >
              {t('app.game.confirm_move')}
            </button>
          ) : null}
          {moveState.kind === 'pendingConfirm' && inPage.cancel ? (
            <button
              class="pill-btn"
              data-action="cancel-move"
              onClick={() => dispatch({ type: 'cancel' })}
            >
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
