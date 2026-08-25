# Module: PBR Material

> Package path: `packages/babylon-lite/src/material/pbr/`
> Files: `pbr-material.ts` (props + factory), `pbr-template.ts` (shader template), `pbr-pipeline.ts` (pipeline cache), `pbr-renderable.ts` (renderable builder and single-mesh rebuild closure), `pbr-flags.ts` / `pbr-flag-bits.ts` (feature flag constants), `no-color-view.ts` (pass-specific material view), `fragments/singlelight-wgsl.ts` (one-light WGSL), `fragments/multilight-wgsl.ts` (multi-light WGSL)

## Purpose

The PBR Material module implements a physically-based rendering material with GGX microfacet BRDF, Smith-GGX height-correlated geometry, Schlick Fresnel, spherical harmonics diffuse IBL, specular IBL via split-sum approximation, normal mapping (tangent or cotangent), emissive (texture and/or uniform color), image processing (exposure, tone mapping, contrast), Kulla-Conty energy conservation, clearcoat, sheen, metallic reflectance extension, specular anti-aliasing, skeletal animation, morph targets, thin instances, a non-looping single-light path, generic multi-light loops, and ESM/PCF shadow receiving. It renders glTF metallic-roughness and specular-glossiness workflow meshes to match Babylon.js PBR output.

Shaders are **dynamically composed** via the `ShaderFragment` / `ShaderComposer` system — no raw `.wgsl` files. A `ShaderTemplate` (`pbr-template.ts`) provides the base WGSL with slot markers; optional `ShaderFragment` modules inject code into those slots. Only the fragments needed for a given mesh's features are composed, minimizing bundle size per the Size Pillar. Fragment modules are **dynamically imported** at build time so unused features are tree-shaken.

## ShaderFragment Composition System

PBR shaders are built using the `ShaderComposer` architecture defined in `src/shader/shader-composer.ts`:

1. **`ShaderTemplate`** (`pbr-template.ts` → `createPbrTemplate()`) — provides base vertex/fragment WGSL with slot markers (e.g. `/*MF*/`, `/*AD*/`, `/*AI*/`, `/*AT*/`, `/*SV*/`, `/*VR*/`, `/*VW*/`, `/*VB*/`, `/*BC*/`, `/*BA*/`, `/*BL*/`, `/*NI*/`), base UBO fields, base vertex attributes, base varyings, and base bindings.

2. **`ShaderFragment`** — each optional feature (IBL, clearcoat, sheen, shadows, skeleton, morph, emissive-color, reflectance) is a fragment object with:
    - `id` — unique string identifier
    - `dependencies` — other fragment IDs that must be composed first
    - `fragmentSlots` / `vertexSlots` — WGSL snippets keyed by slot name
    - `bindings` / `vertexBindings` — `BindingDecl[]` for textures/samplers/UBOs
    - `uboFields` — additional material UBO fields
    - `vertexAttributes` — additional vertex buffer attributes
    - `varyings` — additional inter-stage varyings
    - `helperFunctions` / `vertexHelperFunctions` — WGSL helper code
    - `vertexBuiltins` — built-in inputs (e.g. `vertex_index`)
    - `pipelineVertexBuffers` — extra GPU vertex buffer layouts

3. **`composeShader(template, fragments)`** — topologically sorts fragments by dependency, merges UBO fields, assigns binding indices sequentially, replaces slot markers with concatenated fragment code, and returns a `ComposedShader` with final WGSL + bind group layout descriptors + vertex buffer layouts.

### Composition Flow (PBR)

```
pbr-renderable.ts:
  1. Resolves MaterialOrView to source material state + render feature bits
  2. Dynamically imports only needed fragment modules
  3. Calls createPbrTemplate(config) → ShaderTemplate
  4. Calls composeShader(template, fragments) → ComposedShader
  5. Caches ComposedShader per feature bitmask
  6. Passes ComposedShader to getOrCreatePbrPipeline()
```

## Dynamic Feature Flags (`pbr-flags.ts`)

| Flag                               | Constant  | Condition                     | Shader effect                                        |
| ---------------------------------- | --------- | ----------------------------- | ---------------------------------------------------- |
| `PBR_HAS_NORMAL_MAP`               | `1 << 0`  | Mesh has tangent buffer       | Tangent vertex attr + normal texture + TBN transform |
| `PBR_HAS_EMISSIVE`                 | `1 << 1`  | Material has emissive texture | Emissive texture sampling                            |
| `PBR_HAS_ENV`                      | `1 << 2`  | Environment loaded            | IBL (BRDF LUT + specular cubemap + SH irradiance)    |
| `PBR_HAS_TONEMAP`                  | `1 << 4`  | Tone mapping enabled          | Exposure/contrast/gamma post-processing              |
| `PBR_HAS_ALPHA_BLEND`              | `1 << 6`  | Material has alpha blend      | Alpha blend pipeline state                           |
| `PBR_HAS_SPEC_GLOSS`               | `1 << 7`  | Specular-glossiness workflow  | SpecGloss texture instead of ORM                     |
| `PBR_HAS_DOUBLE_SIDED`             | `1 << 8`  | Material is double-sided      | `cullMode: 'none'` + front-facing normal flip        |
| `PBR_HAS_COTANGENT_NORMAL`         | `1 << 9`  | Normal map without tangents   | Cotangent-frame normal perturbation                  |
| `PBR_HAS_METALLIC_REFLECTANCE_MAP` | `1 << 10` | Has metallic reflectance map  | Reflectance texture sampling                         |
| `PBR_HAS_REFLECTANCE_MAP`          | `1 << 11` | Has reflectance map           | Reflectance map sampling                             |
| `PBR_HAS_USE_ALPHA_ONLY_MR`        | `1 << 12` | Use alpha-only from MR map    | Alpha-only metallic reflectance                      |
| Clustered point gate (local)       | `1 << 13` | Clustered point-light state   | Point-only clustered fragment and cache variant      |
| Clustered spot gate (local)        | `1 << 14` | Clustered spot-light state    | Spot-capable clustered fragment and cache variant    |
| `PBR_HAS_OCCLUSION`                | `1 << 15` | Has occlusion strength        | ORM/separate occlusion with strength factor          |
| `PBR_HAS_SPECULAR_AA`              | `1 << 17` | Specular anti-aliasing        | Geometric AA roughness adjustment                    |
| `PBR_HAS_CLEARCOAT`                | `1 << 20` | Clearcoat layer enabled       | Clearcoat BRDF + energy conservation                 |
| `PBR_HAS_EMISSIVE_COLOR`           | `1 << 21` | Non-zero emissive uniform     | Emissive color uniform contribution                  |
| `PBR_HAS_SHEEN`                    | `1 << 22` | Sheen layer enabled           | Sheen BRDF (Charlie NDF + Ashikhmin visibility)      |
| `PBR_HAS_SHEEN_TEXTURE`            | `1 << 23` | Sheen has texture             | Sheen texture sampling                               |
| Lightmap gate (local)              | `1 << 24` | Opt-in lightmap texture       | Lightmap fragment and cache variant                  |
| `PBR_HAS_GAMMA_ALBEDO`             | `1 << 25` | Base color in gamma space     | Gamma-to-linear decode                               |
| `PBR_HAS_ANISOTROPY`               | `1 << 26` | Anisotropy enabled            | Anisotropic specular BRDF                            |
| `PBR_HAS_SUBSURFACE`               | `1 << 27` | Subsurface enabled            | Translucency / scattering / volume feature root      |
| `PBR_HAS_THICKNESS_MAP`            | `1 << 28` | Thickness texture present     | Thickness texture sampling                           |
| `PBR_HAS_SKYBOX`                   | `1 << 29` | PBR skybox mode               | Direct environment lookup                            |
| `PBR_HAS_SHEEN_ALBEDO_SCALING`     | `1 << 30` | Sheen albedo scaling enabled  | Energy compensation for sheen                        |

