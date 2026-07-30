# Module: Frame-Graph Geometry Renderer

> Package paths: `packages/babylon-lite/src/frame-graph/`, `packages/babylon-lite/src/material/standard/standard-geometry-output-shader.ts`

## Purpose

The geometry renderer task renders a list of scene meshes into a bundle of
multi-render-target (MRT) geometry textures — view-space normals, world-space
positions, reflectivity, albedo, normalized view depth, linear velocity, and so
on. These textures are consumed by downstream tasks (screen-space ambient
occlusion, post-process effects, screen-space reflections, motion blur, etc.).

The shape and texture types mirror Babylon.js'
`MaterialHelperGeometryRendering.GeometryTextureDescriptions`. Babylon Lite
exposes a strict subset, biased toward minimal bundle size:

- `ALBEDO_SQRT` excluded — only `ALBEDO` is exposed.
- `VELOCITY` (screen-space vec2) excluded — only `LINEAR_VELOCITY` (world-space
  vec3) is exposed.
- `IRRADIANCE_LEGACY` excluded — only `IRRADIANCE` is exposed.
- `COLOR` excluded — callers wire a separate scene color RT through the task's
  optional `targetTexture` color attachment (matches BJS `PREPASS_COLOR_INDEX`).

A companion `createCopyToTextureTask()` exists so callers can blit a generated
geometry attachment into a viewport on the swapchain (or any other RT) for
inspection / impostor strips / post-process inputs.

## Public API Surface (types, functions, constants — full signatures)

```ts
export const enum GeometryTextureType {
    IRRADIANCE = 0,
    WORLD_POSITION = 1,
    LOCAL_POSITION = 2,
    REFLECTIVITY = 3,
    VIEW_DEPTH = 4,
    NORMALIZED_VIEW_DEPTH = 5,
    SCREENSPACE_DEPTH = 6,
    VIEW_NORMAL = 7,
    WORLD_NORMAL = 8,
    ALBEDO = 9,
    LINEAR_VELOCITY = 10,
}

export type GeometryClearValue = GPUColor;

export interface GeometryTextureDescription {
    readonly name: string;
    readonly defaultFormat: GPUTextureFormat;
    readonly clearValue: GeometryClearValue;
}

export const GEOMETRY_TEXTURE_DESCRIPTIONS: readonly GeometryTextureDescription[];

export interface GeometryRendererTextureDescription {
    readonly type: GeometryTextureType;
    readonly format?: GPUTextureFormat;
}

export interface GeometryRendererTaskConfig {
    name?: string;
    meshes?: readonly Mesh[];
    camera?: Camera | null;
    size?: "canvas" | { width: number; height: number };
    samples?: 1 | 4;
    depthTexture?: RenderTarget | null;
    readonly textureDescriptions: readonly GeometryRendererTextureDescription[];
    reverseCulling?: boolean;
}

export interface GeometryRendererTask extends Task {
    readonly name: string;
    readonly outputTarget: RenderTargetMrt;
    readonly geometryIrradianceTexture: RenderTarget | null;
    readonly geometryWorldPositionTexture: RenderTarget | null;
    readonly geometryLocalPositionTexture: RenderTarget | null;
    readonly geometryReflectivityTexture: RenderTarget | null;
    readonly geometryViewDepthTexture: RenderTarget | null;
    readonly geometryNormalizedViewDepthTexture: RenderTarget | null;
    readonly geometryScreenspaceDepthTexture: RenderTarget | null;
    readonly geometryViewNormalTexture: RenderTarget | null;
    readonly geometryWorldNormalTexture: RenderTarget | null;
    readonly geometryAlbedoTexture: RenderTarget | null;
    readonly geometryLinearVelocityTexture: RenderTarget | null;
    excludeFromVelocity(mesh: Mesh): void;
    includeInVelocity(mesh: Mesh): void;
}

export function createGeometryRendererTask(scene: SceneContext, config: GeometryRendererTaskConfig): GeometryRendererTask;

export interface CopyToTextureTaskConfig {
    name?: string;
    sourceTexture: RenderTarget;
    targetTexture: RenderTarget;
    viewport?: NormalizedViewport | null;
    lodLevel?: number;
}

export interface CopyToTextureTask extends Task {
    readonly name: string;
    sourceTexture: RenderTarget;
    targetTexture: RenderTarget;
    viewport: NormalizedViewport | null | undefined;
    lodLevel: number;
    readonly outputTexture: RenderTarget;
}

export function createCopyToTextureTask(scene: SceneContext, config: CopyToTextureTaskConfig): CopyToTextureTask;
```

