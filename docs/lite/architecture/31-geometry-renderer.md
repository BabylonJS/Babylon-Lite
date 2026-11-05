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
- `VELOCITY` excluded — the `LINEAR_VELOCITY` contract is specified below.
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
    MESH_BLEND_TAG = 11,
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

export interface GeometryVelocityOptions {
    previousDepth?: boolean;
}
export function enableGeometryVelocity(task: GeometryRendererTask, options?: GeometryVelocityOptions): void;

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
    readonly geometryMeshBlendTagTexture: RenderTarget | null;
    excludeFromVelocity(mesh: Mesh): void;
    includeInVelocity(mesh: Mesh): void;
}

export function createGeometryRendererTask(scene: SceneContext, config: GeometryRendererTaskConfig): GeometryRendererTask;

export interface CopyToTextureTaskConfig {
    name?: string;
    sourceTexture: RenderTarget;
    targetTexture?: RenderTarget;
    ownsTargetTexture?: boolean;
    viewport?: NormalizedViewport | null;
    lodLevel?: number;
    resolveTexture?: RenderTarget;
}

export interface CopyToTextureTask extends Task {
    readonly name: string;
    sourceTexture: RenderTarget;
    targetTexture: RenderTarget | undefined;
    ownsTargetTexture: boolean;
    resolveTexture: RenderTarget | undefined;
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

`MESH_BLEND_TAG` is the exception to the general format override rule: it is
always single-sample `r8uint`, clears to unsigned integer zero, and rejects any
other format or nonzero clear. Standard, PBR, and Node geometry views emit a
typed `u32` `FragmentOutput` member for its MRT slot while all other slots
remain `vec4<f32>`. Integer targets omit blend state. The uploaded tag is the
validated source-mesh tag, so source-backed clones/regular instances and thin
instances use their source draw's tag.

`createMeshBlendingPostProcessTask` installs this opt-in output support. The
geometry task may be created first, but the post-process task must exist before
the frame graph preloads its tasks.

Alpha-blended meshes participate by default, matching Babylon.js geometry
rendering. Callers that need an opaque-only pass provide a filtered `meshes`
array. Alpha-tested materials remain supported because their existing material
shader discards rejected fragments before any geometry output is written.

When more than two HDR (`rgba16float`) attachments are stacked the request can
exceed WebGPU's default `maxColorAttachmentBytesPerSample` cap of 32 bytes.
Callers raise that cap through `EngineOptions.requiredLimits`:

```ts
const engine = await createEngine(canvas, {
    requiredLimits: { maxColorAttachmentBytesPerSample: 64 },
});
```

## Design

### PBR interleaved geometry

The PBR geometry factory reads vertex layout and layout key from
`mesh._gpu._vbLayout` / `mesh._gpu._vbKey`, exactly like forward PBR rendering.
Pass both into shader composition and include the layout key in per-view
resource-cache identity. Layout is per mesh, never material-owned: meshes sharing
a material may use different attribute strides/offsets. Bind vertex buffers at
offset zero; attribute offsets belong to the composed pipeline layouts.

### Deformation-aware velocity (PBR and Standard)

`LINEAR_VELOCITY` is previous-minus-current NDC XY divided by two (Y up),
not world-space velocity. Z remains zero by default, preserving existing
velocity visualization and consumers. Call `enableGeometryVelocity(task)` before
scene registration to opt into PBR rigid/deformation motion and shared previous-pose
resources. `enableGeometryVelocity(task, { previousDepth: true })`
also opts into previous positive view depth in Z (previous clip W), requires a
floating-point RGBA velocity attachment and a perspective camera, and uses the
reserved geometry-parameter scalar `gp.cameraNearFar.z = 1`. The AO demo enables
the producer flag together with its temporal consumer's matching flag.
The same contract serves SSAO and other temporal
consumers without AO-specific work in the geometry renderer.

Non-instanced live skeleton and morph meshes reconstruct the **previous**
deformed local position, in the same order as current geometry: base position,
previous morph weights applied to immutable position deltas, then previous
four/eight-influence bone blend, then previous mesh world and previous task
view-projection. Using current morphed positions with previous bones is wrong
when both change. World/camera motion composes with deformation; a stopped
pose yields zero deformation motion on the next frame, not repeated motion.

A material-agnostic deformation-velocity feature owns the previous-pose shader
code and per-renderable resources. The explicit enabler installs it and the
PBR geometry-velocity implementation behind nullable typed seams; ordinary
PBR geometry retains its historical camera-only velocity without importing
matrix inversion or previous-pose code. Standard velocity passes preload the
shared feature when a skinned or morph mesh is present at task preload. Skinned
Standard velocity requires it, as before; a morph-only Standard mesh bound before
it has loaded (for example, one added after registration) keeps the historical
current-morph previous position instead of failing the pass.
This is also a behavior change for **non-SSAO Standard velocity consumers**:
a pass that preloads a morph mesh now uses its previous morph weights rather
than the current morphed position for both frames. Motion blur or another
temporal consumer therefore receives morph-deformation motion even when no
SSAO task exists. Color-only rendering is unchanged; the late-added morph-only
fallback described above remains available.
Implementation installation alone does not activate another task: the enabler
decorates only its task's PBR view factory after preload, tags those views (with
the task's velocity exclusions), and
uses the task-local tag for previous-pose allocation and shader selection.
The shared composer cache key includes the enabled velocity variant. Active
feature-view scope is restored after synchronous composition/binding, including
nested calls, so legacy and opted-in tasks can coexist in one scene.
No previous pose is allocated by color-only or non-velocity geometry passes.
The generic task contains no new velocity policy, allocation or imports; it
retains only an optional effective-camera validator. The enabler initializes
reserved task parameter field 18 once, which parameter uploads preserve.
Repeated enabling with the same contract is idempotent; changing that contract,
enabling after registration, missing/disposed velocity targets, incompatible
formats and perspective-only previous depth fail explicitly.

Each geometry renderable owns one previous-bone RGBA32F texture and/or one
previous-morph-weight read-only storage buffer, plus CPU pose snapshots.
Bindings are created once. Before each geometry draw, upload the prior snapshot
and snapshot the current CPU mirrors for the following draw; first use,
exclusion/re-inclusion and hidden/reappearing meshes use current pose as their
neutral initialization. All history is task/renderable-local: shared materials,
skeletons, morph weights, other geometry tasks and forward/shadow passes cannot
advance another consumer's previous state. No current source resource is mutated
or destroyed, and no vectors/arrays/bind groups are allocated in the update loop.
Retirement disposes previous resources with the existing generation's fenced
lifetime. Device rebuild starts neutral.

The shared skeleton influence generator is reused for previous-bone blending.
The velocity feature describes previous weights as a typed read-only-storage
binding. Its resource producer installs a binding emitter that generates both
the storage WGSL declaration and GPU layout entry from that metadata, at the
binding index assigned by composition. No emitted shader text is parsed or
rewritten for previous weights. The optional emitter is isolated behind a nullable
composition seam, so ordinary shaders retain no storage-buffer policy. Ordinary
morph rendering keeps its existing two-binding rewrite unchanged.
Current position/normal deformation and normal/material shading are unchanged.
After drawing, camera history copies the current matrix directly from the task's
own scene-UBO scratch. No second current-view-projection array or intermediate
per-frame copy is needed; floating-origin adjustment already happened before
that UBO was uploaded.

Arbitrary NodeMaterial graph deformations, baked VAT and independently animated
thin-instance transforms remain separate contracts; this does not invent a
previous transform for them. Existing explicit custom graph velocity remains
available. The AO demo includes separate animated skinned and morphed examples
and an animation toggle. Production unit coverage in
`geometry-deformation-velocity.test.ts`, `geometry-renderer-task.test.ts` and
`standard-geometry-features.test.ts` checks previous-pose ownership, first-frame
initialization, source replacement, task-local opt-in, previous-depth
configuration, exclusions, the morph-only fallback, and disposal.

Files: `frame-graph/enable-geometry-velocity.ts` (public enabler),
`material/geometry-deformation-hooks.ts` / `material/geometry-deformation-velocity.ts`
(shared previous-pose seam and state), and
`material/pbr/pbr-geometry-velocity-hooks.ts` / `material/pbr/pbr-geometry-velocity.ts`
(PBR seam and per-mesh previous-world state).

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

### Resource ownership and failed rebuilds

Every geometry binding owns a `MeshRebuildResources` lifetime sink. The task creates it before
calling the Standard/PBR/Node geometry rebuilder and stamps it onto the returned renderable
before binding. Builders require that owner and register releases before later fallible work.
The bound list publishes only after every rebuild and bind succeeds; a failure synchronously
releases all candidate sinks, including the failing entry, without changing the previous draw
list or any entry it carries. A sync builds views in its own copy of the task's view cache, which
replaces the cache only when the list publishes, so a failed sync also leaves the cache as the last
publish left it; the views it created are dropped with that copy (their variants' buffers went
with the released sinks).

Replaced or disposed live entries retire their detached lifetime batches behind submitted GPU
work. Shared Standard/Node view resources are retained by each renderable and destroyed only
when the last owner releases; an old callback cannot evict a replacement cache entry. There is
no implicit view lease or scene auxiliary-disposer map.

Shader modules are not generation-owned. Standard and PBR geometry resolve them through a private
per-family memo keyed weakly by device and by the exact composed WGSL, so a re-record, a
renderable-version rebuild, a republished forward PBR context, and materials with identical
composition reuse one module per code string instead of compiling it again. Each memo entry counts
the renderables drawing with it: a renderable acquires its vertex and fragment entries when built
and releases them in its idempotent per-mesh lifetime packet, so a candidate generation, built
before the old one retires, still hits, and an entry leaves the memo with its last holder (a
superseded plugin or material variant, a removed mesh, a rolled-back candidate, a disposed task).
A renderable records only the acquisitions that succeeded, and a release never compiles or creates
an entry, so a candidate whose vertex or fragment compile throws rolls back exactly what it holds
and still destroys its mesh UBO.
A `GPUShaderModule` has no `destroy()`, so dropping an entry never invalidates a module that older
pipelines still reference. Composition, BGLs, pipeline layouts, and pipelines stay per view
resource. A device replaced by device-lost recovery compiles its own modules. Node geometry
already shares modules through its code-keyed pipeline cache.

### Incremental re-sync

`record()` and every `scene._renderableVersion` change re-sync the bound list, but only the
entries a mutation touched are rebuilt, like the forward `RenderTask` resync. Each Standard or
PBR entry remembers the forward renderable the scene tracked for its mesh when it was built
(`scene._renderables` for Standard, the group's tracked output for PBR). While the mesh still
draws the same source material through that same forward renderable, the entry is carried as
is: same renderable, binding, update state (including velocity history) and lifetime sink.
Everything an entry captures either forces a forward rebuild when it changes (material
features and textures, mesh capabilities and vertex layout, the PBR context and light/shadow
request), is constant for the task, or is read live each frame (world, light selection,
material UBO version, vertex/index buffers, thin-instance counts). A resize or frame-graph
rebuild therefore rebuilds nothing, and a Standard material swap, material rebuild or new mesh
rebuilds only its meshes. PBR follows its forward pass: a per-mesh forward rebuild (a material
swap through the group's rebuild closure, `markMeshRenderableDirty`, a `rebuildMaterial` that takes
the per-mesh path) rebuilds only that entry, but a full PBR group rebuild (`rebuildMaterial` on a PBR
material that does not qualify for the per-mesh path, a PBR mesh whose group must
widen or be built at runtime, `rebuildScenePbrPipelines`) replaces every PBR forward renderable
and publishes a new PBR context, so every PBR geometry entry is rebuilt and every PBR view
composes a variant set for the new context; Standard entries are still carried. The PBR
forward-generation gate (`isPbrForwardBuildCurrent`) runs first, so a PBR mesh whose forward
rebuild is pending is dropped, never carried. Only superseded entries are retired.

Standard/PBR views, with the variants compiled on them, persist across syncs while the source
keeps its `_renderFeatures` object; the view map is pruned to the drawn materials at each
publish. A new Standard mesh of an already drawn material compiles nothing. A PBR view keeps
one variant set per forward PBR context it composed against, weakly keyed by the context: the
context supplies the composer, scene features and shadow layout, while each entry binds env and
shadow textures from its own mesh's context, so a variant is never shared across contexts.
Several contexts can be live for one view: a full PBR group rebuild publishes a new scene
context, and a PBR mesh runtime-built into a group that was built after it was requested
(several meshes of a never-built PBR group built in one drain before the scene's first build
completes) keeps its own context until the next full rebuild. Meshes on different contexts
never evict each other's set, so a later rebuild of any of them compiles nothing. A new PBR
mesh compiles nothing when its context already has a set on the view; otherwise it composes
its own variant, as its forward build did. A batch that first binds K meshes on K per-mesh
contexts therefore composes K variants, not one per material. Node entries and views are
rebuilt on every sync, because a Node geometry resource snapshots the material's uniforms
once; a Node view is stamped with a per-sync token that holds no view, so a published Node view
keeps no earlier Node material or view alive. Off-scene meshes of an explicit list have no forward renderable and are rebuilt on every
sync too. A sync that sees a different device, camera or `config.reverseCulling` than the last
publish carries nothing and reuses no view, so a camera or culling change, or a device-loss
recovery (whose `record()` also recreates the task's own buffers), rebuilds the whole pass as
before. The camera is stamped as two elements, both compared by identity: the override as a view
captures it (`config.camera ?? null`, so an omitted and a null override are the same choice) and
the camera the pass draws with (`config.camera`, else `scene.camera`). Both matter under a
floating origin. The override decides what an entry packs its world against and whose version
re-packs it: the override itself, or whatever `scene.camera` is at each pack (it also decides
whether a PBR entry receives shadows). Without it, moving one camera between `scene.camera` and
`config.camera` would keep the effective camera and carry entries that then follow the wrong
origin once `scene.camera` changes. The effective camera catches `scene.camera` replaced for a
task without an override: its entries re-pack only when the version they compare moves, and the
new camera's version can equal the old one. A sync only sees the camera of that moment, so under
a floating origin `execute()` clears the stamp once a frame draws with another camera than the
stamped one: `scene.camera` can then pass through other cameras and return to the stamped one
with the version an entry compared last, leaving it packed against another camera's origin, and
the next sync carries nothing. Clearing instead of rebuilding keeps a camera switch between
frames free of pass rebuilds. If a sync against a changed configuration fails and the previous
configuration is restored, the next sync carries the published entries and views, none of the
failed sync's views.

The task's `_removeMesh` hook evicts every matching bound entry and queues its retirement
immediately, including when rendering is stopped. Its weak exclusion set still rejects removed
off-scene inputs and allows a mesh to rejoin after it is added back to the scene.

The task creates group 0 during recording, not once in the factory and again during recording.
Immutable color clear/load/store state is initialized with the attachments; per-record work
only refreshes changing views, dimensions, and depth attachments.

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
the composed shader, mesh BGL, and its per-render-target pipeline map; its
shader modules come from the per-device memo keyed by exact WGSL (see
"Resource ownership and failed rebuilds"), so equal code shares one module.
The pipeline map remains keyed by the complete MRT target signature. A fog
and non-fog scene sharing one device cannot reuse the same Standard geometry
color shader when `targetTexture` requests lit color.

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
  there is no viewport, source and target are single-sampled and share a
  format, the source mip dimensions match the target attachment's dimensions, the
  target is not the swapchain, and the source/target textures were created
  with `COPY_SRC`/`COPY_DST`. Frame-graph render targets carry both copy usages
  by default; external/eager textures without the required usage fall back to
  the blit path. Texture-backed color wrappers retain `_colorSubresource` so
  encoder-copy destinations use the attachment's selected `mipLevel` and layer
  (`origin.z`) rather than the whole allocation's default mip/layer. Targets
  without this metadata retain the ordinary mip-zero, layer-zero destination.
  A source wrapper likewise supplies the physical source mip and `origin.z`.
  Its view exposes exactly one mip: `lodLevel` is view-relative and clamps to
  zero, so the copy uses its selected-mip dimensions without another shift.
  Ordinary sources retain their existing source-LOD selection. If the selected
  source dimensions differ from the target dimensions, the blit path samples
  the wrapper's selected view instead.

- **Blit path** — full-screen triangle samples the source. MSAA sources
  resolve per-sample with `textureLoad`. Lod level is applied via
  `textureSampleLevel`. The Y axis is flipped when the source and target
  have different `flipY` orientations.

When `ownsTargetTexture` is true, the task rebuilds its target during every
frame-graph build, disposes a previously owned target when `targetTexture`
changes, and disposes the current target with the task. `sourceTexture` cannot
be the engine `scRT`, whose GPU texture changes every frame. Resolve-only and
blit-plus-resolve modes use `resolveTexture` for hardware MSAA resolve.

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
- Re-recording the task, a renderable-version rebuild, and a forward PBR
  rebuild that republishes an equivalent context compile no new Standard or
  PBR geometry shader modules; materials that compose identical WGSL share
  one module pair; a task writing a different attachment compiles only its
  new fragment module and shares the identical vertex module; and a replaced
  device compiles its own.
- Retired PBR plugin variants and Standard material variants leave the memo
  while the live variant stays shared; a disposed task releases only the
  modules no other task draws with, and its last holder empties the entry.
- A candidate whose vertex or fragment module fails to compile releases only
  the modules it acquired, creates no entry, takes no count from a stage a
  live generation holds, and destroys its mesh UBO; a retry compiles the
  missing stages once.
- A re-sync keeps the entries of meshes whose forward renderable is unchanged (new mesh,
  re-record, unrelated swap) and rebuilds only the touched ones, including when driven by the
  scene's own producers (material setter, `markMeshRenderableDirty`, `rebuildMaterial`,
  `addToScene`); a new mesh of a drawn material reuses the cached view and variant; a shared
  Standard variant's material UBO survives deferred retirements until its last owner releases
  it; a failed replacement leaves every carried entry intact; a failed sync, incremental or
  against a changed camera or culling direction, leaves the view cache as published, so a
  restored configuration rebuilds a refreshed entry on its own view; Node entries rebuild on
  every sync, and a Node material swapped over several syncs leaves no earlier material or view
  reachable from the published views.
- Under a floating origin, a tracked mesh is packed against the camera the pass draws with: after
  `scene.camera` is replaced (with an equal world-matrix version) for a task without an override,
  after its camera becomes `config.camera` and `scene.camera` then moves on, after
  `config.camera` is removed while it is the scene camera and `scene.camera` then moves on, and
  on the record after frames drawn with other scene cameras end on the stamped one again.
- A PBR geometry variant composed against a superseded forward PBR context is not reused.
- A PBR view keeps one variant set per live forward context: after meshes on a scene context
  and on per-mesh runtime-build contexts are bound (one variant per context), per-mesh and
  batch refreshes of any of them compile nothing.

## Future extensions

- **PBR support** — mirror `standard-geometry-output-shader.ts` with a
  `pbr-geometry-output-shader.ts` that post-processes the PBR composer's
  fragment output (rewriting the entry return and `return finalColor;` into
  MRT writes).
- **Gaussian splatting + sprites** — render Gaussian splat meshes and sprite
  batches into the same MRT attachments. The flag plumbing already exists
  (`GEOMETRY_OUTPUT` for Standard); the work is per-renderer pipeline
  composition.

## Related

- `28-frame-graph.md` — `Task` / single-attachment `RenderTarget` API.
- `29-post-process.md` — sibling frame-graph task family.
- `08-standard-material.md` — Standard material features and bindings.
- `engine/render-target-mrt.ts` — MRT-only render-target module, lazy-loaded
  by `geometry-renderer-task.ts` so existing scenes keep paying nothing for
  the multi-attachment API.
