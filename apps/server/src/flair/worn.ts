import { flairById, MAX_WORN_FLAIR, type FlairId } from '@chess-goat/shared';

/**
 * Flair spec §3.3: the worn list after `fresh` is earned. New flair fills the free slots, whatever
 * its category; if there is more of it than slots, a uniformly random subset fills them. The chosen
 * ids are appended in catalog order, so `fresh` must be in catalog order. A worn id the catalog no
 * longer has (spec §1.7) is dropped first: its slot is free.
 */
export function fillFreeSlots(
  worn: readonly string[],
  fresh: readonly FlairId[],
  random: () => number = Math.random,
): string[] {
  const kept = worn.filter((id) => flairById(id) !== undefined);
  const free = MAX_WORN_FLAIR - kept.length;
  if (fresh.length <= free) return [...kept, ...fresh];
  // Draw `free` ids without replacement, each uniformly from what is left.
  const pool = [...fresh];
  const drawn: FlairId[] = [];
  for (let n = 0; n < free; n += 1)
    drawn.push(...pool.splice(Math.floor(random() * pool.length), 1));
  return [...kept, ...fresh.filter((id) => drawn.includes(id))];
}
