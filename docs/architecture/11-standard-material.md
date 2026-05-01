# Module: Standard Material (Blinn-Phong)
> Package path: `packages/babylon-lite/src/material/standard/`
> Files: `standard-material.ts` (types/factory), `standard-template.ts` (shader template), `standard-pipeline.ts` (pipeline cache), `standard-renderable.ts` (renderable builder), `standard-single-rebuild.ts` (hot material swap)

## Purpose

The StandardMaterial module implements a Blinn-Phong shading model with point/directional light support, optional fog (linear, exponential, exponential-squared), optional diffuse texture, optional emissive texture, optional bump/normal-map texture, optional specular texture, optional ambient/occlusion texture, optional lightmap texture, optional opacity/transparency texture, optional reflection texture (spherical and planar modes), UV2 support for select texture channels, thin instances with per-instance color, `disableLighting` mode, and optional ESM/PCF shadow receiving. It matches the output of `BABYLON.StandardMaterial` with the corresponding defines active.

Shaders are **dynamically composed** via the `ShaderFragment` / `ShaderComposer` system — no raw `.wgsl` files. A `ShaderTemplate` (`standard-template.ts`) provides the base WGSL with slot markers; optional `ShaderFragment` modules (in `fragments/`) inject code into those slots. Only the fragments needed for a given mesh's features are composed, minimizing bundle size per the Size Pillar. Fragment modules are **dynamically imported** at build time so unused features are tree-shaken. The old `standard-textured-material.ts` was merged into this unified system.

## ShaderFragment Composition System

Standard material shaders are built using the same `ShaderComposer` architecture as PBR (defined in `src/shader/shader-composer.ts`):

1. **`ShaderTemplate`** (`standard-template.ts` → `createStandardTemplate()`) — provides base vertex/fragment WGSL with slot markers (e.g. `/*AC*/`, `/*AD*/`, `/*AT*/`, `/*BC*/`, `/*BA*/`, `/*SV*/`, `/*VB*/`), base UBO fields, base vertex attributes, base varyings, and base bindings for lights/material/diffuse.

2. **`ShaderFragment`** — each optional feature (normal mapping, emissive texture, specular texture, ambient texture, lightmap, opacity, reflection, shadows) is a fragment object with:
   - `id` — unique string identifier
   - `fragmentSlots` / `vertexSlots` — WGSL snippets keyed by slot name
   - `bindings` — `BindingDecl[]` for textures/samplers
   - `varyings` — additional inter-stage varyings (shadows)
   - `helperFunctions` / `vertexHelperFunctions` — WGSL helper code

3. **`composeShader(template, fragments)`** — topologically sorts fragments, merges UBO fields, assigns binding indices, replaces slot markers, and returns a `ComposedShader` with final WGSL + bind group layout descriptors.

### Composition Flow (Standard)

```
standard-material.ts (standardGroupBuilder):
  1. Scans meshes for needed features (bump, emissive, specular, etc.)
  2. Dynamically imports only needed fragment modules
  3. Passes fragment factories to buildStandardMeshRenderables()

standard-renderable.ts (buildStandardMeshRenderables):
  1. Groups meshes by feature bitmask
  2. Per group: builds fragment list from feature flags + fragment factories
  3. Calls composeStandardShader(features, fragments) → ComposedShader
  4. Calls getOrCreatePipeline() with composed shader
```

## `_buildGroup` Pattern

`standard-material.ts` defines `standardGroupBuilder` (not exported), a `MeshGroupBuilder` function that dynamically imports `standard-renderable.js` and the needed fragment modules. This function is set as the `_buildGroup` field on every standard material created by `createStandardMaterial()`. At `startEngine()`, `scene.ts` groups meshes by builder identity so that all standard-material meshes are batched together for a single `buildStandardMeshRenderables()` call.

`standardGroupBuilder` detects which features are needed across all meshes and conditionally imports only the required fragment modules, plus `thin-instance-gpu.ts` when thin instances are present. This ensures zero bundle-size impact for unused features. It also installs `_loadRebuildSingle = () => import("./standard-single-rebuild.js")` for hot material swapping.

## Dynamic Feature Flags

