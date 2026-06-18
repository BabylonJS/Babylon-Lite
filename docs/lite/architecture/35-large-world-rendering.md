# Module: Large World Rendering (LWR / Floating Origin)
> Package path: `packages/babylon-lite/src/large-world/floating-origin.ts`

## Purpose

Large World Rendering (LWR) lets the engine render coordinates far from the world origin (~1e5 metres and beyond, up to planet-scale) without the F32 jitter that normally appears in vertex transform pipelines at that magnitude. When `useFloatingOrigin: true` is set on the engine, every frame the active camera's world position is captured as the "floating origin" offset, and all GPU uploads subtract that offset from world-space translations *before* the implicit F32 store. The vertex shader then operates on small-magnitude eye-relative coordinates where F32 precision is comfortable, while the engine maintains accurate world positions on the CPU in F64.

LWR depends on the High-Precision Matrix substrate (`36-high-precision-matrix.md`): subtracting an F64-accurate eye offset from an already-F32-degraded world translation recovers nothing — the low bits were lost upstream. `useFloatingOrigin: true` therefore requires `useHighPrecisionMatrix: true` on the same engine; `createEngine` throws synchronously if the precondition is violated.

## Public API Surface

### Engine option (`engine/engine.ts`)

```typescript
export interface EngineOptions {
    /** When true, every scene on this engine uses the floating-origin
     *  (eye-relative upload) trick to render large-world coordinates without
     *  F32 jitter. Requires `useHighPrecisionMatrix: true` — throws
     *  synchronously if set without it. Defaults to false.
     *
     *  LWR is engine-wide: all scenes created against this engine inherit
     *  the mode. The LWR runtime module (`large-world/floating-origin.js`)
     *  is dynamically imported during `createEngine` only when this flag is
     *  true, so non-LWR engines never pull the module into their bundle. */
    useFloatingOrigin?: boolean;
}
```

### Read-only offset accessor (`large-world/floating-origin.ts`)

```typescript
/** Read the current floating-origin offset from a scene as a `Vec3`.
 *  Returns the live offset (camera world position when FO is on).
 *  For non-LWR engines this function is never reachable because the
 *  module is not imported. */
export function getFloatingOriginOffset(scene: SceneContext): Vec3;
```

## Internal architecture

### Dynamic-import gate

`createEngine` only imports `floating-origin.ts` when `useFloatingOrigin: true`:

```typescript
if (useFO) {
    const { updateFloatingOriginOffset } = await import("../large-world/floating-origin.js");
    _updateFOOffset = updateFloatingOriginOffset;
}
```

The function reference is stored on `engine._updateFOOffset`. Scene `_update` invokes it via optional chaining:

```typescript
eng._updateFOOffset?.(ctx);
```

Non-LWR engines leave the field undefined, the call is a no-op, and the LWR module is never referenced statically anywhere in the package. Tree-shakers drop it entirely from non-LWR bundles. Validated by `tests/parity/bundle-size.spec.ts` ceilings.

### Per-frame offset update (`updateFloatingOriginOffset`)

Called once per frame from scene `_update`, before any render task runs. Reads the active camera's world matrix, copies its translation column into `scene._eyePosition`, and if the offset changed since last frame, copies the same into `scene._floatingOriginOffset`, bumps `scene._floatingOriginVersion`, and invalidates the camera's view-matrix caches:

```typescript
const wm = camera.worldMatrix;
eye[0] = wm[12]; eye[1] = wm[13]; eye[2] = wm[14];
if (offset[0] !== eye[0] || offset[1] !== eye[1] || offset[2] !== eye[2]) {
    offset[0] = eye[0]; offset[1] = eye[1]; offset[2] = eye[2];
    scene._floatingOriginVersion++;
    camera._viewVer = -1;
    camera._vpVer = -1;
}
```

The version bump is the signal renderable closures use to re-pack mesh UBOs with the new offset (see below). The view/vp cache invalidation forces `getViewMatrix` to recompute on the next access — required because the view matrix is keyed on `worldMatrixVersion` only, and the camera's `worldMatrix` does not bump when only the FO offset changes.

### Three places the offset is subtracted

1. **`getViewMatrix(camera)`** (`camera/camera.ts`): when `camera._floatingOriginOffset` is set, the offset is subtracted from the camera world position *before* the `R_inv * -cameraPos` calculation produces the view translation. When `offset == cameraPos` (the steady-state case), the resulting view translation is mathematically zero. The view matrix uploads therefore use the precision-only `packMat4IntoF32` (no 5th argument) — a second subtraction at upload would double-bias the translation.

