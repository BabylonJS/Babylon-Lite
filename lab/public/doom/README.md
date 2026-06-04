# DOOM demo — game data

This folder holds the game data (IWAD files) the DOOM demo reads at runtime.
The `.wad` files are **not committed to git** (see `.gitignore`).

They are fetched **automatically** by the demo build (`pnpm build:bundle-demos`
and the Pages-site build) because the `doom` entry in `demos-config.json`
declares `"fetch": "freedoom"`. You can also fetch them manually with:

```sh
pnpm fetch:freedoom
```

That script downloads a pinned, checksum-verified [Freedoom](https://freedoom.github.io/)
release and extracts `freedoom1.wad`, `freedoom2.wad`, and the Freedoom
`COPYING.txt` / `CREDITS.txt` here.

## Licensing & attribution

- **Freedoom** is free/libre game data distributed under a BSD 3-Clause license.
  Its full license and contributor credits are in `COPYING.txt` and `CREDITS.txt`
  (extracted next to the WADs by the fetch script). Attribution: the Freedoom
  project and its contributors — https://freedoom.github.io/.
- This demo's engine is a **clean-room** reimplementation of the publicly
  documented Doom data formats and gameplay behavior. It contains **no** id
  Software code (the original Doom engine is GPLv2) and **no** id Software game
  data.
- We never download, host, or bundle id Software's commercial WADs
  (`doom1.wad`, `doom.wad`, `doom2.wad`, …). Users who own them may load their
  own copy in the browser at runtime; such files are parsed client-side only and
  never uploaded.