| Flag | Bit | Condition | Shader effect |
|---|---|---|---|
| `HAS_DIFFUSE_TEXTURE` | `1 << 0` | `material.diffuseTexture` | Diffuse texture sampling |
| `HAS_EMISSIVE_TEXTURE` | `1 << 1` | `material.emissiveTexture` | Emissive texture sampling |
| `RECEIVE_SHADOWS` | `1 << 2` | `mesh.receiveShadows` | ESM shadow map |
| `HAS_BUMP_TEXTURE` | `1 << 3` | `material.bumpTexture` | Cotangent-frame normal mapping |
| `HAS_SPECULAR_TEXTURE` | `1 << 4` | `material.specularTexture` | Specular texture replaces specularColor |
| `HAS_AMBIENT_TEXTURE` | `1 << 5` | `material.ambientTexture` | Ambient occlusion multiply |
| `HAS_LIGHTMAP_TEXTURE` | `1 << 6` | `material.lightmapTexture` | Additive lightmap |
| `HAS_OPACITY_TEXTURE` | `1 << 7` | `material.opacityTexture` | Alpha blending |
| `LIGHTMAP_USES_UV2` | `1 << 8` | Lightmap on UV2 | UV2 attribute for lightmap |
| `AMBIENT_USES_UV2` | `1 << 9` | Ambient on UV2 | UV2 attribute for ambient |
| `DOUBLE_SIDED` | `1 << 10` | `!material.backFaceCulling` | `cullMode: 'none'` |
| `DIFFUSE_USES_UV2` | `1 << 11` | Diffuse on UV2 | UV2 attribute for diffuse |
| `SPECULAR_USES_UV2` | `1 << 12` | Specular on UV2 | UV2 attribute for specular |
| `OPACITY_FROM_RGB` | `1 << 13` | `material.opacityFromRGB` | Opacity from RGB luminance |
| `HAS_REFLECTION_TEXTURE` | `1 << 14` | `material.reflectionTexture` | Spherical/planar reflection |
| `THIN_INSTANCES` | `1 << 15` | `mesh.thinInstances` | Instance matrix attributes + instanced draw |
| `THIN_INSTANCE_COLOR` | `1 << 16` | `mesh.thinInstances.colors` | Per-instance color varying |
| `DISABLE_LIGHTING` | `1 << 17` | `material.disableLighting` | Skip light loop, emissive-only output |
| `PCF_SHADOWS` | `1 << 18` | PCF shadow generator | PCF shadow sampling instead of ESM |
| `NEEDS_UV` | derived | Any texture present | UV vertex attribute |
| `NEEDS_UV2` | derived | Any `*_USES_UV2` flag | UV2 vertex attribute |

Pipelines are cached per `(features, format, msaaSamples, fragmentIds)` tuple.

## Public API Surface

### Types (`standard-material.ts`)

```typescript
import type { MeshGroupBuilder } from '../../render/renderable.js';

/** StandardMaterial properties — plain data. */
export interface StandardMaterialProps {
  diffuseColor: [number, number, number];
  alpha: number;
  specularColor: [number, number, number];
  specularPower: number;
  emissiveColor: [number, number, number];
  ambientColor: [number, number, number];
  diffuseTexture: Texture2D | null;
  diffuseCoordIndex: 0 | 1;
  emissiveTexture: Texture2D | null;
  bumpTexture: Texture2D | null;
  bumpLevel: number;
  specularTexture: Texture2D | null;
  specularCoordIndex: 0 | 1;
  ambientTexture: Texture2D | null;
  ambientTexLevel: number;
  ambientCoordIndex: 0 | 1;
  lightmapTexture: Texture2D | null;
  lightmapLevel: number;
  lightmapCoordIndex: 0 | 1;
  opacityTexture: Texture2D | null;
  opacityLevel: number;
  opacityFromRGB: boolean;
  alphaCutOff: number;
  reflectionTexture: Texture2D | null;
  reflectionLevel: number;
  reflectionCoordMode: 1 | 2;
  uvScale: [number, number];
  backFaceCulling: boolean;
  disableLighting: boolean;
  readonly _buildGroup: MeshGroupBuilder;
}

/** Fog configuration — plain data. */
export interface FogConfig {
  mode: 0 | 1 | 2 | 3;  // 0=off, 1=exp, 2=exp2, 3=linear
  density: number;
  start: number;
  end: number;
  color: [number, number, number];
}

/** Create StandardMaterial with Babylon defaults. Sets _buildGroup to standardGroupBuilder. */
export function createStandardMaterial(): StandardMaterialProps;

/** Collect all non-null textures for acquire/release tracking. */
export function collectStdBoundTextures(mat: StandardMaterialProps): Texture2D[];
```

### Pipeline (`standard-pipeline.ts`)

```typescript
// Feature flags (see Dynamic Feature Flags table above for full list)
export const HAS_DIFFUSE_TEXTURE     = 1 << 0;
// ... (all flags as documented)
export const PCF_SHADOWS             = 1 << 18;

export function computeFeatures(mat: StandardMaterialProps, receiveShadows: boolean): number;
export function featuresToTemplateConfig(features: number): StandardTemplateConfig;
export function composeStandardShader(features: number, fragments?: ShaderFragment[]): ComposedShader;

export function getOrCreatePipeline(
  device: GPUDevice, format: GPUTextureFormat, msaaSamples: number,
  features: number, composed: ComposedShader, fragments?: ShaderFragment[],
): PipelineVariant;

export function createDynamicMeshGPU(
  device: GPUDevice, variant: PipelineVariant, opts: DynamicMeshOpts,
): DynamicMeshGPU;

export function clearStandardPipelineCache(): void;
export function releaseStandardPipelineVariant(variant: PipelineVariant): void;

export function registerPcfShadowShader(ext: ShadowShaderExt): void;
export function getPcfShadowExt(): ShadowShaderExt | null;

// Re-exports from lights-ubo
export { LIGHTS_UBO_SIZE, getLightsUboSize, writeLightsUBO, refreshLightsUBO };
```

### Template (`standard-template.ts`)