2. **Mesh-world UBO uploads** (`material/{standard,pbr,node}-renderable.ts`): each renderable's per-frame update calls `packMat4IntoF32(meshUboData, mesh.worldMatrix, 0, 0, _foOffset)`. The packer subtracts `_foOffset` from the translation column `[12..14]` during pack. Subtraction happens in JS number precision (F64) before the implicit F32 store, recovering the small remainder at full precision.

3. **`vEyePosition` uniform** (`frame-graph/render-task.ts`): `writePassSceneUBO` writes `camera.worldMatrix[12..14] - scene._floatingOriginOffset[0..2]` for the eye-position uniform. Shader expressions of the form `vEyePosition - input.worldPos` now produce the eye-relative vector at full precision because both sides live in the small-magnitude frame.

### Per-renderable version tracking

The mesh UBO encodes `worldMatrix - foOffset`. The UBO contents depend on **two independent inputs**: the mesh moves (bumps `mesh.worldMatrixVersion`) OR the FO offset changes (bumps `scene._floatingOriginVersion`). Each renderable closure tracks both:

```typescript
let _lastWorldVersion = -1;
let _lastFoVersion = -1;
const _foOffset = scene._floatingOriginOffset;

const update = (): void => {
    const foVer = scene._floatingOriginVersion;
    if (mesh.worldMatrixVersion !== _lastWorldVersion || foVer !== _lastFoVersion || s.lights.length !== _lastLightsCount) {
        packMat4IntoF32(meshUboData, mesh.worldMatrix, 0, 0, _foOffset);
        device.queue.writeBuffer(meshUBO, 0, meshUboData);
        _lastWorldVersion = mesh.worldMatrixVersion;
        _lastFoVersion = foVer;
        // ...
    }
};
```

Without the version check, a camera move (which changes the FO offset but does NOT change `mesh.worldMatrixVersion`) would leave every mesh UBO holding stale `world - oldOffset` bytes — visible as a per-frame displacement of every mesh.

For non-LWR engines, `scene._floatingOriginVersion` stays at 0 forever and the `foVer !== _lastFoVersion` branch is always false after the first frame — dead at runtime but bundled regardless. The cost is the price of LWR support; eliminating the dead bytes from non-LWR bundles would require two closure variants (likely a bundle regression overall).

### Scene state fields

```typescript
interface SceneContextInternal {
    /** Mutable backing for `scene.floatingOriginOffset` (the read-only
     *  public accessor goes via `getFloatingOriginOffset`). Always
     *  `[0, 0, 0]` on non-LWR scenes (write-skipped by the per-frame
     *  updater when the engine has no `_updateFOOffset`). */
    _floatingOriginOffset: [number, number, number];
    /** Monotonic version counter bumped by `updateFloatingOriginOffset`
     *  whenever the offset numerically changes. Renderable closures
     *  compare against this to invalidate per-mesh UBO uploads. */
    _floatingOriginVersion: number;
    /** Camera world position copied each frame by
     *  `updateFloatingOriginOffset` so consumers can read eye position
     *  without bouncing through the camera. */
    _eyePosition: [number, number, number];
}
```

The fields exist on every scene regardless of `useFloatingOrigin` to keep the renderable closure shape uniform. For non-LWR scenes the version stays 0 and the offset stays `[0, 0, 0]`, so all subtractions are no-ops and all version comparisons are dead.

## Validation

- Unit: `tests/unit/floating-origin.test.ts` covers the per-frame update — offset tracking, version bumping on change, no bump when steady, camera cache invalidation.
- Unit: `tests/unit/floating-origin-upload.test.ts` covers the precision-recovery path — `packMat4IntoF32` with `offsetXYZ` on a mesh at world `1e6 + delta` lands `delta` in the F32 view; the no-offset control case loses `delta` to F32 quantization.
- Parity: `tests/parity/scenes/scene200-fo-off.spec.ts` and `scene201-fo-on.spec.ts` render the same far-from-origin scene with FO off vs FO on. The two captures MUST diverge (cross-golden MAD ≥ 5.0), proving the offset path is engaged and meaningfully shifts pixels.
- Bundle: HPM-off bundles do not contain the LWR module; LWR-on bundle adds ~1-2 KB per scene for the FO logic.

## Tree-shaking proof

Non-LWR bundles do not statically reference `large-world/floating-origin.js`. The only mention is `eng._updateFOOffset?.(scene)` in `scene-core.ts` — a property access on an undefined field, no module import. `createEngine`'s `await import(...)` lives inside `if (useFO)`, which the bundler proves unreachable when `useFloatingOrigin` is never set true in any reachable scene. Verified by bundle-size ceilings.

