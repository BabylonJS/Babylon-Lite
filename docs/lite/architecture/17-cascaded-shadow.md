# Module: Cascaded Shadow Maps (CSM)

> Package paths:
> `packages/babylon-lite/src/shadow/csm-directional-shadow-generator.ts`
> `packages/babylon-lite/src/shadow/csm-shadow-task-hooks.ts`
> `packages/babylon-lite/src/shader/fragments/csm-shadow-fragment-core.ts`
> `packages/babylon-lite/src/material/standard/fragments/std-csm-shadow-fragment.ts`

## Purpose

Cascaded Shadow Maps for a **directional light**, matching Babylon.js
`CascadedShadowGenerator` with the default 5×5 PCF filter (`computeShadowWithCSMPCF5`).
The camera view frustum is split into N depth slices (cascades); each cascade gets
its own orthographic shadow map fit tightly to that slice, rendered into one layer
of a `depth32float` `texture_2d_array`. The receiver selects a cascade per fragment
from the camera-view-space depth and samples that array layer with PCF5, optionally
cross-fading into the next cascade near the slice boundary.

All substantive CSM code lives in the four modules above plus a byte-minimal set of
shared edits (see *Bundle Discipline*), so ESM/PCF scenes are byte-unaffected.

## Public API Surface

```ts
interface CsmDirectionalShadowGeneratorConfig {
    mapSize?: number;                 // per-cascade square resolution, default 1024
    numCascades?: number;             // default 4 (max 4)
    lambda?: number;                  // log/uniform split blend 0..1, default 0.5
    cascadeBlendPercentage?: number;  // cross-fade fraction, default 0.1 (0 disables)
    stabilizeCascades?: boolean;      // bounding-sphere fit (no shimmer), default false
    shadowMaxZ?: number;              // max shadow distance, default = camera far plane
    bias?: number;                    // depth bias, default 0.00005
    darkness?: number;                // 0 = black shadow, 1 = no shadow, default 0
    frustumEdgeFalloff?: number;      // soft cascade-edge fade 0..1, default 0
    forceRefreshEveryFrame?: boolean; // default false
}

function createCsmDirectionalShadowGenerator(
    engine: EngineContext,
    light: DirectionalLight,
    cfg?: CsmDirectionalShadowGeneratorConfig
): ShadowGenerator;
```

Usage mirrors the other directional generators:

```ts
const light = createDirectionalLight([0, -1, -1], 0.8);
addToScene(scene, light);
light.shadowGenerator = createCsmDirectionalShadowGenerator(engine, light, { mapSize: 1024 });
setShadowTaskCasterMeshes(light.shadowGenerator, casterMeshes);
// receivers: mesh.receiveShadows = true
await registerSceneWithShadowSupport(scene);
```

## Internal Architecture

### `ShadowGenerator` extensions (shared interface, type-only)
- `_shadowType` union widened `"esm" | "pcf"` → `"esm" | "pcf" | "csm"`.
- `_depthView: GPUTextureView` — pre-created receiver-facing view. ESM/PCF set a 2d
  view, CSM sets a `dimension:"2d-array"` view. Receiver renderables bind
  `sg._depthView` (instead of `sg._depthTexture.createView()`) so they stay
  texture-dimension-agnostic with no per-type branch.
- `_csmCascadeCount?: number` — number of cascades, read by the receiver renderable
  to bake the cascade-select loop bound.

### Receiver UBO layout (`_shadowUBO`, 320 bytes / 80 f32)
| offset (f32) | field                | type                  |
|--------------|----------------------|-----------------------|
| 0..63        | `cascadeTransforms`  | `array<mat4x4, 4>`    |
| 64..67       | `viewFrustumZ`       | `vec4<f32>`           |
| 68..71       | `frustumLengths`     | `vec4<f32>`           |
| 72..75       | `shadowsInfo`        | `vec4<f32>` (darkness, mapSize, 1/mapSize, frustumEdgeFalloff) |
| 76..79       | `csmParams`          | `vec4<f32>` (cascadeCount, cascadeBlendFactor, 0, 0) |

`cascadeBlendFactor = cascadeBlendPercentage === 0 ? 10000 : 1 / cascadeBlendPercentage`.
Unused cascade slots (when `numCascades < 4`) are never read — the WGSL loop bound is
the baked cascade count.

### Shadow map texture
`depth32float`, size `mapSize × mapSize × numCascades`,
`RENDER_ATTACHMENT | TEXTURE_BINDING`. Receiver view: `dimension:"2d-array"`. Per-cascade
caster render targets use a single-layer view
(`createView({dimension:"2d", baseArrayLayer:i, arrayLayerCount:1})`). Comparison
sampler `compare:"less"`, linear filtering.