```typescript
/** Configuration for standard shader template generation. */
export interface StandardTemplateConfig {
  textures: {
    diffuse?: boolean;
    emissive?: boolean;
    bump?: boolean;
    specular?: boolean;
    ambient?: boolean;
    lightmap?: boolean;
    opacity?: boolean;
    reflection?: boolean;
  };
  needsUV: boolean;
  needsUV2: boolean;
  lightmapUsesUV2?: boolean;
  ambientUsesUV2?: boolean;
  diffuseUsesUV2?: boolean;
  specularUsesUV2?: boolean;
  hasShadow: boolean;
  hasPcfShadow?: boolean;
  opacityFromRGB?: boolean;
  disableLighting?: boolean;
}

/** Create a ShaderTemplate from standard material configuration. */
export function createStandardTemplate(config: StandardTemplateConfig): ShaderTemplate;
```

### Renderable (`standard-renderable.ts`)

```typescript
/** Fragment factories passed from standardGroupBuilder. */
export interface StdFragmentFactories {
  tiSync?: ThinInstanceSync;
  tiFragment?: ShaderFragment;
  bumpFragment?: ShaderFragment;
  shadowFragment?: (shadowLights: ShadowLightSlot[]) => ShaderFragment;
  emissiveFragment?: ShaderFragment;
  specularFragment?: (usesUV2: boolean) => ShaderFragment;
  ambientFragment?: (usesUV2: boolean) => ShaderFragment;
  lightmapFragment?: (usesUV2: boolean) => ShaderFragment;
  opacityFragment?: (fromRGB: boolean) => ShaderFragment;
  reflectionFragment?: ShaderFragment;
}

export function buildStandardMeshRenderables(
  scene: SceneContext, meshes: Mesh[], factories: StdFragmentFactories,
): { renderables: Renderable[]; updater: SceneUniformUpdater };
```

### Single-Material Rebuild (`standard-single-rebuild.ts`)

```typescript
/** Rebuild a single mesh renderable after material swap without rebuilding entire scene. */
export function buildSingleStandardRenderable(scene: SceneContext, mesh: Mesh): Renderable;
```

### Default Material Values

| Property | Default |
|---|---|
| `diffuseColor` | `[1, 1, 1]` |
| `alpha` | `1` |
| `specularColor` | `[1, 1, 1]` |
| `specularPower` | `64` |
| `emissiveColor` | `[0, 0, 0]` |
| `ambientColor` | `[0, 0, 0]` |
| `diffuseTexture` | `null` |
| `diffuseCoordIndex` | `0` |
| `emissiveTexture` | `null` |
| `bumpTexture` | `null` |
| `bumpLevel` | `1` |
| `specularTexture` | `null` |
| `specularCoordIndex` | `0` |
| `ambientTexture` | `null` |
| `ambientTexLevel` | `1` |
| `ambientCoordIndex` | `0` |
| `lightmapTexture` | `null` |
| `lightmapLevel` | `1` |
| `lightmapCoordIndex` | `1` |
| `opacityTexture` | `null` |
| `opacityLevel` | `1` |
| `opacityFromRGB` | `false` |
| `alphaCutOff` | `0.4` |
| `reflectionTexture` | `null` |
| `reflectionLevel` | `1` |
| `reflectionCoordMode` | `1` |
| `uvScale` | `[1, 1]` |
| `backFaceCulling` | `true` |
| `disableLighting` | `false` |

## Pipeline Configuration

### Vertex Buffers (varies by features)

**Base (always present):**

| Slot | Attribute | Format | Stride | Shader Location |
|---|---|---|---|---|
| 0 | Position | `float32x3` | 12 bytes | `@location(0)` |
| 1 | Normal | `float32x3` | 12 bytes | `@location(1)` |

**Conditional (appended in order, slot numbers shift dynamically):**

| Attribute | Format | Stride | Step Mode | Shader Location(s) | When |
|---|---|---|---|---|---|
| UV | `float32x2` | 8 bytes | `vertex` | `@location(2)` | `NEEDS_UV` |
| UV2 | `float32x2` | 8 bytes | `vertex` | `@location(3)` | `NEEDS_UV2` |
| Instance matrix | 4× `float32x4` | 64 bytes | `instance` | `@location(N)..@location(N+3)` | `THIN_INSTANCES` |
| Instance color | `float32x4` | 16 bytes | `instance` | `@location(N+4)` | `THIN_INSTANCE_COLOR` |

### Pipeline State

| Setting | Value |
|---|---|
| Topology | `triangle-list` |
| Cull mode | `back` (or `none` if `DOUBLE_SIDED`) |
| Front face | `ccw` |
| Depth format | `depth24plus-stencil8` |
| Depth compare | `less-equal` |
| Depth write | `true` |
| MSAA | `count = msaaSamples` |
| Color target | Canvas preferred format, no blend |

### Bind Group Layouts

**Group 0 — Scene**:

| Binding | Visibility | Type |
|---|---|---|
| 0 | VERTEX \| FRAGMENT | Uniform buffer (canonical Scene UBO, 352 bytes) |

**Group 1 — Per-Mesh** (dynamic bindings based on features):

