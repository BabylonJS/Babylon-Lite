# Sprites & MSAA — Proposal and Implementation

> **Status**: Implemented (direct SpriteRenderer pass variant) · **Scope**: Sprite Renderer + frame-graph-compatible engine loop · **Companion docs**: [pr1-pure-2d-sprites-scope.md](pr1-pure-2d-sprites-scope.md), [sprites-implementation-plan.md](sprites-implementation-plan.md)

## Problem

The engine originally hardcoded 4× MSAA for every render pass. That's the right choice for 3D meshes (geometric edges need it), but wasteful for our 2D sprites — they're axis-aligned quads where edges come from texture alpha, not geometry. We were paying ~4× the per-pixel cost of the sprite pass for no visible benefit.

## Original proposal: per-context MSAA

Make MSAA a per-`RenderingContext` setting, defaulting to the engine's MSAA (4) so all current behaviour and parity tests are unchanged. Sprite renderers (and other 2D-style contexts) opt in to MSAA 1.

```ts
// (proposed but not adopted)
createSpriteRenderer(engine, { layers, sampleCount: 1 });
```

This required two render-target sets in the engine (1× depth, 4× color+depth), lazy allocation, an ordering rule (MSAA-4 contexts before MSAA-1), and a doc note.

## What actually shipped: direct SpriteRenderer pass

The frame-graph engine loop now gives each registered `RenderingContext` access to the current command encoder and swapchain view. Scene contexts execute their frame graph. `SpriteRenderer` uses the same per-frame encoder/view but opens its own sprite-only render pass directly on the swapchain:

```ts
const hud = createSpriteRenderer(engine, { layers: [hudLayer], clear: false });
registerSpriteRenderer(hud); // after registerScene(engine, scene)
```

**Consequences:**

- Scene passes still use the scene frame graph and `engine.msaaSamples` for their render targets.
- `SpriteRenderer` always uses `sampleCount = 1`, the engine swapchain format, and no depth attachment. Its pipeline cache key includes the actual sample count it records with.
- HUD overlays preserve the already-rendered scene with `clear: false` (`loadOp: "load"`). Pure-2D renderers use the default `clear: true`.
- There is no `sampleCount` field on `SpriteRendererOptions`; callers choose only whether the direct sprite pass clears or loads the swapchain.

## How sprite scenes use it

Scene 50 and Scene 51 are pure SpriteRenderer scenes. They draw through the direct sampleCount=1 sprite pass regardless of the engine's scene MSAA setting.

Scene 52 demonstrates the mixed HUD case: a normal scene frame graph renders and resolves first, then the HUD `SpriteRenderer` is registered after the scene with `clear: false` so it loads the resolved swapchain color and draws the 2D overlay at sampleCount=1.

Scene 53 demonstrates depth-hosted sprites. Those do not use `SpriteRenderer`; `addSprite2DLayerToScene` creates a scene renderable, so the sprites inherit the frame-graph target's color/depth attachments and sample count.

## Risks & mitigations

- **Parity**: pure-2D/HUD sprites render with the same direct sampleCount=1 path in lab and tests; depth-hosted sprites use the scene target and compare against BJS with the scene's MSAA behavior.
- **Bundle size**: pure-2D scenes import `SpriteRenderer` only; depth-hosted support stays in the sprite-owned `addSprite2DLayerToScene` helper.
- **Pipeline cache**: keyed on sample count, depth state, and depth-stencil format, so direct HUD pipelines and depth-hosted scene pipelines do not alias.
- **Mixed scene/HUD canvases**: supported for the shipped case because the scene resolves into the swapchain before the HUD pass loads it. This is not a general per-context attachment system.

## Future: off-screen HUD / GUI targets

The direct swapchain pass solves pure-2D and HUD-on-3D sprites. It does not solve off-screen HUD/GUI targets, render-to-texture UI, or a future requirement for arbitrary per-context color/depth attachments.

If those arrive, we should revisit one of two designs:

- Extend `SpriteRendererOptions` with explicit off-screen target/depth/resolve attachments.
- Revisit the original per-context attachment proposal and let contexts declare the render target shape they need.

Until then, the shipped API deliberately keeps `SpriteRendererOptions` small: `layers`, `clear`, and `clearValue`.
