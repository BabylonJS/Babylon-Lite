# Module: Renderable + Frame-Graph Architecture

> Package paths: `packages/babylon-lite/src/render/renderable.ts`, `packages/babylon-lite/src/frame-graph/`

## Purpose

The render pipeline is driven by a scene-owned frame graph. Materials still own shaders, pipelines, and bind groups; the frame graph only schedules render passes and asks material renderables to bind target-specific draw closures.

This keeps the engine render loop material-agnostic while allowing the same `Renderable` to participate in multiple passes with different target signatures (color/depth formats, depth compare, and MSAA count).

## Public API Surface

### Renderable contract (`render/renderable.ts`)

```typescript
export interface DrawUpdateContext {
    readonly targetWidth: number;
    readonly targetHeight: number;
    readonly _camera?: Camera | null;
}

export interface DrawBinding {
    readonly renderable: Renderable;
    readonly pipeline: GPURenderPipeline;
    draw(pass: GPURenderPassEncoder | GPURenderBundleEncoder, engine: EngineContext): number;
    update?(context: DrawUpdateContext): void;
    readonly _updateBatches?: readonly DrawUpdateBatch[];
    _sortDistance?: number;
}

export interface Renderable {
    readonly order: number;
    readonly isTransparent: boolean;
    readonly _transmissive?: boolean;
    readonly _direct?: boolean;
    readonly mesh?: Mesh;
    _sortDistance?: number;
    _worldCenter?: [number, number, number];
    _lastMaterial?: any;
    _lifetimeDisposers?: (() => void)[];
    _rebuild?: () => Renderable | Promise<Renderable>;
    bind(engine: EngineContext, target: RenderTargetSignature): DrawBinding;
}

export interface PrePassRenderable {
    execute(encoder: GPUCommandEncoder, engine: EngineContext): number;
}

export interface MeshGroupBuildResult {
    renderables: Renderable[];
    updater?: SceneUniformUpdater;
    rebuildSingle: MeshRebuilder;
}

/** @internal Auxiliary rebuilds register resources with their caller, not the scene. */
export interface MeshRebuildResources {
    readonly _lifetimeDisposers: (() => void)[];
}

export type MeshRebuilder = (scene: SceneContext, mesh: Mesh, materialOverride?: Material, resources?: MeshRebuildResources) => Renderable;
```

`Renderable.bind(engine, target)` is the key split: material modules resolve the pipeline for the pass target once and return a `DrawBinding` closure. The `RenderTask` owns the scene bind group (group 0), so renderables never set bind group 0 themselves.

`DrawBinding.update(context)` is called once per frame per binding before the render pass is opened. The context contains the current pass target dimensions (`targetWidth`, `targetHeight`) and active pass camera (`_camera`) so bindings can refresh target-size-dependent UBOs or camera-sorted instance buffers without rebuilding their pipelines or bind groups. Mesh/material UBO updates that do not need this state still use this hook and version-guard their writes.

### Frame graph (`frame-graph/`)

```typescript
export interface Task {
    readonly name: string;
    readonly engine: EngineContext;
    readonly scene?: SceneContext;
    _passes: Pass[];
    record(): void;
    _preload?(): Promise<void>;
    _removeMesh?(mesh: object): void;
    execute?(): number;
    dispose(): void;
}

export interface FrameGraph {
    _tasks: Task[];
    _currentProcessedTask: Task | null;
    build(): void;
    execute(): number;
    dispose(): void;
}
```

`createSceneContext()` eagerly creates a `FrameGraph` with one default `RenderTask` named `"scene"` that renders into the swapchain unless called with `{ defaultRenderTask: false }`. Post-process pipelines that render the scene to an offscreen source and write their final pass to the swapchain disable this default task so the scene is not drawn twice. User code can add tasks with `addTask()`, `addTaskAtStart()`, or `addTaskBefore()`.

### RenderTask

`RenderTask` is a built-in direct-execution task. `record()` prepares its render target, descriptor, scene binding, and staged draw fields; `execute()` begins the WebGPU render pass, updates/buckets/draws renderables, and ends the pass. Its `_passes` array stays empty. Pass-backed custom tasks remain supported by the generic `Task` contract.

