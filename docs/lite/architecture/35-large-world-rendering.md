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

Each reference is stored on the engine (`engine._wrapRenderableForFO`, `_makePackMeshWorld`, `_lightFoVersion`, `_applyLightFoOffset`). Consumers reach them through optional chaining with a non-FO fallback, e.g. `engine._makePackMeshWorld?.(scene) ?? packMat4IntoF32`. Non-LWR engines leave every field undefined, so no consumer of the FO runtime imports the module statically. Tree-shakers drop it entirely from non-LWR bundles. Validated by `tests/parity/bundle-size.spec.ts` ceilings.

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

### Four places the offset is applied

1. **`getViewMatrix(camera)`** (`camera/camera.ts`): when `camera._useFloatingOrigin` is set, the camera-position components are substituted with zero (`const cx = useFO ? 0 : w[12]!`, and likewise `cy`/`cz`) before the `-(R_inv * cameraPos)` calculation produces the view translation. No offset is subtracted — the offset _is_ the camera position, so under FO the view translation is exactly zero by construction. The view matrix therefore uploads through the precision-only `packMat4IntoF32`; routing it through the offset packer would bias the translation a second time.

2. **Mesh-world UBO uploads** (`material/{standard,pbr,node}-renderable.ts`): each renderable resolves its packer once at construction with `engine._makePackMeshWorld?.(scene) ?? packMat4IntoF32`, then invokes it with the same four arguments either way — `(view, mat, offsetFloats, srcOffsetFloats)`. Under FO that resolves to `makePackMeshWorld(scene)` (`large-world/pack-mat4-with-offset.ts`), whose `packMat4IntoF32WithOffset` subtracts the camera-derived offset from the translation column `[12..14]`. The subtraction happens in JS number precision (F64) before the implicit F32 store, recovering the small remainder at full precision.

3. **`vEyePosition` uniform** (`frame-graph/scene-uniforms-pack.ts`): `_packSceneUniforms` — which `_writePassSceneUBO` calls — writes literal zeroes into `data[32..34]` when `engine.useFloatingOrigin` is set, and the raw camera world position otherwise. It performs no subtraction and does not read the offset helper. Zero is the correct eye position because mesh world translations were already rebased by (2), so shader expressions of the form `vEyePosition - input.worldPos` produce the eye-relative vector at full precision with both sides in the small-magnitude frame.

4. **ShaderMaterial system uniforms** (`material/shader/shader-renderable.ts`): ShaderMaterial writes its own UBO rather than going through `packMat4IntoF32`, so it cannot inherit the subtraction from (2). `_shaderWorldMatrix(mesh, camera, out?)` performs it instead, returning a camera-relative copy of `mesh.worldMatrix` that `world`, `worldView` and `worldViewProjection` are all derived from — they must share one frame, or passes reading different uniforms tear apart. `cameraPosition` is written as zero for the same reason `vEyePosition` is in (3). Both writers share the helper, so enabling `enable-shader-material-uniform-caching.ts` changes only how often the UBO is serialized, never what it contains. `LineMaterial` is a ShaderMaterial underneath and is covered by the same path.

    This one keys on `camera._useFloatingOrigin` rather than the engine flag, so the test is bit-for-bit the one `getViewMatrix` applies to the _same_ camera. A render-target task drawing through a non-scene camera then gets an untranslated view **and** an absolute world, which is self-consistent.

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

LWR stores no mirror fields on `SceneContext`: the offset is the active camera's world position, read on demand, and invalidation rides that camera's `worldMatrixVersion`. Non-LWR scenes therefore carry no inert zeroed offset/version state.

`scene/scene-core.ts` does retain the LWR lifecycle, and it is the only writer of it. Inside `_update`, the first frame with FO on stamps the flag `getViewMatrix` reads and drops the stale view caches:

```typescript
if (eng.useFloatingOrigin && ctx.camera && !ctx.camera._useFloatingOrigin) {
    ctx.camera._useFloatingOrigin = true;
    ctx.camera._viewVer = -1;
    ctx.camera._vpVer = -1;
}
```

## Validation

- Unit: `tests/unit/floating-origin.test.ts` covers the offset read and the lifecycle — `getFloatingOriginOffset` returning the active camera's world position and zero when no camera is set, and `scene._update` stamping `camera._useFloatingOrigin` only when the engine has FO on.
- Unit: `tests/unit/floating-origin-upload.test.ts` covers the zeroing and precision-recovery paths — `getViewMatrix` zeroing the view translation under `_useFloatingOrigin` (with the FO-off large-magnitude control), `packMat4IntoF32WithOffset` landing `delta` in the F32 view for a mesh at world `1e6 + delta`, and the eye-relative-zero `vEyePosition` write.
- Unit: `tests/unit/shader-material-floating-origin.test.ts` covers subtraction site (4) behaviourally — moving the camera toward a fixed mesh must change projected depth and on-screen span in proportion to the real distance, `world`/`worldView`/`worldViewProjection` must stay in one frame, and the eye must sit at the origin under FO and at its real position without it. The FO-off cases are controls: without them a fix that merely zeroed the translation would pass.
- Parity: `tests/parity/scenes/scene200-fo-off.spec.ts` and `scene201-fo-on.spec.ts` render the same far-from-origin scene with FO off vs FO on. The two captures MUST diverge (cross-golden MAD ≥ 5.0), proving the offset path is engaged and meaningfully shifts pixels.
- Bundle: HPM-off bundles do not contain the LWR module; LWR-on bundle adds ~1-2 KB per scene for the FO logic.

## Tree-shaking proof

The module has exactly one static edge in the source tree: `index.ts` re-exports `getFloatingOriginOffset` from it. That edge is tree-shakeable — a scene that never imports the accessor drops it — and it carries only the accessor, not the FO runtime.

Everything else is reached dynamically. Consumers of the runtime go through engine fields left undefined when FO is off (`engine._wrapRenderableForFO?.(...)`, `engine._makePackMeshWorld?.(...)`), which are property accesses rather than module imports, and `createEngine`'s `await import(...)` lives inside `if (useFO)`, which the bundler proves unreachable when `useFloatingOrigin` is never set true in any reachable scene. So a non-LWR bundle contains neither the accessor nor the runtime. Verified by bundle-size ceilings.

## Files / size

| File                                                                        | Purpose                                                                         |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `large-world/floating-origin.ts` (~70 lines)                                | `getFloatingOriginOffset` public read, `wrapRenderableForFO`, light FO helpers  |
| `engine/engine.ts` (FO block in `createEngine`)                             | Dynamic-import gate, `useFO && !useHpm` validation                              |
| `large-world/pack-mat4-with-offset.ts`                                      | `makePackMeshWorld` — mesh-world packer subtracting the offset at the F32 store |
| `camera/camera.ts` (`_useFloatingOrigin?` flag, `getViewMatrix` zeroing)    | View translation zeroed under FO                                                |
| `scene/scene-core.ts` (`_update` FO block)                                  | Stamps `camera._useFloatingOrigin`, invalidates `_viewVer` / `_vpVer`           |
| `material/{standard,pbr,node}-renderable.ts` (packer selection, FO wrapper) | Mesh UBO invalidation when the camera moves                                     |
| `frame-graph/scene-uniforms-pack.ts` (`_packSceneUniforms`)                 | Writes `vEyePosition = (0, 0, 0)` under FO                                      |
| `math/pack-mat4-into-f32.ts` (`packMat4IntoF32`)                            | Precision-only packer; the non-FO fallback and the view-matrix path             |

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
