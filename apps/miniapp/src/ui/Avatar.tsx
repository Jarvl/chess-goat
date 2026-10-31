import {
  avatarColour,
  groupColour,
  groupInitials,
  personInitial,
  type GroupRef,
  type PlayerRef,
} from '@chess-goat/shared';
import { useState } from 'preact/hooks';
import { BRAND } from '../brand';

type Size = 22 | 26 | 34 | 38 | 40 | 56;

export function BotMark(props: { size: Size }) {
  return (
    <img
      class="avatar bot"
      src={BRAND.markUrl}
      alt=""
      width={props.size}
      height={props.size}
      style={{ '--size': `${props.size}px` } as Record<string, string>}
    />
  );
}

/**
 * A person as Telegram draws one: their photo when the server has it, over the coloured initial
 * that shows while it loads and stays if it fails. The bot is the Chess Goat mark.
 */
export function Avatar(props: {
  player: Pick<PlayerRef, 'id' | 'name' | 'isBot' | 'photoUrl'>;
  size: Size;
}) {
  // Keyed by URL, so a later photo gets its own chance after an earlier one failed.
  const [failed, setFailed] = useState<string | null>(null);
  if (props.player.isBot) return <BotMark size={props.size} />;
  const { photoUrl } = props.player;
  return (
    <span
      class="avatar"
      aria-hidden="true"
      style={
        {
          '--size': `${props.size}px`,
          background: avatarColour(props.player.id),
        } as Record<string, string>
      }
    >
      {personInitial(props.player.name)}
      {photoUrl && failed !== photoUrl ? (
        <img
          class="photo"
          src={photoUrl}
          alt=""
          loading="lazy"
          decoding="async"
          width={props.size}
          height={props.size}
          onError={() => setFailed(photoUrl)}
        />
      ) : null}
    </span>
  );
}

export function GroupAvatar(props: { group: GroupRef; size: 48 | 56 }) {
  return (
    <span
      class="avatar group"
      aria-hidden="true"
      style={
        {
          '--size': `${props.size}px`,
          background: groupColour(props.group.id),
        } as Record<string, string>
      }
    >
      {groupInitials(props.group.title)}
    </span>
  );
}
