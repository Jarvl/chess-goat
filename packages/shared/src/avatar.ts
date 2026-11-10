/** Telegram's own avatar colours, in its order. */
export const AVATAR_PALETTE = [
  '#e17076',
  '#faa774',
  '#a695e7',
  '#7bc862',
  '#6ec9cb',
  '#65aadd',
  '#ee7aae',
] as const;

/** Ids are decimal strings up to 19 digits, past a double's exact range, so BigInt it is. */
export function avatarColour(userId: string): string {
  return AVATAR_PALETTE[Number(BigInt(userId) % 7n)]!;
}

export function groupColour(publicId: string): string {
  let sum = 0;
  for (const char of publicId) sum += char.charCodeAt(0);
  return AVATAR_PALETTE[sum % 7]!;
}

/**
 * The first grapheme cluster of `text`, whole even when it is a multi-codepoint emoji (a flag, or
 * a ZWJ sequence like a family). `Intl.Segmenter` sees clusters the way a reader does; plain
 * `Array.from` only sees code points, which splits those sequences into their raw parts.
 */
function firstGrapheme(text: string): string | undefined {
  if (typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    const first = segmenter.segment(text)[Symbol.iterator]().next();
    return first.done ? undefined : first.value.segment;
  }
  return Array.from(text)[0];
}

/** The first character, whole even when it is an emoji; a username's @ is skipped. */
export function personInitial(name: string): string {
  const first = firstGrapheme(name.replace(/^@/, '').trim());
  return first ? first.toUpperCase() : '?';
}

export function groupInitials(title: string): string {
  const words = title.trim().split(/\s+/).filter(Boolean).slice(0, 2);
  const initials = words.map((word) => (firstGrapheme(word) ?? '').toUpperCase()).join('');
  return initials || '?';
}
