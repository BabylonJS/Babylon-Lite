# Module: Large World Rendering (LWR / Floating Origin)

> Package path: `packages/babylon-lite/src/large-world/floating-origin.ts`

## Purpose

Large World Rendering (LWR) lets the engine render coordinates far from the world origin (~1e5 metres and beyond, up to planet-scale) without the F32 jitter that normally appears in vertex transform pipelines at that magnitude. When `useFloatingOrigin: true` is set on the engine, every frame the active camera's world position is captured as the "floating origin" offset, and all GPU uploads subtract that offset from world-space translations _before_ the implicit F32 store. The vertex shader then operates on small-magnitude eye-relative coordinates where F32 precision is comfortable, while the engine maintains accurate world positions on the CPU in F64.

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
    const [{ wrapRenderableForFO, lightFoVersion, applyLightFoOffset }, { makePackMeshWorld }] = await Promise.all([
        import("../large-world/floating-origin.js"),
        import("../large-world/pack-mat4-with-offset.js"),
    ]);
    _wrapRenderableForFO = wrapRenderableForFO;
    _makePackMeshWorld = makePackMeshWorld;
    _lightFoVersion = lightFoVersion;
    _applyLightFoOffset = applyLightFoOffset;
}
```

Each reference is stored on the engine (`engine._wrapRenderableForFO`, `_makePackMeshWorld`, `_lightFoVersion`, `_applyLightFoOffset`). Consumers reach them through optional chaining with a non-FO fallback, e.g. `engine._makePackMeshWorld?.(scene) ?? packMat4IntoF32`. Non-LWR engines leave every field undefined, so the LWR module is never referenced statically anywhere in the package. Tree-shakers drop it entirely from non-LWR bundles. Validated by `tests/parity/bundle-size.spec.ts` ceilings.

### Reading the offset (`getFloatingOriginOffset`)

The floating-origin offset **is** the active camera's world position; there is no scene-side mirror of it. Each consumer derives it at the moment of use:

```typescript
export function getFloatingOriginOffset(scene: SceneContext): Vec3 {
    const cam = scene.camera;
    if (!cam) {
        return { x: 0, y: 0, z: 0 };
    }
    const w = cam.worldMatrix;
    return { x: w[12]!, y: w[13]!, z: w[14]! };
}
```

An earlier design kept `scene._floatingOriginOffset` / `_floatingOriginVersion` / `_eyePosition` in sync through a per-frame `updateFloatingOriginOffset` call. That was removed as net cost without value: the mirror had to be written every frame and read through an extra indirection, to hold a value the camera already carries. Invalidation now rides the camera's own `worldMatrixVersion` (see below).

### Four places the offset is subtracted

1. **`getViewMatrix(camera)`** (`camera/camera.ts`): when `camera._useFloatingOrigin` is set, the offset is subtracted from the camera world position _before_ the `R_inv * -cameraPos` calculation produces the view translation. When `offset == cameraPos` (the steady-state case), the resulting view translation is mathematically zero. The view matrix uploads therefore use the precision-only `packMat4IntoF32` (no 5th argument) — a second subtraction at upload would double-bias the translation.

2. **Mesh-world UBO uploads** (`material/{standard,pbr,node}-renderable.ts`): each renderable's per-frame update calls `packMat4IntoF32(meshUboData, mesh.worldMatrix, 0, 0, _foOffset)`. The packer subtracts `_foOffset` from the translation column `[12..14]` during pack. Subtraction happens in JS number precision (F64) before the implicit F32 store, recovering the small remainder at full precision.

3. **`vEyePosition` uniform** (`frame-graph/render-task.ts`): `writePassSceneUBO` writes `camera.worldMatrix[12..14] - getFloatingOriginOffset(scene)` for the eye-position uniform. Shader expressions of the form `vEyePosition - input.worldPos` now produce the eye-relative vector at full precision because both sides live in the small-magnitude frame.

4. **ShaderMaterial system uniforms** (`material/shader/shader-renderable.ts`): ShaderMaterial writes its own UBO rather than going through `packMat4IntoF32`, so it cannot inherit the subtraction from (2). `_shaderWorldMatrix(mesh, camera, out?)` performs it instead, returning a camera-relative copy of `mesh.worldMatrix` that `world`, `worldView` and `worldViewProjection` are all derived from — they must share one frame, or passes reading different uniforms tear apart. `cameraPosition` is written as zero for the same reason `vEyePosition` is in (3). Both writers share the helper, so enabling `enable-shader-material-uniform-caching.ts` changes only how often the UBO is serialized, never what it contains. `LineMaterial` is a ShaderMaterial underneath and is covered by the same path.

   This one keys on `camera._useFloatingOrigin` rather than the engine flag, so the test is bit-for-bit the one `getViewMatrix` applies to the *same* camera. A render-target task drawing through a non-scene camera then gets an untranslated view **and** an absolute world, which is self-consistent.

### Per-renderable version tracking

The mesh UBO encodes `worldMatrix - foOffset`. Its contents depend on **two independent inputs**: the mesh moves (bumping `mesh.worldMatrixVersion`) OR the camera moves, which moves the offset. Rather than inline a second version check into every renderable closure, the camera check lives in one wrapper applied only when FO is on:

```typescript
export function wrapRenderableForFO(inner: () => void, scene: SceneContext, invalidate: () => void): () => void {
    let _lastCameraVersion = -1;
    return (): void => {
        const cv = scene.camera ? scene.camera.worldMatrixVersion : -1;
        if (cv !== _lastCameraVersion) {
            invalidate();
            _lastCameraVersion = cv;
        }
        inner();
    };
}
```

`invalidate()` resets the renderable's `_lastWorldVersion` to -1, forcing the inner update's "worldMatrix changed" branch to fire and re-pack with the new offset. Renderables opt in with `engine._wrapRenderableForFO?.(_baseUpdate, scene, _invalidate) ?? _baseUpdate`, so non-LWR engines fall through to the bare update with no wrapper overhead and no FO version tracking bundled into the shared closure.

Without this, a camera move — which changes the offset but does NOT change `mesh.worldMatrixVersion` — would leave every mesh UBO holding stale `world - oldOffset` bytes, visible as a per-frame displacement of every mesh.

### Scene state

None. LWR adds no fields to `SceneContext`: the offset is the active camera's world position, read on demand, and invalidation rides that camera's `worldMatrixVersion`. Non-LWR scenes therefore carry no LWR state at all, rather than inert zeroed fields.

## Validation

- Unit: `tests/unit/floating-origin.test.ts` covers the per-frame update — offset tracking, version bumping on change, no bump when steady, camera cache invalidation.
- Unit: `tests/unit/floating-origin-upload.test.ts` covers the precision-recovery path — `packMat4IntoF32` with `offsetXYZ` on a mesh at world `1e6 + delta` lands `delta` in the F32 view; the no-offset control case loses `delta` to F32 quantization.
- Unit: `tests/unit/shader-material-floating-origin.test.ts` covers subtraction site (4) behaviourally — moving the camera toward a fixed mesh must change projected depth and on-screen span in proportion to the real distance, `world`/`worldView`/`worldViewProjection` must stay in one frame, and the eye must sit at the origin under FO and at its real position without it. The FO-off cases are controls: without them a fix that merely zeroed the translation would pass.
- Parity: `tests/parity/scenes/scene200-fo-off.spec.ts` and `scene201-fo-on.spec.ts` render the same far-from-origin scene with FO off vs FO on. The two captures MUST diverge (cross-golden MAD ≥ 5.0), proving the offset path is engaged and meaningfully shifts pixels.
- Bundle: HPM-off bundles do not contain the LWR module; LWR-on bundle adds ~1-2 KB per scene for the FO logic.

## Tree-shaking proof

Non-LWR bundles do not statically reference `large-world/floating-origin.js`. Every mention is a property access on an engine field left undefined when FO is off (`engine._wrapRenderableForFO?.(...)`, `engine._makePackMeshWorld?.(...)`), never a module import. `createEngine`'s `await import(...)` lives inside `if (useFO)`, which the bundler proves unreachable when `useFloatingOrigin` is never set true in any reachable scene. Verified by bundle-size ceilings.

## Files / size

| File                                                                                                        | Purpose                                                                               |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `large-world/floating-origin.ts` (~70 lines)                                                                | `getFloatingOriginOffset` public read, `wrapRenderableForFO`, light FO helpers         |
| `engine/engine.ts` (FO block in `createEngine`)                                                             | Dynamic-import gate, `useFO && !useHpm` validation                                    |
| `large-world/pack-mat4-with-offset.ts`                                                                      | `makePackMeshWorld` — mesh-world packer subtracting the offset at the F32 store        |
| `camera/camera.ts` (`_useFloatingOrigin?` flag, `getViewMatrix` subtract)                                   | View-matrix offset bake                                                               |
| `material/{standard,pbr,node}-renderable.ts` (FO version tracking)                                          | Mesh UBO invalidation when offset changes                                             |
| `frame-graph/render-task.ts` (`vEyePosition` subtract)                                                      | Scene UBO eye-position offset                                                         |
| `math/pack-mat4-into-f32.ts` (`offsetXYZ` 5th arg)                                                          | Subtraction at the GPU pack boundary                                                  |

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
