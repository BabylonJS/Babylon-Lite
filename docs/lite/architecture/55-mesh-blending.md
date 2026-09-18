# Module: Mesh Blending

> Package paths: `packages/babylon-lite/src/mesh/`, `packages/babylon-lite/src/frame-graph/`, `packages/babylon-lite/src/material/`, `packages/babylon-lite/src/post-process/`

## Purpose

Mesh blending is an opt-in, single-frame, screen-space SceneColor post-process that softens visible intersections between independently rendered meshes. It does not modify vertices, normals, depth, lighting, shadow maps, collision data, materials, or scene ownership. The effect consumes:

- the rendered SceneColor texture;
- a single-sample `r8uint` geometry attachment containing one packed mesh-blending tag per visible fragment;
- either signed view-space Z or hardware screen depth;
- an optional linear albedo/base-color attachment used only for shadow-difference attenuation;
- a deterministic spatial blue-noise texture owned by the mesh-blending task.

The implementation is a WebGPU-only port of Babylon.js mesh blending. It preserves Babylon.js tag encoding, defaults, quality variants, search and validation math, interpolation behavior, debug modes, pass-through rules, and task ownership while adapting fullscreen coordinates to Babylon Lite's top-left post-process UV convention.

The feature is completely opt-in:

- unrelated scenes do not import the mesh-blending task, shader, blue-noise generator, or geometry tag helpers;
- no module allocates `Map`, `Set`, `WeakMap`, GPU resources, or other state at import time;
- the only generic runtime changes are a plain optional mesh state field and a new lazy geometry attachment enum value/accessor;
- all mesh-blending GPU resources are owned by the created task and rebuilt for the current device.

## Public API Surface

All public exports are re-exported only from `packages/babylon-lite/src/index.ts`.

### Mesh tag API

```ts
export enum MeshBlendingRadiusClass {
    Small = 0,
    Medium = 1,
    Large = 2,
    ExtraLarge = 3,
}

export interface MeshBlendingTag {
    readonly groupId: number;
    readonly radiusClass: MeshBlendingRadiusClass;
}

export function packMeshBlendingTag(groupId: number, radiusClass: MeshBlendingRadiusClass): number;
export function unpackMeshBlendingTag(tag: number): MeshBlendingTag;
export function validatePackedMeshBlendingTag(tag: number): number;
export function resolveMeshBlendingTag(mesh: Mesh): number;
```

`Mesh` gains:

```ts
export interface Mesh {
    /**
     * Packed mesh-blending tag. Undefined is equivalent to zero/disabled.
     * Bits 0..5 are the group and bits 6..7 are the radius class.
     */
    meshBlendingTag?: number;
}
```

Tag rules:

- `groupId` is an integer from `0` through `63`.
- `radiusClass` is an integer from `0` through `3`.
- Packing is `(radiusClass << 6) | groupId`.
- `groupId === 0` always packs to exactly `0`.
- Valid packed values are `0`, or an unsigned byte whose low six bits are nonzero.
- `64`, `128`, and `192` are invalid because they encode group zero with a nonzero class.
- Same nonzero group never blends.
- When two groups meet, the smaller radius class wins.
- Thin instances use the tag of the mesh that owns the thin-instance draw.
- Lite clones are independent meshes and own independent tags.
- Geometry rendering validates the resolved raw byte before uploading it.

### Geometry renderer extension

`GeometryTextureType` gains:

```ts
MESH_BLEND_TAG = 11;
```

`GEOMETRY_TEXTURE_DESCRIPTIONS[GeometryTextureType.MESH_BLEND_TAG]` is:

```ts
{
    name: "MeshBlendTag",
    defaultFormat: "r8uint",
    clearValue: { r: 0, g: 0, b: 0, a: 0 },
}
```

`GeometryRendererTask` gains:

```ts
readonly geometryMeshBlendTagTexture: RenderTarget | null;
```

Geometry tag invariants:

- a task requesting `MESH_BLEND_TAG` must use `samples: 1`;
- the tag attachment format is exactly `r8uint`; a format override to any other format throws;
- the tag can occupy any MRT color slot;
- the complete MRT remains limited to eight color attachments;
- its clear is exact unsigned integer zero;
- its pipeline target has no blend state;
- all other attachments retain their existing blend behavior;
- transparent meshes are included by default; callers can set `renderTransparentMeshes: false` or pass a filtered `meshes` array for opaque-only tags;
- Standard and PBR alpha-tested geometry preserves discard coverage, but blended transparent tags remain order-dependent and can overwrite an underlying tag with zero;
- alpha-blended geometry attachments must use a blendable format; 32-bit float attachments require `float32-blendable`, so callers without that feature should override `VIEW_DEPTH` to `r16float` or filter transparent meshes;
- transparent Node materials are rejected when `MESH_BLEND_TAG` is requested because the graph's fragment alpha is not available to the geometry terminal; callers must filter them out;
- overlapping transparent layers remain caller-controlled and are not made order-independent by mesh blending.

### Mesh-blending configuration