## Pipeline Configuration

- **Caster pass:** N depth-only render tasks (one per cascade layer), each rendering
  every caster through the material family's *no-color* view, clearing the layer to
  depth 1.0 with `depthCompare:"less-equal"`. The per-cascade camera facade carries
  the cascade view matrix + **bias-adjusted** ortho·view transform.
- **Receiver pass:** group-2 bind group per CSM light = `[arrayDepthView,
  comparisonSampler, csmUBO]` (binding order 0,1,2). The 2d-array view dimension is
  produced by the shader composer (`bglEntry` maps `_textureType` containing `"array"`
  → `viewDimension:"2d-array"`).

## Shader Logic (WGSL outline)

Receiver, per CSM light (suffix `_<lightIndex>`, `N` = baked cascade count):

```wgsl
// cascade select from camera-view-space depth (vf.z), LH
var idx = -1; var diff = 0.0;
for (var i = 0; i < N; i++) {
    diff = csmInfo.viewFrustumZ[i] - vf.z;
    if (diff >= 0.0) { idx = i; break; }
}
if (idx < 0) { idx = N - 1; }

var shadow = csmSample(idx, vec4(vp, 1.0));      // PCF5 on layer idx
// optional cross-fade into next cascade
let ratio = clamp(diff / csmInfo.frustumLengths[idx], 0.0, 1.0) * csmInfo.csmParams.y;
if (idx < N - 1 && ratio < 1.0) {
    shadow = mix(csmSample(idx + 1, vec4(vp, 1.0)), shadow, ratio);
}
shadowFactors[lightIndex] = shadow;
```

`csmSample(layer, worldPos)`:
```wgsl
let p = csmInfo.cascadeTransforms[layer] * worldPos;
let clip = p.xyz / p.w;
let uv = vec2(0.5*clip.x + 0.5, 0.5 - 0.5*clip.y);   // Lite Y-flip convention
let depthRef = clamp(clip.z, 0.0, 0.99999994);        // GREATEST_LESS_THAN_ONE
// 5×5 PCF (9 textureSampleCompareLevel taps, /144 weighting)
// textureSampleCompareLevel(csmTex, csmComp, base + offset, layer, depthRef)
return computeFallOff(mix(darkness, 1.0, sh), clip.xy, frustumEdgeFalloff);
```

The `0.99999994` clamp is critical: fragments projecting beyond a cascade's far plane
must compare strictly *less than* the cleared shadow-map value (1.0) so they read as
**lit**, not shadowed.

`vp` (world position) and `vf` (camera-view-space position) are existing base
varyings — CSM reuses them instead of emitting N per-cascade light-space varyings.

## CSM Math (`csm-shadow-task-hooks.ts`)

### Splits (`_computeCsmCascades`)
`near = camera.near`, `far = camera.far`, `cameraRange = far - near`,
`maxDistance = shadowMaxZ < far && shadowMaxZ >= near ? min((shadowMaxZ-near)/cameraRange, 1) : 1`,
`minZ = near`, `maxZ = near + maxDistance*cameraRange`, `range = maxZ-minZ`, `ratio = maxZ/minZ`.
For `p = (i+1)/N`: `log = minZ*ratio^p`, `uniform = minZ + range*p`,
`d = lambda*(log-uniform) + uniform`.
`viewFrustumZ[i] = d`; `breakDist[i] = (d-near)/cameraRange`;
`frustumLengths[i] = (breakDist[i]-prevBreak)*cameraRange`.

### Per-cascade matrix
1. Invert the **reverse-Z** camera view-projection (`getViewProjectionMatrix`). Transform
   the 8 reverse-Z NDC frustum corners (**near z=1, far z=0**) to world space.
2. Slice [prevSplit, split]: `corner[k] = near + ray*prevSplit`,
   `corner[k+4] = near + ray*split` where `ray = far - near` per side.
3. Centroid = mean of the 8 slice corners.
4. Fit a light-space AABB: temp `LookAtLH` from centroid along `lightDir`
   (`buildLightViewMatrix`), transform corners, take min/max extents.
   (`stabilizeCascades` instead uses a `ceil(radius*16)/16` bounding sphere.)
5. Shadow camera eye = `centroid + lightDir * minExtents.z`; cascade view =
   `buildLightViewMatrix(lightDir, eye)`.
6. Z range: `viewMinZ = 0`, `viewMaxZ = extents.z`, then tightened to the casters'
   world-AABB Z in cascade view space (depthClamp-false behaviour:
   `viewMinZ = min(0, castersMinZ)`, `viewMaxZ = min(extents.z, castersMaxZ)` when
   `castersMinZ <= viewMaxZ`). v1 uses depthClamp = false so no GPU depth-clip feature
   is required.
