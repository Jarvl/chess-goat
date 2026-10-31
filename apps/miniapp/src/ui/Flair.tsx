import { flairById, flairDescriptionKey, t } from '@chess-goat/shared';

/**
 * The emoji a player wears beside their name (flair spec §5.1), or nothing. An id this build's
 * catalog does not know is skipped, since the server can be a deploy ahead of an app still open.
 * Each emoji is its own span, spaced by a flex gap in the stylesheet, so a ZWJ sequence stays whole.
 */
export function Flair(props: { ids: readonly string[] }) {
  const known = props.ids.map((id) => flairById(id)).filter((entry) => entry !== undefined);
  if (known.length === 0) return null;
  return (
    <span
      class="flair"
      role="img"
      aria-label={known.map((entry) => t(flairDescriptionKey(entry.id))).join(', ')}
    >
      {known.map((entry) => (
        <span key={entry.id}>{entry.emoji}</span>
      ))}
    </span>
  );
}