```ts
export enum MeshBlendQuality {
    Low = 0,
    Medium = 1,
    High = 2,
    Cinematic = 3,
}

export enum MeshBlendDepthType {
    View = 0,
    Screen = 1,
}

export enum MeshBlendDebugMode {
    Off = 0,
    PackedTag = 1,
    CandidateDirectionDistance = 2,
    SeamFade = 3,
    RejectionReason = 4,
    StageWork = 5,
    Continuation = 6,
    TinyObject = 7,
    MultiTarget = 8,
    TargetColor = 9,
    ShadowAttenuation = 10,
    ColorInterpolation = 11,
    WorldPosition = 12,
}

export interface MeshBlendRadiusDefinition {
    worldRadius: number;
    minimumProjectedRadius: number;
}

export type MeshBlendRadiusDefinitions = readonly [MeshBlendRadiusDefinition, MeshBlendRadiusDefinition, MeshBlendRadiusDefinition, MeshBlendRadiusDefinition];

export function createMeshBlendRadiusDefinition(worldRadius: number, minimumProjectedRadius: number): MeshBlendRadiusDefinition;
export function createDefaultMeshBlendRadiusDefinitions(): MeshBlendRadiusDefinitions;
```

Each radius definition is independently allocated and exposes validating mutable setters. Both values must be finite and nonnegative. The returned four-element definitions array is frozen, while its four elements remain mutable.

Exact defaults:

| Class      | `worldRadius` | `minimumProjectedRadius` |
| ---------- | ------------: | -----------------------: |
| Small      |        `0.06` |                    `1.5` |
| Medium     |         `0.1` |                      `3` |
| Large      |         `0.2` |                      `3` |
| ExtraLarge |         `0.3` |                      `5` |

### Frame-graph task

```ts
export interface MeshBlendingPostProcessTaskConfig {
    name?: string;
    sourceTexture: RenderTarget;
    meshBlendTagTexture: RenderTarget;
    depthTexture: RenderTarget;
    baseColorTexture?: RenderTarget | null;
    targetTexture?: RenderTarget | null;
    camera: Camera;
    quality?: MeshBlendQuality;
    depthType?: MeshBlendDepthType;
    debugMode?: MeshBlendDebugMode;
    radiusClasses?: readonly MeshBlendRadiusDefinition[];
    slopeFactor?: number;
    enabled?: boolean;
    alphaMode?: PostProcessAlphaMode;
    viewport?: NormalizedViewport | null;
    clear?: boolean;
}

export interface MeshBlendingPostProcessTask extends Task {
    readonly name: string;
    sourceTexture: RenderTarget;
    meshBlendTagTexture: RenderTarget;
    depthTexture: RenderTarget;
    baseColorTexture: RenderTarget | null;
    targetTexture: RenderTarget | null;
    outputTexture: RenderTarget;
    camera: Camera;
    quality: MeshBlendQuality;
    depthType: MeshBlendDepthType;
    debugMode: MeshBlendDebugMode;
    readonly radiusClasses: MeshBlendRadiusDefinitions;
    slopeFactor: number;
    enabled: boolean;
    alphaMode: PostProcessAlphaMode;
    viewport: NormalizedViewport | null;
    clear: boolean;
    updateUniforms(): void;
}

export function createMeshBlendingPostProcessTask(config: MeshBlendingPostProcessTaskConfig, engine: EngineContext, scene?: SceneContext): MeshBlendingPostProcessTask;
```

Defaults:

- `quality = MeshBlendQuality.Medium`;
- `depthType = MeshBlendDepthType.View`;
- `debugMode = MeshBlendDebugMode.Off`;
- `radiusClasses = createDefaultMeshBlendRadiusDefinitions()`;
- `slopeFactor = 2`;
- `enabled = true`;
- `alphaMode = 0`;
- `viewport = null`;
- `clear = true`;
- `baseColorTexture = null`;
- `targetTexture = null`, which creates a task-owned single-sample target matching source format and size.

Validation:

- enum values must be defined enum members;
- `slopeFactor` must be finite and at least `1`;
- exactly four radius definitions are accepted;
- all input color attachments are 2D and single-sample;
- source, tag, depth, optional base color, and output have identical physical dimensions;
- source/output formats are noninteger RGB/RGBA formats supported for render attachment and texture loading, including unsigned-byte, half-float, and float HDR formats;
- tag format is exactly `r8uint`;
- view depth is a float/half-float `r`, `rg`, or `rgba` color format;
- screen depth accepts those formats plus normalized unsigned-byte color formats;
- no sampled input (source, tag, depth, or optional base color) may alias the output, including distinct wrappers around the same GPU texture;
- blended `rgba32float` output requires the WebGPU `float32-blendable` feature;
- caller-owned inputs and target are never disposed by the task.

Runtime changes:

- radius values, `slopeFactor`, `enabled`, camera matrices, and viewport are uniform/runtime state and do not change the shader variant;
- quality, depth type, debug mode, base-color presence, source/tag/depth identity, target format, alpha mode, and replacement GPU device invalidate the appropriate pipeline/bind group state;
- setting `enabled = false` preserves an exact SceneColor texel pass-through when `alphaMode === 0`;
- nonzero `alphaMode` intentionally applies the caller-selected post-process blend state to both enabled and disabled output.

## Internal Architecture

### Files

```text
packages/babylon-lite/src/mesh/mesh-blending-tag.ts
packages/babylon-lite/src/post-process/mesh-blending-blue-noise.ts
packages/babylon-lite/src/post-process/mesh-blending-wgsl.ts
packages/babylon-lite/src/post-process/mesh-blending.ts
```

Existing files extended:

```text
packages/babylon-lite/src/mesh/mesh.ts
packages/babylon-lite/src/frame-graph/geometry-types.ts
packages/babylon-lite/src/frame-graph/geometry-renderer-task.ts
packages/babylon-lite/src/material/standard/standard-geometry-output-shader.ts
packages/babylon-lite/src/material/standard/standard-geometry-renderable.ts
packages/babylon-lite/src/material/pbr/pbr-geometry-output-shader.ts
packages/babylon-lite/src/material/pbr/pbr-geometry-renderable.ts
packages/babylon-lite/src/material/node/node-geometry-renderable.ts
packages/babylon-lite/src/post-process/mesh-blending-pbr-support.ts
packages/babylon-lite/src/index.ts
```