Mesh/pass feature bits live in `mesh-features.ts` (`MSH_HAS_SKELETON`, `MSH_HAS_MORPH_TARGETS`, `MSH_HAS_THIN_INSTANCES`, `MSH_HAS_INSTANCE_COLOR`, `MSH_HAS_VERTEX_COLOR`, `MSH_HAS_UV2`, `MSH_RECEIVE_SHADOWS`). Do not duplicate a mesh feature as `PBR_HAS_*` or `PBR2_HAS_*`; the mesh flag takes precedence.

Extended `features2` bits carry overflow and pass-specific features, including clearcoat texture bits, transmission/volume, unlit, UV transform, occlusion-on-UV2 material intent (`PBR2_HAS_UV2` gated by `MSH_HAS_UV2`), linear image processing for refraction, and `PBR2_NO_COLOR_OUTPUT` for no-color material views. Extension-local bit 29 selects UV2 specifically for lightmaps (alongside shared `PBR2_HAS_UV2`); the sheen roughness-texture selector moves to bit 31 to keep the gates independent.

Light type bits are also shifted into the feature mask via `getLightTypeFeatureBits()` (hemispheric=1, directional=2, point=3).

Base color + ORM textures are always present (core PBR workflow).

PBR caches are two-tiered: sig-independent shader bindings are cached per the inline key string `${features}:${features2}:${meshFeatures}:${sceneFeatures}:${shaderKey}`, where `shaderKey` includes tone-mapping identity and the material-plugin index; geometry-output composition and per-view resources also include the plugin index. Each binding then caches sig-specific pipelines per `targetSignatureKey(sig)` (format, depth format, sample count, Y-flip).

## Public API Surface

### Material Props (`pbr-material.ts`)

```typescript
import type { Texture2D } from "../../texture/texture-2d.js";
import type { MeshGroupBuilder } from "../../render/renderable.js";

/** Clearcoat layer properties. */
export interface ClearCoatProps {
    isEnabled?: boolean;
    intensity?: number;
    roughness?: number;
    indexOfRefraction?: number;
    texture?: Texture2D;
    roughnessTexture?: Texture2D;
    bumpTexture?: Texture2D;
    bumpTextureScale?: number;
    useF0Remap?: boolean;
}

/** Sheen layer properties. */
export interface SheenProps {
    isEnabled: boolean;
    color?: [number, number, number];
    roughness?: number;
    intensity?: number;
    texture?: Texture2D;
    albedoScaling?: boolean;
}

export interface AnisotropyProps {
    isEnabled: boolean;
    intensity?: number;
    direction?: [number, number];
}

export interface TranslucencyProps {
    intensity?: number;
    color?: [number, number, number];
    diffusionDistance?: [number, number, number];
}

export interface ScatteringProps {
    diffusionDistance?: [number, number, number];
    metersPerUnit?: number;
}

export interface ThicknessProps {
    texture?: Texture2D;
    useGlTFChannel?: boolean;
    min?: number;
    max?: number;
}

export interface RefractionProps {
    intensity?: number;
    texture?: Texture2D;
    indexOfRefraction?: number;
    useThicknessAsDepth?: boolean;
}

export interface TintProps {
    color?: [number, number, number];
    atDistance?: number;
}

export interface SubSurfaceProps {
    translucency?: TranslucencyProps;
    scattering?: ScatteringProps;
    thickness?: ThicknessProps;
    tint?: TintProps;
    refraction?: RefractionProps;
}

/** User-facing PBR material properties. */
export interface PbrMaterialProps extends Material {
    baseColorTexture?: Texture2D;
    normalTexture?: Texture2D;
    normalTextureScale?: number;
    /** Occlusion-Roughness-Metallic packed: R=occ, G=rough, B=metal. */
    ormTexture?: Texture2D;
    emissiveTexture?: Texture2D;
    specGlossTexture?: Texture2D;
    metallicReflectanceTexture?: Texture2D;
    reflectanceTexture?: Texture2D;
    /** @internal Set via `setPbrEmissive()` — direct assignment skips extension registration. */
    _emissiveColor?: [number, number, number];
    doubleSided?: boolean;
    alpha?: number;
    alphaBlend?: boolean;
    alphaCutOff?: number;
    environmentIntensity?: number;
    directIntensity?: number;
    usePhysicalLightFalloff?: boolean;
    reflectance?: number;
    metallicFactor?: number;
    roughnessFactor?: number;
    occlusionStrength?: number;
    occlusionTexCoord?: number;
    occlusionTexture?: Texture2D;
    metallicF0Factor?: number;
    metallicReflectanceColor?: [number, number, number];
    useOnlyMetallicFromMetallicReflectanceTexture?: boolean;
    enableSpecularAA?: boolean;
    gammaAlbedo?: boolean;
    clearCoat?: ClearCoatProps;
    sheen?: SheenProps;
    anisotropy?: AnisotropyProps;
    subsurface?: SubSurfaceProps;
    transmissive?: boolean;
    skyboxMode?: boolean;
    unlit?: boolean;
    unlitColor?: [number, number, number];
}

/** Create a PbrMaterialProps with optional overrides. */
export function createPbrMaterial(props?: Partial<PbrMaterialProps>): PbrMaterialProps;

/** MeshGroupBuilder that dynamically imports pbr-renderable.js. */
export const pbrGroupBuilder: MeshGroupBuilder;

/** Collect all non-null textures for acquire/release tracking. */
export function collectPbrBoundTextures(mat: PbrMaterialProps): Texture2D[];

/** Create a pass-specific no-color material view over a PBR source material. */
export function createPbrNoColorMaterialView(source: PbrMaterialProps): MaterialView;
```

Usage:

```typescript
// Manual creation
const mat = createPbrMaterial({
    baseColorTexture: await loadTexture2D(engine, "albedo.png"),
    normalTexture: await loadTexture2D(engine, "normal.png"),
    ormTexture: await loadTexture2D(engine, "orm.png"),
    clearCoat: { isEnabled: true, intensity: 1, roughness: 0.1 },
    sheen: { isEnabled: true, color: [1, 1, 1], roughness: 0.5 },
});

// From glTF (automatic — loadGltf() builds PbrMaterialProps internally)
addToScene(scene, await loadGltf(engine, "model.glb"));
```

### Material Views and Rebuild

PBR renderables accept `MaterialOrView`. A plain material computes/stores `_renderFeatures = _computePbrMaterialFeatures(mat)`. A view uses `view._renderFeatures` exactly while reading all uniform/texture state from `view.source`.