## Files / size

| File | Purpose |
|------|---------|
| `large-world/floating-origin.ts` (~70 lines) | `updateFloatingOriginOffset` per-frame update + `getFloatingOriginOffset` public read |
| `engine/engine.ts` (FO block in `createEngine`) | Dynamic-import gate, `useFO && !useHpm` validation |
| `scene/scene-core.ts` (`_eyePosition`, `_floatingOriginOffset`, `_floatingOriginVersion`, `_update` wiring) | Per-scene state + per-frame trigger |
| `camera/camera.ts` (`_floatingOriginOffset?` field, `getViewMatrix` subtract) | View-matrix offset bake |
| `material/{standard,pbr,node}-renderable.ts` (FO version tracking) | Mesh UBO invalidation when offset changes |
| `frame-graph/render-task.ts` (`vEyePosition` subtract) | Scene UBO eye-position offset |
| `math/pack-mat4-into-f32.ts` (`offsetXYZ` 5th arg) | Subtraction at the GPU pack boundary |

## Wired features

Beyond the foundation (mesh world matrix, view matrix, eye position), the following
features subtract the active-camera offset so they stay precise at far-from-origin scale.
Each has a paired parity scene (Lite `useFloatingOrigin` vs BJS `useLargeWorldRendering`):

- Point + spot light positions (lights UBO offset bake) — scenes 202, 203.
- Thin-instance per-instance world matrices — scene 204.
- Sprites / billboard sprites (anchor offset bake on both upload paths) — scenes 205 (facing transparent), 206 (cutout/opaque).
- Shadow light-space matrix (PCF directional/spot + ESM directional generators build the
  light view/projection eye-relative, so the caster pass and receiver shader stay consistent
  with the eye-relative mesh world matrices) — scene 207.
- NodeMaterial mesh-world transform (NME resolves `worldViewProjection` to
  `sceneU.viewProjection * meshU.world`, where `meshU.world` is FO-packed eye-relative) — scene 208.
- Havok physics: **multi-region floating origin** (opt-in). Calling `enableHavokFloatingOrigin(world)`
  (loaded on demand) makes `physics/havok.ts` simulate bodies in regions centred near them (local
  coordinates near zero) so the float32 Havok solver keeps precision at far-from-origin scale; node
  transforms remain true
  world coordinates and the eye-relative render path is unchanged. Bodies migrate between regions
  (with velocity preserved and a 20% hysteresis margin) as they cross region boundaries, mirroring
  Babylon.js's `scene.floatingOriginMode` + Havok plugin `floatingOriginWorldRadius`. Per-region
  gravity is supported via the optional `worldPosition` argument to `setPhysicsGravity` — scene 209.

## Out of scope

Three features are **degenerate in Babylon.js itself** under `useLargeWorldRendering`, so there
is no correct far-from-origin reference to match and Lite intentionally does not wire them:

- Clip planes: Babylon.js `BindClipPlane` (`Materials/clipPlaneMaterialHelper`) uploads the plane
  with a plain `setFloat4` (no offset bias), while the shader evaluates `dot(worldPos, n) + d`
  against an eye-relative `worldPos`. The raw world-space `d` (≈ −offset·n) clips the whole scene —
  Babylon.js renders fully black far from the origin.
- Clustered point lights: `Lights/Clustered/clusteredLightContainer` packs raw world light
  positions into the light-data texture with no offset; the shader diffs them against eye-relative
  `posW`, so every clustered light becomes effectively infinitely far and contributes nothing.
- Background-ground / skybox material: Babylon.js makes `vEyePosition` eye-relative (≈0) under
  `useLargeWorldRendering` but leaves `BackgroundMaterial.sceneCenter` (→ `vBackgroundCenter`) at
  the world origin for the OPACITYFRESNEL path (only REFLECTIONFRESNEL is offset). The floor
  falloff term `dot(normalW, normalize(vEyePosition - vBackgroundCenter))` degenerates to
  `normalize(0)` and the ground fades to fully transparent. (`createDefaultEnvironment` users
  should keep the environment near the origin.)

- Particles: N/A — Lite has no particle system.
- Rect-area lights, cascaded shadow maps, edges/bounding-box renderers, utility-layer/gizmos:
  N/A — Lite does not implement these yet. Babylon.js floating-origin-wires them; when any is
  ported to Lite, the floating-origin offset MUST be ported with it (see `GUIDANCE.md` →
  "Large World Rendering — Feature Parity").

These extensions slot into the same substrate (per-frame version tracking, packer offset path,
scene state) already used by the wired features.