### Tree-shaking and state

- Tag pack/unpack/default/math helpers are pure.
- Blue-noise CPU data is generated only when the mesh-blending factory is called.
- The blue-noise module has no module-level cache.
- The task owns its blue-noise `GPUTexture`, view, uniform buffer, shader module, bind-group layout, bind group, pipeline layout, pipeline, and optional internal output target.
- The task stores no GPU handle in its public interface.
- Shader source generation returns a string and contains no GPU state.
- Creating a mesh-blending task installs a shader fragment for Babylon.js-compatible non-uniform normal handling. The fragment is inert outside PBR geometry compositions that request `MESH_BLEND_TAG`, so forward PBR rendering and unrelated geometry tasks remain unchanged. Registration happens only after the factory has validated and constructed the task, and the inverse-matrix WGSL plus extra tangent-frame varying live in `mesh-blending-pbr-support.ts`.
- Standard, PBR, and Node geometry renderables validate raw mesh tags through the tiny `geometry-types.ts` helper and do not statically import `mesh-blending-tag.ts`.
- The geometry renderer already lazy-loads Standard, PBR, and Node material-family bridges and passes the requested attachment list to their geometry views.
- A representative ordinary PBR/glTF scene remains byte-identical to the public-master bundle baseline. Geometry-renderer bundles retain only the reusable typed-`r8uint` attachment/output capability; the post-process, tag helpers, blue noise, search shader, and non-uniform PBR correction remain absent until the mesh-blending task factory is imported.

### Task internal state

The concrete task contains:

```ts
interface MeshBlendingPostProcessTaskInternal extends MeshBlendingPostProcessTask {
    _internalTarget: RenderTarget | null;
    _internalTargetKey: string;
    _device: GPUDevice | null;
    _compiledQuality: MeshBlendQuality | -1;
    _compiledDepthType: MeshBlendDepthType | -1;
    _compiledDebugMode: MeshBlendDebugMode | -1;
    _compiledHasBaseColor: boolean | null;
    _compiledOutputFormat: GPUTextureFormat | null;
    _compiledSourceFormat: GPUTextureFormat | null;
    _compiledDepthFormat: GPUTextureFormat | null;
    _compiledBaseColorFormat: GPUTextureFormat | null;
    _compiledAlphaMode: PostProcessAlphaMode | -1;
    _uniformBuffer: GPUBuffer | null;
    _uniformData: Float32Array;
    _blueNoiseTexture: GPUTexture | null;
    _blueNoiseView: GPUTextureView | null;
    _shaderModule: GPUShaderModule | null;
    _bindGroupLayout: GPUBindGroupLayout | null;
    _pipelineLayout: GPUPipelineLayout | null;
    _pipeline: GPURenderPipeline | null;
    _bindGroup: GPUBindGroup | null;
    _renderPassDescriptor: GPURenderPassDescriptor;
    _colorAttachment: GPURenderPassColorAttachment;
    _boundSource: GPUTexture | null;
    _boundTag: GPUTexture | null;
    _boundDepth: GPUTexture | null;
    _boundBaseColor: GPUTexture | null;
    _validatedSource: GPUTexture | null;
    _validatedTag: GPUTexture | null;
    _validatedDepth: GPUTexture | null;
    _validatedBaseColor: GPUTexture | null;
    _validatedOutput: GPUTexture | null;
    _validatedWidth: number;
    _validatedHeight: number;
    _validatedDepthType: MeshBlendDepthType | -1;
    _validatedAlphaMode: PostProcessAlphaMode | -1;
}
```

GPU state is created lazily in `record()` and revalidated in `execute()`. If `engine._device` changes:

1. stale buffer/texture handles are destroyed or dropped;
2. all bind-group/pipeline/module references are cleared;
3. the deterministic CPU noise is uploaded to a new current-device texture;
4. the current input views are rebound;
5. the current variant is recompiled.

The task never leaves a stale old-device handle reachable from executable state.

### Uniform layout

One 240-byte uniform buffer is written as 60 `f32` values:

| Float range | Value                                     |
| ----------- | ----------------------------------------- |
| `0..15`     | projection matrix                         |
| `16..31`    | inverse projection matrix                 |
| `32..47`    | inverse view matrix                       |
| `48..51`    | world radii Small..ExtraLarge             |
| `52..55`    | minimum projected radii Small..ExtraLarge |
| `56`        | `meshBlendIsOrthographic`, `1` or `0`     |
| `57`        | `slopeFactor`                             |
| `58`        | `enabled`, `1` or `0`                     |
| `59`        | reserved zero                             |

Projection and inverse projection are computed from the task camera and the output dimensions. The `inverseView` range remains zero for ordinary variants and is computed and written only for the WorldPosition debug variant. Orthographic state is `camera.ortho ? 1 : 0`.

### Blue noise

`createMeshBlendingBlueNoiseData()` returns a deterministic `Uint8Array` of `128 * 128 * 2` bytes.

For each of two channels:

1. produce integer-hashed white noise using seed `0x68bc21eb` for R and `0x2f6e2b1d` for G;
2. subtract the toroidally wrapped average of the eight neighboring samples;
3. sort pixel indices by the high-pass value, breaking ties by pixel index;
4. assign byte `floor(rank * 256 / 16384)`.