`createPbrNoColorMaterialView(source)` creates a view that clears `PBR_HAS_ALPHA_BLEND` and sets `PBR2_NO_COLOR_OUTPUT`. This produces a no-color PBR pipeline suitable for passes that should execute the fragment stage without writing color, while retaining the source material's geometry-relevant state and textures.

The `rebuildSingle` closure returned from `buildPbrRenderables()` is stored on `pbrGroupBuilder._rebuildSingle`. It is used by material swaps, `rebuildMaterial()`, and `RenderTask.addMesh(mesh, { material })` per-pass overrides.

### Pipeline (`pbr-pipeline.ts`)

```typescript
/** Compute PBR feature bitmask from mesh/material/scene capabilities. */
export function computePbrFeatures(...): number;

/** Get or create sig-independent PBR shader bindings. */
export function getOrCreatePbrBindings(
  engine: EngineContextInternal, features: number, features2: number,
  meshFeatures: number, sceneFeatures: number,
  composed: ComposedShader, shaderKey?: string,
): _PbrShaderBindings;

/** Get or create a cached PBR pipeline for a render-target signature. */
export function getOrCreatePbrPipeline(
  engine: EngineContextInternal, sig: RenderTargetSignature, bindings: _PbrShaderBindings,
): GPURenderPipeline;

/** Create per-mesh bind group (group 1) with textures matching the composed shader layout. */
export function createPbrMeshBindGroup(
  engine: EngineContextInternal, bindings: PbrShaderBindings, composed: ComposedShader,
  meshUBO: GPUBuffer, materialUBO: GPUBuffer, material: PbrMaterialProps,
  env: EnvironmentTextures | null,
  meshCtx: { skeleton?: { boneTexture: GPUTexture } | null; morphTargets?: { texture: GPUTexture; weightsBuffer?: GPUBuffer } | null } | null,
): GPUBindGroup;

export function clearPbrPipelineCache(): void;
```

### Template (`pbr-template.ts`)

```typescript
/** Full configuration for PBR template generation. */
export interface PbrTemplateConfig {
    // Light configuration
    _hasSingleLight?: boolean;
    _hasMultiLight?: boolean;
    _singleLightWGSL?: string;
    _singleLightBlock?: string;
    _multiLightWGSL?: string;
    _multiLightLoop?: string;
    // Feature booleans
    _normalMode?: "tangent" | "cotangent" | "none";
    _hasEmissiveTexture?: boolean;
    _hasSpecGloss?: boolean;
    _hasDoubleSided?: boolean;
    _hasTonemap?: boolean;
    _acesHelpers?: string;
    _acesTonemapCall?: string;
    _hasAlphaBlend?: boolean;
    _hasSpecularAA?: boolean;
    _hasGammaAlbedo?: boolean;
    _hasMorph?: boolean;
    _hasOcclusion?: boolean;
    _hasEmissiveColor?: boolean;
    _hasReflectanceExt?: boolean;
    _hasIbl?: boolean;
    _hasAnisotropy?: boolean;
    _anisoBrdfFunctions?: string;
    _anisoTBBlock?: string;
    _ext?: PbrTemplateExt;
    _noColorOutput?: boolean;
    _esmShadowOutput?: boolean;
    _esmShadowDepthCode?: string;
}

/** Create a ShaderTemplate from PBR configuration. */
export function createPbrTemplate(config: PbrTemplateConfig): ShaderTemplate;
```

### Renderable Builder (`pbr-renderable.ts`)

```typescript
/** Build PBR renderables from mesh data. */
export function buildPbrRenderables(
  scene: SceneContext, meshes: Mesh[], envTextures: EnvironmentTextures | undefined,
): Promise<MeshGroupBuildResult>;

/** Internal helper used by the captured single-mesh rebuild closure. */
export function _createPbrMeshUBO(...): GPUBuffer;
```

## Fragment Modules

All fragments live in `src/material/pbr/fragments/` and export factory functions returning `ShaderFragment` objects.

### `ibl-fragment.ts` — IBL Environment Lighting

- **Factory**: `createIblFragment(hasNormalMap: boolean): ShaderFragment`
- **ID**: `"ibl"`
- **Bindings**: `brdfLUT` (texture2D), `brdfSampler_` (sampler), `iblTexture` (cube texture), `iblSampler` (sampler)
- **Helper WGSL**: `environmentHorizonOcclusion()`, `getEnergyConservationFactor()`, `rotateY()`
- **Fragment slots**:
    - `AI` — full IBL computation: reflected vector, BRDF LUT sampling, specular radiance, SH irradiance, horizon occlusion, energy conservation
    - `BA` — luminance-over-alpha accumulation for alpha blending

### `local-cubemap-fragment.ts` — Per-material and bounded local IBL (opt-in)

- **Opt-in/init**: call `await enablePbrLocalCubemap({ maxCandidates })` before loading any DDS or
  HDR environment that will be used as a probe, creating probe sets, or registering the scene.
  `maxCandidates` defaults to 4, accepts 1–12, and is fixed after the first call.
- **Zero-cost default**: state, WGSL, resource packing, and binding logic are reachable only from
  `enable-pbr-local-cubemap.ts` and its dynamic fragment import. Ordinary PBR materials retain the
  existing IBL shader and bindings.
- **Public assignments**:
    - `setPbrEnvironment(material, environment)` selects one material-specific cubemap without
      parallax correction.
    - `setPbrLocalEnvironment(material, environment, options)` selects one box- or sphere-projected
      cubemap. `capturePosition` may differ from `projectionPosition`; it defaults to the projection
      centre for backward compatibility.
    - `setPbrLocalEnvironmentProbeSet(material, set)` selects fragment-weighted local probes.
    - `clearPbrLocalEnvironment(material)` removes any of these private opt-in assignments.
- **Binding lifecycle**: configure assignments before `registerScene()`. After renderables exist,
  call `rebuildMaterial(scene, material)` after changing or clearing an assignment.
- **Material views**: local-environment state is resolved through a view's source material, so
  geometry and other pass views compose, write, and bind the same assignment without copying it.
- **Pass variants**: no-color, ESM-shadow, and skybox variants intentionally skip local-IBL
  rewriting because they do not contain the ordinary shaded-IBL targets. A scene environment, when
  present, continues to serve those variants through their existing paths.
- **Layered IBL**: a local environment counts as active IBL even when the scene has no global
  environment. Clearcoat, sheen, subsurface, unlit, and alpha-luminance composition therefore use
  the same local cubemap or blended probe radiance as the base PBR layer.
- **Device replacement**: probe-set textures, uniform/storage buffers, views, samplers, and dummy
  bindings are recreated lazily when the engine acquires a replacement GPU device. Source
  `EnvironmentTextures` must already refer to resources recovered for that device.
- **Feature variant**: primary PBR bit 31 gates one local-environment fragment. A material UBO mode
  selects unprojected, box, sphere, or probe-array behavior at runtime, avoiding collisions with
  lightmap and sheen feature bits while keeping the implementation out of non-opted bundles.
- **Single local environment**: the assigned environment supplies prefiltered specular radiance,
  BRDF LUT, diffuse spherical harmonics, and LOD scale. Finite projection intersects the reflected
  ray with the authored box or sphere, then samples the cubemap using the vector from the independent
  capture position to that hit point.
