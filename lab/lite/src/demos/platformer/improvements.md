# Platformer Demo — Improvements & Ideas

A living backlog of ideas to grow **World 1-1** into something that is both
genuinely fun to play **and** a showcase for what Babylon **Lite** + WebGPU can
do in a tiny, tree-shaken, pure-2D bundle (no scene, camera, or mesh — just the
sprite path).

> **Run it locally:** `pnpm build:bundle-demo platformer` (build the bundle the
> page loads), then `pnpm --filter @babylon-lite/lab dev` and open
> `http://localhost:<port>/demo-platformer.html` (WebGPU browser required; the
> CC0 assets are committed, no fetch needed). **Iterate:** re-run
> `pnpm build:bundle-demo platformer` after edits and refresh — no server
> restart. Add `--measure` to refresh the bundle-size badge. `pnpm dev:lab`
> rebuilds **every** scene + demo first (slower); `pnpm build:bundle-demos`
> rebuilds all demos.

---

## 🎯 Definition of Done (committed roadmap)

The owner has committed to these four items — once they land, this demo is
considered **done**. (A **polish pass** comes first, driven by play-testing, before
any of these are built.)

1. **Title / attract screen — [#20](#polish).** ✅ **DONE.**
2. **`loadArea` area system — [#3](#3-several-scenes--pipe-warps--sub-areas-).** ✅ **DONE.**
   Real discrete-area teardown/refill (overworld + cave today; castle next).
3. **CRT / scanline post-process — [#17](#tech-showcase--flex).** ✅ **DONE.**
   Default ON (toggle with **C**). Uses a new opt-in, tree-shakable engine hook —
   `createRenderTexture2D` + `setSpriteRendererTarget` — to render the scene into an
   offscreen texture, then presents it through a curved-glass CRT fragment
   (barrel curvature + scanlines + aperture mask + chromatic aberration + vignette).
4. **Castle finale + boss — [#12](#gameplay--content).** ✅ **DONE.**

> **Status:** title ✅ + `loadArea` ✅ + castle/boss ✅ + **CRT ✅** — the committed
> roadmap is **complete**. Also done: full **world reset on death**.

---

## Legend — engine readiness

Each idea is tagged with how much engine support it needs **today**:

- ✅ **Ready** — buildable now with shipped Lite features (additive/multiply
  blend descriptors, per-layer custom fragment shaders, opt-in `uvScroll`).
- 🟡 **Workaround** — achievable now with a sprite-space trick, but a future
  engine feature would make it cleaner/cheaper.
- 🔴 **Needs engine** — requires a capability Lite does not have yet. Listed
  here and consolidated under [Engine feature asks](#engine-feature-asks) for
  discussion before we commit.

**Scope** is relative implementation size (S / M / L), not a time estimate.

---

## Current state (baseline)

What ships today, so we know what we're building on:

- **Art pack** — the curated CC0 Kenney **"Platformer Art Deluxe"** subset
  (committed under `lab/public/platformer/`): one combined `tiles` sheet
  (grass/dirt/stone/castle/snow terrain **and** the box/brick blocks), `items`,
  combined alien character sheets (the player is the green/yellow **astronaut**),
  `enemies`, `hud`, and themed backgrounds. One cohesive classic look throughout.
- **World 1-1** — a scrolling level (left→right) to a flagpole goal, **plus** a
  warp pipe down to a **large lava-lit underground cavern** (`1-2`) and back.
  Run/jump physics, coyote-time + jump-buffer, ?-blocks & breakable bricks, pits,
  hazards, moving-ground edges.
- **Underground cavern** — ✅ **DONE.** A multi-section cave: entry chamber, two
  molten **lava** channels (instant-death) crossed on stone stepping-stones, a
  bonus ledge with reward blocks, all lit by a player-following **lantern** + wall
  **torches**. See [#7](#visual-fx)/[#8](#visual-fx)/[#9](#visual-fx).
- **Star invincibility** — ✅ **DONE.** A per-layer custom fragment shader on the
  player (rainbow palette-cycle + sparkle pulse via `fx.time`, intensity driven
  by `setSprite2DShaderParams`) plus a 6-ghost **additive** afterimage trail on a
  second layer. Blinks as a warning in the final ~2 s. Replaced the old flat
  yellow vertex-tint. See [#1](#1-star-invincibility--make-it-dazzle-).
- **Parallax background** — ✅ **DONE.** Replaced the single `colored_grass.png`
  backdrop with a procedural multi-band parallax ([`parallax.ts`](parallax.ts)): a
  static sky gradient, drifting clouds, and two rows of rolling hills, each a
  single full-screen sprite scrolling via **`uvScroll`** at its own depth rate.
  See [#2](#2-richer-parallax--multi-band-scrolling-world-).
- **Power-ups** — mushroom (grow), ✅ **fire flower** (shoot fireballs), and star
  (invincibility). Block progression is classic: a mushroom-block gives a mushroom
  when small, a fire flower once big. See [#4](#visual-fx).
- **Enemies** — stompable slimes + snails (snails shell on stomp, then kick), a
  sine-flying **bee**, and a **pipe-plant** that rises from a decorative pipe.
  Fireballs and the star also pop them; a **stomp combo** escalates the score.
- **Platforms** — ✅ **DONE.** **One-way** grass ledges (jump up through, land on
  top) and **moving** platforms (a horizontal pit-ferry, a vertical elevator, and a
  cave platform over lava) that carry the player. See [#13](#gameplay--content).
- **Pipes** — ✅ **DONE.** A green warp pipe in the overworld teleports the player
  (duck on top) to the underground cavern (`1-2`) and back. The warp plays a classic
  **pipe animation**: the player turns to face the camera and slides _down behind_
  the pipe (occluded by it via draw order on a dedicated layer), a brief iris hides
  the camera jump, then the player rises _up out of_ a pipe at the destination. See
  [#3](#3-several-scenes--pipe-warps--sub-areas-).
- **Juice** — ✅ **DONE.** Additive sparkle bursts + floating HUD-digit score
  popups on coin/stomp/kill, and a 4-chunk spinning **brick-break debris** spray
  when a big player smashes a brick. See [#6](#visual-fx).
- **Sprite sizing** — ✅ **DONE.** Visual draw sizes are decoupled from the
  (tighter) collision boxes so the player, enemies, and items read at ~1 tile
  like the ?-blocks, and big-player growth reads as a clear ~2-tile jump. The
  Deluxe character/enemy frames are tightly cropped at varying sizes, so the
  player and enemies are **natural-frame scaled** (each frame drawn at its own
  size × a target-height factor, feet-anchored via a bottom pivot); the still-
  padded item frames keep per-kind draw cells.
- **HUD** — DOM overlay (score, coins, time, lives). **Audio** — clean-room
  chiptune SFX (jump, coin, stomp, power-up, warp, fireball, break, …).
  **Input** — keyboard / gamepad / touch (with a fire button).

---

## Requested ideas

### 1. Star invincibility — make it dazzle ✅ DONE

> **Shipped.** Implemented in [`game.ts`](game.ts) as a dual-duty custom shader on
> the player layer (at strength 0 it returns the stock sprite, so one layer covers
> both normal and powered states) plus an additive afterimage trail. The optional
> world-wide "star pulse" tint below was **not** implemented — left as a possible
> follow-up.

**What.** Replace the flat color-tint with a proper invincibility shader: a
rainbow palette-cycle sweeping over the sprite, a bright rim/flash pulse, and an
**additive sparkle trail** of afterimages behind the running player.

**Why it's a showcase.** Shows off per-layer custom fragment shaders + additive
blending driving a classic effect that normally needs a full material system —
in a pure-2D bundle.

**How (Lite APIs).**

- Give the player its own layer built with
  `createSprite2DLayer(atlas, { customShader: starShader, ... })`.
- `starShader = createSprite2DCustomShader({ fragment })` where the WGSL samples
  `atlasTex`/`atlasSamp`, then hue-rotates RGB by `fx.time` and adds a rim glow.
  Drive intensity from `setSprite2DShaderParams(layer, [strength, 0,0,0])`,
  ramping `strength` to 0 as the star timer runs out (and a faster flash in the
  final ~2 s warning).
- Sparkle trail: a small pool of player-frame sprites on an **additive** layer
  (`blendMode: spriteBlendAdditive`) sampling recent positions, fading by age.
- Optional: tint the whole world subtly during the star by setting `fx.params`
  on the terrain/block layers too (a shared "star pulse" uniform).

**Scope.** S–M.

---

### 2. Richer parallax — multi-band scrolling world ✅ DONE

> **Shipped.** Implemented in [`parallax.ts`](parallax.ts): four bands (sky
> gradient, clouds, far hills, near hills) generated procedurally with an offscreen
> 2D canvas, each a single full-screen sprite whose atlas frame has `uvMax.x > 1`
> (texture tiles across the screen under `repeat` wrap) and scrolls via
> `setSprite2DUvOffset` at a per-band parallax factor. Clouds also self-drift. The
> old 12-slot manual tile-wrapping backdrop is gone. **Not yet** done from the
> wishlist below: distant mountains as a separate band and the additive sun/haze
> — left as easy follow-ups.

**What.** Replace the single tiled background with **several depth bands** that
scroll at different rates: far sky gradient, clouds, distant mountains, mid hills,
near bushes/foreground. Add slow drifting clouds and a soft additive sun/haze.

**Why it's a showcase.** This is the textbook use of the new opt-in **`uvScroll`**
feature — infinite horizontal scroll with **zero cross-scene cost** — layered
with additive atmosphere. Big visual payoff, tiny code.

**How (Lite APIs).**

- For each band, a wide sprite (or a few wrapping tiles) on a layer created with
  `createSprite2DLayer(atlas, { uvScroll: true, order })`. Each frame, advance
  `setSprite2DUvOffset(layer, idx, [cameraX * factorBand, 0])` with a smaller
  `factor` for farther bands → parallax depth.
- Clouds: a second `uvScroll` band advancing on its own slow timer independent of
  the camera.
- Sun glow / god-rays / atmospheric haze: an **additive** sprite
  (`blendMode: spriteBlendAdditive`) pulsing via a custom shader's `fx.time`.
- Underground/cave areas (see #3) swap to dark bands + a multiply vignette.

**Scope.** M.

---

### 3. Several "scenes" — pipe warps & sub-areas ✅ DONE (full `loadArea`)

> **Shipped — now a real `loadArea` area system.** The world is modelled as
> **discrete `LevelArea`s** in [`level.ts`](level.ts), each a self-contained little
> level on its **own tile grid** (own `solid`/`oneway` collider, terrain, blocks,
> coins, enemies, lava, torches, movers, pipes, named entry points + optional flag).
> `buildWorld()` returns `{ areas, start }`; the runtime keeps a `level` pointer to
> the **current** area. `loadArea(areaId, entry)` in [`game.ts`](game.ts) **tears
> down** the pooled sprite layers (`clearSprite2DLayer`) and **refills** them for the
> new area, rebuilds the collider, and stands the player on the named `entry` cell —
> so areas differ freely in size/theme with **no shared mega-grid**. Pipes warp by
> naming a destination `toArea` + `toEntry`; the player slides down the source pipe,
> the area swaps under the iris, then emerges from the destination pipe. A **death**
> reloads the start area (full reset) keeping score/coins/lives. Verified in-browser:
> overworld ⇄ cave bidirectional warps with full teardown/refill, no leaks, no errors.
>
> **Areas today:** `overworld` (1-1) + `cave` (1-2). The **castle** finale is the
> next area to drop in (see #12). **Not yet:** per-area music.

**What.** Turn the single level into a small **world** of connected areas:
overworld → enter a pipe → underground coin room → exit pipe back out (or to a
bonus area), plus a final castle approach. Each area has its own palette, music,
parallax bands, and tile set.

**Why it's a showcase.** Demonstrates that a Lite sprite game can manage multiple
"rooms" cheaply — tearing down and repopulating sprite layers per area with no
scene graph — and gives the demo real game structure.

**How (Lite APIs).**

- Model the level as a list of **areas**, each with its own tile/terrain/enemy
  data. A `loadArea(area)` clears and refills the existing layers
  (`updateSprite2DIndex` over pooled slots) — no engine teardown needed.
- A `warp` trigger tile: when the player ducks into a pipe mouth, play the
  existing **pipe** SFX, run a short "descend into pipe" tween (clip the player
  sprite as it sinks), then `loadArea(targetArea)` and reposition the player at
  the destination pipe.
- Persist score/coins/time/lives across areas in the existing game state.
- 🟡 **Transition polish.** The shipped iris-wipe is a fullscreen custom-shader
  **overlay** quad (it covers the frame; it does not re-read rendered pixels), so
  it needed **no** engine work. A transition that distorts/samples the existing
  frame (e.g. a swirl or pixelate wipe) would want a real post-process pass — see
  the corrected [Engine feature asks](#engine-feature-asks).

**Scope.** L (area system + at least one underground + one bonus area).

---

## More ideas (showcase + fun)

### Visual FX

- **4. Fire flower + fireballs ✅ DONE.** Procedural fire-flower pickup
  ([`fire.ts`](fire.ts)) emerges from a `?`-block once the player is big; collecting
  it grants the **fire** state (yellow alien via [`PLAYER_FIRE_FRAMES`](frames.ts)).
  The fire/run button (X / Shift / B) throws bouncing **fireball** projectiles drawn
  on an **additive** layer with a glowing core (capped at 2 live, rate-limited); they
  bounce along the ground, pop enemies on contact, and expire. Taking a hit drops
  fire→big→small. A `warp()`-style `fireball()` SFX was added too.
- **5. Power-state palette swaps ✅ (S).** Small / big / fire player rendered
  from one base sheet recolored by a **palette-remap custom shader** with an
  extra LUT texture (`createSprite2DCustomShader({ extraTextures: [palette] })`)
  — the same technique as parity scenes 93/95. One sheet, many looks.
- **6. Coin & stomp juice ✅ DONE.** Additive **sparkle bursts** (procedural
  4-point star, [`juice.ts`](juice.ts)) on coin-collect (gold) and enemy-stomp /
  fireball-kill (white), plus floating **score popups** built from the Kenney HUD
  digit glyphs (`hud0`–`hud9`) that rise and fade. Pooled sprites on two new
  layers (additive sparks + alpha digits). **Bonus:** smashing a brick as big now
  sprays **four spinning brick chunks** (rotating tile-sprite debris with gravity)
  plus a dust sparkle and a crunchy `breakBlock()` SFX.
- **7. Animated lava bands ✅ DONE.** The expanded underground has molten **lava
  pools** ([`lava.ts`](lava.ts)): a per-pool custom-shader quad generating flowing,
  glowing magma entirely from `fx.time` + `in.uv` (no texture — it reuses the 1×1
  white atlas, like the GPU-water trick), with a shimmering surface crest. Touching
  lava is instant death; stone stepping-stones let you hop across. Each pool also
  casts a warm **additive glow** so it lights the dark.
- **8. Underground "lantern" lighting ✅ DONE.** ([`lantern.ts`](lantern.ts)) A
  full-screen **multiply**-darkness quad whose fragment carves a soft radial pool of
  light that follows the player (params drive its screen position / radius / ambient),
  plus wall/ledge **torches** with flickering additive glows. The cave reads as a
  lantern-lit explore. (A real 2D light system would still be a cleaner engine ask.)
- **9. Heat-haze / underwater wobble 🟡 (per-layer DONE).** The lava surface
  **wobbles** its sample UVs with a scrolling sine in [`lava.ts`](lava.ts) — the
  per-layer heat-haze from this idea, applied to the lava itself. A **fullscreen**
  heat-haze that distorts the whole frame still needs the engine offscreen-RT hook
  (ask A) and is deliberately left for later.
- **10. Weather & time-of-day ✅/🔴 (M).** Rain/snow as additive particle sprites
  and a day→dusk→night sky gradient. Sprite-based version ✅; a true fullscreen
  graded sky / color-grade wants a post pass 🔴.

### Gameplay & content

- **11. Checkpoints & a tiny world map ✅ (M).** Flag checkpoints mid-level and a
  between-areas map screen — reinforces the multi-area system from #3.
- **12. More enemy types ✅ DONE (incl. boss).** Added a **flying bee** (sine-bobbing through the
  air, stompable from above) and a **pipe-plant** (the tall green `snakeSlime` that
  rises from / retracts into a decorative pipe on a timed cycle, freezing while the
  player stands over it; contact hurts, fireballs kill it). They reuse the shared
  enemy update/stomp/fireball paths — flyers stomp like slimes, the plant can't be
  stomped. Joins the existing slimes + shell-kicking snails. The **castle boss** (a
  big spider in the `castle` finale area) paces, ramps speed + lobs arcing
  projectiles per phase, takes **3 hits** (stomp / fireball / star) shown on a DOM
  **health-pip bar**, flashes invulnerable between hits, and on defeat triggers the
  **YOU WIN!** sequence (big bonus + fireworks → back to the title).
- **13. Moving & one-way platforms ✅ DONE.** **One-way platforms** (thin grass
  ledges) you jump up _through_ and land on top of — a `isOneWay` oracle in the
  swept-AABB collider only blocks a downward move whose feet were above the platform.
  **Moving platforms** (kinematic `bridge` tiles) ferry the player along X or Y and
  **carry** them (horizontal drift + vertical follow), with a per-frame delta applied
  to the rider: a horizontal ferry over an overworld pit, a vertical elevator to a
  coin stash, and a cave platform riding over a **lava** channel.
- **14. Combo / scoring system ✅ DONE.** A **stomp combo** escalates points for
  chaining enemies mid-air without landing (100 → 200 → 400 → 800 → 1000 → 2000 →
  4000 → 8000 → **1-up**, then resets), shown via the floating score popups; the
  chain resets the moment you touch solid ground. Reaching the flag now awards an
  **end-of-area time bonus** (remaining time × 50) shown in the completion banner.

### Tech showcase / "flex"

- **15. Sprite-throughput stress mode ✅ (S).** A toggle that spawns thousands of
  coins/particles to flaunt WebGPU instancing throughput while staying smooth.
- **16. Live debug HUD ✅ (S).** Optional overlay: sprite count, draw calls, frame
  time, and the demo's gzip bundle size — makes the "tiny + fast" story explicit.
- **17. Retro CRT / scanline filter ✅ DONE (M) — ⭐ COMMITTED.** A full-screen CRT pass
  (barrel curvature + scanlines + aperture mask + chromatic aberration + vignette),
  default ON, toggle with **C**. Shipped the engine **fullscreen post pass** hook
  (ask A): `createRenderTexture2D` + `setSpriteRendererTarget` let the scene
  `SpriteRenderer` render into an offscreen texture; a second present
  `SpriteRenderer` samples it through the CRT custom shader. See `crt.ts`.
- **18. Smooth integer-scale pixel zoom 🔴 (M).** Crisp pixel-art scaling at
  fractional window sizes via **render-to-texture** at integer scale, then blit.
  Needs RTT/framegraph.

### Polish

- **19. Controller rumble + better touch controls ✅ (S).** Gamepad haptics on
  hit/stomp; larger, nicer on-screen buttons for mobile.
- **20. Title & attract screen ✅ DONE.** A "COSMIC RUN" start screen: a rainbow
  **shimmer** logo (CSS gradient animation echoing the star power) + a blinking
  "PRESS ENTER · TAP Ⓐ" prompt over a live **attract loop** — the camera slowly
  ping-pongs across the overworld behind the title, flaunting the parallax + level.
  Enter starts a fresh run; game over returns here.
- **21. Accessibility ✅ (S).** Reduced-motion mode (calm the parallax/flashing),
  remappable keys, colorblind-friendly power-up shapes.

---

## Engine feature asks

Consolidated from the 🟡/🔴 ideas above — to discuss before committing.

> **Correction (verified in the engine source).** An earlier draft said RTT /
> frame-graph / post-process were "not supported." That was **wrong**: the engine
> already ships a frame-graph (`packages/babylon-lite/src/frame-graph/`),
> render targets (`engine/render-target.ts`), a post-process task, and a
> fullscreen effect renderer (`effect/effect-renderer.ts`,
> `effect/uniform-effect-renderer.ts`) — proven scene-lessly by scenes 140–144
> and the torus-states bloom demo. So the only real gap for a **pixel-reading**
> post pass is letting the pure-2D `SpriteRenderer` render into an offscreen
> color target (it currently hardcodes the swapchain view) and feeding that into
> an existing effect pass. That is a **moderate, well-scoped hook**, not new
> infrastructure.

| #   | Feature                                                          | Unlocks                                                                                           | Status                                                                                                                                                                                                                                                                                                                                         |
| --- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | **SpriteRenderer → offscreen target + post pass** ✅ **SHIPPED** | CRT/scanline (#17 ✅), fullscreen heat-haze (#9), graded day/night sky (#10), screen-wide flashes | Done: `createRenderTexture2D` (renderable+sampleable `Texture2D`) + `setSpriteRendererTarget(sr, target\|null)` (defaults to the swapchain, so zero impact on existing scenes; tree-shaken when unused). The platformer CRT (#17) is the first user — scene renders into an RT, a present `SpriteRenderer` samples it through a custom shader. |
| B   | **Render-to-texture at integer scale + blit**                    | Crisp integer-scale pixel zoom (#18)                                                              | Same RT building blocks; needs an integer-scale resolve/blit path.                                                                                                                                                                                                                                                                             |
| C   | **2D sprite cutout (alpha-test) blend**                          | Hard-edged depth-sorted sprites (foliage/grates) if we ever go 2.5D                               | Billboard cutout already ships; 2D-sprite cutout is still TODO. Low priority for this demo.                                                                                                                                                                                                                                                    |
| D   | **(Nice-to-have) lightweight 2D light/normal system**            | Cleaner underground lighting (#8)                                                                 | Fully fakeable with multiply sprites today; only worth it if multiple demos want real 2D lighting.                                                                                                                                                                                                                                             |

Everything not in this table is ✅ **buildable now** — the headline effects the
demo wants most (dazzling star, multi-band parallax, **pipe-warp areas**,
additive/fire juice, palette-swap power states) need **no new engine work**.
Note the shipped **iris transition (#3)** is an overlay quad and needed nothing
from this table.

---

## Suggested first slice

A high-impact, all-✅ starting batch that needs zero engine changes:

1. **#1 Star shader** — ✅ **DONE** (immediate "wow", small scope).
2. **#2 Multi-band parallax** — ✅ **DONE** (transformed the whole look via `uvScroll`).
3. **#3 area system + one underground room** — ✅ **DONE** (pipe warp + iris + cave
   `1-2`, all overlay-side; no engine post-process needed).
4. **#6 coin/stomp juice** + **#4 fireballs** — gameplay-feel polish.
   (#4 fire flower + fireballs ✅ **DONE**; #6 coin/stomp juice + brick-break
   debris ✅ **DONE**).

Next natural step is the **CRT/scanline post-process (#17)** — the first effect
that genuinely needs the engine offscreen-RT hook (ask A), or more gameplay
content (#11 checkpoints, #12 more enemy types, #13 moving platforms).

Then the **CRT/scanline post-process (#17)** is the natural next showcase — it's
the first effect that genuinely needs the engine hook (ask A above), and would
flex the existing frame-graph stack scene-lessly through the sprite renderer.