This preserves an exactly uniform byte histogram in each channel while distributing low-frequency energy into high spatial frequencies. The task uploads the result to:

```ts
{
    size: [128, 128, 1],
    format: "rg8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    mipLevelCount: 1,
    sampleCount: 1,
}
```

The shader wraps integer pixel coordinates manually and uses no temporal/frame index. The noise pattern is therefore deterministic and spatially stable.

## Geometry Pipeline Integration

### Per-mesh data

When a geometry view requests `MESH_BLEND_TAG`, its per-renderable uniform layout gains one scalar `meshBlendTag` field. Standard and Node place it in their mesh UBO; PBR places it in the geometry renderable's task-owned material UBO because PBR extension fields compose into that layout. Each PBR geometry renderable owns a distinct material UBO, so the value remains per mesh even when several meshes share one source material. The CPU upload writes `resolveMeshBlendingTag(mesh)` as an exactly representable `f32` in `[0,255]`; WGSL converts it to `u32`.

This field is geometry-view-only. Forward Standard/PBR/Node renderables are unchanged.

### Standard material geometry output

The Standard geometry view continues to compose the complete Standard shader, preserving:

- diffuse/opacity/bump textures;
- material alpha;
- alpha cutoff/discard;
- bones;
- morph targets;
- vertex colors and vertex alpha;
- regular and thin instancing;
- all existing UV and transform behavior.

`FragmentOutput` generation is per attachment:

```wgsl
struct FragmentOutput {
    // float attachment
    @location(N) fN: vec4<f32>,

    // mesh tag attachment
    @location(M) meshBlendTagM: u32,
}
```

For alpha-tested variants, all fragments reaching the return site survived the existing discard, so the tag write is the raw source tag. For non-alpha-tested variants:

```wgsl
out.meshBlendTagM = select(0u, u32(mesh.meshBlendTag), alpha > 0.4);
```

Every existing float attachment write remains unchanged.

### PBR material geometry output

The PBR geometry view continues to compose the complete PBR shader, preserving:

- metallic/roughness and specular workflows;
- alpha cutoff/discard;
- bones, morphs, vertex colors, and thin instances;
- normal, clearcoat, sheen, anisotropy, iridescence, subsurface, emissive, shadows, IBL, and existing plugin fragments.

The typed output rule matches Standard. Alpha-tested PBR variants write the raw tag after the existing discard. Other variants write zero unless final material alpha is greater than `0.4`.

PBR debug/auxiliary float writes never address the integer attachment.

### Node material geometry output

The Node geometry view continues to re-emit the graph from `GeometryTextureOutputBlock`; no separate simplified material renderer is introduced. Existing graph discard logic runs before the return block. The geometry output builder:

- emits `u32` only for `MESH_BLEND_TAG`;
- emits `vec4<f32>` for all existing geometry attachment types;
- appends the geometry-only mesh uniform scalar;
- writes the validated source-mesh tag for surviving fragments.

The tag is engine-controlled and is not exposed as a `GeometryTextureOutputBlock` graph input.

### Pipeline color targets

For each attachment format:

```ts
format === "r8uint" ? { format } : { format, blend: existingGeometryBlendState };
```

The render pass clears the integer attachment with exact zero. This permits `r8uint` in any slot beside float/unorm attachments without assigning a float blend state to the integer target.

## Mesh-Blending Shader

### Bindings

The shader uses only `textureLoad`; there are no samplers.

Without base color:

| Binding | WGSL type         | Resource               |
| ------: | ----------------- | ---------------------- |
|       0 | `texture_2d<f32>` | source SceneColor      |
|       1 | `texture_2d<u32>` | mesh tag               |
|       2 | `texture_2d<f32>` | depth                  |
|       3 | `texture_2d<f32>` | blue noise             |
|       4 | uniform buffer    | mesh-blending uniforms |

With base color:

| Binding | WGSL type         | Resource               |
| ------: | ----------------- | ---------------------- |
|       0 | `texture_2d<f32>` | source SceneColor      |
|       1 | `texture_2d<u32>` | mesh tag               |
|       2 | `texture_2d<f32>` | depth                  |
|       3 | `texture_2d<f32>` | linear base color      |
|       4 | `texture_2d<f32>` | blue noise             |
|       5 | uniform buffer    | mesh-blending uniforms |

The absence of base color produces a shader variant with no base-color declaration, loads, fields, or shadow-estimation calculations.

### Fullscreen convention

The fullscreen triangle uses Lite's standard top-left UV:

```wgsl
out.uv = vec2<f32>(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
```

Pixel coordinates:

```wgsl
renderSize = textureDimensions(depthTexture, 0);
pixel = clamp(vec2<i32>(floor(uv * vec2<f32>(renderSize))), vec2<i32>(0), vec2<i32>(renderSize) - 1);
pixelUv = (vec2<f32>(pixel) + 0.5) / vec2<f32>(renderSize);
```

Because UV Y increases downward, reconstruction uses:

```wgsl
ndcXY = vec2<f32>(pixelUv.x * 2.0 - 1.0, 1.0 - pixelUv.y * 2.0);
```

Babylon.js's post-process shader evaluates the algorithm in bottom-up pixel coordinates. To preserve the exact deterministic pattern while Lite stores render-target rows top-down, the port keeps candidate/debug directions in Babylon.js algorithm space and converts only at texture-access boundaries:

