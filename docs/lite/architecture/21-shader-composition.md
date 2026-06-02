# Module: Shader Composition
> Package path: `packages/babylon-lite/src/shader/`

## Purpose

Provides a declarative, fragment-based shader composition system. Individual rendering features (IBL, clearcoat, skeleton skinning, thin instances, normal mapping, etc.) are encapsulated as `ShaderFragment` objects that declare their WGSL code, bindings, UBO fields, vertex attributes, and varyings. The `ShaderComposer` (`composeShader()`) assembles fragments into final WGSL source code and GPU pipeline descriptors via topological sort, slot injection, and bind group layout merging.

Key design principles:
- **Zero global state** — no module-level registries; fragments are passed as arrays
- **Full tree-shaking** — unused fragments add zero bytes to bundles
- **Materials own shaders** — the composer is generic; materials select which fragments to include
- **No WGSL parsing** — structured data (UBO fields, bindings) uses typed interfaces, never regex on emitted WGSL

## Public API Surface

### Constants

```typescript
// Shader stage visibility flags (numeric for Node.js compatibility — no GPUShaderStage in Node)
const STAGE_VERTEX   = 0x1;   // GPUShaderStage.VERTEX
const STAGE_FRAGMENT = 0x2;   // GPUShaderStage.FRAGMENT
```

### Types — `fragment-types.ts`

```typescript
// ── WGSL scalar/vector types ──
export type WgslScalarType = "f32" | "u32" | "i32" | "vec2<f32>" | "vec3<f32>" | "vec4<f32>" | "mat4x4<f32>";

// ── Vertex Attributes ──
export interface VertexAttribute {
    readonly name: string;           // WGSL variable name (e.g. "position", "world0")
    readonly type: string;           // WGSL type (e.g. "vec3<f32>")
    readonly gpuFormat: GPUVertexFormat;
    readonly arrayStride: number;
    readonly stepMode?: GPUVertexStepMode;   // default "vertex"
    readonly bufferGroup?: string;   // shared buffer key (e.g. "ti-matrix")
    readonly offset?: number;        // byte offset within buffer (default 0)
}

// ── Varyings ──
export interface Varying {
    readonly name: string;           // WGSL variable name
    readonly type: string;           // WGSL type
}

// ── UBO Fields ──
export interface UboField {
    readonly name: string;           // WGSL field name
    readonly type: WgslScalarType;
}

// ── Binding Declarations ──
export type BindingKind =
    | { readonly kind: "uniform-buffer" }
    | { readonly kind: "texture";
        readonly textureType: "texture_2d<f32>" | "texture_cube<f32>" | "texture_depth_2d" | "texture_2d<u32>";
        readonly sampleType?: "float" | "unfilterable-float" | "depth" | "sint" | "uint"; }
    | { readonly kind: "sampler"; readonly samplerType: "sampler" | "sampler_comparison" }
    | { readonly kind: "storage-texture"; readonly access: "read" | "write" | "read_write"; readonly format: string };

export interface BindingDecl {
    readonly name: string;           // WGSL variable name
    readonly type: BindingKind;
    readonly group?: "mesh" | "shadow";   // default "mesh" → group(1); "shadow" → group(2)
    readonly visibility: GPUShaderStageFlags;
}

// ── Fragment Slot Markers ──
export type FragmentSlot = "HF" | "SV" | "AT" | "AC" | "MF" | "BL" | "AD" | "AI" | "NI" | "BC" | "BA";
export type VertexSlot   = "VR" | "VW" | "VB";
```

### ShaderFragment Interface

```typescript
export interface ShaderFragment {
    readonly id: string;                              // unique ID for dedup + dependency resolution
    readonly dependencies?: readonly string[];         // fragment IDs that must compose before this one

    // ── Vertex stage ──
    readonly vertexAttributes?: readonly VertexAttribute[];
    readonly varyings?: readonly Varying[];
    readonly vertexBindings?: readonly BindingDecl[];
    readonly vertexSlots?: Partial<Record<VertexSlot, string>>;
    readonly pipelineVertexBuffers?: (nextLoc: number) => { buffers: GPUVertexBufferLayout[]; nextLoc: number };
    readonly vertexBuiltins?: readonly { readonly name: string; readonly builtin: string; readonly type: string }[];
    readonly vertexHelperFunctions?: string;

    // ── Fragment stage ──
    readonly uboFields?: readonly UboField[];
    readonly bindings?: readonly BindingDecl[];
    readonly helperFunctions?: string;
    readonly fragmentSlots?: Partial<Record<FragmentSlot, string>>;

}
```

