import {
  FLAIR,
  FlairDtoSchema,
  MAX_WORN_FLAIR,
  flairById,
  type FlairDto,
} from '@chess-goat/shared';
import { signal } from '@preact/signals';
import type { ApiClient } from '../api/client';

/**
 * The viewer's own flair (flair spec §5.2, §5.3): what they wear, in slot order, and what they have
 * earned. It outlives any one screen, so Settings and the Flair screen share one copy. Null until
 * the first load.
 */
export const myFlair = signal<FlairDto | null>(null);

export async function loadMyFlair(client: ApiClient): Promise<FlairDto> {
  const flair = await client.get('/api/me/flair', FlairDtoSchema);
  myFlair.value = flair;
  return flair;
}

/**
 * The worn list after a tap on `id` while `slot` is selected (flair spec §5.4). A flair already in
 * that slot comes out of it; otherwise it goes in, swapping places with the slot's occupant when
 * it was worn in another slot. Empty slots are dropped, so the list closes up.
 */
export function wearFlair(worn: readonly string[], slot: number, id: string): string[] {
  const slots: (string | undefined)[] = Array.from({ length: MAX_WORN_FLAIR }, (_, i) => worn[i]);
  if (slots[slot] === id) {
    slots[slot] = undefined;
  } else {
    const from = slots.indexOf(id);
    if (from >= 0) slots[from] = slots[slot];
    slots[slot] = id;
  }
  return slots.filter((entry) => entry !== undefined);
}

/**
 * The share of the catalog the viewer has earned, as a rounded percentage (flair spec §5.2). An
 * earned id this build's catalog does not know is not counted: the server can be a deploy ahead
 * of an app still open, and the share must never pass 100.
 */
export function unlockedPercent(flair: FlairDto): number {
  const known = flair.earned.filter((entry) => flairById(entry.id) !== undefined).length;
  return Math.round((100 * known) / FLAIR.length);
}

/** Counts the saves so far; only the latest may settle `myFlair`. */
let latestSave = 0;

/**
 * Wears `worn` at once, then asks the server to keep it (flair spec §5.3). The server's answer
 * replaces the signal; a failed save puts the previous list back and answers false. Taps can come
 * faster than the server answers, and answers can arrive out of order, so only the latest save may
 * touch the signal: an older one answers true and changes nothing.
 */
export async function saveWornFlair(client: ApiClient, worn: string[]): Promise<boolean> {
  const save = ++latestSave;
  const previous = myFlair.value?.worn ?? [];
  if (myFlair.value) myFlair.value = { ...myFlair.value, worn };
  try {
    const answer = await client.put('/api/me/flair', { worn }, FlairDtoSchema);
    if (save === latestSave) myFlair.value = answer;
    return true;
  } catch {
    if (save !== latestSave) return true;
    if (myFlair.value) myFlair.value = { ...myFlair.value, worn: previous };
    return false;
  }
}
