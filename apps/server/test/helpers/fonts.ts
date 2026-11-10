import { fetchFonts } from '../../../../scripts/fetch-fonts.mjs';

/** Every server test run, unit tests included, gets the snapshot card's fonts. */
export default async function setup(): Promise<void> {
  await fetchFonts();
}