### ShaderTemplate Interface

```typescript
export interface ShaderTemplate {
    readonly vertexTemplate: string;                    // WGSL with slot markers
    readonly fragmentTemplate: string;                  // WGSL with slot markers
    readonly baseMeshUboFields: readonly UboField[];
    readonly baseVertexAttributes: readonly VertexAttribute[];
    readonly baseVaryings: readonly Varying[];
    readonly baseBindings?: readonly BindingDecl[];
    readonly baseVertexBindings?: readonly BindingDecl[];
    readonly baseMaterialUboFields?: readonly UboField[];
}
```

### Composed Output

```typescript
export interface UboSpec {
    readonly totalBytes: number;                       // aligned to 16 bytes
    readonly offsets: ReadonlyMap<string, number>;      // field name → byte offset
    readonly structBody: string;                       // WGSL struct body (fields only)
}

export interface ComposedShader {
    readonly vertexWGSL: string;
    readonly fragmentWGSL: string;
    readonly meshBGLDescriptor: GPUBindGroupLayoutDescriptor;       // group(1)
    readonly shadowBGLDescriptor: GPUBindGroupLayoutDescriptor | null; // group(2)
    readonly vertexBufferLayouts: GPUVertexBufferLayout[];
    readonly meshUboSpec: UboSpec;
    readonly sceneUboSpec: UboSpec;
    readonly fragmentKey: string;                      // sorted IDs joined with "|" — pipeline cache key
}
```

### Main Function

```typescript
export function composeShader(template: ShaderTemplate, fragments: readonly ShaderFragment[]): ComposedShader;
```

### UBO Layout

```typescript
export function computeUboLayout(fields: readonly UboField[]): UboSpec;
```

## Internal Architecture

### Topological Sort — `topoSort()`

Fragments declare dependencies via `dependencies: string[]`. The composer:
1. Builds a map of `id → ShaderFragment`
2. Computes in-degrees from dependency edges
3. Performs Kahn's algorithm with deterministic alphabetical ordering of zero-degree nodes
4. Throws on duplicate IDs, unknown dependencies, or cycles

The sorted order determines:
- Code injection order (fragments contribute to slots in dependency order)
- Binding index assignment (deterministic binding numbers)
- UBO field ordering

### Slot Injection — `injectSlots()`

Templates contain comment markers in the format `/*SLOT_NAME*/` (e.g., `/*AI*/`, `/*VW*/`).

The `SLOT_RE = /\/\*([A-Z_0-9]+)\*\//g` regex finds all markers. For each marker, the composer:
1. Iterates sorted fragments
2. Collects any contributions to that slot name from `fragmentSlots` or `vertexSlots`
3. Joins contributions with `\n`
4. Replaces the marker with the concatenated code

**Fragment slot markers** (fragment shader):
| Slot | Purpose |
|------|---------|
| `HF` | Helper functions |
| `SV` | Shader variables initialization |
| `AT` | Alpha/texture modifications |
| `AC` | Alpha cutoff |
| `MF` | Material function overrides |
| `BL` | Before lighting variables |
| `AD` | After direct lighting |
| `AI` | Ambient/IBL integration |
| `NI` | Normal injection |
| `BC` | Before color output |
| `BA` | Before alpha output |

**Vertex slot markers**:
| Slot | Purpose |
|------|---------|
| `VR` | Before main body (morph pre-skinning) |
| `VW` | Compute `finalWorld` (skeleton skinning, thin-instance) |
| `VB` | After world transform (varying passthrough) |

### Template Markers (non-slot)

Fixed markers replaced once (not iterated over fragments):
| Marker | Replacement |
|--------|-------------|
| `/*SU*/` | `struct SceneUniforms { ... }` |
| `/*MU*/` | `struct MeshUniforms { ... }` |
| `/*VI*/` | `struct VertexInput { ... }` |
| `/*VO*/` | `struct VertexOutput { ... }` |
| `/*VD*/` | Vertex binding declarations |
| `/*VP*/` | Vertex function parameters (builtins + inputs) |
| `/*VH*/` | Vertex helper functions |
| `/*FI*/` | `struct FragmentInput { ... }` |
| `/*HF*/` | Fragment helper functions |
| `/*FB*/` | Fragment binding declarations |

### Bind Group Layout Construction

