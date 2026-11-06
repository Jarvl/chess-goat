import {
  BotCardDtoSchema,
  ChallengeDtoSchema,
  GameDtoSchema,
  PlayersPickerDtoSchema,
  ratingLabel,
  t,
  TIME_PER_MOVE_OPTIONS,
  timeSpanLabel,
  type BotCardDto,
  type ChallengeRequest,
  type ColourChoice,
  type EngineGameRequest,
  type EngineLevel,
  type PlayersPickerDto,
  type TimePerMove,
} from '@chess-goat/shared';
import { h } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { ApiError } from '../../api/client';
import { serverNow } from '../../state/session';
import { Avatar, BotMark } from '../Avatar';
import { useApp } from '../context';
import { Switch, Tiles, type DataAttributes } from '../controls';
import { useMainButton, useResource } from '../hooks';
import { toast } from '../toast';
import { ErrorScreen, Loading } from './Status';

const TIME_VALUES: TimePerMove[] = [...TIME_PER_MOVE_OPTIONS, null];
/** A game against a bot needs a clock, so a group default of "No clock" becomes this. */
const BOT_FALLBACK_TIME: TimePerMove = 259200;
const BOT_IDLE_MS = 24 * 3_600_000;

/**
 * Exactly one opponent choice at a time. Replaces a pair of independently-settable
 * `opponentId`/`bot` fields, which let a human pick and a bot level coexist and left `submit`
 * choosing one of them arbitrarily.
 */
type Selection =
  | { kind: 'none' }
  | { kind: 'human'; id: string }
  | { kind: 'open' }
  | { kind: 'bot'; level: EngineLevel }
  | { kind: 'ownedBot'; bot: BotCardDto };

function OpponentRow(props: {
  on: boolean;
  avatar: preact.ComponentChildren;
  title: preact.ComponentChildren;
  /** A rating or level badge, kept fully visible while `title` alone ellipsises. */
  trailing?: preact.ComponentChildren;
  sub?: string;
  onPick: () => void;
  data: DataAttributes;
}) {
  const { tg } = useApp();
  return (
    <button
      type="button"
      class={props.on ? 'option-row on' : 'option-row'}
      aria-pressed={props.on ? 'true' : 'false'}
      onClick={() => {
        tg.hapticSelection();
        props.onPick();
      }}
      {...props.data}
    >
      {props.avatar}
      <span class="grow">
        <span class="name-row">
          <span class="name">{props.title}</span>
          {props.trailing ? <span class="rating">{props.trailing}</span> : null}
        </span>
        {props.sub ? <span class="secondary">{props.sub}</span> : null}
      </span>
      <span class={props.on ? 'radio on' : 'radio'} aria-hidden="true">
        {props.on ? '✓' : null}
      </span>
    </button>
  );
}

const king = (colour: 'white' | 'black') => h('piece', { class: `king ${colour}` });

/**
 * Loads the picker, then the form: the group's defaults come with the players, so the form is
 * right whether it was opened from the lobby, a player's page or a chat link.
 */
export function NewGame(props: { groupId: string; opponentId?: string }) {
  const { client } = useApp();
  const picker = useResource(`players:${props.groupId}`, () =>
    client.get(`/api/groups/${props.groupId}/players`, PlayersPickerDtoSchema),
  );
  if (picker.error) return <ErrorScreen onRetry={() => void picker.reload()} />;
  if (!picker.data) return <Loading />;
  return <NewGameForm groupId={props.groupId} opponentId={props.opponentId} picker={picker.data} />;
}