## Usage

```ts
const gbuffer = createGeometryRendererTask(scene, {
    samples: engine.msaaSamples as 1 | 4,
    textureDescriptions: [
        { type: GeometryTextureType.NORMALIZED_VIEW_DEPTH },
        { type: GeometryTextureType.VIEW_NORMAL },
        { type: GeometryTextureType.WORLD_POSITION },
        { type: GeometryTextureType.REFLECTIVITY },
        { type: GeometryTextureType.ALBEDO },
    ],
});
addTask(scene, gbuffer);

// Blit the depth attachment into a 256×144 strip at the top of the swapchain.
addTask(
    scene,
    createCopyToTextureTask(scene, {
        sourceTexture: gbuffer.geometryNormalizedViewDepthTexture!,
        targetTexture: outputTarget,
        viewport: { x: 0, y: 0, width: 0.2, height: 0.2 },
    })
);
```

The task accepts up to 8 attachments (the WebGPU max). Each
`GeometryRendererTextureDescription.format` defaults to the entry in
`GEOMETRY_TEXTURE_DESCRIPTIONS[type].defaultFormat` and can be overridden per
attachment.

When more than two HDR (`rgba16float`) attachments are stacked the request can
exceed WebGPU's default `maxColorAttachmentBytesPerSample` cap of 32 bytes.
Callers raise that cap through `EngineOptions.requiredLimits`:

```ts
const engine = await createEngine(canvas, {
    requiredLimits: { maxColorAttachmentBytesPerSample: 64 },
});
```

## Design

### Two-phase task: `record()` plus `execute()`

All allocations, shader compilations, pipeline creation, bind-group creation,
draw-list construction, and viewport math live in `record()`. `execute()` only:

1. updates per-frame UBO contents (scene UBO from the task's camera, per-mesh
   world matrix, previous world matrix for velocity, geometry params), and
2. dispatches the prebuilt draw list against the prebuilt MRT render-pass
   descriptor.

The frame graph rebuilds and re-records when scene inputs change, so callers
never have to worry about stale caches. The same `record()`-vs-`execute()`
split is used by `RenderPassTask`, `CopyToTextureTask`, and the post-process
tasks.

### Bundle isolation

`createGeometryRendererTask()` owns its own scene UBO, scene bind group,
material-view cache, and pipeline cache. It does **not** route through
`getOrCreateStandardBindings()` or `getOrCreateStandardPipeline()`. Existing
scenes that never import `geometry-renderer-task.js` pay zero bytes.

Likewise, `geometry-types.ts` and the Standard geometry-output shader composer
(`standard-geometry-output-shader.ts`) are loaded only by the geometry task.

### MRT engine plumbing — a dedicated `RenderTargetMrt` module

A geometry task's `outputTarget` is built with `colorFormats` set from the
`textureDescriptions` array. The MRT-specific render-target API lives in its
own module (`engine/render-target-mrt.ts`), separate from the single-attachment
`RenderTarget` (`engine/render-target.ts`) used by every existing scene. This
split keeps non-geometry scenes from paying for MRT helpers:

- `RenderTargetMrt` owns `colorFormats: readonly GPUTextureFormat[]` (1..8),
  `_colorTextures: GPUTexture[]`, `_colorViews: GPUTextureView[]`, plus
  `_resolveColorTextures` / `_resolveColorViews` (MSAA → resolve) when
  `sampleCount > 1`.
- Single-attachment `RenderTarget` keeps its original `_colorTexture` /
  `_colorView` shape — unchanged from `master` for binary-format compatibility.