```typescript
export interface RenderTaskConfig {
    name: string;
    rt: RenderTarget;
    rst?: RenderTarget;
    depth?: RenderTarget;
    clrColor?: GPUColorDict;
    clr?: boolean;
    depthClear?: boolean;
    sharedRt?: boolean;
    cam?: Camera | null;
    cs?: boolean;
    transmission?: { copyCount?: number; generateMipmaps?: boolean; mipLevelCount?: number; grabDepth?: boolean };
    autoMirror?: boolean;
}
```

Important fields:

| Field        | Meaning                                                                                                                                                   |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rt`         | Concrete color/depth render target. The single-sample default task may use the surface-owned `scRT`; MSAA tasks use an owned multisample target.          |
| `rst`        | Optional single-sample resolve target used when `rt` is multisampled. The default MSAA scene task resolves into the surface `scRT`.                       |
| `depth`      | Optional separate depth target. Eager targets are borrowed; non-eager targets are built and disposed by the task.                                         |
| `clr`        | `true`/undefined clears color; `false` loads previous color content for overlays/multi-scene composition.                                                 |
| `depthClear` | Controls rt-owned depth independently. `true`/undefined clears depth; `false` loads existing depth. External `depth` targets keep their ownership policy. |
| `sharedRt`   | Uses a target owned and recorded by an earlier task; this task does not build or dispose `rt`/`rst`.                                                      |
| `cam`        | Per-pass camera override; defaults to `scene.camera`.                                                                                                     |
| `cs`         | Use canvas dimensions for scene UBO aspect instead of RTT dimensions. Used when an RTT texture must be rendered with canvas aspect.                       |
| `autoMirror` | Set `false` to keep an empty explicit render list instead of mirroring the scene renderables.                                                             |

`addMeshToTask(task, mesh, { material })` accepts either a source material or a `MaterialView`. The mesh is resolved at `record()` time through the completed scene-local material group's `r` closure, so explicit offscreen tasks can render the same mesh with pass-specific material features without mutating `mesh.material`. Standalone geometry-view factories explicitly opt into `_sceneIndependentRebuild`; only these may fall back to `_buildGroup._rebuildSingle` when no scene group exists.

`RenderTask.enabled` defaults to `true`. Setting it to `false` skips the pass before updates, attachment loads, resolves, or draws.

## Runtime Flow

```text
createSceneContext(engine)
  -> createFrameGraph(engine, scene)
  -> append default swapchain RenderTask unless defaultRenderTask is false
  -> build frame graph

startEngine/registerScene frame:
  scene._update()
    -> before-render callbacks
    -> material swap processing
    -> shadow generators and legacy pre-passes
    -> shared uniform updaters
  scene._record()
    -> frameGraph.execute()
      -> task.execute() when present
      -> otherwise each pass._execute()