- **Probe-set diffuse lighting**: arrays replace specular radiance. Diffuse irradiance uses the
  scene spherical harmonics when a scene environment exists; otherwise it uses the first probe's
  spherical harmonics. Probe irradiance is intentionally not blended.
- **Probe array**: `createPbrLocalEnvironmentProbeSet()` copies every probe into one
  `texture_cube_array<f32>`. Sources share a format and have power-of-two-related square dimensions.
  The destination uses the smallest dimension; larger sources contribute matching lower mips, so
  no resampling pass is required. The array uses the engine's deduplicated trilinear sampler rather
  than depending on any source environment's sampler identity. Source cubemaps must include
  `COPY_SRC` usage. The built-in `.env` loader always includes it; DDS and HDR loaders include it
  only for environments loaded after `enablePbrLocalCubemap()` is called. Environments loaded earlier
  must be reloaded, and unsupported custom environments are rejected synchronously with the same
  ordering requirement in the error.
- **Shared probe UBO**: each probe occupies seven `vec4`s: projection centre/layer,
  projection half-size/LOD scale, capture position/LOD bias, inner influence centre/yaw cosine,
  inner half-size/yaw sine, outer influence centre, and outer half-size/packed metadata. The last
  word stores RGB8 debug color plus the sphere flag. The WebGPU-guaranteed 64 KiB uniform binding
  therefore holds 585 probes after the fixed header.
- **Independent influence centres**: `influencePosition` centres the inner full-weight volume.
  Box probes may set `influenceOuterPosition` independently; it defaults to the inner centre.
  Validation transforms their offset into the probe's yaw-local frame and requires the inner box
  to remain fully contained by the outer box.
- **World-space voxel lookup**: each set owns one dense read-only storage buffer. Its header stores
  grid minimum, reciprocal cell size, dimensions, and fixed cell stride; each cell stores a count
  followed by up to `maxCandidates` probe indices. CPU voxelization uses the outer centre and exact
  yaw-oriented box/AABB or sphere/AABB tests. Overflow throws instead of discarding probes, and
  empty cells receive the deterministic nearest probe at the cell centre.
- **Asymmetric box influence**: fragments rotate `worldPos - influencePosition` into probe-local
  space. For each axis, the fade span toward the negative or positive outer boundary incorporates
  the signed offset between the inner and outer centres. The box NDF is the maximum axis value;
  spheres use `(distance - innerRadius) / (outerRadius - innerRadius)`. Inner hits receive full
  weight, one outer hit receives full weight, overlapping outer hits use normalized blend-map
  weights, and points outside every outer volume sample the smallest unbounded NDF candidate.
- **Limits**: the cube-array count is additionally limited by `maxTextureArrayLayers / 6`; the
  dense grid must fit `maxBufferSize` and `maxStorageBufferBindingSize`. Grid dimensions and byte
  size are checked before allocating per-cell CPU arrays. Probe-set creation locks the current
  `maxCandidates` before measuring the grid, so a custom value must be configured first with
  `enablePbrLocalCubemap({ maxCandidates })`; overflowing cells always throw instead of truncating.
- **Diagnostics**: `setPbrLocalEnvironmentProbeDebug(set, true)` preserves production influence
  calculations but replaces cubemap samples and final PBR output with weighted packed probe colors.
- **Coverage**: Scene 186 compares per-material unprojected environments, hard finite projection,
  and blended probes, including influence debug visualization. It sets `skipParity` because
  Babylon.js has no equivalent fragment-weighted local cube-array blending feature.
- **References**:
    - Shadertoy reference implementation: <https://www.shadertoy.com/view/DtlBWn>
    - Sébastien Lagarde, _Local Image-based Lighting with Parallax-Corrected Cubemaps_:
      <https://dl.acm.org/doi/10.1145/2343045.2343094>

### `clearcoat-fragment.ts` — Clearcoat Layer

- **Factory**: `createClearcoatFragment(hasIbl: boolean, hasReflectance?: boolean): ShaderFragment`
- **ID**: `"clearcoat"`
- **Dependencies**: `["ibl"]` when `hasIbl`, `["reflectance"]` when `hasReflectance`
- **Helper WGSL**: `visibility_Kelemen()`, `getR0RemappedForClearCoat()`
- **Fragment slots**:
    - `MF` — remaps base F0 using clearcoat IOR/refraction params from `mesh.ccParams` / `mesh.ccRefractionParams`
    - `BL` — initializes direct clearcoat attenuation/specular variables
    - `AD` — direct clearcoat BRDF (GGX NDF + Kelemen visibility + Fresnel)
    - `AI` (IBL path) — samples IBL for clearcoat environment reflection, applies Jones-style energy conservation
    - `NI` (non-IBL path) — non-IBL clearcoat energy conservation

### `sheen-fragment.ts` — Sheen Layer

- **Factory**: `createSheenFragment(hasSheenTexture: boolean, hasIbl?: boolean): ShaderFragment`
- **ID**: `"sheen"`
- **Dependencies**: `["ibl"]` when `hasIbl`
- **Helper WGSL**: `normalDistributionFunction_CharlieSheen()`, `visibility_Ashikhmin()`
- **Fragment slots**:
    - `SV` — initializes sheen local vars (`sheenDirectTerm`, `sheenIblTerm`, `sheenAlbedoScaling`, `sheenColorFinal`, `sheenRoughnessAdjusted`); optionally samples sheen texture
    - `AD` — direct sheen specular term via Charlie NDF + Ashikhmin visibility
    - `AI` (IBL path) — IBL sheen reflection from `iblTexture` and `brdfLUT`
    - `NI` (non-IBL path) — direct sheen only

### `reflectance-fragment.ts` — Metallic Reflectance Extension

- **Factory**: `createReflectanceFragment(hasMetallicReflectanceMap: boolean, hasReflectanceMap: boolean, useAlphaOnlyMR: boolean): ShaderFragment`
- **ID**: `"reflectance"`
- **Bindings**: conditionally `metallicReflectanceMap` + sampler, `reflectanceMap` + sampler
- **Fragment slots**:
    - `MF` — computes `mrFactors`, dielectric F0, surface reflectivity, `colorF0`/`colorF90`, surface albedo
    - `AT` — computes occlusion from ORM with `mesh.occlusionStrength`

### `emissive-fragment.ts` — Emissive Color Uniform

- **Factory**: `createEmissiveColorFragment(hasEmissiveTexture: boolean): ShaderFragment`
- **ID**: `"emissive-color"`
- **Fragment slots**:
    - `AT` — sets `emissive` from `mesh.emissiveColor`, optionally multiplied by emissive texture sample

### `lightmap-fragment.ts` — Baked Lightmap (opt-in)

