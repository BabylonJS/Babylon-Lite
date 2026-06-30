# feat(picking): sprite & billboard picking (`pickSprite2D` + `pickBillboardSprite`)

## Summary

Adds picking for both sprite families, bringing Lite to parity with Babylon's
`scene.pickSprite(x, y)`:

- **`pickSprite2D(layers, xPx, yPx)`** — a pure-CPU hit test for `Sprite2DLayer`
  sprites (HUD / pure-2D). Walks layers in reverse draw order and inverts each
  sprite's pivot + rotation, so it reports exactly the sprite the GPU drew under
  the point. No GPU pass, no scene/camera required.
- **`pickBillboardSprite(scene, xPx, yPx)`** — a GPU picker for world-space
  `*BillboardSpriteSystem` sprites. Billboards are drawn into the **same** 1×1
  depth-sorted pass the mesh picker uses, so a billboard occluded by a mesh (or a
  nearer billboard) correctly loses the pick.

Previously the engine had no sprite-picking primitive at all — the Freeciv demo
had to hand-roll tile selection from analytic grid math. This ships the real
primitive and wires the demo to it.

## Public API

```ts
// 2D sprites — CPU
export function pickSprite2D(layers: ReadonlyArray<Sprite2DLayer>, xPx: number, yPx: number): SpritePickInfo | null;
export interface SpritePickInfo {
    layer: Sprite2DLayer;
    spriteIndex: number;
    u: number;
    v: number;
}

// Billboards — GPU
export function pickBillboardSprite(scene: SceneContext, xPx: number, yPx: number): Promise<BillboardPickInfo | null>;
export interface BillboardPickInfo {
    system: BillboardSpriteSystem;
    spriteIndex: number;
    pickedPoint: [number, number, number] | null;
    distance: number;
}
```

## Design

- **Two pickers, matched to the two families.** 2D sprites are screen-space
  rectangles → a trivial CPU rect test (pure-2D apps have no scene/camera/RT to
  hook a GPU pass into anyway). Billboards live in the 3D depth buffer → they must
  be picked in the shared GPU pass to respect occlusion.
- **Zero cost when unused (mirrors GS picking).** The billboard pick pipeline +
  all its draw/resolve/dispose orchestration live in a dynamically-imported
  `picking/billboard-pick-pipeline.ts`. `gpu-picker.ts` keeps only a thin guarded
  dispatch (`if (scene._billboardSystems.length) …`), exactly like the existing
  Gaussian-splatting picking path. A mesh-only or billboard-free picker scene
  fetches **zero** billboard-pick bytes (verified: the chunk is built but never in
  `runtimeChunks`). 2D `pickSprite2D` lives in its own folder and tree-shakes away
  unless called.
- **No render-path changes.** Picking is purely additive — the only new scene
  state is an opaque `scene._billboardSystems` registry (mirroring `_gsMeshes`),
  so visual parity cannot move.

## Demo

The **Freeciv** demo now selects the scout via `pickSprite2D` against its sprite
(which overhangs its tile and slides between tiles mid-hop), while the _move
destination_ keeps the analytic tile inversion — each technique used where it
fits. Also fixes the lab dev server serving `.spec` / `.tilespec` tileset files
(they were falling through to the SPA HTML fallback).

## Lab scenes

Two new parity scenes alongside the existing picking scenes (113–115):

- **Scene 117 — 2D Sprite Picking** (`pickSprite2D`, MAD 0.005)
- **Scene 118 — Billboard Sprite Picking** (`pickBillboardSprite` vs BJS
  `scene.pickSprite`, MAD 0.041)

## Tests

- Unit: `pick-sprite-2d.test.ts` (11), `billboard-pick.test.ts` (5).
- GPU plumbing: `billboard-pick.spec.ts` — real-WebGPU hit / occlusion / miss.
- Parity: scenes 117 + 118.
- Existing mesh & GS picking parity (113 / 114 / 115 / 129) re-verified green — the
  `gpu-picker` refactor is non-regressing.

## Bundle size

The shared `gpu-picker` dispatch glue grows picker scenes by **~+0.3 KB raw /
+0.1 KB gzip** (consistent with the existing GS-picking pattern; billboard code
itself is 0 bytes unless a scene uses billboards). Three picker-scene ceilings
bumped to absorb this natural growth:

| Scene                  | `maxRawKB`    |
| ---------------------- | ------------- |
| 115 — Alien Picking    | 126.3 → 127   |
| 221 — Pointer Drags    | 100.6 → 101.5 |
| 222 — Composite Gizmos | 111.7 → 112.5 |

`bundle-size.spec.ts`'s `SPRITE_USING_IDS` allowlist gains 117 / 118 (they
legitimately load sprite modules).

## Notes / follow-ups

- `Sprite2DProps.pickable` is accepted for API compatibility but not yet consulted
  by `pickSprite2D` (every visible sprite is pickable) — a future enhancement.
- Compat-layer `scene.pickSprite` remains a separate follow-up.
- Per-hit UV reconstruction for billboards is deferred (not in the v1
  `BillboardPickInfo`).
- Additive change — no breaking-change marker needed.