```wgsl
algorithmPixel = vec2<i32>(pixel.x, renderSize.y - 1 - pixel.y);
pixelOffset = round(vec2<f32>(direction.x, -direction.y) * distancePixels);
```

Blue noise is indexed with `algorithmPixel`. Candidate directions, refinement angles, and debug direction colors remain unchanged from Babylon.js; every search, continuation, target-color, and opposite-direction texture offset uses `pixelOffset`. Without both conversions, the same displayed pixel would read another blue-noise row and probe vertically mirrored candidates.

### Compile-time quality constants

| Quality   | Directions | Radial samples | Direction samples | Direction steps | Exact edge | Radius scale | Rotation         | Jitter | Fallback | Tiny object | Secondary | Interpolation |
| --------- | ---------: | -------------: | ----------------: | --------------: | ---------: | -----------: | ---------------- | -----: | -------- | ----------- | --------- | ------------- |
| Low       |          3 |              2 |                 1 |               2 |          5 |       `0.50` | 8-step quantized |  `0.5` | no       | no          | no        | sRGB          |
| Medium    |          3 |              3 |                 2 |               4 |          8 |       `0.90` | 8-step quantized |  `0.5` | no       | no          | no        | OKLab         |
| High      |          3 |              3 |                 3 |               5 |         10 |       `1.00` | continuous       |  `0.5` | yes      | yes         | yes       | OKLab         |
| Cinematic |          8 |              6 |                 4 |               5 |         50 |       `0.95` | continuous       |  `1.0` | yes      | yes         | yes       | OKLab         |

Quality, depth type, debug mode, and base-color presence are encoded by generated WGSL constants/dead branches so WebGPU compiles only the selected variant's loops and optional calculations.

### Shader constants

```text
TWO_PI                            6.283185307179586
EPSILON                           0.00001
REFINEMENT_SECTOR_SCALE           0.2
TINY_OBJECT_PROBE_COUNT           8
MIN_SLOPE_SCALE                   0.25
BOUNDARY_SEPARATION_FACTOR        0.75
BOUNDARY_PIXEL_TOLERANCE          3.0
FOREGROUND_DEPTH_FACTOR           0.35
FOREGROUND_LATERAL_FACTOR         2.0
TARGET_SPAN_FACTOR                1.5
TOTAL_SPAN_FACTOR                 2.5
NEAR_EDGE_TARGET_WEIGHT           0.35
NEAR_SEAM_MAX_DISTANCE            1.25
NEAR_SEAM_COLOR_DELTA             0.02
BASE_LUMINANCE_EPSILON            0.00001
TARGET_DARKER_RATIO               0.65
TARGET_NON_DARK_RATIO             0.9
SHADOW_DIFFERENCE_LOW             0.15
SHADOW_DIFFERENCE_HIGH            0.5
SHADOW_MIN_ATTENUATION            0.25
```

Rejection codes:

```text
0 NONE
1 NO_CANDIDATE
2 NO_CONTINUATION
3 INVALID_DEPTH
4 DEPTH_SEPARATION
5 FOREGROUND_BACKGROUND
6 PHYSICAL_SPAN
7 CONTACT_ANGLE
```

### Shader structures

The generated WGSL defines:

```text
MeshBlendTag
  groupId: u32
  radiusClass: u32

MeshBlendCandidate
  targetGroupId: u32
  radiusClass: u32
  direction: vec2f
  distancePixels: f32
  searchRadiusPixels: f32
  score: f32
  valid: bool

MeshBlendResult
  candidate: MeshBlendCandidate
  targetPixel: vec2i
  targetFarPixel: vec2i
  currentViewPosition: vec3f
  effectiveRadiusPixels: f32
  fade: f32
  tinyObjectRadiusRatio: f32
  rejectionReason: i32
  stageReached: i32
  valid: bool
  continuationFound: bool
  usedFallback: bool
  tinyObjectRadiusReduced: bool

MeshBlendTargetColorSamples
  fartherColor: vec4f
  boundaryPlusOneColor: vec4f
  boundaryPlusTwoColor: vec4f
  conservativeNearColor: vec4f
  targetColor: vec4f
  fartherBaseColor: vec3f             // base-color variant only
  conservativeNearBaseColor: vec3f    // base-color variant only
  onePixelEdge: bool

MeshBlendColorEvaluation
  samples: MeshBlendTargetColorSamples
  currentColor: vec4f
  blendedColor: vec4f
  worldPosition: vec3f
  shadowAttenuation: f32
  adjustedFade: f32
  nearSeamCorrected: bool
```

### Tag, depth, and position helpers

Tag decoding:

```wgsl
groupId = packed & 0x3fu;
radiusClass = packed >> 6u;
```

Class selection uses x/y/z/w for class 0/1/2/3+.

All tag/depth loads clamp to valid depth dimensions. Search probes therefore alias the border except continuation, which rejects an unclamped out-of-range coordinate.

Depth reconstruction:

- Screen depth uses WebGPU hardware depth directly as NDC Z.
- View depth projects `(0,0,depth,1)` through the current projection to obtain NDC Z.
- Position is `inverseProjection * vec4(ndcXY, ndcZ, 1)` followed by homogeneous division.
- Reverse depth is handled entirely by the projection/inverse-projection matrices.
- Position validity rejects every component whose exponent bits are `0xff`, covering NaN and infinity.
- WorldPosition debug applies `inverseView` after view reconstruction.

### Radius math

