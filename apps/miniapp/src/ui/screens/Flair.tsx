import {
  FLAIR,
  FLAIR_CATEGORIES,
  MAX_WORN_FLAIR,
  flairById,
  flairCategoryKey,
  flairDescriptionKey,
  t,
  type FlairEarned,
  type FlairEntry,
} from '@chess-goat/shared';
import { Fragment } from 'preact';
import { useState } from 'preact/hooks';
import { loadMyFlair, myFlair, saveWornFlair, wearFlair } from '../../state/flair';
import { session } from '../../state/session';
import { Avatar } from '../Avatar';
import { useApp } from '../context';
import { Flair } from '../Flair';
import { flairEarnedLabel } from '../format';
import { useResource } from '../hooks';
import { toast } from '../toast';
import { ErrorScreen, Loading } from './Status';

const SLOTS = Array.from({ length: MAX_WORN_FLAIR }, (_, index) => index);

const SECTIONS = FLAIR_CATEGORIES.map((category) => ({
  category,
  entries: FLAIR.filter((entry) => entry.category === category),
}));

/** One of the slots you wear flair in; the selected one is where the next tap on a row goes. */
function SlotTile(props: {
  index: number;
  id: string | undefined;
  selected: boolean;
  onSelect: () => void;
}) {
  const emoji = props.id === undefined ? undefined : flairById(props.id)?.emoji;
  return (
    <button
      type="button"
      class={props.selected ? 'flair-slot on' : 'flair-slot'}
      data-slot={props.index}
      aria-pressed={props.selected}
      onClick={props.onSelect}
    >
      {/* An empty slot's dot only draws the gap, so screen readers skip it and say "Slot N". */}
      <span
        class={emoji ? 'flair-slot-emoji' : 'flair-slot-emoji empty'}
        aria-hidden={emoji ? undefined : 'true'}
      >
        {emoji ?? '·'}
      </span>
      <span class="flair-slot-label">{t('app.flair.slot', { n: props.index + 1 })}</span>
    </button>
  );
}

/** What a row shows on the right (flair spec §5.3): where it is worn, or that it is not yet yours. */
function Badge(props: { earned: boolean; wornAt: number; slot: number }) {
  if (!props.earned) return <span class="tag">{t('app.flair.locked')}</span>;
  if (props.wornAt === props.slot) return <span class="flair-check">✓</span>;
  if (props.wornAt >= 0) {
    return <span class="tag">{t('app.flair.slot', { n: props.wornAt + 1 })}</span>;
  }
  return <span class="flair-free" />;
}

function FlairRow(props: {
  entry: FlairEntry;
  earned: FlairEarned | undefined;
  wornAt: number;
  slot: number;
  now: Date;
  onWear: (id: string) => void;
}) {
  const { entry, earned, wornAt, slot } = props;
  return (
    <button
      type="button"
      class={earned ? 'flair-row' : 'flair-row locked'}
      data-flair={entry.id}
      disabled={!earned}
      onClick={earned ? () => props.onWear(entry.id) : undefined}
    >
      <span class={wornAt === slot ? 'flair-tile here' : 'flair-tile'}>{entry.emoji}</span>
      <span class="grow">
        <span class="primary">{t(flairDescriptionKey(entry.id))}</span>
        {earned ? (
          <span class="earned">{flairEarnedLabel(entry.category, earned, props.now)}</span>
        ) : null}
      </span>
      <Badge earned={earned !== undefined} wornAt={wornAt} slot={slot} />
    </button>
  );
}

/**
 * Flair spec §5.3: the viewer's flair in three slots, and every flair with its state. It draws
 * from the shared `myFlair` signal and refreshes it on mount; a tap wears the flair in the selected
 * slot at once and saves in the background.
 */
export function FlairScreen() {
  const { client, tg } = useApp();
  const [slot, setSlot] = useState(0);
  const load = useResource('flair', () => loadMyFlair(client));
  const flair = myFlair.value;
  if (!flair) return load.error ? <ErrorScreen onRetry={() => void load.reload()} /> : <Loading />;

  const me = session.value?.user;
  const now = new Date();
  const earnedById = new Map(flair.earned.map((entry) => [entry.id, entry]));
  const wear = async (id: string) => {
    tg.hapticSelection();
    // Read fresh: a second tap can land before this render's list has caught up with the first.
    const worn = myFlair.value?.worn ?? [];
    if (!(await saveWornFlair(client, wearFlair(worn, slot, id)))) toast(t('app.common.error'));
  };

  return (
    <div class="screen">
      <h1 class="title">{t('app.flair.title')}</h1>
      <div class="card flair-preview">
        <div class="flair-me">
          {/* The launch's user carries no photo URL, so the viewer shows as their initial here. */}
          {me ? <Avatar player={{ ...me, isBot: false, photoUrl: null }} size={26} /> : null}
          <span class="name">{me?.name}</span>
          <Flair ids={flair.worn} />
        </div>
        <div class="flair-slots">
          {SLOTS.map((index) => (
            <SlotTile
              key={index}
              index={index}
              id={flair.worn[index]}
              selected={index === slot}
              onSelect={() => {
                tg.hapticSelection();
                setSlot(index);
              }}
            />
          ))}
        </div>
      </div>
      {SECTIONS.map(({ category, entries }) => (
        <Fragment key={category}>
          <div class="section">{t(flairCategoryKey(category))}</div>
          <div class="card">
            {entries.map((entry) => (
              <FlairRow
                key={entry.id}
                entry={entry}
                earned={earnedById.get(entry.id)}
                wornAt={flair.worn.indexOf(entry.id)}
                slot={slot}
                now={now}
                onWear={(id) => void wear(id)}
              />
            ))}
          </div>
        </Fragment>
      ))}
    </div>
  );
}