- **Public API**: call `await enablePbrLightmap()` before `registerScene()`, then assign the texture with `setPbrLightmap(material, texture, options)`.
- **Tree shaking**: the enable call dynamically imports and registers the fragment. The always-loaded PBR renderable never scans for lightmaps, so scenes that do not opt in retain no lightmap implementation.
- **Feature variants**: primary bit 24 gates lightmap presence, extended bit 29 selects lightmap UV2, and primary bits 16/18/19 select shadowmap composition, gamma decode, and effective V flip. Clustered point/spot lighting retains primary bits 13/14. The lightmap-local bits participate in the normal PBR shader cache key without overlapping those lighting gates.
- **UV selection**: `setPbrLightmap()` owns bit 64 of `_uv2Mask`; this reuses the existing TEXCOORD_1 attribute/varying path while preserving all other channel claims.
- **UBO and bindings**: contributes `lmLvl`, `lmTexture`, and `lmSampler`.
- **Composition**: the `NI` slot adds the decoded sample by default or multiplies the lit result while preserving emissive for `useLightmapAsShadowmap`. Dependencies keep it after unlit, sheen, refraction, and subsurface final-color reconstruction.
- **Orientation**: the V-flip variant is `texture.invertY XOR (texture.uAng === Math.PI)`, matching the Standard texture path for upload-flipped and codec-decoded textures.
- **Coverage**: `pbr-lightmap.test.ts` covers feature detection, UV fallback, composition order, UBO/bindings, and texture enumeration; Scene 167 covers UV1/UV2, additive/shadowmap, gamma decode, and V-flip parity.

### `morph-fragment.ts` — Morph Targets

- **Factory**: `createMorphFragment(): ShaderFragment`
- **ID**: `"morph"`
- **Vertex builtins**: `vertex_index` (`u32`)
- **Vertex bindings**: `morphTargets` (texture2D, unfilterable), `morph` (uniform buffer with weights/count/texWidth/rowsPerBand)
- **Vertex slots**:
    - `VR` — loops over morph targets, accumulates position/normal deltas from morph texture

### `skeleton-fragment.ts` — Skeletal Animation

- **Factory**: `createSkeletonFragment(has8Bones: boolean): ShaderFragment`
- **ID**: `"skeleton"`
- **Vertex attributes**: `joints`, `weights` (+ `joints1`, `weights1` for 8-bone)
- **Vertex bindings**: `boneSampler` (texture2D, unfilterable)
- **Helper WGSL**: `readMatrixFromRawSampler()`
- **Vertex slots**:
    - `VW` — reads bone matrices, blends 4 or 8 bone influences, sets `finalWorld = mesh.world * influence`

### `pbr-shadow-fragment.ts` — Shadow Receiving

- **Factory**: `createPbrShadowFragment(shadowLights: PbrShadowLightSlot[]): ShaderFragment`
- **ID**: `"pbr-shadow"`
- **Interface**: `PbrShadowLightSlot { lightIndex: number; shadowType: "esm" | "pcf" }`
- **Varyings**: per-light `vPosFromLight_<n>` (`vec4<f32>`), `vDepthMetric_<n>` (`f32`)
- **Bindings**: per-light shadow textures + samplers + `shadowInfo_<n>` uniform buffers (group `"shadow"`)
- **Vertex slots**:
    - `VB` — transforms world position into light space, computes depth metric
- **Fragment slots**:
    - `AD` — computes per-light shadow factor via ESM or PCF, writes `shadowFactors[lightIndex]`
- Supports both ESM (`computeShadowESM_<n>`) and PCF (`computeShadowPCF_<n>`) shadow modes per light.

## PBR Light WGSL

PBR lighting consumes the shared `render/lights-ubo.ts` buffer. Light code is still dynamically imported so scenes only fetch the shader helper they need:

| Helper                          | Loaded when                                     | Exports                                                             |
| ------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------- |
| `fragments/singlelight-wgsl.ts` | Exactly one scene light and no shadow receivers | `SINGLE_LIGHT_STRUCTS`, `getSingleLightBlock(lightType)`            |
| `fragments/multilight-wgsl.ts`  | More than one light, or any shadow receiver     | `MULTI_LIGHT_STRUCTS()`, `COMPUTE_PBR_LIGHT`, `getMultiLightLoop()` |

The single-light helper emits specialized, non-looping WGSL for hemispheric, directional, point, or spot lights and reads the mesh-selected light index. The multi-light helper emits `computePbrLight()` plus a loop over the mesh-selected light indices; it also exposes first-light aliases for direct-light fragments (`clearcoat`, `sheen`, `subsurface`) and supports shadow factors written by `pbr-shadow-fragment.ts`.

`usePhysicalLightFalloff` defaults to `true`, matching Babylon.js PBR's physical inverse-square point/spot falloff. When set to `false`, point and spot lights use Babylon's Standard-style falloff: linear range attenuation and spot cone exponent attenuation. Scene 22 uses this path to mirror `PBRMaterial.usePhysicalLightFalloff = false` in the Babylon.js reference.

## Pipeline Configuration

### Vertex Buffers (varies by features)

Base vertex buffers are defined by the template. Fragment modules add additional attributes:

**Base (always present):**

| Slot | Attribute | Format      | Stride   | Shader Location |
| ---- | --------- | ----------- | -------- | --------------- |
| 0    | Position  | `float32x3` | 12 bytes | `@location(0)`  |
| 1    | Normal    | `float32x3` | 12 bytes | `@location(1)`  |
| 2    | UV        | `float32x2` | 8 bytes  | `@location(2)`  |

**Conditional (appended by template or fragments, location indices assigned by composer):**

| Attribute                                   | Source                   | When                                |
| ------------------------------------------- | ------------------------ | ----------------------------------- |
| Tangent (`float32x4`)                       | Template                 | `PBR_HAS_NORMAL_MAP` (tangent mode) |
| Joints (`uint16x4`) + Weights (`float32x4`) | `skeleton-fragment`      | `MSH_HAS_SKELETON`                  |
| Joints1 + Weights1                          | `skeleton-fragment`      | `MSH_HAS_SKELETON_8`                |
| Instance matrix (4× `float32x4`)            | `thin-instance-fragment` | `MSH_HAS_THIN_INSTANCES`            |
| Instance color (`float32x4`)                | `thin-instance-fragment` | `MSH_HAS_INSTANCE_COLOR`            |

### Pipeline State

| Setting       | Value                                                         |
| ------------- | ------------------------------------------------------------- |
| Topology      | `triangle-list`                                               |
| Cull mode     | `back` (or `none` if `PBR_HAS_DOUBLE_SIDED`)                  |
| Front face    | `ccw`                                                         |
| Depth format  | `depth24plus-stencil8`                                        |
| Depth compare | `greater-equal`                                               |
| Depth write   | `true` (disabled for alpha-blend variants)                    |
| MSAA          | `count = msaaSamples` (4)                                     |
| Color target  | Canvas preferred format, alpha blend if `PBR_HAS_ALPHA_BLEND` |

### Bind Group Layouts

**Group 0 — Scene Uniforms** (shared across all materials):

| Binding | Visibility         | Type                                       |
| ------- | ------------------ | ------------------------------------------ |
| 0       | VERTEX \| FRAGMENT | Uniform buffer (size varies with features) |

**Group 1 — PBR Mesh** (dynamic, binding indices assigned by `ShaderComposer`):

Binding 0 is always the mesh UBO (VERTEX+FRAGMENT). Subsequent bindings are assigned sequentially by the composer based on which fragments are active. The order follows fragment topological sort:

- Mesh UBO — always (binding 0)
- Morph target texture + UBO — if `MSH_HAS_MORPH_TARGETS`
- Bone sampler texture — if `MSH_HAS_SKELETON`
- Base color texture + sampler — always
- Normal texture + sampler — if `PBR_HAS_NORMAL_MAP`
- ORM texture + sampler — always (or specGloss texture)
- Emissive texture + sampler — if `PBR_HAS_EMISSIVE`
- BRDF LUT + sampler + IBL cubemap + sampler — if `PBR_HAS_ENV`
- Reflectance maps + samplers — if reflectance extension
- Sheen texture + sampler — if `PBR_HAS_SHEEN_TEXTURE`
- Lightmap texture + sampler — if the opt-in PBR lightmap extension is active