- `createRenderTargetMrt` / `buildRenderTargetMrt` / `disposeRenderTargetMrt` /
  `getSampledColorTexture` / `getSampledColorView` are exported from the MRT
  module and lazy-loaded only by the geometry renderer.

Each per-type accessor on `GeometryRendererTask` (e.g.
`geometryViewNormalTexture`) returns a wrapper single-attachment `RenderTarget`
whose `_colorTexture` / `_colorView` are aliased to the underlying MRT
attachment via `getSampledColorTexture` / `getSampledColorView`. The wrapper
sets `_eager: true` so `buildRenderTarget` becomes a no-op (the MRT owns the
real GPU texture). This lets downstream tasks (`createCopyToTextureTask`,
post-process, etc.) consume a single geometry attachment as if it were an
ordinary single-attachment RT — they never need to know MRT exists.

### Standard material geometry view

For each unique source `Material` among the caster meshes, the task creates a
`MaterialView` whose `_renderFeatures` flips `GEOMETRY_OUTPUT` on and clears
`MATERIAL_ALPHA_BLEND`. The view shares the source material's bindings
(textures, samplers, UBO data) and only swaps the compiled shader pipeline.

The MaterialView indirection (prototype-inheritance wrapper, see
`material/material-view.ts`) means the source material's `diffuseTexture`,
`bumpTexture`, `opacityTexture`, etc., flow through unchanged — every
property lookup falls through to the source. The geometry task reuses the
same texture handles and sampler objects the regular Standard pipeline uses.

The view's compiled fragment WGSL is produced by **post-processing** the
output of `composeStandardShader` (the regular Standard composer):

1. The standard composer emits the full fragment body, including bump
   perturbation (`normalW = perturbNormal(...)` via the AC slot), opacity-
   texture alpha modulation (`alpha *= textureSample(oT, oS, ...)`),
   alpha-cutout discard, instancing, thin-instance colour, and the lighting
   loop. None of this is re-implemented for the geometry pass.
2. `composeStandardGeometryShader` (in `standard-geometry-output-shader.ts`)
   then string-patches the composed fragment WGSL:
    - rewrites the entry-point return type from `-> @location(0) vec4<f32>`
      to `-> FragmentOutput`,
    - prepends a `struct FragmentOutput { @location(0) f0: vec4<f32>, ... };`
      declaration sized to the requested attachment count, and
    - replaces `return color;` with MRT writes computed from already-in-scope
      variables (`normalW`, `baseColor`, `alpha`, `input.vp`, `scene.view`,
      `gp.cameraNearFar`).
3. When any requested attachment needs `cameraNearFar` /
   `previousViewProjection` (NORMALIZED_VIEW_DEPTH, LINEAR_VELOCITY), a
   small `~geometry-params` ShaderFragment is appended to the fragment list
   to contribute the `gp` UBO binding. The fragment id starts with `~` so
   it sorts after every `std-*` ext in the composer's alphabetical topo-sort
   order, placing the binding last in the layout.

The result is that **every enabled Standard material and mesh feature flows
through**: morph targets, skeletal skinning, bump perturbation,
opacity-texture alpha modulation, alpha-cutout, UV scale/offset transforms,
RGBA vertex colour modulation, instancing, and thin-instance colour all use
the same fragments as the main scene render. The Standard geometry path
computes the same effective material feature mask from the source material
plus the current mesh feature bits, then mirrors the regular bind-group and
draw-buffer ordering.

The optional Standard skeleton / vertex-color / UV-offset paths remain behind
the published Standard mesh-feature enablers. A geometry task does not
statically import those chunks. Skeletal previous-bone state is a separate
dynamic chunk loaded only when the skeleton enabler, a matching Standard mesh,
and a velocity attachment are all present.

#### Standard geometry variant and cache identity

`view._geometry` is keyed by every shader-relevant input:

```
meshFeatures
sceneFeatures (including fog presence)
attachment list (owned by the view)
emitColor (owned by the view)
```