The composer emits material-owned bind groups after the frame-graph scene group:
- **Group 0**: external frame-graph scene group, not owned by the composer. Binding 0 is the per-pass `SceneUniforms` UBO and binding 1 is the scene-owned `LightsUniforms` UBO.
- **Group 1 ("mesh")**: Mesh UBO (binding 0, always present), optional Material UBO (binding 1 when `baseMaterialUboFields` is present), and fragment bindings after that
- **Group 2 ("shadow")**: Shadow-specific bindings (optional)

Binding assignment order:
1. `template.baseVertexBindings` (vertex-stage bindings)
2. Each sorted fragment's `vertexBindings`
3. `template.baseBindings` (fragment-stage bindings)
4. Each sorted fragment's `bindings` where `group === "mesh"` or default
5. Each sorted fragment's `bindings` where `group === "shadow"`

Each binding gets:
- A `GPUBindGroupLayoutEntry` via `bglEntry()` (maps BindingKind → WebGPU descriptor)
- A WGSL declaration via `declWGSL()` (e.g., `@group(1) @binding(3) var normalTex: texture_2d<f32>;`)
- Assignment to vertex and/or fragment declaration lists based on `visibility`

### Vertex Buffer Layout Construction

1. Template `baseVertexAttributes` + fragment `vertexAttributes` are deduplicated by name
2. Each attribute without a `bufferGroup` gets its own `GPUVertexBufferLayout`
3. Attributes sharing a `bufferGroup` are packed into a single interleaved buffer layout (e.g., thin-instance `world0`–`world3` share `"ti-matrix"` with stride 64)
4. Fragments with `pipelineVertexBuffers` callbacks append additional layouts (e.g., skeleton joints/weights)

### UBO Layout — `ubo-layout.ts`

`computeUboLayout()` follows WGSL uniform buffer alignment rules (std140-like):

| Type | Align | Size |
|------|-------|------|
| `f32` | 4 | 4 |
| `u32` / `i32` | 4 | 4 |
| `vec2<f32>` | 8 | 8 |
| `vec3<f32>` | 16 | 12 |
| `vec4<f32>` | 16 | 16 |
| `vec4<u32>` | 16 | 16 |
| `mat4x4<f32>` | 16 | 64 |
| `array<vec4<u32>, N>` | 16 | 16 × N |

Array type parsing accepts optional whitespace after the comma, so both `array<vec4<u32>, 4>` and `array<vec4<u32>,4>` are valid field type strings. This matters for production bundles because inline WGSL minification may remove spaces.

Algorithm:
1. Walk fields in order, align cursor to field alignment
2. Record byte offset for each field name
3. Generate WGSL struct body (`name: type,` per field)
4. Round total size to 16-byte boundary

Composed shaders generate material-owned UBO specs only:
- **Mesh UBO**: template `baseMeshUboFields` (group 1, binding 0)
- **Material UBO**: template `baseMaterialUboFields` + fragment `uboFields` (group 1, binding 1) when `baseMaterialUboFields` is present; otherwise fragment `uboFields` are appended to the mesh UBO

The canonical scene UBO is not composed from fragments. Material templates prepend `SCENE_UBO_WGSL` through the `/*SU*/` marker, and `RenderTask` writes the group-0 scene bind group per pass.

### Deduplication — `dedup()`

Template base arrays and fragment contributions are merged with name-based deduplication. First occurrence wins. Applied to vertex attributes and varyings.

## Pipeline Configuration

N/A — The composer generates pipeline descriptors but doesn't create GPU pipelines. Pipeline creation is the responsibility of the material system.

## Shader Logic — `wgsl-helpers.ts`

Shared WGSL snippets (pure function strings, no bindings):

### `WGSL_PERTURB_NORMAL`
Cotangent-frame bump mapping. Requires `bumpTex`, `bumpSampler` in scope.
```
fn perturbNormal(vNormalW, positionW, uv, bumpScale) → vec3<f32>
  Sample normal map, construct cotangent frame from screen-space derivatives,
  transform normal sample into world space.
```

### `WGSL_SHADOW_ESM`
Exponential shadow map sampling. Requires `shadowTex`, `shadowSampler` in scope.
```
fn computeFallOff(value, clipSpace, frustumEdgeFalloff) → f32
fn computeShadowWithESM(posFromLight, depthMetric, darkness, depthScale, frustumEdgeFalloff) → f32
  Projects shadow coordinates, samples depth, applies ESM with edge falloff.
```