```text
projectionScale = max(0.5 * renderHeight * abs(projection[1][1]), EPSILON)
viewDepth = abs(viewPosition.z)

perspectiveProjected = worldRadius * projectionScale / max(viewDepth, EPSILON)
orthographicProjected = worldRadius * projectionScale

scaledRadius =
    max(projectedWorldRadius, minimumProjectedRadius) * qualityRadiusScale

searchRadius =
    scaledRadius > 0 ? max(1, scaledRadius) : 0
```

World units per pixel:

```text
orthographic: 1 / projectionScale
perspective: max(viewDepth, EPSILON) / projectionScale
```

### Candidate search

Blue-noise values:

```text
algorithmPixel = vec2(pixel.x, renderHeight - 1 - pixel.y)
noisePixel = algorithmPixel % vec2(noiseWidth, noiseHeight)
random = textureLoad(blueNoise, noisePixel, 0).rg
sector = TWO_PI / directionCount
rotation =
    continuous quality ? random.x * sector
                       : floor(random.x * 8) * 0.125 * sector
radialJitter = mix(0.5, random.y, jitterFactor)
```

For each radial shell, then each direction:

```text
normalized = (radialIndex + radialJitter) / radialSampleCount
distance = max(1, ceil(normalized^3 * currentRadius))
```

Reject group zero, current group, and the optional ignored secondary-search group. Candidate class is the smaller of the current and sampled class. Recompute radius for that class and reject if distance exceeds it.

Score:

```text
1 - clamp(distance / max(candidateRadius, EPSILON), 0, 1)
```

Strictly greater score replaces the current best candidate. Search stops after the first radial shell that produced any candidate.

Direction refinement:

- skipped at distance `<= 2`;
- interval is `atan2(direction) ± sector * 0.2`;
- sample random is `fract(random.y + random.x * 0.754877666 + sampleIndex * 0.618033989)`;
- step size is `max(1, distance / (stepCount + 1))`;
- each refinement ray walks inward until it leaves the target group.

Exact edge refinement subtracts exactly one pixel per iteration and stops on the first non-target.

### Continuation and fallback

Continuation distance:

```text
max(2 * boundaryDistance, boundaryDistance + 1)
```

The unclamped continuation coordinate must remain in bounds and in the target group. The target and continuation classes tighten the candidate to the smallest participating class.

Low and Medium reject absent continuation.

High and Cinematic search cardinal one-pixel neighbors in exact order:

```text
(+1,0), (-1,0), (0,+1), (0,-1)
```

The preferred original target group receives `+1` score. A fallback candidate is allowed to validate with no continuation; in that case target C and farther target both equal target B.

### Tiny-object protection

High/Cinematic only:

1. probe eight distances opposite the target direction to find the current object's projected thickness;
2. probe four cardinal directions at the original radius;
3. reduce only when an opposite boundary exists and at least three cardinal probes leave the current group;
4. use:

```text
newRadius = max(candidateDistance, min(originalRadius, max(1, thickness * 1.25)))
```

### Contact validation

Coordinates:

```text
A = current pixel
B = refined target boundary
E = direction * max(distance - 2, 0)
C = continuation, or B for permitted fallback
```

Tags must be current/current/target/target as applicable. Reconstruct A/E/B/C and reject invalid positions.

Let:

```text
R = candidateRadius * worldUnitsPerPixel
T = 3 * worldUnitsPerPixel
```

Reject when:

```text
distance(B,E) > 0.75 * R + T
```

Foreground/background rejection requires both:

```text
abs(abs(B.z) - abs(E.z)) > max(0.35 * R, T)
abs(abs(B.z) - abs(E.z)) > 2 * length((B-E).xy)
```

Physical span rejects:

```text
distance(B,C) > 1.5 * R + T
distance(A,C) > 2.5 * R + T
```

Contact direction:

```text
oppositeFacing = -dot(normalize(A-B), normalize(C-B))
slopeScale =
    slopeFactor <= 1
        ? 1
        : 0.25 + 0.75 * clamp(oppositeFacing,0,1)^(slopeFactor-1)
```

Candidate distance must fit `candidateRadius * slopeScale`.

### Fade

```text
boundaryDistance = max(distance - 0.5, 0)
normalized = clamp(boundaryDistance / max(radius, EPSILON), 0, 1)
inverse = 1 - normalized
fade = mix(inverse^2, inverse, clamp(inverse - 0.75, 0, 1)) * 0.5
```

A nonpositive accepted fade is treated as `PHYSICAL_SPAN`.

### Target color and near-seam correction

Load:

- farther/continuation target;
- one pixel farther from the boundary;
- two pixels farther;
- matching base colors only in the shadow-estimation variant.

If plus-one is not target group, use farther directly. Otherwise choose the darker valid plus-one/plus-two sample by sRGB luminance and construct:

```text
target = 0.65 * farther + 0.35 * conservativeNear
```

For one-pixel seams at distance `<= 1.25`, sample one pixel opposite the target. If it remains in the current group and:

```text
distance(current.rgb, target.rgb) + 0.02 < distance(opposite.rgb, target.rgb)
```

replace current RGBA with the opposite-side RGBA before interpolation.

### Color interpolation

Low interpolates in sRGB and converts back to linear.

Medium/High/Cinematic interpolate in OKLab with the standard matrices:

