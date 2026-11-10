# Piece set attribution

The chess piece glyphs embedded in `pieces.ts` are the **cburnett** set by
[Colin M.L. Burnett](https://en.wikipedia.org/wiki/User:Cburnett), copied from the files that
lichess.org ships under `public/piece/cburnett` and regenerated with `scripts/vendor-pieces.mjs`.

The author multi-licenses the set on Wikimedia Commons (GFDL, BSD, GPLv2+ and CC BY-SA 3.0);
lichess redistributes its copy under GPLv2+. This project uses the glyphs under the
[Creative Commons Attribution-ShareAlike 3.0](https://creativecommons.org/licenses/by-sa/3.0/)
terms. The only change is that each standalone SVG file was
turned into an inline fragment. Shared position images carry this credit, and the Mini App's
About screen repeats it.

# Font attribution

The text on shared-position images is drawn with Noto Sans, Noto Emoji, Noto Sans Symbols 2,
Noto Sans CJK SC and Young Serif, under the SIL Open Font License 1.1. `apps/server/fonts/README.md` lists each
file's source and copyright; `apps/server/fonts/OFL.txt` is the licence.

# Emoji attribution

The trophy, skull and scales badges in `emoji.ts`, and the flair in `flairEmoji.ts`, are Noto Color
Emoji images by Google, from [googlefonts/noto-emoji](https://github.com/googlefonts/noto-emoji)
(`2D/svg`, tag `v2026-09-24-unicode18_0`) under the [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0),
regenerated with `scripts/vendor-snapshot-art.mjs`. The only changes are removing each file's XML
declaration, doctype and comments (substituting the doctype's namespace entities where a file
declares them) and Illustrator's private editing data.