### `WGSL_FOG`
Linear/exp/exp² fog. Requires `scene.vFogInfos` (vec4: mode, start, end, density).
```
fn calcFogFactor(fogDistance: vec3<f32>) → f32
```

### `WGSL_IMAGE_PROCESSING`
Exposure → Reinhard tonemap → gamma → contrast. Requires `scene.exposureLinear`, `scene.contrast`.
```
fn applyImageProcessing(result: vec4<f32>) → vec4<f32>
  rgb *= exposureLinear
  rgb = 1 - exp2(-1.590579 * rgb)   // tonemapping
  rgb = pow(rgb, 1/2.2)              // gamma
  contrast interpolation (below 1: mix with 0.5; above 1: mix with S-curve)
```

### `WGSL_DITHER`
Noise-based dithering. Pure math, no UBO dependency.
```
fn dither(seed: vec2<f32>, varianceAmount: f32) → f32
  fract(sin(dot(seed, [12.9898, 78.233])) * 43758.5453)
  Mix ±normVariance where normVariance = varianceAmount / 255
```

### Canonical SceneUniforms

All runtime material shaders use the canonical `SceneUniforms` declaration from `packages/babylon-lite/shaders/scene-uniforms.wgsl`, imported through `src/shader/scene-uniforms.ts`. The struct is fixed-size (`SCENE_UBO_BYTES = 352`) and contains:

- `viewProjection`, `view`, and `vEyePosition`
- environment rotation, SH irradiance, exposure/contrast/LOD image-processing fields
- fog info/color

Light data is not appended to `SceneUniforms`; Standard and PBR use the separate `render/lights-ubo.ts` buffer when direct lighting is active. Frame-graph `RenderTask` owns one scene UBO/bind group per pass so offscreen passes can write target-specific projection state (including Y-flip) without mutating global scene state.

## State Machine / Lifecycle

The composer is a pure function — no lifecycle or state. Call `composeShader(template, fragments)` and receive a `ComposedShader`.

Materials cache composed shaders by `fragmentKey` (sorted fragment IDs joined with `"|"`).

## Babylon.js Equivalence Map

| Babylon.js | Babylon Lite |
|---|---|
| `ShaderMaterial` + Effect system | `ShaderTemplate` + `ShaderFragment[]` + `composeShader()` |
| `#define` preprocessor macros | Slot injection (`/*AI*/`, `/*VW*/`, etc.) |
| `UniformBuffer` layout | `computeUboLayout()` with `UboField[]` |
| `MaterialPluginBase` | `ShaderFragment` interface |
| `Effect.ShadersStore` (global) | Fragment modules (tree-shakable imports) |
| `Engine._caps` feature detection | Fragment `dependencies` (explicit) |
| `PBRMaterial.customShaderNameResolve` | Fragment slot contributions |

## Dependencies

- No external dependencies — pure TypeScript, zero npm imports
- Internal: `fragment-types.ts` (types), `ubo-layout.ts` (UBO computation)

## Test Specification

1. **Topological sort**: Verify correct ordering with diamond dependencies (A→B,C→D)
2. **Cycle detection**: Verify error thrown for A→B→A
3. **Duplicate fragment ID**: Verify error thrown
4. **Unknown dependency**: Verify error thrown
5. **Slot injection**: Verify `/*AI*/` replaced with concatenated fragment contributions in dependency order
6. **Binding assignment**: Verify mesh bindings get sequential indices starting at 1
7. **UBO layout alignment**: Verify vec3 gets 16-byte alignment, struct total rounds to 16
8. **Vertex buffer grouping**: Verify `bufferGroup` attributes merge into single layout
9. **Deduplication**: Verify same-name attributes/varyings not duplicated
10. **Fragment key**: Verify deterministic key generation for pipeline caching

## File Manifest

| File | Purpose |
|---|---|
| `fragment-types.ts` | All type definitions: ShaderFragment, ShaderTemplate, ComposedShader, UboSpec, slot types, binding types |
| `shader-composer.ts` | `composeShader()` — topological sort, slot injection, bind group layout construction, WGSL assembly |
| `ubo-layout.ts` | `computeUboLayout()` — WGSL std140-like alignment computation for UBO structs |
| `wgsl-helpers.ts` | Shared WGSL snippets: perturbNormal, ESM shadows, fog, image processing, dither |
| `fragments/thin-instance-fragment.ts` | Example fragment: thin-instance world matrix + optional instance color |