| Binding | Visibility | Type | Resource | When |
|---|---|---|---|---|
| 0 | VERTEX | Uniform buffer | Mesh UBO (64B) | Always |
| 1 | FRAGMENT | Uniform buffer | Light UBO (48B or 64B with shadow) | Always |
| 2 | FRAGMENT | Uniform buffer | Material UBO (96B) | Always |
| 3 | FRAGMENT | texture_2d | Diffuse texture | HAS_DIFFUSE_TEXTURE |
| 4 | FRAGMENT | sampler | Diffuse sampler | HAS_DIFFUSE_TEXTURE |
| 5 | VERTEX+FRAGMENT | Uniform buffer | Shadow UBO (96B) or UV UBO (16B) | RECEIVE_SHADOWS or NEEDS_UV |
| 6 | FRAGMENT | texture_2d | Emissive texture | HAS_EMISSIVE_TEXTURE |
| 7 | FRAGMENT | sampler | Emissive sampler | HAS_EMISSIVE_TEXTURE |
| 8 | FRAGMENT | texture_2d | Bump texture | HAS_BUMP_TEXTURE |
| 9 | FRAGMENT | sampler | Bump sampler | HAS_BUMP_TEXTURE |
| 10 | FRAGMENT | texture_2d | Specular texture | HAS_SPECULAR_TEXTURE |
| 11 | FRAGMENT | sampler | Specular sampler | HAS_SPECULAR_TEXTURE |
| 12 | FRAGMENT | texture_2d | Ambient texture | HAS_AMBIENT_TEXTURE |
| 13 | FRAGMENT | sampler | Ambient sampler | HAS_AMBIENT_TEXTURE |
| 14 | FRAGMENT | texture_2d | Lightmap texture | HAS_LIGHTMAP_TEXTURE |
| 15 | FRAGMENT | sampler | Lightmap sampler | HAS_LIGHTMAP_TEXTURE |
| 16 | FRAGMENT | texture_2d | Opacity texture | HAS_OPACITY_TEXTURE |
| 17 | FRAGMENT | sampler | Opacity sampler | HAS_OPACITY_TEXTURE |
| 18 | FRAGMENT | texture_2d | Reflection texture | HAS_REFLECTION_TEXTURE |
| 19 | FRAGMENT | sampler | Reflection sampler | HAS_REFLECTION_TEXTURE |

**Group 2 — Shadow Map** (only when RECEIVE_SHADOWS):

| Binding | Visibility | Type | Resource |
|---|---|---|---|
| 0 | FRAGMENT | texture_2d | Shadow map texture |
| 1 | FRAGMENT | sampler | Shadow map sampler |

## Internal Architecture

### Uniform Buffer Layouts

#### Scene UBO (Group 0, Binding 0) — 352 bytes (canonical `SceneUniforms`)

| Offset (bytes) | Floats | WGSL Type | Field |
|---|---|---|---|
| 0 | 0–15 | `mat4x4<f32>` | `viewProjection` |
| 64 | 16–31 | `mat4x4<f32>` | `view` |
| 128 | 32–35 | `vec4<f32>` | `vEyePosition` (xyz + pad) |
| 144 | 36–39 | Scalars/padding | environment rotation/padding |
| 160–303 | 40–75 | 9 × SH vec3 + padding | environment irradiance |
| 304 | 76–79 | Scalars/padding | exposure, contrast, LOD scale |
| 320 | 80–83 | `vec4<f32>` | `vFogInfos` (x=mode, y=start, z=end, w=density) |
| 336 | 84–87 | `vec4<f32>` | `vFogColor` (rgb + pad) |

#### Mesh UBO (Group 1, Binding 0) — 64 bytes

| Offset | WGSL Type | Field |
|---|---|---|
| 0 | `mat4x4<f32>` | `world` |

#### Lights UBO (Group 1, Binding 1) — 16-byte header + `MAX_LIGHTS × 64` bytes

| Offset (bytes) | Type | Field |
|---|---|---|
| 0–15 | `vec4<f32>` | `vLightData` — xyz=position/dir, w=0(point)/1(dir) |
| 16–31 | `vec4<f32>` | `vLightDiffuse` — rgb=diffuse×intensity, a=range |
| 32–47 | `vec4<f32>` | `vLightSpecular` — rgb=specular×intensity, a=0 |
| 48–63 | `vec4<f32>` | `shadowsInfo` — if RECEIVE_SHADOWS (x=darkness, z=depthScale, w=frustumEdgeFalloff) |

#### Material UBO (Group 1, Binding 2) — 96 bytes (24 floats)

| Offset (bytes) | Type | Field |
|---|---|---|
| 0–15 | `vec4<f32>` | `vDiffuseColor` — rgb=diffuse, a=alpha |
| 16–31 | `vec4<f32>` | `vSpecularColor` — rgb=specular, a=specularPower |
| 32–43 | `vec3<f32>` | `vEmissiveColor` |
| 44–47 | `f32` | `bumpScale` (1.0 / bumpLevel) |
| 48–59 | `vec3<f32>` | `vAmbientColor` |
| 60–63 | `f32` | `textureLevel` (1.0 when NEEDS_UV) |
| 64–67 | `f32` | `ambientTexLevel` |
| 68–71 | `f32` | `lightmapLevel` |
| 72–75 | `f32` | `opacityLevel` |
| 76–79 | `f32` | `alphaCutOff` |
| 80–83 | `f32` | `reflectionLevel` |
| 84–87 | `f32` | `reflectionCoordMode` (1=spherical, 2=planar) |
| 88–95 | 2× `f32` | padding |