function NewGameForm(props: { groupId: string; opponentId?: string; picker: PlayersPickerDto }) {
  const { client, router, tg } = useApp();
  const { players, bot: botPicker, settings: defaults } = props.picker;
  // A player's page sends its player along; one who has since left the group is simply not picked.
  const [selection, setSelection] = useState<Selection>(() => {
    const picked = players.find((player) => player.id === props.opponentId);
    return picked ? { kind: 'human', id: picked.id } : { kind: 'none' };
  });
  const [botUnavailable, setBotUnavailable] = useState(false);
  const [timePerMove, setTimePerMove] = useState<TimePerMove>(defaults.defaultTimePerMove);
  const [colour, setColour] = useState<ColourChoice>('random');
  const [rated, setRated] = useState(defaults.ratedDefault);
  const [sending, setSending] = useState(false);

  // A bot opened from the bot browser or a link is not in the players list: look it up.
  const wantedBot =
    props.opponentId && !players.some((player) => player.id === props.opponentId)
      ? props.opponentId
      : null;
  useEffect(() => {
    if (!wantedBot) return;
    let live = true;
    client
      .get(`/api/groups/${props.groupId}/bots/${encodeURIComponent(wantedBot)}`, BotCardDtoSchema)
      .then((bot) => {
        if (live) setSelection((now) => (now.kind === 'none' ? { kind: 'ownedBot', bot } : now));
      })
      .catch((error: unknown) => {
        if (live && error instanceof ApiError && error.status === 404) setBotUnavailable(true);
      });
    return () => {
      live = false;
    };
  }, [client, props.groupId, wantedBot]);

  // A bot needs a clock; the stored choice is kept so that a human gets "No clock" back.
  const ownedBot = selection.kind === 'ownedBot' ? selection.bot : null;
  const botTime: TimePerMove = defaults.defaultTimePerMove ?? BOT_FALLBACK_TIME;
  const effectiveTime: TimePerMove = ownedBot && timePerMove === null ? botTime : timePerMove;
  const casualOnly = selection.kind === 'bot' || ownedBot?.isMine === true;
  const lastActive = ownedBot?.botActivity?.lastActiveAt;
  const idleBot =
    ownedBot !== null &&
    (!lastActive || serverNow().getTime() - new Date(lastActive).getTime() > BOT_IDLE_MS);

  const ready = selection.kind !== 'none' && !sending;
  const submit = useMemo(
    () => async () => {
      if (selection.kind === 'none') return;
      setSending(true);
      try {
        if (selection.kind === 'bot') {
          const body: EngineGameRequest = { level: selection.level, colour };
          const game = await client.post(
            `/api/groups/${props.groupId}/engine-games`,
            body,
            GameDtoSchema,
          );
          router.replace({ name: 'game', gameId: game.id });
        } else {
          const opponentId =
            selection.kind === 'open'
              ? null
              : selection.kind === 'ownedBot'
                ? selection.bot.id
                : selection.id;
          const body: ChallengeRequest = {
            opponentId,
            timePerMove: effectiveTime,
            colour,
            rated: casualOnly ? false : rated,
          };
          await client.post(`/api/groups/${props.groupId}/challenges`, body, ChallengeDtoSchema);
          toast(t('app.new.sent'));
          router.replace({ name: 'lobby', groupId: props.groupId });
        }
      } catch (error) {
        toast(
          error instanceof ApiError && error.code === 'network'
            ? t('app.common.offline')
            : t('app.common.error'),
        );
      } finally {
        setSending(false);
      }
    },
    [client, router, props.groupId, selection, effectiveTime, casualOnly, colour, rated],
  );
  // A half-filled form is not lost to a stray swipe (Bot API 6.2).
  useEffect(() => {
    tg.setClosingConfirmation(true);
    return () => tg.setClosingConfirmation(false);
  }, [tg]);
  const actionLabel = t(selection.kind === 'bot' ? 'app.new.start' : 'app.new.send');
  const inPage = useMainButton({
    text: actionLabel,
    onClick: () => void submit(),
    enabled: ready,
    progress: sending,
  });

  // The picker DTO guarantees at least one level whenever the bot is offered; narrowing on the
  // first entry carries that guarantee into the types, so no non-null assertion is needed here.
  const firstLevel = botPicker?.levels[0];

  return (
    <div class="screen">
      <h1 class="title">{t('app.new.title')}</h1>
      <div class="section">{t('app.new.opponent')}</div>
      <div class="card">
        {botPicker && firstLevel ? (
          <OpponentRow
            on={selection.kind === 'bot'}
            avatar={<BotMark size={38} />}
            title={t('app.new.bot')}
            sub={t('app.new.bot_sub')}
            onPick={() => setSelection({ kind: 'bot', level: firstLevel })}
            data={{ 'data-testid': 'opponent-bot' }}
          />
        ) : null}
        {ownedBot ? (
          <OpponentRow
            on
            avatar={<Avatar player={ownedBot} size={38} />}
            title={ownedBot.name}
            trailing={ratingLabel(ownedBot.rating, ownedBot.provisional)}
            onPick={() => setSelection({ kind: 'ownedBot', bot: ownedBot })}
            data={{ 'data-bot-opponent': ownedBot.id }}
          />
        ) : null}
        {players.map((player) => (
          <OpponentRow
            key={player.id}
            on={selection.kind === 'human' && selection.id === player.id}
            avatar={<Avatar player={player} size={38} />}
            title={player.name}
            trailing={ratingLabel(player.rating, player.provisional)}
            onPick={() => setSelection({ kind: 'human', id: player.id })}
            data={{ 'data-opponent': player.id }}
          />
        ))}
        {defaults.allowOpenChallenges ? (
          <OpponentRow
            on={selection.kind === 'open'}
            avatar={
              <span
                class="avatar open"
                aria-hidden="true"
                style={{ '--size': '38px' } as Record<string, string>}
              >
                +
              </span>
            }
            title={t('app.new.open_challenge')}
            sub={t('app.new.open_sub')}
            onPick={() => setSelection({ kind: 'open' })}
            data={{ 'data-opponent': 'open' }}
          />
        ) : null}
        <button
          type="button"
          class="option-row"
          data-testid="bots-row"
          onClick={() => {
            tg.hapticSelection();
            router.push({ name: 'botBrowser', groupId: props.groupId });
          }}
        >
          <span
            class="avatar open"
            aria-hidden="true"
            style={{ '--size': '38px' } as Record<string, string>}
          >
            🤖
          </span>
          <span class="grow">
            <span class="name">{t('app.new.bots_row')}…</span>
          </span>
          <span class="chevron" aria-hidden="true">
            ›
          </span>
        </button>
      </div>
      {botUnavailable && !ownedBot ? <p class="hint">{t('app.new.bot_unavailable')}</p> : null}
      {players.length === 0 ? <p class="hint">{t('app.new.no_players')}</p> : null}
      {selection.kind === 'bot' && botPicker ? (
        <>
          <div class="section">{t('app.new.bot_level')}</div>
          <Tiles
            columns={4}
            value={selection.level}
            onChange={(level) => setSelection({ kind: 'bot', level })}
            tiles={botPicker.levels.map((level) => ({
              key: level,
              value: level,
              label: t(`app.level.${level}`),
              'data-testid': `bot-level-${level}`,
            }))}
          />
          <p class="hint">{t('app.new.bot_casual')}</p>
        </>
      ) : (
        <>
          <div class="section">{t('app.new.time')}</div>
          <Tiles
            columns={3}
            value={effectiveTime}
            onChange={setTimePerMove}
            tiles={TIME_VALUES.filter((value) => value !== null || !ownedBot).map((value) => ({
              key: String(value),
              value,
              label: value === null ? t('time.per_move.none') : timeSpanLabel(value),
              'data-time': value === null ? 'none' : value,
            }))}
          />
          {idleBot && ownedBot ? (
            <p class="hint" data-testid="bot-idle">
              {t('app.new.bot_idle', { bot: ownedBot.name })}
            </p>
          ) : null}
          {ownedBot?.isMine ? <p class="hint">{t('app.new.own_bot_casual')}</p> : null}
        </>
      )}
      <div class="section">{t('app.new.colour')}</div>
      <Tiles
        columns={3}
        variant="soft"
        value={colour}
        onChange={setColour}
        tiles={(
          [
            ['white', [king('white')]],
            ['random', [king('white'), king('black')]],
            ['black', [king('black')]],
          ] as const
        ).map(([value, kings]) => ({
          key: value,
          value,
          'data-colour': value,
          label: (
            <>
              <span class="kings cg-wrap">{kings}</span>
              <span>{t(`colour.${value}`)}</span>
            </>
          ),
        }))}
      />
      <div class={casualOnly ? 'card field inert' : 'card field'}>
        <span>{t('app.new.rated')}</span>
        <Switch
          checked={casualOnly ? false : rated}
          onChange={setRated}
          disabled={casualOnly}
          data-rated=""
          label={t('app.new.rated')}
        />
      </div>
      {inPage ? (
        <div class="inline-main">
          <button class="btn block" disabled={!ready} onClick={() => void submit()}>
            {actionLabel}
          </button>
        </div>
      ) : null}
    </div>
  );
}