7. `ortho = OrthoOffCenterLH(minX,maxX,minY,maxY, viewMinZ, viewMaxZ)` (column-major,
   half-z, near→0 far→1 — same convention as the PCF generator's shadow ortho).
8. `transform = ortho · view`. **Texel snap (always applied):** project the world origin
   (`transform[12], transform[13]`), `× mapSize/2`, round, build an XY translation of the
   rounded offset, `transform = (T·ortho) · view`.
9. Receiver `cascadeTransforms[i] = transform` (unbiased). Caster camera view-projection
   = `transform` with a `bias·0.5·w` term added to its Z row.

## State Machine / Lifecycle

`createShadowTask` (scene-owned) drives the generic hooks:
`_preloadShadowTask` → loads the no-color material-view factories.
`_ensureShadowTaskState` → builds N per-layer render targets + cameras + tasks once
(rebuilt only when the caster set identity changes).
`_renderShadowMap` → per frame, dirty-checked on `casterVersion + lightVersion +
cameraVersion`; recomputes splits + matrices, writes the 320-byte UBO (bumping
`_version`), updates each cascade camera, executes all cascade tasks.

## Babylon.js Equivalence Map

| Babylon.js | Babylon Lite |
|---|---|
| `CascadedShadowGenerator._splitFrustum` | `_computeCsmCascades` (split section) |
| `_computeFrustumInWorldSpace` | reverse-Z frustum corner extraction + slice |
| `_computeCascadeFrustum` | centroid + light-space AABB / sphere fit |
| `_computeMatrices` (ortho + snap) | `orthoOffCenterLH` + texel-snap block |
| `computeShadowWithCSMPCF5` | `csmSample_<i>` (PCF5, array layer) |
| cascade select in `lightFragment.fx` | `computeShadowCSM_<i>` loop + blend |
| `GREATEST_LESS_THAN_ONE` | `0.99999994` depthRef clamp |

Two deliberate deviations from default BJS, applied symmetrically to the BJS oracle so
parity holds: **reverse-Z** NDC (Lite's projection) and **depthClamp = false**
(avoids the optional `depth-clip-control` WebGPU feature). Both are reflected in the
reference scene (`sg.depthClamp = false`). Result: full-image MAD = 0.000.

## Bundle Discipline (no movement for unrelated scenes)

Shared edits are byte-minimal:
- TS union widenings `"esm" | "pcf"` → add `"csm"` (type-only, 0 runtime bytes) in
  `shadow-generator.ts`, `standard-renderable.ts`; PBR/Node renderables filter out CSM
  lights (they ignore CSM in v1).
- `_depthView` field swap in the three receiver renderables (call → field read).
- One `hasCsm`-gated dynamic import of `std-csm-shadow-fragment.ts` in
  `standard-group-builder.ts`.
- `shader-composer.ts` `bglEntry` gains `"array"` → `"2d-array"` view-dimension support
  (a few bytes on the shared material chunk; well within ceilings).

All cascade math + WGSL live in the four new modules, dynamically imported only by
scenes that create a CSM generator.

## Dependencies

`shadow-base` (`buildLightViewMatrix`, `multiply4x4`, `createShadowCamera`,
`updateShadowCameraBase`, `createShadowParamsUBO`, `casterVersionSum`),
`pcf-shadow-task-hooks` (`getNoColorView`, `preloadPcfShadowTaskState`),
`math/mat4-invert`, `camera` (`getViewProjectionMatrix`), `frame-graph/render-task`.

## Test Specification

`tests/lite/parity/scenes/scene214-cascaded-shadows.spec.ts` — captures the BJS CSM
oracle (`captureGolden({ force: true })`) and compares the Lite render of
`scene214.html` (6×6 Standard box casters + Standard ground receiver, 4-cascade CSM).
Threshold `maxMad` in `scene-config.json` (achieved MAD = 0.000).

## File Manifest

- `shadow/csm-directional-shadow-generator.ts` — public factory + texture/UBO/sampler.
- `shadow/csm-shadow-task-hooks.ts` — cascade math + N-layer caster render hooks.
- `shader/fragments/csm-shadow-fragment-core.ts` — receiver WGSL codegen.
- `material/standard/fragments/std-csm-shadow-fragment.ts` — Standard-family wrapper.
- `lab/lite/src/lite/scene214.ts`, `lab/lite/scene214.html` — Lite demo scene.
- `lab/lite/src/bjs/scene214.ts`, `lab/lite/babylon-ref-scene214.html` — BJS oracle.
- `reference/lite/scene214-cascaded-shadows/babylon-ref-golden.png` — golden.