#### Shadow UBO (Group 1, Binding 5) — 96 bytes (if RECEIVE_SHADOWS)

| Offset (bytes) | Type | Field |
|---|---|---|
| 0–63 | `mat4x4<f32>` | `lightMatrix` |
| 64–79 | `vec4<f32>` | `depthValues` (x=near, y=far) |
| 80–95 | `vec4<f32>` | `uvScaleOffset` (x=uScale, y=vScale, z=uOffset, w=vOffset) |

#### UV UBO (Group 1, Binding 5) — 16 bytes (if NEEDS_UV without shadow)

| Offset (bytes) | Type | Field |
|---|---|---|
| 0–15 | `vec4<f32>` | `uvScaleOffset` (x=uScale, y=vScale, z=uOffset, w=vOffset) |

### Shader Template (`standard-template.ts`)

`createStandardTemplate(config)` builds a `ShaderTemplate` with slot markers for fragment injection. The template provides:

**Always-present WGSL blocks (embedded in template):**

| Block | Contents | Included when |
|---|---|---|
| `LIGHTING_FN` | `computeLighting()` — Blinn-Phong with up to 4 lights, shadow factors | Not `DISABLE_LIGHTING` |
| `FOG_FN` | `calcFogFactor()` — linear/exp/exp2 from `WGSL_FOG` helper | Always |

**Template slot markers** (injected by `ShaderComposer`):

| Slot | Stage | Purpose |
|---|---|---|
| `/*AC*/` | Fragment | Normal perturbation (bump map) |
| `/*AD*/` | Fragment | Ambient/shadow/reflection contributions |
| `/*AT*/` | Fragment | Emissive/specular/opacity texture sampling |
| `/*BC*/` | Fragment | Post-lighting composition (lightmap, instance color) |
| `/*BA*/` | Fragment | Final alpha adjustments |
| `/*SV*/` | Fragment | Variable initialization |
| `/*VB*/` | Vertex | Shadow light-space transforms |
| `/*VR*/` | Vertex | Pre-transform modifications |
| `/*VW*/` | Vertex | World matrix override (skinning) |

**`disableLighting` path:** When `DISABLE_LIGHTING` is set, the template omits the lighting function, light loop, shadow factors, ambient, reflection, and lightmap. Output becomes `clamp(emissiveContrib * diffuseColor, 0, 1) * baseColor`.

**Per-instance color:** When `THIN_INSTANCE_COLOR` is set, a `vInstanceColor` varying passes from vertex to fragment. Applied after main composition in the `BC` slot as `color.rgb *= vInstanceColor.rgb`.

### Pipeline Caching (`standard-pipeline.ts`)

`getOrCreateStandardPipeline` keeps a per-`StandardShaderBindings` `Map<targetSignatureKey(sig), GPURenderPipeline>`. BGLs are stable across signatures (only the pipeline depends on `sig`), so meshBGs validate against any pipeline produced for the same `(features)` bindings instance.

Composed shaders are also cached per `(features, fragmentIds)` to avoid recomposition when only format/MSAA differs. The scene UBO is created per pipeline variant (not per mesh), and a single `SceneUniformUpdater` writes to ALL variant UBOs each frame.

Pipeline and composed shader caches are cleared on GPU device change.

### Renderable Builder (`standard-renderable.ts`)

`buildStandardMeshRenderables(scene, meshes, factories)`:
1. Groups meshes by feature bitmask (via `computeFeatures()`)
2. For each group: builds fragment list from feature flags + `StdFragmentFactories` → `composeStandardShader(features, fragments)` → `getOrCreatePipeline()` → `createDynamicMeshGPU()`
3. Creates one `Renderable` per group (order = 100, or 200 for transparent)
4. Creates a single `SceneUniformUpdater` that writes to all variant sceneUBOs and refreshes all cached light UBOs
5. Stashes first sceneUBO on scene for deferred builders (skybox)
6. Acquires textures for reference counting, registers cleanup disposables

When thin instances are present, the draw function calls `tiSync(device, ti, pass, slot, hasInstanceColor)` to synchronize GPU buffers before each instanced draw, and uses `drawIndexed(indexCount, ti.count)` for instanced rendering.

### Single-Material Rebuild (`standard-single-rebuild.ts`)

`buildSingleStandardRenderable(scene, mesh)`:
- Rebuilds a single mesh renderable after material swap without rebuilding the entire scene
- Computes feature bitmask from the mesh's current material
- Gets/creates pipeline variant and builds per-mesh GPU resources
- Computes light mask for the mesh and writes a filtered lights UBO
- Builds per-light shadow UBOs if shadow generators exist
- If no shared scene UBO exists yet, initializes it and pushes a scene uniform updater
- Acquires/releases textures for reference counting
- Returns a `Renderable` that early-exits draw if mesh material changed again
- Render order: `mesh.renderOrder ?? (isTransparent ? 200 : 100)`