`meshFeatures` includes morph, skeleton, 8-bone skeleton, vertex color, UV2,
thin instances, and instance color. The resource stored under that key owns
the composed shader, mesh BGL, shader modules, and its per-render-target
pipeline map. The pipeline map remains keyed by the complete MRT target
signature. A fog and non-fog scene sharing one device cannot reuse the same
Standard geometry color shader when `targetTexture` requests lit color.

#### Standard geometry binding and draw order

Group-1 resources and vertex buffers follow the composed shader exactly:

1. mesh UBO (`world`, light selection, and velocity fields when requested),
2. morph storage buffers when morphing is active,
3. material UBO,
4. diffuse texture/sampler,
5. UV transform UBO,
6. sorted Standard extension bindings (including the skeleton bone texture),
7. geometry params UBO and previous-bone texture when velocity requires them.

Vertex buffers are position, normal, UV/UV2, sorted enabled extension buffers
(vertex color and skeleton joints/weights), then thin-instance buffers.
Interleaved offsets come from `MeshGPU._vbLayout`, matching the regular
Standard draw path.

The per-scene fog fragment and `STD_SCENE_FOG` bit participate in Standard
geometry composition and cache identity. Without a real-color target the
resulting lit `color` and fog blend are dead code for the WGSL compiler; with
`targetTexture`, the same fragment produces the forward fogged color.

The per-attachment `writeGeometryInfo` gate (`wg = select(0.0, 1.0, alpha > 0.4)`)
matches BJS `default.fragment.fx` PREPASS: combined with per-attachment
`ALPHA_COMBINE` blend state, low-opacity samples preserve the destination
(background) while high-opacity samples overwrite it. The MRT pipeline
toggles per-attachment alpha blend + depth-write-off when the source
material has `alpha < 1` or `HAS_OPACITY_TEXTURE`.

Vertex color is `vec4<f32>`. Its RGB multiplies `baseColor`; its alpha
multiplies the running Standard `alpha` before both alpha-test discard and the
geometry write gate. Omitted Standard `uvOffset` always contributes `[0, 0]`
in both forward and geometry UV UBOs, including when UV-offset support was
enabled globally for a different material.

The `REFLECTIVITY` attachment re-samples `sT`/`sS` (the specular texture +
sampler) to recover the glossiness alpha channel that the std-specular
fragment drops when writing into `specularColor.rgb`.

### Velocity attachment

When `LINEAR_VELOCITY` is requested, the task tracks per-mesh world matrices
across frames for its existing material paths. `excludeFromVelocity(mesh)`
and `includeInVelocity(mesh)` let callers opt single meshes out of velocity
tracking (e.g., for known-static instances or sky / hud meshes).

For Standard meshes the renderable extends `MeshUniforms` with `previousWorld`
and a velocity-enabled scalar. Current clip position uses the fully deformed
`out.vp`; previous clip position uses the prior local world snapshot and
deformation state. Skeletal velocity lazily creates two `rgba32float` bone
textures and two matching bind groups per renderable. Each update samples the
texture written on the prior frame while `queue.writeTexture` refreshes the
idle texture for the next frame, then swaps roles. Forward-only skeletons and
non-skeletal geometry scenes never load this implementation.

The first frame initializes previous world and both bone textures from current
state and keeps the velocity gate disabled, producing zero motion.
`excludeFromVelocity()` clears the per-mesh UBO gate while local previous state
continues advancing, so re-inclusion does not require a bind-group rebuild or
produce a stale-frame spike.

### Depth attachment

The task allocates its own `depth32float` depth texture when
`config.depthTexture` is omitted. Pass an external `RenderTarget` to share an
existing depth attachment with another task (e.g., the main scene render
task). The depth format of the geometry pipelines is taken from the actual
attached depth-stencil texture.

### Camera

`config.camera` overrides the per-pass camera. When omitted, the task reads
`scene.camera` at `execute()` time. Both view and view-projection matrices are
written into the task's own scene UBO via `writePassSceneUBO()`.

## CopyToTextureTask

