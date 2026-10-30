import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Font } from 'satori';

export type SnapshotFonts = Font[];

/** Where `pnpm fonts` puts them (`scripts/fetch-fonts.mjs`). */
export const FONTS_DIR = fileURLToPath(new URL('../../fonts/', import.meta.url));

/** Spec §2.1, in Satori's fallback order: the first font with a glyph draws it. */
const FONTS = [
  { file: 'NotoSans-Regular.ttf', name: 'Noto Sans', weight: 400 },
  { file: 'NotoSans-SemiBold.ttf', name: 'Noto Sans', weight: 600 },
  { file: 'NotoSans-Bold.ttf', name: 'Noto Sans', weight: 700 },
  { file: 'NotoEmoji-Regular.ttf', name: 'Noto Emoji', weight: 400 },
  { file: 'NotoSansSymbols2-Regular.ttf', name: 'Noto Sans Symbols 2', weight: 400 },
  { file: 'NotoSansCJKsc-Regular.otf', name: 'Noto Sans CJK SC', weight: 400 },
  { file: 'YoungSerif-Regular.ttf', name: 'Young Serif', weight: 400 },
] as const;

/** Test seam: what the renderer loads, checked against the download manifest. */
export const FONT_FILES: readonly string[] = FONTS.map((font) => font.file);

/** Spec §2.3: read once at boot; a missing file stops the process with the fix in the message. */
export async function loadFonts(dir: string = FONTS_DIR): Promise<SnapshotFonts> {
  return Promise.all(
    FONTS.map(async ({ file, name, weight }) => {
      try {
        return { name, weight, style: 'normal' as const, data: await readFile(join(dir, file)) };
      } catch (error) {
        throw new Error(
          `fonts missing in apps/server/fonts, run pnpm fonts (${file}: ${(error as Error).message})`,
          { cause: error },
        );
      }
    }),
  );
}
