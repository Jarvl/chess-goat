import { BotListDtoSchema, ratingLabel, t, type BotListDto } from '@chess-goat/shared';
import { useEffect, useRef, useState } from 'preact/hooks';
import { ApiError } from '../../api/client';
import { serverNow } from '../../state/session';
import { Avatar } from '../Avatar';
import { Flair } from '../Flair';
import { useApp } from '../context';
import { Segmented } from '../controls';
import { botActivityLabel } from '../format';
import { toast } from '../toast';
import { ErrorScreen, Loading } from './Status';

type Sort = 'rating' | 'active' | 'newest';
type Listing = BotListDto;
type BotCardDto = BotListDto['bots'][number];

const SEARCH_DEBOUNCE_MS = 300;

function BotRow(props: { bot: BotCardDto; now: Date; onOpen: (id: string) => void }) {
  const { bot } = props;
  const activity = botActivityLabel(bot, props.now);
  return (
    <button class="player-row" data-bot={bot.id} onClick={() => props.onOpen(bot.id)}>
      <Avatar player={bot} size={40} />
      <span class="grow">
        <span class="name-row">
          <span class="name">{bot.name}</span>
          <Flair ids={bot.flair} />
          <span class="rating">{ratingLabel(bot.rating, bot.provisional)}</span>
        </span>
        {bot.tagline ? <span class="secondary">{bot.tagline}</span> : null}
        <span class="secondary">{t('app.player.record', bot.record)}</span>
        {activity ? <span class="secondary bot-activity">{activity}</span> : null}
      </span>
    </button>
  );
}

/**
 * A group's bots to challenge: searched by name, sorted, and paged 20 at a time. Opened from New
 * game (`from: 'newGame'`) it stands in for that form, so a pick replaces it with a fresh one.
 */
export function BotBrowser(props: { groupId: string; from?: 'newGame' }) {
  const { client, router } = useApp();
  const [typed, setTyped] = useState('');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('rating');
  const [listing, setListing] = useState<Listing | null>(null);
  const [failed, setFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // Only the latest request may land; a slow, stale answer must not replace a newer one.
  const latest = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(typed.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [typed]);

  const path = (cursor?: string) => {
    const params = new URLSearchParams({ sort });
    if (query) params.set('q', query);
    if (cursor) params.set('cursor', cursor);
    return `/api/groups/${props.groupId}/bots?${params.toString()}`;
  };

  const load = async () => {
    const seq = (latest.current += 1);
    setFailed(false);
    try {
      const page = await client.get(path(), BotListDtoSchema);
      if (seq === latest.current) setListing(page);
    } catch {
      if (seq === latest.current) setFailed(true);
    }
  };
  useEffect(() => {
    void load();
  }, [props.groupId, query, sort]);

  const more = async () => {
    if (!listing?.nextCursor) return;
    const seq = latest.current;
    setLoadingMore(true);
    try {
      const page = await client.get(path(listing.nextCursor), BotListDtoSchema);
      if (seq === latest.current) {
        setListing({ ...page, bots: [...listing.bots, ...page.bots] });
      }
    } catch (error) {
      toast(
        error instanceof ApiError && error.isNetwork
          ? t('app.common.offline')
          : t('app.common.error'),
      );
    } finally {
      setLoadingMore(false);
    }
  };

  if (failed) return <ErrorScreen onRetry={() => void load()} />;
  if (!listing) return <Loading />;
  const now = serverNow();
  const open = (opponentId: string) => {
    const next = { name: 'newGame', groupId: props.groupId, opponentId } as const;
    if (props.from === 'newGame') router.replace(next);
    else router.push(next);
  };

  return (
    <div class="screen">
      <h1 class="title">{t('app.bots.browse_title', { group: listing.group.title })}</h1>
      <input
        class="search-input"
        type="search"
        autoComplete="off"
        placeholder={t('app.bots.search')}
        aria-label={t('app.bots.search')}
        maxLength={64}
        value={typed}
        onInput={(event) => setTyped(event.currentTarget.value)}
      />
      <Segmented<Sort>
        value={sort}
        onChange={setSort}
        options={[
          { value: 'rating', label: t('app.bots.sort_rating'), 'data-sort': 'rating' },
          { value: 'active', label: t('app.bots.sort_active'), 'data-sort': 'active' },
          { value: 'newest', label: t('app.bots.sort_newest'), 'data-sort': 'newest' },
        ]}
      />
      {listing.bots.length === 0 ? (
        <div class="card empty">
          {query ? t('app.bots.no_match', { query }) : t('app.bots.none')}
        </div>
      ) : (
        <div class="card">
          {listing.bots.map((bot) => (
            <BotRow key={bot.id} bot={bot} now={now} onOpen={open} />
          ))}
        </div>
      )}
      {listing.nextCursor ? (
        <button
          class="btn secondary block"
          data-action="more"
          disabled={loadingMore}
          onClick={() => void more()}
        >
          {t('app.bots.more')}
        </button>
      ) : null}
    </div>
  );
}