Used in Scene 145's impostor strip to display geometry attachments. Two
execution paths chosen in `record()`:

- **Fast path** — `GPUCommandEncoder.copyTextureToTexture`. Eligible when
  there is no viewport, source and target share format and sample count, the
  source mip dimensions match the target's mip-0 dimensions, the target is
  not the swapchain, and the target owns a color GPU texture. WebGPU allows
  `copyTextureToTexture` for non-zero `lodLevel` and for MSAA → MSAA copies
  when both textures have the same sample count.

- **Blit path** — full-screen triangle samples the source. MSAA sources
  resolve per-sample with `textureLoad`. Lod level is applied via
  `textureSampleLevel`. The Y axis is flipped when the source and target
  have different `flipY` orientations.

The color attachment's `loadOp` is `"load"` when a viewport is set (so
pixels outside the viewport are preserved — required for impostor strips
that overlay a scene render) and `"clear"` otherwise.

## Scene 145

`lab/src/lite/scene145.ts` is the primary parity / integration test for the
geometry renderer task. It loads the public Hill Valley `.babylon` scene,
renders it through an MSAA swapchain `RenderTask`, runs a six-attachment
`GeometryRendererTask` over the same meshes, and uses six
`CopyToTextureTask`s to display the geometry attachments in a strip across
the top of the canvas:

1. `NORMALIZED_VIEW_DEPTH`
2. `VIEW_NORMAL`
3. `WORLD_NORMAL`
4. `WORLD_POSITION`
5. `REFLECTIVITY`
6. `ALBEDO`

Six attachments at the chosen formats sum to 34 bytes/sample (with WebGPU
alignment, just over the default cap of 32), so the scene calls
`createEngine(canvas, { requiredLimits: { maxColorAttachmentBytesPerSample: 64 } })`.

The BJS reference scene ports
[Playground #ARI9J5#6](https://playground.babylonjs.com/#ARI9J5#6) (minus the
`FrameGraphGUITask` overlays, which are out of scope for Lite). Parity passes
at `MAD ≈ 0.002` against the BJS golden — the MaterialView post-processing
approach reuses the standard fragment body verbatim, so the impostor strip
matches BJS pixel-for-pixel (no lossy material-constants approximation).

## Test Specification

- Minimal Standard composition excludes fog helper/blend WGSL.
- Explicit Standard fog context includes helper/blend WGSL.
- Fog/non-fog Standard bindings and geometry color resources remain separate
  on one device.
- Missing `uvOffset` writes zeros in forward and geometry UBO data.
- Standard geometry composition with skeleton includes the shared skinning
  helper, bone bindings, joints/weights layouts, deformed world
  position/normal, and previous-bone velocity state.
- Standard geometry composition with vertex color modulates albedo and alpha
  before discard/write masking and binds the color buffer.
- Morph/skeleton/vertex-color bits participate in the geometry resource key.

## Future extensions

- **PBR support** — mirror `standard-geometry-output-shader.ts` with a
  `pbr-geometry-output-shader.ts` that post-processes the PBR composer's
  fragment output (rewriting the entry return and `return finalColor;` into
  MRT writes).
- **Gaussian splatting + sprites** — render Gaussian splat meshes and sprite
  batches into the same MRT attachments. The flag plumbing already exists
  (`GEOMETRY_OUTPUT` for Standard); the work is per-renderer pipeline
  composition.
- **Previous morph weights for velocity** — current Standard/PBR morph
  positions are applied to depth/normals/current clip. A future shared
  previous-weight buffer can extend motion vectors for independently animated
  morph weights in the same way Standard skeleton velocity retains prior bone
  matrices.

## Related

- `28-frame-graph.md` — `Task` / single-attachment `RenderTarget` API.
- `29-post-process.md` — sibling frame-graph task family.
- `08-standard-material.md` — Standard material features and bindings.
- `engine/render-target-mrt.ts` — MRT-only render-target module, lazy-loaded
  by `geometry-renderer-task.ts` so existing scenes keep paying nothing for
  the multi-attachment API.
