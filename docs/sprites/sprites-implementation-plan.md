# Sprites — Implementation Plan

> **Status:** Approved by David. Awaiting first PR.
> **Source spec:** [`architecture/26-sprites.md`](architecture/26-sprites.md)
> **Engine/scene cross-cutting review (David-approved):** [`sprites-scene-engine-changes-review.md`](sprites-scene-engine-changes-review.md)

## Why this document exists

David approved the design but asked that we **land it as a sequence of small PRs, each with visible progress**, rather than one large drop. This document is the agreed sequencing.

It also captures two strategic decisions made before the first PR:

1. We start from a **clean branch off `master`**, not from `lite-2d`.
2. Master already contains an engine/scene decoupling commit (`fe94005 feat(engine): decouple engine from scene; multi-scene rendering via RenderingContext`) — read in detail before scoping PR 1. **PR 0 is effectively done by this commit; sprite PRs build directly on it.** See [Pre-flight outcome](#pre-flight-outcome-fe94005-already-implements-pr-0) below.

---

## Branching strategy

- **`lite-2d` (current branch):** retain locally as a **read-only reference** for porting code. Do not push. Do not merge. Treat it as a working scrapyard.
- **New branch off `master`:** all PRs below land here, one at a time.
- **Each PR is rebased on `master` before merge** to keep history linear.
- **No sprite code is forward-ported wholesale** — each PR rewrites the relevant slice against the spec and pulls only the pieces that fit. This is faster than untangling `lite-2d`'s history and produces smaller, reviewable diffs.

---

## Pre-flight outcome — `fe94005` already implements PR 0

David's commit `fe94005 feat(engine): decouple engine from scene; multi-scene rendering via RenderingContext` lands the engine-side scaffold we'd planned for PR 0, with a slightly different (and better) shape than the `EngineRenderer` we proposed in the review doc.

### What's in master today

**`RenderingContext` interface** (`packages/babylon-lite/src/engine/engine.ts`):

```ts
export interface RenderingContext {
    /** Draw calls produced by pre-pass work during `_update` (shadows + pre-passes). */
    _drawCallsPre: number;
    /** Clear color used when this context is the first active one in a frame. */
    clearColor: GPUColorDict;
    /** Per-frame update: beforeRender hooks, shadow + pre-passes, UBO updates.
     *  May submit work into `encoder` and return a new one if it submitted. */
    _update(encoder: GPUCommandEncoder, delta: number): GPUCommandEncoder;
    /** Record main-pass draws into `pass`. Returns draw-call count. */
    _record(pass: GPURenderPassEncoder): number;
}
```

**Engine state:** `_renderingContexts: RenderingContext[]` on `EngineContextInternal`.

**Public API (already exported from `index.ts`):** `registerScene(engine, scene)`, `unregisterScene(engine, scene)`, `startEngine(engine)` (no scene arg), `disposeScene(scene)` (also unregisters).

**Per-frame loop:** engine walks `_renderingContexts`, calls `_update` on each (pre-pass / shadow work; may return a new encoder), then opens **one shared render pass** — first context clears, subsequent contexts use `loadOp: "load"` and always-resolve MSAA — and calls `_record` on each into that pass.

**Tests:** all 65 pixel-parity tests pass. Bundle ceilings unchanged.

### Why this shape is better than our planned `EngineRenderer`

| Our planned `EngineRenderer`                          | David's `RenderingContext` (shipped)                                                                       |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Single `render(encoder, dt)` method                   | Split into `_update(encoder, dt)` (pre-pass, owns encoder) + `_record(pass)` (records into shared pass)    |
| Each renderer opens its own pass                      | All renderers share one pass per frame — lower overhead, no extra `beginRenderPass`/`end` per registration |
| HUD on top via 2nd registration with `loadOp: "load"` | First registration clears; engine sets `loadOp: "load"` automatically on registrations 2+                  |
| "Clear vs. load" is a registration concern            | "Clear vs. load" is the engine's concern, not the registration's                                           |

Sprites just implement `_update` (sprite UBO updates, atlas readiness) + `_record` (sprite draws). HUD-on-3D works because the sprite context is registered second; engine handles the rest.

### Implications for the rest of the ladder

- **PR 0 is done.** Skipped.
- **`SpriteRenderer` implements `RenderingContext` directly** — no separate `EngineRenderer` interface.
- The review doc's references to `EngineRenderer` should be read as `RenderingContext`. (Will reconcile during PR 1.)
- Public API additions narrow to: `createSpriteRenderer`, `registerSpriteRenderer`, `unregisterSpriteRenderer`, `disposeSpriteRenderer`, plus the `Sprite2DLayer` type. `registerScene`/`unregisterScene`/`startEngine(engine)` already exist.

---

## PR ladder

Each PR must be small enough to review in one sitting, and **each PR must produce a visible visual deliverable** (a new lab scene, or new behavior in an existing one) so progress can be demoed.

> **PR 0 — Engine registration scaffold** is already shipped in master via commit `fe94005`. See [Pre-flight outcome](#pre-flight-outcome-fe94005-already-implements-pr-0). Skipped from the ladder below.

### ~~PR 0 — Engine registration scaffold~~ _(done in master, fe94005)_

_The `RenderingContext` interface, `_renderingContexts` list, `registerScene`/`unregisterScene`/`startEngine(engine)` public API, the shared-pass per-frame loop, and the deprecated-overload backward compat are all already implemented and tested. All 65 parity tests pass; bundle ceilings unchanged. Original PR 0 scope retained below for reference only:_

- `EngineRenderer` interface: `{ render(encoder: GPUCommandEncoder, deltaMs: number): void; dispose(): void }`
- `engine._registrations: EngineRenderer[]` (internal field)
- `registerScene(engine, scene): Promise<void>` — runs deferred builders, wraps scene as `EngineRenderer`, pushes onto `_registrations`
- `unregisterScene(engine, scene): void`
- `startEngine(engine): Promise<void>` — drops `scene` arg; walks `_registrations` per frame
- **Backward-compat:** keep deprecated `startEngine(engine, scene)` overload that internally calls `registerScene` then `startEngine(engine)` so existing 35 lab scenes keep working byte-identical

**Visual proof:** all existing parity scenes still pass byte-identical (no MAD regression).

**Tests:**

- `register-scene.test.ts` — registration order, idempotency, double-register guard
- `start-engine-no-scene.test.ts` — empty registration list resolves cleanly; multi-registration walks in order
- Existing parity suite (full run) — must remain green
- Existing bundle-size ceilings — must hold

**Why first:** every later PR depends on this. Doing it as a separate, zero-feature PR makes review trivial and revert safe.

---

### PR 1 — Pure 2D sprites _(first PR; first new visual)_ ✅ shipped

**Goal:** sprites on screen with no `Scene` involved at all.

**Scope:**

- `Sprite2DLayer` type — `depth: "none"` only for now
- `SpriteRenderer` + `SpriteRendererOptions`. **`SpriteRenderer` implements `RenderingContext` directly** — provides `_update`, `_record`, `_drawCallsPre`, `clearColor`.
- `createSpriteRenderer(engine, opts)` / `registerSpriteRenderer(sr)` / `unregisterSpriteRenderer(sr)` / `disposeSpriteRenderer(sr)`
    - `registerSpriteRenderer` pushes onto the renderer's engine `_renderingContexts` (same list scenes use)
    - `unregisterSpriteRenderer` removes it
- WGSL pipeline + atlas/texture binding
- Module: `sprite-renderer.ts`
- Public-API exports

**No new engine surface.** All engine plumbing (`_renderingContexts`, shared pass, clear-vs-load) is already in master.

**Visual proof:** lab scene `scene50-sprite-grid` is the BJS-validated parity scene that covers PR 1. It exercises the full pure-2D path — atlas, layer, tints, rotation, flipX, and per-sprite size variation — against a BJS `SpriteManager` oracle.

**Tests:**

- `sprite-renderer.test.ts` — create, register, render, unregister, dispose
- Pure-2D bundle-size ceiling (forbids `scene/scene-core.js` entirely from the 2D bundle)
- New parity scene with golden screenshot

**Constraints reminder:** pure-2D ceiling forbids `scene/scene-core.js` — verify with bundle analyzer.

---

### PR 2 — Sprite HUD on top of 3D _(the 2.5D path)_

**Goal:** 3D scene with a static sprite HUD overlay (the canonical game-GUI case).

**Scope:**

- New `addToScene` branch: `_entityType === "sprite-2d-layer"` with `depth: "none"` routes to `_hudSpriteLayers`
- `registerScene` auto-creates an internal `SpriteRenderer` and pushes it onto `engine._renderingContexts` _after_ the scene if `_hudSpriteLayers.length > 0`
- **No special pass plumbing needed** — engine already uses `loadOp: "load"` for registrations 2+; HUD sprite context just disables depth-test in its pipeline

**Visual proof:** new lab scene `scene51-3d-with-sprite-hud` — rotating cube + static health-bar overlay in screen-space.

**Tests:**

- `addToScene-sprite-2d-branch.test.ts` — bucket routing
- `register-scene-hud.test.ts` — HUD `SpriteRenderer` is auto-registered after the scene
- Parity scene with golden screenshot — verifies 3D underneath, HUD on top, no clearing in between

**No power-user opt-out for v1** (per recent decision — API is experimental, breaking later is fine).

---

### PR 3 — Depth-hosted sprites

**Goal:** sprites participate in 3D depth — passes behind / in front of geometry.

**Scope:**

- `Sprite2DLayer` with `depth: "test"` and `"test-write"`
- `addToScene` branch routes these into existing `_opaqueRenderables` / `_transparentRenderables` via `_deferredBuild` — no new render pass, no new pipeline-cache plumbing
- WGSL fragment composes correctly with depth attachment

**Visual proof:** new lab scene `scene52-depth-tested-sprites` — a sprite that is occluded by a rotating 3D mesh.

**Tests:**

- `sprite-2d-depth-routing.test.ts` — verifies `_opaqueRenderables` / `_transparentRenderables` placement
- Parity scene with golden screenshot showing partial occlusion

---

### PR 4 — Billboards (anchored / camera-facing)

**Goal:** dense camera-facing sprites in 3D — trees, particles, UI markers.

**Scope:**

- Port `BillboardSpriteSystem` from `lite-2d` reference, reshaped to live cleanly under the new `SpriteRenderer` / `_deferredBuild` model (or as its own `EngineRenderer` if cleaner — TBD during PR)
- Reuse existing `_sprite3dSceneUBO` / `_anchoredSceneUBO` machinery already on `SceneContextInternal`
- Variants: anchored to a transform vs. world-positioned

**Visual proof:** new lab scene `scene53-billboards` — a field of camera-facing sprites that always face the camera.

**Tests:**

- `billboard-system.test.ts`
- Parity scene with golden screenshot from a fixed camera angle
- Camera-rotation test (sprites stay facing camera)

**Note:** existing `billboard-sprite-system` and `anchored-sprite-layer` branches in `scene-core.ts` should be **rationalized/renamed** under the unified `sprite-2d-layer` discriminator if it makes sense; otherwise kept distinct. Decision deferred to PR 4 author after PRs 1–3 prove the new model.

---

### PR 5 — Sprite picking

**Goal:** clicking a sprite returns which sprite was hit.

**Scope:**

- CPU-side hit-test: ray vs. screen-space quads for HUD sprites (depth:"none"), ray vs. world-space quads for depth-hosted/billboard sprites
- Hooks into existing engine pointer events
- Returns `(layer, spriteIndex)` initially; `Sprite2DHandle` integration comes in PR 6

**Visual proof:** new lab scene `scene54-sprite-picking` — click a sprite, log/highlight it.

**Tests:**

- `sprite-picking.test.ts` — synthetic click coordinates, expected hit results
- Parity scene (visual highlight on click) — may need event-driven golden capture

**Why before handles:** handles need picking as a foundation; doing picking standalone keeps PR 5 small.

---

### PR 6 — Sprite handles _(observable + parentable identity)_

**Goal:** the `Sprite2DHandle` / `BillboardSpriteHandle` API — observable fields, stable id, parenting — so callers don't mutate index arrays directly.

**Scope:**

- `Sprite2DHandle` in `sprite/sprite-2d-handle.ts` (separately importable so index-only scenes don't pull handle code — bundle ceiling enforces this)
- `addSprite2D(layer, init): Sprite2DHandle` / `updateSprite2D(handle, patch)` / `removeSprite2D(handle)`
- Same for billboards: `addBillboardSprite` / `updateBillboardSprite` / `removeBillboardSprite` / `setBillboardSpriteFrame`
- Parenting: handles can have a parent (mesh, transform node, another sprite handle)
- PR 5's picking returns handles when the handle module is loaded, falls back to `(layer, index)` when not

**Visual proof:** new lab scene `scene55-sprite-handles` — drag sprites around the screen using handles + picking; demonstrate parenting (sprite follows a moving 3D mesh).

**Tests:**

- `sprite-2d-handle.test.ts` — create/update/remove, observable field notifications, stable id across reorders
- `sprite-handle-parenting.test.ts` — handle follows parent transform
- Bundle-size ceiling: index-only scenes do not include `sprite-2d-handle.js`

---

## Sequencing rationale

- **PR 0** is the only invisible PR. Everything else produces a screenshot-deliverable.
- **PRs 1 → 2 → 3** climb the rendering complexity ladder: no scene → scene + HUD overlay → scene with depth interaction. Each adds exactly one new concern.
- **PR 4** ports the existing billboard work into the proven new shape.
- **PRs 5 → 6** layer interaction on top of rendering, in dependency order (picking before handles).
- **No PR depends on a future PR.** Each can be reverted independently if needed.

---

## Cross-cutting reminders

These apply to every PR:

- **No side-effect imports.** Add explicit imports for any prototype-augmented method.
- **No allocations in the render loop.** Use scratch buffers; verify with perf tests (user-run only).
- **Backward compatibility** of public API across PRs (the deprecated `startEngine(engine, scene)` overload from PR 0 stays through at least PR 6).
- **Tree-shaking ceilings** — pure-2D bundle forbids `scene/scene-core.js`; index-only scenes forbid `sprite-2d-handle.js`. Each PR adds/maintains the relevant ceiling test.
- **Parity tests must stay green** at every PR boundary. No MAD regression. No golden reference changes without explicit user approval.

---

## Open items

- **Branch name** for the new clean branch off `master` — suggest `lite-sprites` or `lite-2d`. User's choice.
- **PR 4 — keep or unify branches?** Decide whether `anchored-sprite-layer` / `billboard-sprite-system` discriminators get unified under `sprite-2d-layer` or stay distinct. Defer to PR 4 author.
- **Reconcile `sprites-scene-engine-changes-review.md`** with master's actual `RenderingContext` shape (review doc references the older `EngineRenderer` proposal). Cleanup task during PR 1.