## Fragment Modules

All fragments live in `src/material/standard/fragments/` and export factory functions returning `ShaderFragment` objects.

### `normal-map-fragment.ts` — Bump/Normal Mapping

- **Factory**: `createNormalMapFragment(): ShaderFragment`
- **ID**: `"normal-map"`
- **Bindings**: `bumpTex` (texture2D), `bumpSampler` (sampler)
- **Helper WGSL**: `WGSL_PERTURB_NORMAL` — cotangent-frame normal perturbation from screen-space derivatives
- **Fragment slot**:
  - `AC` — `normalW = perturbNormal(input.vNormalW, input.vPositionW, input.vUV, mat.bumpScale)`

### `std-emissive-fragment.ts` — Emissive Texture

- **Factory**: `createStdEmissiveFragment(): ShaderFragment`
- **ID**: `"std-emissive"`
- **Bindings**: `emissiveTex` (texture2D), `emissiveSampler` (sampler)
- **Fragment slot**:
  - `AT` — `emissiveContrib = mat.vEmissiveColor * textureSample(emissiveTex, ..., input.vUV).rgb * mat.textureLevel`

### `std-specular-fragment.ts` — Specular Texture

- **Factory**: `createStdSpecularFragment(usesUV2: boolean): ShaderFragment`
- **ID**: `"std-specular"`
- **Bindings**: `specularTex` (texture2D), `specularSampler` (sampler)
- **Fragment slot**:
  - `AT` — `specularColor = textureSample(specularTex, ..., uv).rgb` (uses UV or UV2 based on `usesUV2`)

### `std-ambient-fragment.ts` — Ambient/Occlusion Texture

- **Factory**: `createStdAmbientFragment(usesUV2: boolean): ShaderFragment`
- **ID**: `"std-ambient"`
- **Bindings**: `ambientTex` (texture2D), `ambientSampler` (sampler)
- **Fragment slot**:
  - `AD` — `baseAmbientColor = textureSample(ambientTex, ..., uv).rgb * mat.ambientTexLevel`

### `std-lightmap-fragment.ts` — Lightmap Texture

- **Factory**: `createStdLightmapFragment(usesUV2: boolean): ShaderFragment`
- **ID**: `"std-lightmap"`
- **Bindings**: `lightmapTex` (texture2D), `lightmapSampler` (sampler)
- **Fragment slot**:
  - `BC` — additive lightmap: `color = vec4(color.rgb + textureSample(lightmapTex, ..., uv).rgb * mat.lightmapLevel, color.a)`

### `std-opacity-fragment.ts` — Opacity/Transparency Texture

- **Factory**: `createStdOpacityFragment(fromRGB: boolean): ShaderFragment`
- **ID**: `"std-opacity"`
- **Bindings**: `opacityTex` (texture2D), `opacitySampler` (sampler)
- **Fragment slot**:
  - `AT` — modulates alpha:
    - RGB mode (`fromRGB=true`): `alpha *= luminance(textureSample(...).rgb) * mat.opacityLevel`
    - Alpha mode: `alpha *= textureSample(...).a * mat.opacityLevel`

### `std-reflection-fragment.ts` — Reflection Texture

- **Factory**: `createStdReflectionFragment(): ShaderFragment`
- **ID**: `"std-reflection"`
- **Bindings**: `reflectionTex` (texture2D), `reflectionSampler` (sampler)
- **Helper WGSL**: `computeSphericalCoords()`, `computePlanarCoords()`
- **Fragment slot**:
  - `AD` — chooses spherical vs planar coords via `mat.reflectionCoordMode`, samples reflection texture, writes `reflectionColor * mat.reflectionLevel`

### `std-shadow-fragment.ts` — Shadow Receiving

- **Factory**: `createStdShadowFragment(shadowLights: ShadowLightSlot[]): ShaderFragment`
- **ID**: `"std-shadow"`
- **Interface**: `ShadowLightSlot { lightIndex: number; shadowType: "esm" | "pcf" }`
- **Varyings**: per-light `vPosFromLight_<n>` (`vec4<f32>`), `vDepthMetric_<n>` (`f32`)
- **Bindings**: per-light shadow textures + samplers + `shadowInfo_<n>` uniform buffers (group `"shadow"`)
- **Helper WGSL**: per-light `shadowInfo_<n>Uniforms` struct, ESM (`computeShadowESM_<n>`, `computeFallOff_<n>`) and PCF (`computeShadowPCF_<n>`) functions
- **Vertex slot**:
  - `VB` — transforms world position into light space, computes depth metric
- **Fragment slot**:
  - `AD` — writes `shadowFactors[lightIndex]` per light via ESM or PCF

## Shader Logic

### Vertex Shader (composed by template + fragments)

```
worldPos = mesh.world × vec4(position, 1.0)
normalWorld = mat3x3(world[0].xyz, world[1].xyz, world[2].xyz)
vNormalW = normalize(normalWorld × normal)
clipPos = scene.viewProjection × worldPos
vFogDistance = (scene.view × worldPos).xyz
```

