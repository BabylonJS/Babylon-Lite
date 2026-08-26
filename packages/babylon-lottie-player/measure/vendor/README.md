# `measure/vendor/` — measurement reference players

This folder holds source for the alternative Lottie player used by the Sprite-vs-Stencil benchmark.
Keeping the reference implementation in the repository makes the comparison reproducible on any
clone and visible to CI.

The reference source is measurement-only: nothing here ships in `@babylonjs/lottie-player`, and this
folder is not part of the package's published `dist/`.

## The players

The benchmark compares the package's vector player with the included raster reference:

| Player                                       | Where                       | Status               |
| -------------------------------------------- | --------------------------- | -------------------- |
| **Stencil** (vector, stencil-then-cover)     | `../../src/` (this package) | The shipped player.  |
| **Sprite** (raster atlas, 1 draw call/frame) | `sprite/`                   | Benchmark reference. |

Each player has a distinct strength: stencil supports deforming vector paths and clipping, while the
sprite player can collapse a supported animation to a single draw call per frame.

## Contents

- `sprite/` contains the raster sprite-player benchmark source. It is MIT licensed; see [`sprite/LICENSE.txt`](sprite/LICENSE.txt).

Only the player is included here, not a copy of lite-gl. Both players are measured against the same
installed `@babylonjs/lite-gl`. The sprite source imports `babylon-lite-gl` and its sprite/texture
subpaths; the measurement build aliases those specifiers to the installed package used by the
stencil player.

## Provenance

The sprite renderer is derived from the Babylon.js Lottie player and adapted to the function-based
`@babylonjs/lite-gl` API for this benchmark. The upstream Babylon.js Lottie player is licensed under
MIT; its license is preserved in [`sprite/LICENSE.txt`](sprite/LICENSE.txt).

## Living source, not a frozen snapshot

Unlike a frozen vendor snapshot, the benchmark implementation may be improved in place. Record any
changes below so benchmark results remain reproducible.

If you do change vendored code, note it below so the divergence from the origin commit stays
traceable:

### Local modifications

No local modifications have been recorded.

## How it's used

`measure/size-lib.mjs` points the sprite build at `vendor/sprite` and aliases its lite-gl imports to
the same installed package used by the stencil player. Run the comparison with `pnpm measure` from
the package root. See the package
[README](../../README.md#measurement) for the full methodology.