```

`FrameGraph.build()` calls `record()` on every task, then initializes any recorded passes. `RenderTask.record()` builds the render target, follows scene renderables while in scene-mirroring mode, resolves pending `addMeshToTask()` inputs, stages per-target `DrawBinding` lists, refreshes the task-owned scene bind group as the final fallible step, and only then publishes draw fields plus descriptor/dimension updates. `FrameGraph.execute()` calls its direct `execute()` function rather than draining a `RenderPass`.

## RenderTask Buckets

At record/re-sync time, a render pass task partitions bindings into:

| Bucket      | Source flag                        | Draw path                                                                                            |
| ----------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Opaque      | `!isTransparent && !_direct`       | Cached `GPURenderBundle`; rebuilt for a fresh binding generation or global visibility/resource epoch |
| Direct      | `_direct`                          | Direct draw after opaque bundle                                                                      |
| Transparent | `isTransparent \|\| _transmissive` | Direct draw, camera-space-depth sorted back-to-front per pass                                        |

Opaque and direct bindings are sorted by `renderable.order`. Transparent bindings must remain camera-space-depth sorted and are not pipeline-sorted. `_transmissive` marks true scene-texture refraction surfaces; the render task routes them into the same sorted transparent loop so transmission snapshots happen immediately before the current transmissive draw. `_direct` selects the non-transparent direct-draw bucket; mutable depth-writing sprite/billboard batches set `_direct` without `_transmissive` so they still appear in opaque-scene refraction RTTs.

`_lastVersion` is the scene renderable version captured before the active binding generation is
built. Auto-mirroring tasks use it to detect source-list synchronization, and
`enableRenderTaskMeshRefresh` uses the same snapshot to detect when tracked meshes may need rebuilt
renderables. Draw execution never overwrites it. Opaque bundle caching is independent: publishing
bindings provides a fresh empty `_ob`, explicit invalidation clears `_ob`, and a `_vis` epoch change
rebuilds the bundle. Replacing only the group-0 lights buffer clears `_ob` so the bundle captures the
new scene bind group, but preserves `_lastVersion` and the material binding generation. It therefore
rebuilds the bundle once without redundantly rebinding every material or triggering explicit mesh
refresh. The same rules apply to the transmission split-pass path.

## Per-Pass Scene UBO

Each `RenderTask` owns:

- `_sceneUBO`
- `_sceneBG`, created on first recording
- scene UBO scratch/cache arrays

The scene UBO is allocated with the task. Its bind group is created only when recording first
needs it; light-buffer storage remains scene-owned. Binding creation must succeed before a new
draw-binding generation is published, so a failed first recording can be retried.

`writePassSceneUBO()` writes the canonical 352-byte `SceneUniforms` struct for the pass. All render targets use the same upright projection/culling convention; downstream texture-copy and post-process shaders handle their sampling convention without a per-target flip flag. The task-level UBO lets RTT passes, canvas passes, and camera overrides coexist without mutating global scene state.

## Scene Bind-Group-Layout Cache

`getSceneBindGroupLayout(engine)` in `render/scene-helpers.ts` lazily caches the immutable group-0
layout in a `WeakMap<GPUDevice, GPUBindGroupLayout>`. Engines that share a device receive the same
layout; different or replacement devices use independent keys. The newly created layout is inserted
only after `GPUDevice.createBindGroupLayout()` succeeds, so a failed allocation remains retryable and
can never return a layout created by the previous device.

Scene layouts are independent from material pipeline/bind-group caches. Clearing a Standard,
PBR, Shader, or Node material cache does not clear the scene layout, and device recovery requires no
explicit layout invalidation: the replacement `GPUDevice` naturally selects a fresh key while dead
device entries remain weakly collectible. `clearSceneBGLCache()` remains an explicit internal reset
for focused tests and tooling; production material-cache clear and recovery paths do not retain or
invoke it.

## Lighting Module Boundary

Lighting support is split so each consumer retains only the layer it needs:

- `render/lights-ubo.ts` is a compatibility facade. It contains no implementation and re-exports the scene-state, mesh-layout, and mesh-selection helpers below.
- `render/scene-lights-ubo.ts` owns scene-wide GPU light state: the shared light buffer/scratch/version record, `ensureSceneLightState()`, `refreshSceneLightsUBO()`, `getLightsUboSize()`, and `_writeTaskLightsData()` for a task-specific camera/light source.
- `render/mesh-light-layout.ts` owns only shader/UBO layout construction: `appendMeshLightUboFields()` and `meshLightIndexWGSL()`. Standard/PBR templates import this module without retaining scene light upload code.
- `render/mesh-light-selection.ts` owns per-mesh inclusion/exclusion filtering and index packing through `writeMeshLightSelection()`. Standard/PBR/Node renderable builders import it without retaining scene-state allocation.

`RenderTask` and device recovery import `scene-lights-ubo.ts` directly. Material templates import
`mesh-light-layout.ts`, while material renderable builders import `mesh-light-selection.ts`. This
keeps scene GPU-state ownership, shader declaration, and per-mesh CPU selection as separate
tree-shakable concerns.

## Material-Owned Pipelines

Standard shadow variant-key construction is private to the lazy receiver fragment. The shared
Standard material types/feature module must not re-export it: even an unused receiver entry can
otherwise retain shadow-key code in ordinary Standard bundles through shared module exports.

`standard-material.ts` contains types and compatibility re-exports only. Runtime feature detection
lives in `standard-material-features.ts`, while pipeline-cache key construction is private to
`standard-pipeline.ts`. The renderer, plugin bridge, and geometry loader import their concrete
operations rather than the material facade, avoiding cycles through material creation and loading.

Material renderable builders remain responsible for:

1. Computing feature bits from mesh/material/scene state
2. Dynamically importing needed shader fragments
3. Composing WGSL
4. Creating/caching pipelines and bind group layouts
5. Returning renderables whose `bind(engine, target)` selects the correct pipeline for that target signature

The frame graph never imports material-specific shader code.

## Material Views

Material views are lightweight pass-specific views over a source material. They are used when a render task needs different render features for the same source material state, for example rendering Standard/PBR meshes into shadow-depth RTTs.

```typescript
export interface Material {
    readonly _buildGroup: MeshGroupBuilder;
    _renderFeatures?: MaterialRenderFeatures;
    _uboVersion: number;
}