If NEEDS_UV: `vDiffuseUV = uv × uvScaleOffset.xy + uvScaleOffset.zw`
If RECEIVE_SHADOWS: `vPositionFromLight = shadow.lightMatrix × worldPos`, `vDepthMetric = (lightClip.z + near) / far`

### Fragment Shader (composed by template + fragments)

#### Blinn-Phong Lighting (`computeLighting`)

```
if lightData.w == 0:  // Point light
  direction = lightPos - fragmentPos
  attenuation = max(0, 1 - length(direction) / range)
  lightVectorW = normalize(direction)
else:                  // Directional light
  lightVectorW = normalize(-lightDir)
  attenuation = 1.0

NdotL = max(0, dot(N, L))
diffuse = NdotL × lightDiffuse × attenuation
H = normalize(V + L)
specComp = pow(max(0, dot(N, H)), max(1, glossiness))
specular = specComp × lightSpecular × attenuation
```

#### ESM Shadow (if RECEIVE_SHADOWS)

```
shadowPixelDepth = clamp(depthMetric, 0, 1)
shadowMapSample = textureSampleLevel(shadowTex, shadowSampler, uv, 0).x
esm = 1 - clamp(exp(min(87, depthScale × shadowPixelDepth)) × shadowMapSample, 0, 1 - darkness)
shadow = computeFallOff(esm, clipSpace.xy, frustumEdgeFalloff)
```

#### Fog (`calcFogFactor`)

```
dist = length(vFogDistance)
mode 3 (linear):  fogCoeff = (end - dist) / (end - start)
mode 1 (exp):     fogCoeff = 1 / e^(dist × density)
mode 2 (exp2):    fogCoeff = 1 / e^(dist² × density²)
```

#### Final Composition

```
baseColor = textureSample(diffuseTex, ...) × textureLevel     // if HAS_DIFFUSE_TEXTURE, else vec4(1)
emissiveTex = textureSample(emissiveTex, ...).rgb              // if HAS_EMISSIVE_TEXTURE
shadow = computeShadowWithESM(...)                             // if RECEIVE_SHADOWS, else 1.0

finalDiffuse = clamp(diffuseBase × shadow × diffuseColor + emissiveColor + ambientColor, 0, 1) × baseColor.rgb
finalSpecular = specularBase × shadow × specularColor
color = vec4(finalDiffuse + finalSpecular, alpha)
color = max(color, 0)
if fogMode > 0: color.rgb = mix(fogColor, color.rgb, fogCoeff)
```

## State Machine / Lifecycle

```
addToScene(scene, mesh)            → mesh registered for deferred building
registerScene(engine, scene)       → runs deferred builders and builds frame graph
  standardGroupBuilder()           → detects features, dynamically imports fragment modules
  buildStandardMeshRenderables()   → groups meshes by features, composes shaders
    composeStandardShader()        → createStandardTemplate() + composeShader(template, fragments)
    getOrCreatePipeline()          → cached pipeline + scene UBO
    createDynamicMeshGPU()         → per-mesh UBOs + bind groups
  → renderables + updater registered by buildScene
  render loop begins
    updater.update(engine)         → refreshes light/material state
    RenderPassTask.binds renderables for its target
    DrawBinding.draw(pass, engine) → dispatches draw calls per mesh
  mesh.material = newMat           → triggers single-rebuild path
    buildSingleStandardRenderable()→ recomputes features, gets pipeline, creates mesh GPU resources
```

## Babylon.js Equivalence Map

| Babylon Lite | Babylon.js |
|---|---|
| `createStandardMaterial()` | `new BABYLON.StandardMaterial("mat", scene)` |
| `HAS_DIFFUSE_TEXTURE` | `#define DIFFUSE` |
| `HAS_EMISSIVE_TEXTURE` | `#define EMISSIVE` |
| `RECEIVE_SHADOWS` | `#define SHADOW0` |
| `HAS_BUMP_TEXTURE` | `#define BUMP` |
| `HAS_SPECULAR_TEXTURE` | `#define SPECULAR` |
| `HAS_AMBIENT_TEXTURE` | `#define AMBIENT` |
| `HAS_LIGHTMAP_TEXTURE` | `#define LIGHTMAP` |
| `HAS_OPACITY_TEXTURE` | `#define OPACITY` |
| `HAS_REFLECTION_TEXTURE` | `#define REFLECTION` |
| `THIN_INSTANCES` / `THIN_INSTANCE_COLOR` | `mesh.thinInstanceSetBuffer(...)` |
| `material.disableLighting` | `material.disableLighting` |
| `PCF_SHADOWS` | `#define SHADOWPCF0` |
| `computeFeatures()` | Internal define computation in `StandardMaterial._getEffect()` |
| `getOrCreatePipeline()` | Pipeline cache in StandardMaterial |
| `createStandardTemplate()` + `composeShader()` | GLSL shader generation from defines |
| `ShaderFragment` composition | `#include` / `#define` preprocessor |
| `DrawBinding.updateUBOs()` | Per-mesh/material uniform refresh before draw |
| `buildSingleStandardRenderable()` | `Material._markAllSubMeshesAsAllDirty()` |
| `computeLighting()` in shader | `computeLighting()` in Babylon standard shader |
| `calcFogFactor()` | `CalcFogFactor()` in Babylon |
| `computeShadowWithESM()` | `computeShadowWithESM()` in Babylon |