```text
linear RGB -> LMS:
[0.4122214708 0.5363325363 0.0514459929]
[0.2119034982 0.6806995451 0.1073969566]
[0.0883024619 0.2817188376 0.6299787005]

cuberoot LMS -> OKLab:
[ 0.2104542553  0.7936177850 -0.0040720468]
[ 1.9779984951 -2.4285922050  0.4505937099]
[ 0.0259040371  0.7827717662 -0.8086757660]

OKLab -> cubed LMS:
l_ = L + 0.3963377774a + 0.2158037573b
m_ = L - 0.1055613458a - 0.0638541728b
s_ = L - 0.0894841775a - 1.2914855480b

LMS -> linear RGB:
[ 4.0767416621 -3.3077115913  0.2309699292]
[-1.2684380046  2.6097574011 -0.3413193965]
[-0.0041960863 -0.7034186147  1.7076147010]
```

Signed cube roots are used. No gamut, negative, or HDR clamp is applied. Alpha is interpolated independently with the same adjusted fade.

### Optional shadow attenuation

The base-color variant estimates:

```text
shadow = luminance(linearToSrgb(rendered)) / luminance(linearToSrgb(base))
```

Base luminance `<= 0.00001` returns `1`.

```text
difference = abs(fartherShadow - conservativeNearShadow)
mismatch = smoothstep(0.15, 0.5, difference)
targetToCurrent = targetLuminance / max(currentLuminance, 0.00001)
targetNotDark = smoothstep(0.65, 0.9, targetToCurrent)
attenuation = mix(1, 0.25, mismatch * targetNotDark)
adjustedFade = geometricFade * attenuation
```

No shadow value is transferred; only fade is reduced.

### Secondary target

High/Cinematic perform a second search excluding the primary target group. If both results validate:

```text
totalDistance = max(primaryDistance + secondaryDistance, EPSILON)
primaryProximity = secondaryDistance / totalDistance
secondaryProximity = primaryDistance / totalDistance
primaryWeight = primaryAdjustedFade * primaryProximity
secondaryWeight = secondaryAdjustedFade * secondaryProximity
```

If combined weight is effectively zero, pass through source. Otherwise output the normalized weighted average of the two independently blended RGBA results.

### Debug modes

All debug outputs use alpha `1`.

Radius colors:

```text
Small      (0.15, 0.55, 1.00)
Medium     (0.15, 0.90, 0.35)
Large      (1.00, 0.65, 0.10)
ExtraLarge (0.95, 0.20, 0.65)
```

1. `PackedTag`: class color multiplied by `0.45 + 0.55 * fract(groupId * 0.61803398875)`; group zero black.
2. `CandidateDirectionDistance`: `(dir.x*0.5+0.5, dir.y*0.5+0.5, 1-distance/radius)`; invalid `(0.04,0.04,0.04)`.
3. `SeamFade`: quarter-bright class color to white by `clamp(totalFade*2,0,1)`.
4. `RejectionReason`: accepted blue `(0.10,0.55,1.00)` to green `(0.20,1.00,0.25)` by slope ratio; no candidate gray; no continuation purple; invalid depth magenta; separation red; foreground/background orange; physical span yellow; contact angle cyan.
5. `StageWork`: stages 1..7 use navy, blue, cyan, green-cyan, lime, amber, green. Invalid sizing depth is `(0.45,0.1,0.1)` and radius zero is `(0.2,0.2,0.65)`.
6. `Continuation`: no candidate dark; rejected missing continuation magenta; fallback yellow; otherwise green.
7. `TinyObject`: red/orange to blue by retained-radius ratio, full brightness when reduced and `0.45` brightness when unchanged; unsupported/no candidate dark.
8. `MultiTarget`: valid secondary near-white; rejected secondary magenta; primary-only blue; none dark.
9. `TargetColor`: repeating four-pixel columns selected by `(pixel.x / 4) % 4`: farther, plus-one, plus-two, constructed target.
10. `ShadowAttenuation`: `(1-attenuation, attenuation, nearSeamCorrected ? 1 : 0)`. Without base color attenuation is `1`.
11. `ColorInterpolation`: sRGB orange `(1,0.4,0.05)`, OKLab cyan `(0.1,0.75,1)`, intensity `mix(0.35,1,clamp(adjustedFade*2,0,1))`.
12. `WorldPosition`: `fract(worldPosition * 0.1)`.

Generic debug background is `(0.04,0.04,0.04,1)`. With debug Off, every invalid/disabled branch returns the exact loaded source texel.

## State Machine and Lifecycle

### Creation

1. Validate scalar configuration and clone four task-owned radius definitions.
2. Create a task-owned internal output descriptor only when no target is supplied.
3. Allocate CPU uniform scratch and deterministic CPU blue-noise bytes.
4. Allocate no GPU resources.

### Record

1. Build current source/input/output render targets.
2. Resolve physical dimensions and validate format/sample/dimension contracts.
3. Reconfigure and rebuild the task-owned internal target in place if the source format/size identity changed, preserving the published `outputTexture` object used by downstream tasks.
4. Detect device replacement, clear stale GPU state, and rebuild the same published internal output target for the new device.
5. Upload blue noise if absent for the current device.
6. Generate the selected WGSL variant.
7. Create shader module, bind-group layout, pipeline layout, pipeline, uniform buffer, and bind group.
8. Refresh the render-pass descriptor's current output view.

### Execute

1. Revalidate source/view identity and rebuild bind groups or variant state if required.
2. Update camera/radius/slope/enabled uniforms.
3. Apply output viewport/scissor and clear/load state.
4. Draw one fullscreen triangle.
5. Return one draw call.

### Disposal

- destroy the task-owned uniform buffer and blue-noise texture;
- dispose only the task-owned internal output target;
- clear pipeline/module/layout/bind-group references;
- never dispose source, tag, depth, base color, camera, or caller target.

