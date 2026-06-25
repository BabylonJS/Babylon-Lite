# Platformer demo — art & audio credits

This folder holds the curated sprite sheets the platformer demo reads at runtime
(`players`, `enemies`, `items`, `tiles`, `hud`, and the `backgrounds/` images).

Unlike the voxel/DOOM demos, this subset is **committed to git** — it is small and
CC0, so there is no licensing reason to keep it out and no runtime network
dependency. It is regenerated for provenance (pinned + checksum-verified) by:

```sh
pnpm tsx scripts/fetch-platformer.ts
```

That script downloads a pinned release of Kenney's "Platformer Art Deluxe" pack and
extracts the curated sheets plus `License.txt` into this folder.

## Licensing & attribution

- **Art & FX — Kenney "Platformer Art Deluxe".** Every sprite in this demo (the
  player aliens, enemies, coins/power-ups, terrain + block tiles, HUD digits, and
  the parallax/backdrop images) comes from Kenney's pack, released under the
  **Creative Commons Zero (CC0)** public-domain dedication: free to use, modify and
  redistribute for any purpose, with credit appreciated but **not required**. The
  full text ships in `License.txt` in this folder.
  Attribution: **Kenney Vleugels — https://kenney.nl**. Thank you, Kenney!
- **CRT / scanline post-process — ichiaka's "CRTFilter".** The optional CRT effect
  (press `C`) is a faithful WGSL port of the technique in **ichiaka's** MIT-licensed
  **CRTFilter** (https://github.com/Ichiaka/CRTFilter). The port and the
  original-author credit live in `lab/lite/src/demos/platformer/crt.ts`.
  Thank you, ichiaka!
- **Sound & music.** All sound effects and the looping background music are
  **procedurally synthesised** at runtime with the Web Audio API (no audio files
  shipped) — see `audio.ts`.
- **Engine & gameplay.** The renderer is Babylon Lite; the physics, AI, power-up
  system, scoring and game logic are **original, clean-room** code. This is a
  side-scrolling-platformer _homage_ — it contains **no** Nintendo code or assets
  and is not affiliated with or endorsed by Nintendo.