## Dependencies

- **`standard-material.ts`**: Imports `Texture2D` from texture-2d, `computeUboLayout` from ubo-layout, `createStandardTemplate` from standard-template.
- **`standard-template.ts`**: Imports `ShaderTemplate`, `UboField`, `VertexAttribute`, `Varying`, `BindingDecl` from fragment-types, `WGSL_FOG` from wgsl-helpers.
- **`standard-pipeline.ts`**: Imports `createStandardTemplate` from standard-template, `composeShader` from shader-composer, types from standard-material, shadow generator types, lights UBO helpers.
- **`standard-renderable.ts`**: Imports pipeline functions from standard-pipeline, `ShaderFragment` from fragment-types, scene/engine/mesh/light types, renderable interface, resource pool helpers.
- **`standard-single-rebuild.ts`**: Imports pipeline functions, material types, resource pool helpers.
- **Fragment modules** (`fragments/`): Each imports only `ShaderFragment` (and optionally `BindingDecl`, `Varying`) from `fragment-types.js`.
- **`thin-instance-gpu.ts`** (`src/mesh/`): Conditionally imported by `standardGroupBuilder` when thin instances are detected.
- **Depended on by**: Application code (via `createStandardMaterial`), mesh factories, skybox-cubemap (shares scene UBO layout).

## Test Specification

| Test | Description |
|---|---|
| `createStandardMaterial defaults` | All properties match documented defaults |
| `pipeline cache hit` | Same features+format+msaa → same variant object |
| `pipeline cache miss on features` | Different features → different variant |
| `simple shader (features=0)` | No UV attribute, no texture bindings |
| `textured shader (features=1)` | UV attribute added, diffuse texture bound |
| `shadow shader (features=4)` | Shadow UBO, shadow map bind group created |
| `full shader (features=7)` | All bindings present |
| `mesh grouping` | Meshes with same features share pipeline |
| `Blinn-Phong NdotL=0` | Diffuse = 0, specular = 0 |
| `Fog linear at start` | fogCoeff = 1 |
| `Fog linear at end` | fogCoeff = 0 |
| `single rebuild` | Material swap rebuilds one mesh without full scene teardown |
| `fragment composition` | Bump fragment injects perturbNormal helper + AC slot code |
| `shadow fragment ESM` | ESM shadow factor computation per light |
| `shadow fragment PCF` | PCF shadow factor computation per light |

## File Manifest

| File | Size | Purpose |
|---|---|---|
| `src/material/standard/standard-material.ts` | ~299 lines | Types (StandardMaterialProps, FogConfig), factory, collectStdBoundTextures, standardGroupBuilder with dynamic fragment imports |
| `src/material/standard/standard-template.ts` | ~299 lines | `StandardTemplateConfig` + `createStandardTemplate()` — builds `ShaderTemplate` with Blinn-Phong lighting, fog, slot markers |
| `src/material/standard/standard-pipeline.ts` | ~503 lines | Feature flags, `computeFeatures()`, `composeStandardShader()`, `getOrCreatePipeline()`, `createDynamicMeshGPU()`, `writeMaterialUBO()`, pipeline/shader caches, PCF shadow registration |
| `src/material/standard/standard-renderable.ts` | ~313 lines | `StdFragmentFactories` interface, `buildStandardMeshRenderables()` — groups meshes, composes shaders with fragments, creates Renderables |
| `src/material/standard/standard-single-rebuild.ts` | ~140 lines | `buildSingleStandardRenderable()` — hot material swap for a single mesh |
| `src/material/standard/fragments/normal-map-fragment.ts` | ~33 lines | Cotangent-frame bump/normal mapping fragment (`AC` slot) |
| `src/material/standard/fragments/std-emissive-fragment.ts` | ~17 lines | Emissive texture sampling fragment (`AT` slot) |
| `src/material/standard/fragments/std-specular-fragment.ts` | ~18 lines | Specular texture sampling fragment (`AT` slot, UV/UV2 aware) |
| `src/material/standard/fragments/std-ambient-fragment.ts` | ~18 lines | Ambient/AO texture sampling fragment (`AD` slot, UV/UV2 aware) |
| `src/material/standard/fragments/std-lightmap-fragment.ts` | ~18 lines | Additive lightmap fragment (`BC` slot, UV/UV2 aware) |
| `src/material/standard/fragments/std-opacity-fragment.ts` | ~20 lines | Opacity texture fragment (`AT` slot, RGB or alpha mode) |
| `src/material/standard/fragments/std-reflection-fragment.ts` | ~39 lines | Spherical/planar reflection fragment (`AD` slot) |
| `src/material/standard/fragments/std-shadow-fragment.ts` | ~155 lines | ESM/PCF shadow receiving fragment (per-light, `VB` + `AD` slots) |
| `src/mesh/thin-instance-gpu.ts` | ~50 lines | `syncThinInstanceBuffers()` — uploads instance matrix/color vertex buffers |
| `src/shader/shader-composer.ts` | ~293 lines | `composeShader()` — topological sort, UBO merge, binding assignment, slot injection |