export interface MaterialRenderFeatures {
    features: number;
    features2?: number;
}

export interface MaterialView extends Material {
    readonly source: Material;
    _renderFeatures: MaterialRenderFeatures;
}

export function createMaterialView(source: Material, renderFeatures: MaterialRenderFeatures): MaterialView;
export function markMaterialUboDirty(materialOrView: Material): void;
export function rebuildMaterial(scene: SceneContext, materialOrView: Material, options?: RebuildMaterialOptions): void;

// Public, read-only material-family discriminator.
export function getMaterialFamily(material: Material): string | undefined;

// Public, read-only enumeration of the material's currently bound 2D textures.
export function getMaterialTextures(material: Material): readonly Texture2D[];

// Public TypeScript type guards for the well-known core material families.
export function isPbrMaterial(material: Material): material is PbrMaterialProps;
export function isStandardMaterial(material: Material): material is StandardMaterialProps;
export function isShaderMaterial(material: Material): material is ShaderMaterial;
export function isNodeMaterial(material: Material): material is NodeMaterial;
```

`getMaterialFamily()` returns a stable string identifying which concrete family a material belongs to, so scene explorers, serializers, and diagnostics can display the family using only public APIs — never private renderer fields or property-shape heuristics. It unwraps a `MaterialView` to its `source` and reads the family declared on the material's `_buildGroup`. It returns `"pbr"`, `"standard"`, `"shader"` (including the grid material and other `createShaderMaterial`-based materials), `"node"`, or `undefined` (deliberately discoverable from the `string | undefined` signature so callers handle the unknown case). The material-builder surface (`_buildGroup`) is `@internal`, so package consumers cannot author their own builder: a user-created "custom material" is a `createShaderMaterial` (reported as `"shader"`) or a node material (`"node"`), and `getMaterialFamily` will not return an arbitrary user-defined string today. The return type is nonetheless a raw `string` rather than a string-literal union so a new core family can be added without a breaking change, and so the function stays forward-compatible if a public custom-family builder API is introduced later (it passes any tagged string through unchanged).

`getMaterialTextures()` returns a newly allocated readonly array containing the non-null `Texture2D` handles currently bound by the material. It supports standard, PBR, shader, and node material families, including registered material-extension and plugin textures. Unknown material families return an empty array. Material views are unwrapped to their source so enumeration reports the source material's bindings. The function is implemented in a side-effect-free module and costs zero bundle bytes until imported.

`isPbrMaterial()`, `isStandardMaterial()`, `isShaderMaterial()`, and `isNodeMaterial()` are formal TypeScript type guards over `getMaterialFamily()`: each narrows a `Material` to the concrete family type (`PbrMaterialProps`, `StandardMaterialProps`, `ShaderMaterial`, `NodeMaterial`). A `MaterialView` over a matching source passes its family's guard, since it inherits every property from the source through its prototype chain. All of these functions are fully tree-shakable: scenes that never call them retain zero bytes for them.

`createMaterialView()` creates a material-compatible object whose prototype is the source material, then stores only view-owned render feature bits and a `source` pointer. Textures, samplers, uniforms, alpha/culling state, extension data, `_buildGroup`, and UBO versions are inherited from the source material. Creating a view from another view collapses to the original source; no source-side view registry is retained.

Material renderables intentionally do not import material-view helpers or unwrap the source material. They read the selected material object normally: plain materials recompute/store `material._renderFeatures` at build time, while views provide their own `_renderFeatures` and inherit every other property from the source. This keeps material-view helper bytes isolated to scenes that import `createMaterialView()` or family-specific view helpers. Mesh/pass feature bits remain separate and are computed per renderable.

`markMaterialUboDirty()` increments `source._uboVersion`, so every renderable/view derived from that source can observe scalar/vector UBO changes independently. `rebuildMaterial()` scans scene meshes and matches either the source or views whose `source` is that material; `rebuildViews: false` limits matching to the exact supplied material/view. Use it for feature/layout changes such as texture changes, sampler/layout changes, alpha/culling changes, or view feature changes.

## `_buildGroup` Pattern

Materials carry `_buildGroup: MeshGroupBuilder` on their props. `addToScene()` groups meshes by builder, and deferred builders run before rendering to produce renderables.

`MeshGroupBuildResult.rebuildSingle` is stored on the scene group as `r` for material swaps and per-pass material overrides. The builder's `_rebuildSingle` cache does not establish readiness for another scene; an existing group without `r` must finish its build before rebuilding a mesh.

NodeMaterial vertex features use an optional typed compiler/binding seam. The built-in `MorphTargetsBlock` installs the morph feature directly; for public custom block loaders that only set the established `usesMorphTargets` flag, the async material parser dynamically imports and installs the same feature before pipeline compilation. This compatibility fallback is not a synchronous pipeline dependency, so ordinary static Node graphs do not fetch morph WGSL, binding code, or the zero-target fallback allocation.

Node light selection follows the same opt-in rule. Emitters that set `usesLightsUbo` install the `node-lighting.ts` mesh-layout/writer seam; a flag-only custom emitter receives the same seam from the async parser fallback. Unlit Node materials retain only the 20-float world/receiver/attribute-flags mesh UBO and do not import mesh light-selection code. Lit materials preserve the existing `lc`/`li` fields, `nli()` helper, group-0 lights declaration, 40-float mesh UBO, and per-mesh index packing.

Auxiliary task rebuilds pass `MeshRebuildResources` through every wrapper and specialized builder.
With this argument, a builder registers cleanup in the supplied lifetime list before subsequent
fallible work instead of replacing the mesh's scene-owned disposer entries. Without it, ordinary
scene rendering uses the main mesh disposer list. There is no separate scene-owned auxiliary
registry: render and geometry tasks own their auxiliary resources. Task rollback releases only unpublished auxiliary
resources; removal or replacement retires the published resources after submitted GPU work.
Shared geometry-view resources retain their renderable owners, so retiring one task's entries
or swapping the main material cannot destroy storage still used by another task.

Standard rebuild context retains the scene-specific fragment factories and the scene's shadow-
presence flag, not another engine reference or a detailed shadow-slot list.
Rebuilders resolve the engine from their supplied scene. After a successful group build,
geometry passes share that same completed factory object instead of copying its fog and morph
members into a second context object.

Standard and PBR shadow receiver modules own their shared group-2 binding resolver. Its cache is
created only after the receiver module is loaded and is keyed by the GPU bind-group-layout object.
Both material families use the same descriptor construction, preserving light order and the
texture/sampler/uniform triple for each light. Ordinary material builders retain neither that
construction loop nor a shadow binding cache. Standard shader generation also consumes the
existing scene-local shadow slots instead of projecting a new slot and generator array per mesh.
The Standard receiver module also owns slot capture, variant-key construction, and a lazily
created immutable receiver fragment reused by all meshes in that scene build. Non-shadow
Standard rendering retains none of those operations.

The internal factory is
`createMaterialShadowBindings(engine: EngineContext, lights: readonly { readonly gen: ShadowGenerator }[]): (layout: GPUBindGroupLayout) => GPUBindGroup`.
Each call creates an independent weak-keyed cache. A layout is published to that cache only after
successful bind-group creation, so failed construction remains retryable without borrowing another
scene's generators.

Bindings may expose feature-owned `_updateBatches`. Their producer installs collection on the
target signature only when needed; ordinary rendering uses optional batch reset/flush hooks
without retaining the collection and retirement implementation. This work is separate from
renderable lifetime ownership and does not require a second disposer-map generation.
Cached batch generations become unavailable when retirement is scheduled, not when its fence
finishes. Reactivation therefore creates a new generation, and a late or repeated destroy of
the old generation cannot evict its replacement. A batch retained by another live state is
neither retired nor removed from its cache.
The uniform batch factory owns cache and specialized-collector replacement. After its fence
drains, a retired entry keeps only cleared, weak-keyed generation metadata until that signature
is reused or collected; deferred destruction never edits the cache or the current collector. A generic
collector installed by another feature is preserved.
Uniform producers queue fixed-size engine-owned staging images. Queueing validates alignment,
assigns each copy's packed upload offset while accumulating the required byte count, and invalidates
a cached byte view only when its source image changes. Both flush passes reuse those offsets rather
than recomputing prefix sums. Flushing needs only the CPU packing and GPU copy-recording passes,
not a separate size/validation scan. Image contents remain live until packing, and the queue
upload still happens before any GPU copy commands are recorded.
Uniform-only collection reuses an immutable single-batch state. When another producer joins a
candidate, the generic collector copies that state before appending batches; it never mutates
the previously published uniform-only state.

Shader composition keeps one dependency record per fragment and one native vertex-layout record
per interleaved group. The first attribute still determines its group's stride and step mode;
ungrouped layouts precede groups in first-seen order. Material bindings remain ahead of shadow
bindings, and base template substitutions retain their original sequential order. These are
CPU-side preparation changes only: generated WGSL and GPU layout descriptors remain unchanged.

## Babylon.js Equivalence Map

| Babylon Lite                            | Babylon.js                                        |
| --------------------------------------- | ------------------------------------------------- |
| `FrameGraph` + `Task`                   | Frame graph / render graph scheduling             |
| `RenderTask`                            | Render pass task that binds target + camera state |
| `Renderable.bind()`                     | Material/effect submesh binding for a target      |
| `DrawBinding`                           | Prepared draw item / submesh draw packet          |
| `MaterialView`                          | Pass-specific material variant / render override  |
| Task-owned scene UBO                    | Per-pass scene uniform state                      |
| Opaque/transmissive/transparent buckets | Rendering group draw lists                        |
| `renderable.order`                      | Rendering order / group sorting                   |

Node morph position and normal helper functions are generated from the same weighted-delta
loop template with offsets `0` and `3` into the six-float delta record. This only shares CPU-side
source construction; emitted WGSL, load indices, and floating-point accumulation order are
unchanged.

## Dependencies

- `render/renderable.ts` imports only engine/mesh/render-target types.
- `frame-graph/frame-graph.ts` depends only on `Task` and uses the engine already captured by each task.
- `frame-graph/render-task-base.ts` owns ordinary recording and execution without importing auxiliary rebuild ownership.
- `frame-graph/render-task.ts` exposes task creation and the independently tree-shakable `addMeshToTask`; task population owns transactional auxiliary rebuilds.
- Material modules depend on `Renderable` and return target-bindable renderables; the frame graph does not depend on material modules.
- `material/material-view.ts`, `material/material-dirty.ts`, and `material/material-rebuild.ts` own the shared material-view and material-rebuild helpers used by render tasks and material families.

## File Manifest

| File                                         | Purpose                                                                                                                      |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `src/render/renderable.ts`                   | `Renderable`, `DrawBinding`, `PrePassRenderable`, optional `SceneUniformUpdater`, `MeshGroupBuildResult`, `MeshGroupBuilder` |
| `src/frame-graph/task.ts`                    | Polymorphic frame-graph task interface                                                                                       |
| `src/frame-graph/frame-graph.ts`             | Ordered task list, build/execute/dispose lifecycle                                                                           |
| `src/frame-graph/frame-graph-actions.ts`     | `addTask`, `addTaskAtStart`, `addTaskBefore` helpers                                                                         |
| `src/frame-graph/render-task-base.ts`        | Per-pass scene UBO, renderable bucketing, RTT/swapchain pass execution                                                       |
| `src/frame-graph/render-task.ts`             | Public task creation and opt-in explicit mesh population                                                                     |
| `src/frame-graph/render-task-transaction.ts` | Auxiliary rebuild publication, rollback, and ownership                                                                       |
| `src/render/draw-update-batches.ts`          | Optional batch collection and lifetime coordination                                                                          |
| `src/render/scene-helpers.ts`                | GPUDevice-keyed scene BGL cache, world-matrix UBO updates, and default pipeline descriptor construction                      |
| `src/render/lights-ubo.ts`                   | Compatibility facade re-exporting the split lighting helpers                                                                 |
| `src/render/scene-lights-ubo.ts`             | Scene-owned shared light buffer, scratch/version state, upload refresh, and task-specific light-data writer                  |
| `src/render/mesh-light-layout.ts`            | Mesh-light UBO field declarations and WGSL index accessor                                                                    |
| `src/render/mesh-light-selection.ts`         | Per-mesh light filtering and packed light-index writes                                                                       |
| `src/shadow/material-shadow-bindings.ts`     | Receiver-only shadow bind-group construction and per-scene layout cache shared by Standard/PBR                               |
| `src/material/material.ts`                   | Shared material, material-view, and render-feature interfaces                                                                |
| `src/material/material-view.ts`              | Lightweight material view creation and source normalization                                                                  |
| `src/material/material-dirty.ts`             | Source-material UBO version bump helper                                                                                      |
| `src/material/material-rebuild.ts`           | Rebuild helpers for source materials and their views                                                                         |
