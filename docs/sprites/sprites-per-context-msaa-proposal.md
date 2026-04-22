# Sprites & MSAA — Proposal and Implementation

> **Status**: Implemented (engine-wide variant) · **Scope**: Engine + Sprite Renderer · **Companion docs**: [pr1-pure-2d-sprites-scope.md](pr1-pure-2d-sprites-scope.md), [sprites-implementation-plan.md](sprites-implementation-plan.md)

## Problem

The engine originally hardcoded 4× MSAA for every render pass. That's the right choice for 3D meshes (geometric edges need it), but wasteful for our 2D sprites — they're axis-aligned quads where edges come from texture alpha, not geometry. We were paying ~4× the per-pixel cost of the sprite pass for no visible benefit.

## Original proposal: per-context MSAA

Make MSAA a per-`RenderingContext` setting, defaulting to the engine's MSAA (4) so all current behaviour and parity tests are unchanged. Sprite renderers (and other 2D-style contexts) opt in to MSAA 1.

```ts
// (proposed but not adopted)
createSpriteRenderer(engine, { layers, sampleCount: 1 });
```

This required two render-target sets in the engine (1× depth, 4× color+depth), lazy allocation, an ordering rule (MSAA-4 contexts before MSAA-1), and a doc note.

## What actually shipped: engine-wide MSAA

The architect chose a simpler design: **engine-wide** MSAA, set once at engine creation.

```ts
// engine.ts (current)
export interface EngineOptions {
    msaaSamples?: 1 | 4; // WebGPU only permits 1 or 4; default 4
}
createEngine(canvas, { msaaSamples: 1 });
```

**Consequences:**

- One render-target set per engine. When `msaaSamples === 1`, no MSAA color texture is created at all (engine renders directly into the swapchain), and the depth buffer is allocated at sample count 1. Same lazy/zero-cost outcome as the proposal for the pure-2D case.
- `SpriteRenderer` reads `eng.msaaSamples` and uses it for its pipeline cache. The `sampleCount` field on `SpriteRendererOptions` remains accepted-but-ignored (forward-compat for a future per-context world).
- No ordering rule needed; no second pass needed.
- Trade-off: a single canvas can't mix MSAA-4 3D meshes with MSAA-1 sprites. For the pure-2D PR1 surface this is fine; if we ever want mixed MSAA in one canvas we revisit the original proposal.

## How sprite scenes use it

Scene 50 and Scene 51 (the parity oracles for straight-alpha and premultiplied sprites) read MSAA from a URL query parameter:

```ts
// lab/src/lite/scene50.ts and scene51.ts
const msaaParam = new URLSearchParams(window.location.search).get("msaa");
const msaaSamples: 1 | 4 = msaaParam === "4" ? 4 : 1;
const engine = await createEngine(canvas, { msaaSamples });
```

- **Default (lab demo, real-world use)**: MSAA 1 — full perf benefit.
- **Parity tests**: navigate with `?msaa=4` so we match the BJS oracle (BJS's default WebGPU engine uses 4× MSAA, and we want the comparison to be apples-to-apples).

```ts
// tests/parity/scenes/scene50-sprite-grid.spec.ts
await page.goto("/scene50.html?msaa=4");
```

## Risks & mitigations

- **Parity**: tests force `?msaa=4`, so MAD against BJS goldens is unchanged.
- **Bundle size**: zero — `EngineOptions` already exists.
- **Pipeline cache**: keyed on sample count, so MSAA-1 and MSAA-4 sprite pipelines coexist cleanly even if the same dev session opens both URLs.
- **Mixed-MSAA canvases**: not supported. If/when needed, escalate back to the per-context proposal at the top of this doc.

## Future: HUD / GUI will hit this again

The engine-wide MSAA decision is the right call for the pure-2D sprite PR (each app picks one mode), but the moment we land HUD or GUI on top of a 3D scene we get the exact same problem **inside a single canvas**:

- 3D scene wants MSAA 4 (geometric edges).
- HUD / GUI wants MSAA 1 (text, icons, panels are axis-aligned bitmaps; crispness comes from the font atlas / SDF, not from sample coverage). HUD coverage is often a large fraction of the screen — this is real perf, not a micro-optimisation.

Engine-wide MSAA gives us only bad choices when both coexist:

1. **Force HUD to MSAA 4** — pay ~4× shading cost on HUD pixels for no visible benefit.
2. **Force scene to MSAA 1** — kill 3D mesh quality.
3. **HUD renders to its own offscreen MSAA-1 RT, then we composite it into the swapchain** after the 3D pass resolves. Works, but it's a second pass + a blit + the HUD owning its own RT lifecycle. Heavier than per-context MSAA.
4. **Resurrect the per-context proposal at the top of this doc**: two depth targets in the engine, contexts pick their sample count, MSAA-4 contexts register first so the MSAA-1 HUD pass can `loadOp: "load"` the resolved swapchain.

Related GUI-only constraint: GUI usually wants **no depth buffer at all** (z-order is draw order). Engine-wide config can't express that either; per-context naturally can, since each pass picks its own attachments.

**Recommendation:** when HUD/GUI work starts, treat the per-context refactor as a prerequisite. The proposal at the top of this doc is the design we'd implement at that point.
