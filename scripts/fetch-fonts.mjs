#!/usr/bin/env node
// The snapshot card's fonts are downloaded, never committed.
// Every file is pinned by URL and sha256, so a changed upstream file fails here instead of shipping.
// Idempotent: a file already present with the right hash is not downloaded again, and a file with
// the wrong bytes (an interrupted download, say) is replaced. Writes go through `<file>.part` and a
// rename, so a crash never leaves a half-written font under its real name.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const NOTO =
  'https://raw.githubusercontent.com/notofonts/notofonts.github.io/e0ad9f160a2942bcdd249bb1958e8336742edef3/fonts';

/** Satori's fallback order; `apps/server/src/images/fonts.ts` loads them in this order. */
export const FONT_MANIFEST = [
  {
    file: 'NotoSans-Regular.ttf',
    url: `${NOTO}/NotoSans/hinted/ttf/NotoSans-Regular.ttf`,
    sha256: '478c558ea716033cd60c03438f628dfa75694dcf6b5f6d505a2f05fd2b4f3823',
  },
  {
    file: 'NotoSans-SemiBold.ttf',
    url: `${NOTO}/NotoSans/hinted/ttf/NotoSans-SemiBold.ttf`,
    sha256: 'a4e91fd530ac2b4ef5367240144ff37d7d65d66cf76f2e9a2187b93c676f92d0',
  },
  {
    file: 'NotoSans-Bold.ttf',
    url: `${NOTO}/NotoSans/hinted/ttf/NotoSans-Bold.ttf`,
    sha256: '1df075a380fc7cb898acf64c1f7b3b4dd780de3caa860178bf929de35817a913',
  },
  {
    // The static weight-400 instance Google Fonts serves. The upstream file is a variable font
    // whose `fvar` table Satori's parser throws on.
    file: 'NotoEmoji-Regular.ttf',
    url: 'https://fonts.gstatic.com/s/notoemoji/v65/bMrnmSyK7YY-MEu6aWjPDs-ar6uWaGWuob-r0jwv.ttf',
    sha256: '988621dc5c9a75eb6144f28faae30317a8e3421b68b28740747b3d739e2326b8',
  },
  {
    file: 'NotoSansSymbols2-Regular.ttf',
    url: `${NOTO}/NotoSansSymbols2/hinted/ttf/NotoSansSymbols2-Regular.ttf`,
    sha256: 'c4a0a80f0041ce4be81e2478faad22776d23edb98ae3f0d19bd37044820ecf9d',
  },
  {
    file: 'NotoSansCJKsc-Regular.otf',
    url: 'https://raw.githubusercontent.com/notofonts/noto-cjk/Sans2.004/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf',
    sha256: '2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b',
  },
  {
    // The brand footer's wordmark only; last, so it is never a fallback for other text.
    file: 'YoungSerif-Regular.ttf',
    url: 'https://fonts.gstatic.com/s/youngserif/v2/3qTpojO2nS2VtkB3KtkQZ2t6.ttf',
    sha256: 'a0a943015fae6d41423f2f65ff27655055b1f1aca1a890b84c2b3855ae925a2b',
  },
];

export const FONTS_DIR = fileURLToPath(new URL('../apps/server/fonts/', import.meta.url));

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

async function readIfPresent(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/** Downloads every entry missing from `dir` or whose bytes do not match; returns what it fetched. */
export async function fetchFonts({
  dir = FONTS_DIR,
  manifest = FONT_MANIFEST,
  fetchImpl = fetch,
} = {}) {
  await mkdir(dir, { recursive: true });
  const downloaded = [];
  for (const entry of manifest) {
    const path = join(dir, entry.file);
    const existing = await readIfPresent(path);
    if (existing && sha256(existing) === entry.sha256) continue;
    const response = await fetchImpl(entry.url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`${entry.file}: HTTP ${response.status} from ${entry.url}`);
    const data = Buffer.from(await response.arrayBuffer());
    const actual = sha256(data);
    if (actual !== entry.sha256) {
      await rm(path, { force: true });
      throw new Error(`${entry.file}: sha256 ${actual}, expected ${entry.sha256}`);
    }
    await writeFile(`${path}.part`, data);
    await rename(`${path}.part`, path);
    downloaded.push(entry.file);
  }
  return downloaded;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  fetchFonts().then(
    (files) => console.log(files.length ? `fetched ${files.join(', ')}` : 'fonts up to date'),
    (error) => {
      console.error(error.message);
      process.exit(1);
    },
  );
}