**Group 2 — Shadow** (only when `MSH_RECEIVE_SHADOWS`):

Per-light shadow info UBOs, shadow textures, and shadow samplers.

## `_buildGroup` Pattern

`pbr-material.ts` exports `pbrGroupBuilder`, a `MeshGroupBuilder` function that dynamically imports `pbr-renderable.js` at build time. This function is set as the `_buildGroup` field on every PBR material created by `createPbrMaterial()`. At `startEngine()`, `scene.ts` calls each mesh's `material._buildGroup`, grouping meshes by builder identity so that all PBR meshes are batched together for a single `buildPbrRenderables()` call.

The builder stores the returned `rebuildSingle` closure on `pbrGroupBuilder._rebuildSingle`. The closure is captured inside `pbr-renderable.ts`, reuses the initial per-scene caches, and rebuilds one mesh for material swaps, `rebuildMaterial()`, and per-pass `RenderTask.addMesh(mesh, { material })` overrides.

## Visible Environment Skybox Opt-Ins

Visible HDR and DDS skyboxes each have one canonical renderable builder:

- `buildHdrSkyboxRenderable`
- `buildDdsSkyboxRenderable`

The builders patch their fragment shader from a fixed core when an optional environment feature is enabled. They never select or import alternate renderable builders.

Two public scene setters provide independent opt-ins:

```ts
setEnvironmentBlur(scene: SceneContext, blur: number): void;
setEnvironmentRotation(scene: SceneContext, rotation: number): void;
```

Each setter registers one feature-owned patch loader in an ordered composition slot with a feature-agnostic composer stored on that scene. Rotation therefore always applies before blur regardless of setter call order. Configuring one scene cannot activate a feature for another scene.

The canonical builders contain only one optional call to the scene-local composer. They do not import the composer or either feature patch, keeping non-feature skybox consumers at the canonical-builder baseline. This follows the PBR/Standard extension principle without a global registry: generic composition is retained only by consumers that import an environment feature setter.

The core skybox shader has two composition slots:

| Slot      | Default                   | Optional contribution                                                                                     |
| --------- | ------------------------- | --------------------------------------------------------------------------------------------------------- |
| Direction | Normalized cube direction | `setEnvironmentRotation` rotates the sampling direction around Y using the `envRotationY` scene uniform   |
| LOD       | Mip level `0.0`           | `setEnvironmentBlur` computes a clamped fractional cubemap LOD from blur, cubemap size, scale, and offset |

Blur and rotation patches are separate modules. Importing one setter does not retain the other patch. The rotation registration loads its patch only when the scene-local composer first runs during visible-skybox construction, while the blur registration resolves its statically imported patch. Lighting-only consumers do not fetch the rotation patch.

The first call to either setter must occur before the visible skybox is built so its shader variant includes the corresponding patch. Subsequent calls update scene-uniform data and take effect without rebuilding the skybox.

## Internal Architecture

### Scene Uniform Buffer Layout (Group 0, Binding 0)

PBR uses the canonical `SceneUniforms` shared with Standard/material-independent passes. The struct is fixed-size (`SCENE_UBO_BYTES = 352`) and is declared in `packages/babylon-lite/shaders/scene-uniforms.wgsl`. It contains view/projection matrices, camera position, environment rotation, SH irradiance, image-processing fields, and fog fields.

The environment rotation slot remains in this fixed layout for alignment and shader compatibility, but the base scene packer and cache key do not read it. Rotation is setter-only: `setEnvironmentRotation` owns the internal scene value, lazy skybox-patch registration, contributor registration, and task-cache invalidation. Environment loaders register the same contributor for SH data, while glTF image-based lights may initialize the internal value from asset metadata.

Light data is **not** stored in `SceneUniforms`. PBR direct lighting reads the scene-owned `LightsUniforms` UBO at group 0 binding 1 when `_hasSingleLight` or `_hasMultiLight` is enabled.

### Mesh Uniform Buffer Layout (Group 1, Binding 0)

Base fields (always present):

| Offset (bytes) | Size                        | WGSL Type                                | Field                                              |
| -------------- | --------------------------- | ---------------------------------------- | -------------------------------------------------- |
| 0              | 64                          | `mat4x4<f32>`                            | `world`                                            |
| 64             | 4                           | `u32`                                    | `lc`                                               |
| 80..           | `ceil(MAX_LIGHTS / 4) × 16` | `array<vec4<u32>, ceil(MAX_LIGHTS / 4)>` | packed light indices into group-0 `LightsUniforms` |

Additional fields appended by fragments:

| Field                                                               | Type                      | Fragment               |
| ------------------------------------------------------------------- | ------------------------- | ---------------------- |
| `metallicReflectanceColor`, `metallicF0Factor`, `occlusionStrength` | `vec3<f32>`, `f32`, `f32` | `reflectance-fragment` |
| `emissiveColor`                                                     | `vec3<f32>`               | `emissive-fragment`    |
| `ccParams`, `ccRefractionParams`                                    | `vec4<f32>`, `vec4<f32>`  | `clearcoat-fragment`   |
| `sheenParams`, `sheenParams2`                                       | `vec4<f32>`, `vec4<f32>`  | `sheen-fragment`       |

The exact layout is computed by `computeUboLayout()` from the merged UBO field list.

### Pipeline Caching

`getOrCreatePbrPipeline` keeps a per-`PbrShaderBindings` `Map<targetSignatureKey(sig), GPURenderPipeline>`. Bind-group layouts are stable across signatures (only the pipeline depends on `sig`), so meshBGs validate against any pipeline produced for the same `(features, features2)` bindings instance.

### Shader Template (`pbr-template.ts`)

`createPbrTemplate(config)` builds a `ShaderTemplate` with:

- **Vertex template** — world transform, optional TBN (tangent or cotangent), UV passthrough, slot markers for morph (`/*VR*/`), skinning (`/*VW*/`), shadow (`/*VB*/`)
- **Fragment template** — texture sampling, BRDF functions (always included: GGX NDF, Smith-GGX geometry, Schlick Fresnel), optional specular AA, optional gamma decode, slot markers for material setup (`/*MF*/`, `/*SV*/`, `/*BL*/`), direct lighting (`/*AD*/`), IBL (`/*AI*/` or `/*NI*/`), post-effects (`/*AT*/`, `/*BC*/`, `/*BA*/`)
- **Base UBO fields** for the mesh light-selection data and **base bindings** for the always-present textures; direct lighting uses the fixed group-0 lights UBO

Supports both metallic-roughness and specular-glossiness workflows via `_hasSpecGloss`.

### Composed Shader Caching

`pbr-renderable.ts` maintains composed shader caches keyed by material features, extended features, mesh features, scene features, light mode, and shader variant key. The same captured composer is used by the `rebuildSingle` closure returned from the initial build.

### Renderable Builder (`pbr-renderable.ts`)

`buildPbrRenderables(scene, meshes, envTextures)`:

1. Dynamically imports only the fragment modules needed by the mesh set
2. Computes per-mesh affected light indices from scene lights
3. Creates composed shaders per feature bitmask and per-mesh light mode (no light, single-light fast path, or multi/shadow path)
4. Builds per-mesh mesh/material UBOs and bind groups; the mesh UBO stores `lc` and packed `li` scene-light indices
5. For each mesh: `computePbrFeatures()` → compose shader → `getOrCreatePbrPipeline()` → create mesh UBO → `createPbrMeshBindGroup()`
6. Returns one `Renderable` per mesh; each renderable binds target-specific `DrawBinding`s for frame-graph passes
7. Uses opaque order = 100 and transparent/transmissive order = 150; scene-texture refraction surfaces set `_transmissive` and bind against `RenderTargetSignature._transmissionTexture` during `record()`
8. Returns `rebuildSingle` so material swaps and per-pass material overrides can rebuild one mesh without rebuilding the whole scene
9. Sets up disposal to clear pipeline cache and samplers on scene teardown

### Single-Mesh Rebuild Closure

The `rebuildSingle(scene, mesh, materialOverride?)` closure returned from `buildPbrRenderables()` rebuilds one mesh after a material swap or pass-specific override without rebuilding the entire scene. It accepts `MaterialOrView`, uses view render features with source material resources, reuses captured per-scene fragment imports/composer caches/shadow caches/environment state, recomputes mesh features and light variants, creates/reuses shader bindings and pipelines, and returns a `Renderable` that early-exits if the mesh material changed again unless it was built for an explicit override.

## Shader Logic

### Vertex Shader (composed by template + fragments)

**Inputs**: position (`vec3`), normal (`vec3`), uv (`vec2`), optional tangent (`vec4`), optional joints/weights, optional instance matrix.

**Processing**:

1. `/*VR*/` — Morph target application (if `MSH_HAS_MORPH_TARGETS`): accumulates position/normal deltas from morph texture
2. `/*VW*/` — Skinning (if `MSH_HAS_SKELETON`): `finalWorld = mesh.world * boneInfluence`; otherwise `finalWorld = mesh.world`
3. `worldPos = finalWorld × vec4(position, 1.0)`
4. `clipPos = scene.viewProjection × worldPos`
5. `worldNormal = normalize((finalWorld × vec4(normalize(normal), 0)).xyz)`
6. If tangent normal map — compute TBN **in local space first** (critical for reflection matrices):
    ```
    N_local = normalize(normal)
    T_local = normalize(tangent.xyz)
    B_local = cross(N_local, T_local) * tangent.w
    worldTangent = normalize((finalWorld × vec4(T_local, 0)).xyz)
    worldBitangent = normalize((finalWorld × vec4(B_local, 0)).xyz)
    ```
7. `/*VB*/` — Shadow light-space transform (if `MSH_RECEIVE_SHADOWS`)

**Outputs**: `worldPos`, `worldNormal`, [`worldTangent`, `worldBitangent`], `uv`, optional shadow varyings.

### Fragment Shader (composed by template + fragments)

#### 1. Texture Sampling (always)

```
baseColor = textureSample(baseColorTexture, baseColorSampler, uv)
// Optional gamma decode when gammaAlbedo flag is set
occlusion = orm.r
roughness = clamp(orm.g, 0.04, 1.0)
metallic  = orm.b
```

#### 2. Material Setup Slots

- `/*MF*/` — Reflectance F0 remap (reflectance-fragment), clearcoat IOR remap (clearcoat-fragment)
- `/*SV*/` — Sheen variable initialization (sheen-fragment)
- `/*BL*/` — Clearcoat variable initialization (clearcoat-fragment)

#### 3. Normal Mapping

- Tangent mode (`PBR_HAS_NORMAL_MAP`): TBN matrix from interpolated tangent/bitangent
- Cotangent mode (`PBR_HAS_COTANGENT_NORMAL`): cotangent-frame reconstruction from screen-space derivatives
- Neither: `N = normalize(worldNormal)`, with front-face flip if double-sided

#### 4. Emissive

- If `PBR_HAS_EMISSIVE`: `emissive = textureSample(emissiveTexture, ...).rgb`
- `/*AT*/` slot: `emissive-fragment` adds emissive color uniform contribution

#### 5. Direct Lighting + `/*AD*/` Slot

BRDF evaluation (GGX NDF + Smith-GGX geometry + Schlick Fresnel) for the primary light, plus:

- Clearcoat direct BRDF (clearcoat-fragment `AD`)
- Sheen direct term (sheen-fragment `AD`)
- Shadow factor application (pbr-shadow-fragment `AD`)
- Single-light direct block when `_hasSingleLight` is enabled
- Multi-light loop when `_hasMultiLight` is enabled

#### 6. Environment Lighting — `/*AI*/` or `/*NI*/` Slot

- `AI` (IBL path): SH irradiance, specular radiance via split-sum, BRDF LUT, energy conservation, horizon occlusion, clearcoat IBL, sheen IBL
- `NI` (non-IBL path): clearcoat/sheen non-IBL conservation

#### 7. Final Composition — `/*BC*/` and `/*BA*/` Slots

- Emissive additive
- Lightmap contributions
- Alpha blend luminance accumulation (`BA`)

#### 8. Image Processing (if `PBR_HAS_TONEMAP`)

- Exposure: `color *= exposureLinear`
- Tone mapping: `color = color / (1 + color)`
- Contrast adjustment
- Gamma: `pow(color, 1/2.2)`

## Babylon.js Equivalence Map

| Babylon Lite                                 | Babylon.js                                          |
| -------------------------------------------- | --------------------------------------------------- |
| `computePbrFeatures()`                       | Internal define flags in `PBRMaterial._getEffect()` |
| `getOrCreatePbrPipeline()`                   | Pipeline cache in `PBRMaterial._getEffect()`        |
| `createPbrTemplate()` + `composeShader()`    | GLSL shader generation from defines                 |
| `ShaderFragment` composition                 | `#include` / `#define` preprocessor                 |
| Scene UBO (group 0)                          | `Scene.sceneUbo`                                    |
| Mesh UBO (group 1, binding 0)                | `Mesh._uniformBuffer`                               |
| `PBR_HAS_NORMAL_MAP`                         | `#define BUMP`                                      |
| `PBR_HAS_EMISSIVE`                           | `#define EMISSIVE`                                  |
| `PBR_HAS_ENV`                                | `#define REFLECTION` + `#define SS_REFRACTION`      |
| `PBR_HAS_CLEARCOAT`                          | `#define CLEARCOAT`                                 |
| `PBR_HAS_SHEEN`                              | `#define SHEEN`                                     |
| `MSH_HAS_SKELETON`                           | `#define BONES`                                     |
| `MSH_HAS_MORPH_TARGETS`                      | `#define MORPHTARGETS`                              |
| `MSH_RECEIVE_SHADOWS`                        | `#define SHADOW0`                                   |
| `PBR_HAS_SPEC_GLOSS`                         | `#define SPECULARGLOSSINESS`                        |
| `PBR_HAS_SPECULAR_AA`                        | `#define SPECULARAA`                                |
| `rebuildSingle` closure                      | `Material._markAllSubMeshesAsAllDirty()`            |
| `singlelight-wgsl.ts` / `multilight-wgsl.ts` | Direct-light setup/functions in `pbr.fragment.fx`   |