## Babylon.js Equivalence Map

| Babylon.js source                                  | Babylon Lite implementation                                       |
| -------------------------------------------------- | ----------------------------------------------------------------- |
| `Meshes/meshBlendingTag.ts`                        | `mesh/mesh-blending-tag.ts`                                       |
| `AbstractMesh.meshBlendingTag`                     | `Mesh.meshBlendingTag`                                            |
| regular/thin instance source tag                   | no regular-instance API; thin instances use their owning mesh tag |
| `ThinMeshBlendingPostProcess` settings and defines | plain task state + WGSL generator                                 |
| `meshBlendingBlueNoise.ts`                         | task-local deterministic generator/upload                         |
| `meshBlending.fragment.fx`                         | `mesh-blending-wgsl.ts`                                           |
| `FrameGraphMeshBlendingTask`                       | `createMeshBlendingPostProcessTask`                               |
| `PREPASS_MESH_BLEND_TAG`                           | `GeometryTextureType.MESH_BLEND_TAG`                              |
| Standard/PBR/Node prepass outputs                  | existing Lite geometry views with typed tag slot                  |
| NRGE mesh blending block                           | intentionally omitted; Lite exposes the frame-graph task directly |

## Test Specification

### Unit tests

`tests/lite/unit/mesh-blending-tag.test.ts`:

- all valid group/class pack combinations;
- group zero canonicalization;
- invalid group/class inputs;
- invalid raw packed values `64`, `128`, `192`, negatives, fractions, and values above `255`;
- unpack round trips;
- source-mesh resolution and thin/source semantics;
- default radius values and frozen tuple/mutable validated elements;
- slope/enum validation;
- quality constant table and projected-radius math for perspective/orthographic.

`tests/lite/unit/mesh-blending-blue-noise.test.ts`:

- deterministic byte-for-byte generation;
- exact dimensions and two channels;
- exact per-channel histogram of 64 occurrences for every byte;
- Babylon.js-compatible FNV-1a digest `0x965547cd`;
- channel seeds produce different outputs;
- the Babylon.js spectral assertion keeps selected low-frequency power below 10% of selected high-frequency power.

`tests/lite/unit/mesh-blending-shader.test.ts`:

- each quality emits exact loop constants/features/interpolation;
- base-color absence removes every base-color binding and shadow calculation;
- base-color presence adds them;
- view vs screen depth reconstruction contracts;
- top-left NDC Y conversion plus the bottom-up Babylon.js noise-row and direction-offset mapping;
- typed `texture_2d<u32>` tag binding;
- all 13 debug variants;
- exact radius/contact/fade/OKLab constants;
- source pass-through branch;
- HDR path contains no saturate/clamp of interpolated SceneColor;
- secondary target code only in High/Cinematic;
- alpha-independent texture loads and exact texel access.

`tests/lite/unit/geometry-renderer-task.test.ts` additions:

- tag accessor and `r8uint` default;
- tag sample-count/format validation;
- transparent filtering default/override;
- typed shader outputs for Standard, PBR, and Node geometry paths;
- integer target blend omission.

Focused mesh-blending unit tests are run independently from the full repository suites.

### Parity scenes

IDs `310..315` contain six focused scenes. Scene 315 is the user-approved exception to the original five-scene cap:

|  ID | Coverage                                                                                                         |
| --: | ---------------------------------------------------------------------------------------------------------------- |
| 310 | Core Standard/PBR intersections, default Medium/view-depth behavior, packed radius classes, and same-group seam  |
| 311 | Three large ShadowAttenuation seams comparing no albedo on the left with linear albedo on the right              |
| 312 | Nearly full-frame orthographic panels using reverse-Z screen depth, High quality, and custom radius/slope values |
| 313 | Alpha-tested Standard/PBR materials proving discarded fragments write no tag                                     |
| 314 | Cinematic tiny-object protection, continuation/fallback, three-group secondary target, and duplicated contacts   |
| 315 | Hosted coastalCliff.glb with PBR materials, screen depth, optional albedo, exclusions, and asset-scaled radii    |

Each scene includes:

- `lab/lite/sceneN.html`;
- `lab/lite/babylon-ref-sceneN.html`;
- `lab/lite/bundle-sceneN.html`;
- `lab/lite/src/lite/sceneN.ts`;
- `lab/lite/src/bjs/sceneN.ts`;
- one `scene-config.json` entry with a new ceiling, never modifying existing ceilings;
- one parity spec under `tests/lite/parity/scenes/`;
- gallery discovery through `scene-config.json`;
- Vite discovery through the existing HTML auto-input scan;
- bundle-size discovery through the existing scene-config-driven bundle harness.

Each scene has a committed Babylon.js golden under `reference/lite/` and a gallery thumbnail under `lab/public/thumbnails/`.

Scene 311 compares against a fresh Babylon.js capture from the same browser session. Its two half-width post-process viewports map fragment centers exactly onto source-texel boundaries, where fullscreen-varying interpolation can select an adjacent texel on different GPU implementations. A same-GPU reference preserves the strict MAD thresholds without changing the committed golden or weakening the algorithm.

## Dependencies

Static dependencies are limited to existing Lite modules:

- camera matrix getters and matrix inversion;
- render-target creation/build/disposal;
- frame-graph task types;
- geometry material-view composers;
- GPU flags and resource retirement conventions;
- `wgsl` source branding.

No dependency is added. No Babylon.js runtime package is imported by `@babylonjs/lite`; Babylon.js imports exist only in reference scene sources.
