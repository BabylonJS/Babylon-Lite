# Freeciv Demo — Graphics Features

A running list of "whoah" graphics effects for the Freeciv isometric demo. All
are demo-level on Lite's sprite path (no engine changes) unless noted; the
post-processing items want the `createPostProcess` framegraph (drafted, not yet
handed to engine devs).

## Shipped

- [x] **GPU water** — animated caustic custom-shader on ocean tiles.
- [x] **Day/night cycle + city lights** — press **N** to ease day↔night (and stay
      there); warm additive glows bloom on cities at night.
- [x] **Cloud shadows (v1)** — dark blobs drifting in lockstep under the CPU cloud
      puffs (`atmosphere.ts`), above fog/units/cities, below the clouds.

## Roadmap

### Tier 1 — biggest payoff, builds on what's there

1. **Procedural clouds in-shader + soft cloud shadows (v2).** Move clouds from
   scattered CPU puffs to a fullscreen fBm custom shader; cast soft moving shadows
   via a second multiply pass sampling the *same* noise. Supersedes the v1 sprite
   shadows.
2. **Animated fog-of-war.** Replace flat black diamonds with shader-driven drifting
   noise at the explored/unexplored frontier ("smoke curling at the border"), and
   animate reveal as a dissolve instead of a pop.

### Tier 2 — juicy game-feel, cheap

3. **Selection & combat FX.** Shader pulsing selection ring (glow, not frame-cycle),
   tile highlight with animated marching-ants, hit flashes, explosion/impact bursts.
4. **Water sun-glints / specular sparkle.** Animated bright speckles catching
   "sunlight," angled to match the day/night sun direction — pairs with the
   day/night system.

### Tier 3 — post-processing flex (needs `createPostProcess` framegraph)

5. **Post-style vignette/grade as a shader** (replace the baked radial) **+ optional
   bloom-ish glow** on bright sprites (city lights, gold).
6. **Water-edge heat shimmer / distortion.** Displacement shader sampling a feedback
   texture for shimmer over deserts / a "magic" tile — a good flex of `extraTextures`.

### Characterful extras — low risk, sprite-path

7. **City smoke** — thin rising wisps over larger cities (living settlements).
8. **Unit movement trails / dust** — fading puff or footprints behind the moving scout.
9. **Coast foam** — subtle pulsing foam ring on coast tiles.
10. **Weather** — light rain/snow drift, optionally terrain-tied (snow on
    mountains/tundra).