## Dependencies

- **`pbr-material.ts`**: Imports `Texture2D` from texture-2d, `MeshGroupBuilder` from renderable.
- **`pbr-flags.ts`**: Pure PBR feature/ext constants and registry helpers. No light-extension dependency.
- **`pbr-template.ts`**: Imports `ShaderTemplate`, `UboField`, `VertexAttribute`, `Varying`, `BindingDecl` from fragment-types.
- **`pbr-pipeline.ts`**: Imports `PbrMaterialProps` from pbr-material, `ComposedShader` from shader-composer, feature flags from pbr-flags.
- **`pbr-renderable.ts`**: Imports pipeline functions, template creator, shader composer, fragment factories (dynamic), engine/scene/mesh/light types, material-view types, resource pool helpers, and returns the single-mesh rebuild closure.
- **`no-color-view.ts`**: Imports `createMaterialView` and PBR feature flags to create no-color material views without pulling the helper into ordinary PBR scenes.
- **`fragments/singlelight-wgsl.ts`**: No imports (pure WGSL string helpers).
- **`fragments/multilight-wgsl.ts`**: Imports `MAX_LIGHTS` to size the generated WGSL arrays.
- **Fragment modules**: Each imports only `ShaderFragment` (and optionally `BindingDecl`, `Varying`) from `fragment-types.js`.
- **Depended on by**: `load-gltf.ts` (imports `PbrMaterialProps`, `createPbrMaterial`), `background-renderable.ts` (reuses scene BGL/BG), `index.ts` (public exports).

## Test Specification

| Test                                       | Description                                                 |
| ------------------------------------------ | ----------------------------------------------------------- |
| `pipeline cache hit`                       | Same features+format+msaa → same pipeline object            |
| `pipeline cache miss on features`          | Different features → different pipeline                     |
| `vertex buffers with tangent`              | HAS_NORMAL_MAP → tangent buffer in layout                   |
| `vertex buffers without tangent`           | No HAS_NORMAL_MAP → no tangent buffer                       |
| `composed shader with IBL`                 | IBL fragment injects BRDF LUT + cubemap bindings            |
| `composed shader without IBL`              | Fragment omits IBL blocks, smaller output                   |
| `clearcoat fragment integration`           | Clearcoat slots inject BRDF + energy conservation code      |
| `sheen fragment integration`               | Sheen slots inject Charlie NDF + Ashikhmin visibility       |
| `skeleton fragment`                        | 4-bone and 8-bone vertex attribute injection                |
| `morph fragment`                           | Morph target texture binding + vertex slot code             |
| `shadow fragment ESM`                      | ESM shadow factor computation per light                     |
| `shadow fragment PCF`                      | PCF shadow factor computation per light                     |
| `single rebuild`                           | Material swap rebuilds one mesh without full scene teardown |
| `GGX NDF at roughness=0.5, NdotH=1`        | D = α⁴/(π) ≈ 0.001245                                       |
| `Fresnel at cosθ=0`                        | F = 1.0 (full reflection)                                   |
| `Image processing: exposure=1, contrast=1` | Tone map only                                               |

## File Manifest

| File                                                   | Size       | Purpose                                                                                                                                         |
| ------------------------------------------------------ | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/material/pbr/pbr-material.ts`                     | ~140 lines | `PbrMaterialProps`, `ClearCoatProps`, `SheenProps` interfaces + `createPbrMaterial()` factory + `pbrGroupBuilder` + `collectPbrBoundTextures()` |
| `src/material/pbr/pbr-flags.ts`                        | ~43 lines  | Feature flag bit constants + PBR extension registry helpers                                                                                     |
| `src/material/pbr/pbr-template.ts`                     | ~465 lines | `PbrTemplateConfig` + `createPbrTemplate()` — builds `ShaderTemplate` with BRDF helpers, slot markers, base UBO/bindings                        |
| `src/material/pbr/pbr-pipeline.ts`                     | ~284 lines | `computePbrFeatures()`, `getOrCreatePbrPipeline()`, `createPbrMeshBindGroup()`, pipeline cache management                                       |
| `src/material/pbr/pbr-renderable.ts`                   | ~723 lines | `buildPbrRenderables()` — dynamic fragment import, shader composition, lights UBO setup, renderable creation, single-mesh rebuild closure       |
| `src/material/pbr/no-color-view.ts`                    | ~18 lines  | `createPbrNoColorMaterialView()` — pass-specific no-color material view helper                                                                  |
| `src/material/pbr/fragments/singlelight-wgsl.ts`       | ~75 lines  | Lazy WGSL helpers for the non-looping one-light direct path                                                                                     |
| `src/material/pbr/fragments/multilight-wgsl.ts`        | ~120 lines | Lazy WGSL helpers: `MULTI_LIGHT_STRUCTS()`, `COMPUTE_PBR_LIGHT`, `getMultiLightLoop()`                                                          |
| `src/material/pbr/fragments/ibl-fragment.ts`           | ~86 lines  | IBL environment lighting fragment (BRDF LUT, specular cubemap, SH irradiance)                                                                   |
| `src/material/pbr/fragments/local-cubemap-fragment.ts` | ~600 lines | Opt-in per-material environments, finite box/sphere projection, and fragment-weighted probe-array IBL                                           |
| `src/material/pbr/enable-pbr-local-cubemap.ts`         | ~500 lines | Public local-environment API, validation, probe packing, cube-array creation, and voxel lookup                                                  |
| `src/material/pbr/fragments/clearcoat-fragment.ts`     | ~122 lines | Clearcoat layer fragment (Kelemen visibility, F0 remap, direct + IBL clearcoat)                                                                 |
| `src/material/pbr/fragments/sheen-fragment.ts`         | ~115 lines | Sheen layer fragment (Charlie NDF, Ashikhmin visibility, direct + IBL sheen)                                                                    |
| `src/material/pbr/fragments/reflectance-fragment.ts`   | ~79 lines  | Metallic reflectance extension fragment (F0 computation, reflectance maps)                                                                      |
| `src/material/pbr/fragments/emissive-fragment.ts`      | ~29 lines  | Emissive color uniform fragment                                                                                                                 |
| `src/material/pbr/fragments/lightmap-fragment.ts`      | ~140 lines | Opt-in baked lightmap fragment (UV1/UV2, additive/shadowmap, gamma decode, effective V flip)                                                    |
| `src/material/pbr/enable-pbr-lightmap.ts`              | ~70 lines  | Published `enablePbrLightmap()` / `setPbrLightmap()` opt-in seam                                                                                |
| `src/material/pbr/fragments/morph-fragment.ts`         | ~48 lines  | Morph target vertex animation fragment                                                                                                          |
| `src/material/pbr/fragments/skeleton-fragment.ts`      | ~71 lines  | Skeletal animation fragment (4-bone or 8-bone)                                                                                                  |
| `src/material/pbr/fragments/pbr-shadow-fragment.ts`    | ~143 lines | PBR shadow receiving fragment (ESM + PCF, per-light)                                                                                            |
| `src/shader/shader-composer.ts`                        | ~293 lines | `composeShader()` — topological sort, UBO merge, binding assignment, slot injection                                                             |
