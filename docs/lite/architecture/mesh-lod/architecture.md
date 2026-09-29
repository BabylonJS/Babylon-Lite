# MeshLoD Architecture

> - Feature root: `packages/babylon-lite/src/mesh-lod/`
> - Offline tool root: [MegameshCLI](https://github.com/CedricGuillemet/MegameshCLI) (`CMakeLists.txt` at repository root)
> - Approved inputs: `goals.md`, `requirements.md`, Babylon Lite source architecture, and the approved clustered-LOD research conclusions.

## 1. Executive Summary

MeshLoD is an opt-in Babylon Lite feature for static opaque triangle geometry. A native CMake converter preprocesses one glTF material primitive into a deterministic, versioned, range-addressable `.mlod` container. At runtime Babylon Lite loads resident hierarchy metadata and pinned coarse geometry first, streams 64–256 KiB pages containing multiple meshlets, selects a crack-free cut from screen-space error and residency, and renders each compatible material/hierarchy batch with one indirect hardware-raster draw rather than one CPU draw per meshlet.

The runtime preserves Babylon Lite's architectural invariants:

- public MeshLoD values are pure state and behavior is supplied by standalone functions;
- MeshLoD assets and instances never reference a scene;
- the scene owns MeshLoD registrations, renderables, update batches, and disposal callbacks; renderables own their device-recovery rebuild thunks;
- materials own the MeshLoD shader variant, pipeline descriptor, bind-group layout, and bind-group creation;
- no public API exposes WebGPU handles;
- importing unrelated APIs has no side effects and non-MeshLoD scenes fetch no MeshLoD chunks.

### Before / after

| Concern | Before MeshLoD | After MeshLoD |
| --- | --- | --- |
| Large static geometry | Entire ordinary mesh is loaded and uploaded before rendering | Validated hierarchy metadata and pinned coarse pages become renderable first; fine pages stream by demand |
| LOD | Ordinary mesh or application-authored alternatives | Converter-generated clustered group DAG with explicit screen-space-error selection and hysteresis |
| Submission | One draw per ordinary renderable; thin-instance culling may use indirect drawing | One `drawIndirect` per compatible MeshLoD material/hierarchy batch, independent of selected meshlet count |
| Geometry binding | Fixed vertex/index buffers | Material-owned vertex-processing variant fetches packed page geometry and expanded draw vertices from storage buffers |
| Optional features | glTF and material features use lazy registries/imports | MeshLoD follows the same lazy seams and adds no eager core feature branch |
| Failure fallback | Loader failure normally prevents the mesh from existing | Fine-page failure retains the nearest complete resident ancestor; bootstrap corruption still fails the asset explicitly |
| Device loss | Scene rebuild recreates ordinary meshes/material renderables | Generic renderable `_rebuild` thunks recover MeshLoD arenas, pinned pages, and material packets; fine pages stream again on demand |

No migration is required for existing applications. MeshLoD is additive and unused scenes remain byte- and behavior-compatible (`REQ-INT-1`, `REQ-INT-8`).

## 2. Resolved Open Decisions

All eight decisions from section 14 of `requirements.md` are resolved as follows.

| # | Decision | Approved architecture default | Rationale |
| --- | --- | --- | --- |
| 1 | Multi-primitive output naming | One `.mlod` still contains exactly one primitive hierarchy. If a conversion selects more than one primitive, `--output statue.mlod` deterministically emits `statue.mesh000.prim000.mlod`, `statue.mesh001.prim000.mlod`, etc. If exactly one primitive is selected, the requested path is used exactly. | Preserves the one-container-per-primitive contract while allowing the three-primitive statue to convert in one command without an additional manifest format. |
| 2 | Binary compatibility | Format `1.0`, little-endian, 64-byte section/page alignment, 256-byte header, CRC32C on header/directory/each required metadata section/each stored page, strict major compatibility, capability-checked minor compatibility, and skippable optional sections. | Range validation must work without downloading the whole file. Per-range CRC32C detects corruption where it is consumed; SHA-256 provenance hashes identify source/build inputs. |
| 3 | Final page size | Every stored page, including the last, is padded to at least 64 KiB; stored pages are multiples of 64 KiB and at most 256 KiB. Padding is zero and covered by the page CRC. | Keeps cache allocation, range scheduling, and validation uniform and satisfies `REQ-FMT-4` without a special final-page rule. |
| 4 | Runtime defaults | 2.0 px SSE; 15% LOD hysteresis; 120-frame residency hold; two-frame obsolete-request grace; 128 MiB effective GPU cache; capacity defaults to the same value; four concurrent requests; two retries after the initial attempt at 250 ms and 1,000 ms; demo simulation 8 MiB/s and 100 ms RTT. | Conservative desktop defaults make transitions visible without excessive refinement, bound work, and are deterministic in tests. All are observable and configurable. |
| 5 | Material boundary | Version 1 guarantees Babylon Lite `PbrMaterialProps` for opaque metallic-roughness materials using `TEXCOORD_0`: base-color texture/factor, normal texture/scale, ORM and occlusion strength, emissive texture/color, metallic/roughness factors, double-sided state, and unlit. No alpha mask/blend, transmission, clearcoat, sheen, iridescence, anisotropy, UV2, vertex color, skin, morph, VAT, or material plugins. | Covers all three statue materials, including unlit and double-sided variants, while avoiding speculative shader permutations. Unsupported combinations fail explicitly rather than rendering approximately. |
| 6 | Request customization | Applications may supply headers, credentials, and a custom `fetch`-compatible function. The custom function is the v1 external-cache integration point; there is no separate cache-provider protocol. | Covers authentication, signed URLs, testing, bandwidth simulation, and application caches with one standard seam and no premature cache abstraction. |
| 7 | GPU timing fallback | Report `unsupported`; do not hide it and do not substitute CPU timing. | A CPU duration is not equivalent to GPU duration. This matches the existing Babylon Lite task-timing status model. |
| 8 | Deterministic camera path | Required in the demo: 20 seconds, looping, fixed 60 Hz sample time, two 10-second smooth orbit/zoom segments around the statue bounds; manual interaction pauses it and reset resumes at `t=0`. Automated demo verification uses fixed timestamps at 0, 5, 10, and 15 seconds. | Produces repeatable streaming/selection states while preserving normal orbit and zoom controls. |

## 3. Current Babylon Lite Architecture

### 3.1 Ownership and build flow

Babylon Lite entities are plain data. `SceneContext` owns meshes, renderables, callbacks, deferred builders, frame-graph tasks, and disposal lists. `addToScene` groups ordinary meshes by `material._buildGroup`; `registerScene` drains deferred builders and builds the frame graph.

```text
Application
   |
   +-- createEngine(canvas)
   +-- createSceneContext(engine)
   +-- addToScene(scene, plain data)
   +-- registerScene(scene)
            |
            +-- drain scene._deferredBuilders
            +-- material._buildGroup(scene, meshes)
            +-- scene._renderables[]
            +-- frameGraph.build()
```

MeshLoD must not add a feature case to `addToScene`. It uses the existing optional-scene-work pattern (`addDeferredSceneRenderables`) and the renderable-owned recovery seam (`REQ-INT-2`, `REQ-INT-4`).

### 3.2 Material-owned renderables

`Renderable.bind(engine, target)` returns a `DrawBinding`. The binding captures the target-specific pipeline, owns per-frame `update`, and records draw commands. Material modules build these renderables and pipelines; the generic render task only sorts, updates, batches, and invokes them.

```text
RenderTask
  update bindings
      |
      +-- binding.update(context)
      +-- DrawUpdateBatch.flush(engine)     <-- compute work before render pass
  begin render pass
      |
      +-- set material-owned pipeline
      +-- binding.draw(pass, engine)
```

MeshLoD selection, demand generation, draw expansion, and indirect-argument generation therefore fit into a feature-owned `DrawUpdateBatch`. The PBR MeshLoD material module owns the subsequent render pipeline and bind group (`REQ-RENDER-3`).

### 3.3 Existing thin-instance GPU-culling precedent

Thin-instance culling already demonstrates the required pattern:

- a lazily imported feature module;
- per-binding compute state;
- a task-local `DrawUpdateBatch`;
- compute passes flushed before the render pass;
- compacted buffers and indirect arguments consumed by a material draw closure;
- device-keyed caches and frame-safe retirement.

MeshLoD generalizes this pattern from compacting instances to selecting hierarchy clusters and expanding their indexed triangles into a storage-backed draw stream. It does not reuse thin-instance state or shaders directly.

### 3.4 glTF feature registry and current meshopt behavior

The glTF loader dynamically imports `gltf-feature-registry.ts` only when an asset may need optional behavior. `EXT_meshopt_compression` is then dynamically imported as a `GltfFeature` and runs before accessor extraction.

Current `EXT_meshopt_compression` behavior is:

1. lazily load `/meshopt_decoder.js` through `getMeshoptDecoder()`;
2. decode every compressed glTF buffer view eagerly;
3. copy every uncompressed buffer view;
4. repack all materialized views into one 4-byte-aligned binary buffer;
5. rewrite glTF buffer views to the replacement buffer;
6. support only source buffer zero.

MeshLoD does **not** route pages through that glTF feature and does not change its eager glTF semantics. It reuses the same lazy decoder module directly, one page at a time, with glTF-compatible `ATTRIBUTES` and `TRIANGLES` streams. Consequently the decoder script is still fetched only when a glTF meshopt asset or MeshLoD asset actually requires it.

### 3.5 Device-loss recovery

Current recovery rebuilds textures, retained ordinary mesh data, material groups, render-task scene buffers, and frame graphs. Before clearing the scene renderables, it captures each optional renderable's `_rebuild` thunk and replays them after rebuilding material groups. MeshLoD attaches one thunk per material/hierarchy batch, recovering pinned coarse pages once per asset and recreating each batch's material-owned GPU packet. A missing pinned page fails device recovery explicitly; removed batches return no renderable. No MeshLoD branch is added to generic recovery.

## 4. Target Component Architecture

```text
                     OFFLINE
  glTF/GLB primitive
          |
          v
  mesh-lod-tool (CMake)
    cgltf validation/normalization
    clustered group DAG
    8-wide per-level hierarchy forest
    meshlet-local geometry
    deterministic page packing
          |
          v
      one .mlod per primitive

                     RUNTIME
  loadMeshLoD(engine, source, options)
          |
          +-- range source / validator
          +-- immutable metadata
          +-- pinned coarse page decode/upload
          +-- shared page/cache/scheduler state
          v
      MeshLoDAsset (no scene reference)
          |
  createMeshLoDInstance(asset, pbrMaterial)
          v
      MeshLoDInstance (plain SceneNode state)
          |
  addMeshLoDToScene(scene, instance)
          v
  Scene-owned MeshLoD registry
    batches by asset + exact material object
    update batch: selection -> demand -> expansion
    PBR-owned MeshLoD renderable
    scene disposal/recovery callbacks
```

### 4.1 Lazy module boundaries

```text
main package entry
  mesh-lod public facade (only retained when imported)
      |
      +-- dynamic import ./mesh-lod-runtime.js on first load/registration
      +-- dynamic import ../material/pbr/pbr-mesh-lod-renderable.js
      +-- dynamic import ../loader-gltf/meshopt-decode.js on first page decode
```

No MeshLoD module registers itself at import time. Module-level state is limited to nullable lazy caches; no module-level `Map`, `Set`, or `WeakMap` allocation is permitted (`REQ-INT-1`, `REQ-INT-2`, `REQ-INT-6`).

## 5. Public API Surface

The declarations below are the exact v1 public contract. They are declarations only, not implementation code.

```typescript
export type MeshLoDSource = string | ArrayBuffer | Blob;

export type MeshLoDAssetState =
    | "loading"
    | "ready"
    | "recovering"
    | "failed"
    | "disposed";

export type MeshLoDSelectionMode = "cpu" | "gpu";

export type MeshLoDDebugView =
    | "none"
    | "meshlet-id"
    | "lod-depth"
    | "selected-group"
    | "page-residency"
    | "requested-pages";

export interface MeshLoDRequestOptions {
    readonly fetch?: typeof globalThis.fetch;
    readonly headers?: HeadersInit;
    readonly credentials?: RequestCredentials;
}

export interface MeshLoDLoadOptions {
    readonly screenSpaceError?: number;
    readonly lodHysteresis?: number;
    readonly residencyHoldFrames?: number;
    readonly obsoleteRequestGraceFrames?: number;
    readonly cacheBudgetBytes?: number;
    readonly cacheCapacityBytes?: number;
    readonly cpuPageCacheBytes?: number;
    readonly maxConcurrentRequests?: number;
    readonly retryCount?: number;
    readonly retryDelaysMs?: readonly number[];
    readonly selectionMode?: MeshLoDSelectionMode;
    readonly request?: MeshLoDRequestOptions;
    readonly signal?: AbortSignal;
}

export interface MeshLoDMetadata {
    readonly formatMajor: number;
    readonly formatMinor: number;
    readonly toolVersion: string;
    readonly meshoptimizerRevision: string;
    readonly cgltfRevision: string;
    readonly sourceSha256: string;
    readonly buildFingerprintSha256: string;
    readonly meshIndex: number;
    readonly primitiveIndex: number;
    readonly sourceTriangleCount: number;
    readonly hierarchyTriangleCount: number;
    readonly clusterCount: number;
    readonly groupCount: number;
    readonly hierarchyNodeCount: number;
    readonly hierarchyDepth: number;
    readonly pageCount: number;
    readonly pinnedPageCount: number;
    readonly boundsMin: readonly [number, number, number];
    readonly boundsMax: readonly [number, number, number];
}

export interface MeshLoDDiagnostics {
    readonly frameIndex: number;
    readonly sourceTriangleCount: number;
    readonly renderedTriangleCount: number;
    readonly selectedMeshletCount: number;
    readonly visibleGroupCount: number;
    readonly fallbackGroupCount: number;
    readonly maximumSelectedErrorPixels: number;
    readonly maximumUnmetErrorPixels: number;
    readonly requestedPageCount: number;
    readonly queuedPageCount: number;
    readonly inFlightPageCount: number;
    readonly residentPageCount: number;
    readonly pinnedPageCount: number;
    readonly terminalFailedPageCount: number;
    readonly downloadedBytes: number;
    readonly gpuCacheUsedBytes: number;
    readonly gpuCacheBudgetBytes: number;
    readonly gpuCacheCapacityBytes: number;
    readonly cpuPageCacheUsedBytes: number;
    readonly maxConcurrentRequests: number;
    readonly streamingPaused: boolean;
    readonly selectionMode: MeshLoDSelectionMode;
}

export interface MeshLoDAsset {
    readonly metadata: MeshLoDMetadata;
    readonly diagnostics: MeshLoDDiagnostics;
    state: MeshLoDAssetState;
    error?: MeshLoDError;
    /** @internal */ _runtime: MeshLoDAssetRuntime;
}

export interface MeshLoDInstanceOptions {
    readonly name?: string;
    readonly visible?: boolean;
    readonly screenSpaceError?: number;
}

export interface MeshLoDInstance extends SceneNode {
    readonly asset: MeshLoDAsset;
    readonly material: PbrMaterialProps;
    visible: boolean;
    screenSpaceError?: number;
    /** @internal */ _asset: MeshLoDAsset;
    /** @internal */ _material: PbrMaterialProps;
    /** @internal */ _instanceId: number;
}

export type MeshLoDErrorCode =
    | "MLOD_INVALID_OPTION"
    | "MLOD_ABORTED"
    | "MLOD_DISPOSED"
    | "MLOD_HTTP_STATUS"
    | "MLOD_HTTP_RANGE"
    | "MLOD_HTTP_ENCODING"
    | "MLOD_TRUNCATED"
    | "MLOD_BAD_MAGIC"
    | "MLOD_UNSUPPORTED_VERSION"
    | "MLOD_UNSUPPORTED_ENDIAN"
    | "MLOD_HEADER_INTEGRITY"
    | "MLOD_DIRECTORY_INTEGRITY"
    | "MLOD_SECTION_INTEGRITY"
    | "MLOD_PAGE_INTEGRITY"
    | "MLOD_INVALID_LAYOUT"
    | "MLOD_INVALID_HIERARCHY"
    | "MLOD_BUDGET_TOO_SMALL"
    | "MLOD_UNSUPPORTED_MATERIAL"
    | "MLOD_DECODER_LOAD"
    | "MLOD_DECODER_FAILURE"
    | "MLOD_DEVICE_LIMIT"
    | "MLOD_DEVICE_RECOVERY";

export interface MeshLoDError extends Error {
    readonly code: MeshLoDErrorCode;
    readonly url?: string;
    readonly sectionType?: number;
    readonly pageId?: number;
    readonly byteOffset?: number;
    readonly expected?: string | number;
    readonly actual?: string | number;
    readonly cause?: unknown;
}

export function loadMeshLoD(
    engine: EngineContext,
    source: MeshLoDSource,
    options?: MeshLoDLoadOptions
): Promise<MeshLoDAsset>;

export function createMeshLoDInstance(
    asset: MeshLoDAsset,
    material: PbrMaterialProps,
    options?: MeshLoDInstanceOptions
): MeshLoDInstance;

export function addMeshLoDToScene(
    scene: SceneContext,
    instance: MeshLoDInstance
): void;

export function removeMeshLoDFromScene(
    scene: SceneContext,
    instance: MeshLoDInstance
): void;

export function setMeshLoDScreenSpaceError(
    asset: MeshLoDAsset,
    pixels: number
): void;

export function setMeshLoDCacheBudget(
    asset: MeshLoDAsset,
    bytes: number
): void;

export function setMeshLoDStreamingPaused(
    asset: MeshLoDAsset,
    paused: boolean
): void;

export function setMeshLoDDebugView(
    asset: MeshLoDAsset,
    view: MeshLoDDebugView
): void;

export function setMeshLoDSelectionMode(
    asset: MeshLoDAsset,
    mode: MeshLoDSelectionMode
): void;

export function getMeshLoDDiagnostics(
    asset: MeshLoDAsset
): MeshLoDDiagnostics;

export function disposeMeshLoDAsset(asset: MeshLoDAsset): void;

export function isMeshLoDError(error: unknown): error is MeshLoDError;
```

### 5.1 Public behavior rules

- `loadMeshLoD` resolves only after header, directory, required metadata, hierarchy validation, decoder readiness, pinned-page integrity checks, pinned-page CPU decode, and pinned-page GPU upload succeed. Fine pages are not awaited (`REQ-LOAD-1`).
- `cacheCapacityBytes` is the immutable arena capacity. `cacheBudgetBytes` is the mutable effective residency budget and must be `<= capacity`. Both default to 128 MiB. The demo loads with 256 MiB capacity and a 128 MiB initial budget so its slider never reallocates the arena.
- `createMeshLoDInstance` accepts only the guaranteed PBR subset. Validation occurs immediately from material state; unsupported material state throws `MLOD_UNSUPPORTED_MATERIAL`.
- `addMeshLoDToScene` is idempotent for the same scene/instance pair and registers a scene-owned batch; it does not write a scene reference into the instance.
- `removeMeshLoDFromScene` is idempotent and immediately removes the instance from future selection/submission.
- `disposeMeshLoDAsset` is idempotent. It aborts queued/in-flight work, invalidates completion generations, marks the asset disposed, and retires shared GPU resources after the last submitted frame. Scene-owned registries prune disposed assets before their next command encoding. Callers may remove instances first for immediate scene-list cleanup.
- `getMeshLoDDiagnostics` returns the stable state object referenced by `asset.diagnostics`; callers must treat it as read-only.

## 6. Internal TypeScript Architecture

Internal members live directly on their corresponding public objects with `@internal`, following `GUIDANCE.md`. Separate internal interfaces below represent genuinely separate concrete runtime records.

```typescript
interface MeshLoDAssetRuntime {
    readonly engine: EngineContext;
    readonly source: MeshLoDRangeSource;
    readonly header: MeshLoDHeader;
    readonly sections: readonly MeshLoDSectionEntry[];
    readonly groups: readonly MeshLoDGroup[];
    readonly clusters: readonly MeshLoDCluster[];
    readonly hierarchyNodes: readonly MeshLoDHierarchyNode[];
    readonly pageRecords: readonly MeshLoDPageRecord[];
    readonly groupPageRefs: Uint32Array;
    readonly scheduler: MeshLoDRequestScheduler;
    readonly cache: MeshLoDPageCache;
    readonly gpu: MeshLoDGpuState;
    readonly settings: MeshLoDEffectiveSettings;
    readonly abortController: AbortController;
    generation: number;
    frameIndex: number;
    streamingPaused: boolean;
    debugView: MeshLoDDebugView;
    selectionMode: MeshLoDSelectionMode;
}

interface MeshLoDEffectiveSettings {
    screenSpaceError: number;
    lodHysteresis: number;
    residencyHoldFrames: number;
    obsoleteRequestGraceFrames: number;
    cacheBudgetBytes: number;
    cacheCapacityBytes: number;
    cpuPageCacheBytes: number;
    maxConcurrentRequests: number;
    retryCount: number;
    retryDelaysMs: readonly number[];
}

interface MeshLoDGroup {
    readonly center: readonly [number, number, number];
    readonly radius: number;
    readonly simplifiedError: number;
    readonly depth: number;
    readonly firstCluster: number;
    readonly clusterCount: number;
    readonly firstPageRef: number;
    readonly pageRefCount: number;
    readonly terminal: boolean;
    readonly sourceTriangleCount: number;
    readonly outputTriangleCount: number;
}

interface MeshLoDCluster {
    readonly center: readonly [number, number, number];
    readonly radius: number;
    readonly error: number;
    readonly groupId: number;
    readonly refinedGroupId: number;
    readonly pageId: number;
    readonly vertexOffset: number;
    readonly indexOffset: number;
    readonly vertexCount: number;
    readonly triangleCount: number;
    readonly sourceTriangleCount: number;
}

interface MeshLoDHierarchyNode {
    readonly center: readonly [number, number, number];
    readonly radius: number;
    readonly error: number;
    readonly groupId: number;
    readonly childOffset: number;
    readonly childCount: number;
}

type MeshLoDPageState =
    | "unrequested"
    | "queued"
    | "fetching"
    | "retry-wait"
    | "received"
    | "decoding"
    | "cpu-resident"
    | "uploading"
    | "gpu-resident"
    | "terminal-failed"
    | "evicting"
    | "disposed";

interface MeshLoDPageRuntime {
    readonly id: number;
    state: MeshLoDPageState;
    generation: number;
    demandFrame: number;
    lastUsedFrame: number;
    obsoleteFrames: number;
    retryAttempt: number;
    priority: number;
    request?: AbortController;
    storedBytes?: Uint8Array;
    decodedBytes?: Uint8Array;
    arenaOffset: number;
    arenaBytes: number;
    frameRefCount: number;
    terminalError?: MeshLoDError;
}

interface MeshLoDSceneRegistry {
    readonly byAsset: Map<MeshLoDAsset, Map<PbrMaterialProps, MeshLoDSceneBatch>>;
    readonly batches: MeshLoDSceneBatch[];
    builderRegistered: boolean;
}

interface MeshLoDSceneBatch {
    readonly asset: MeshLoDAsset;
    readonly material: PbrMaterialProps;
    readonly instances: MeshLoDInstance[];
    renderable?: Renderable;
}

interface MeshLoDUpdateBatch extends DrawUpdateBatch {
    queue(job: MeshLoDSelectionJob): void;
}
```

The update batch is resolved by the material binding for the active render-target signature, not stored on the scene batch. `getMeshLoDUpdateBatch(signature)` enables the renderer's `DrawUpdateBatch` collection seam before returning a batch; without that opt-in, updates are queued but the compute passes are never flushed before the indirect draw.

`SceneContext` stores the registry lazily; the existing renderable rebuild seam handles device loss:

```typescript
interface SceneContext {
    /** @internal */ _meshLoDRegistry?: MeshLoDSceneRegistry;
}

interface Renderable {
    /** @internal */ _rebuild?: () => Renderable | null | Promise<Renderable | null>;
}
```

Only optional MeshLoD renderables carry the rebuild thunk. Device-loss recovery replays it after ordinary material groups; it contains no MeshLoD-specific branch.

## 7. Offline Tool

### 7.1 Dependency pins

CMake `FetchContent` uses immutable full commit IDs:

- meshoptimizer: `f843aae0b3070306bd2aeef43ffcf09509fee526`;
- cgltf: `85cd62382dfea638278962690cf515023f33ed00`.

The meshoptimizer pin contains `demo/clusterlod.h`, the group DAG builder, boundary locking, and `clodBuildHierarchy`. The cgltf pin is the validated 1.15 header at the selected immutable revision. These exact IDs are written to provenance and printed by `--version` (`REQ-TOOL-2`, `REQ-TOOL-6`).

### 7.2 Source layout

```text
MegameshCLI/
  CMakeLists.txt
  cmake/
    Dependencies.cmake
    CompilerWarnings.cmake
  include/
    mlod_format.h
  src/
    main.cpp
    cli.h / cli.cpp
    input.h / input.cpp
    normalize.h / normalize.cpp
    hierarchy.h / hierarchy.cpp
    page_packer.h / page_packer.cpp
    mlod_writer.h / mlod_writer.cpp
    validator.h / validator.cpp
    statistics.h / statistics.cpp
    crc32c.h / crc32c.cpp
    sha256.h / sha256.cpp
  tests/
    CMakeLists.txt
    fixtures/...
    tool_tests.cpp
    format_tests.cpp
  assets/
    harvard-yenching_institute_statue.glb
```

`CLUSTERLOD_IMPLEMENTATION` is defined in exactly one translation unit. cgltf implementation macros are likewise confined to `input.cpp`.

### 7.3 CLI

```text
mesh-lod-tool
  --input <path>                    required
  --output <path>                   required
  [--mesh <zero-based-index>]
  [--primitive <zero-based-index>]  requires --mesh
  [--meshlet-max-vertices <4..256>] default 64
  [--meshlet-min-triangles <4..256>] default 40
  [--meshlet-max-triangles <4..256>] default 124
  [--partition-size <2..32>]        default 8
  [--simplify-ratio <0..1>]         default 0.5
  [--simplify-threshold <0..1>]     default 0.85
  [--page-min-kib <64..256>]        default 64
  [--page-target-kib <64..256>]     default 128
  [--page-max-kib <64..256>]        default 256
  [--stats-json <path>]
  [--validate-only]
  [--help]
  [--version]
```

From a MegameshCLI checkout, documented Windows build and invocation forms are:

```text
# Single-config (Ninja)
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build build
build\mesh-lod-tool.exe --input assets\harvard-yenching_institute_statue.glb --output harvard-yenching_institute_statue.mlod

# Multi-config (Visual Studio 2022)
cmake -S . -B build -G "Visual Studio 17 2022" -A x64
cmake --build build --config Release
build\Release\mesh-lod-tool.exe --input assets\harvard-yenching_institute_statue.glb --output harvard-yenching_institute_statue.mlod
```

Constraints:

- `pageMin <= pageTarget <= pageMax`;
- v1 requires page values to be multiples of 64 KiB;
- hierarchy node width is fixed at eight and is not a CLI option;
- no prompt, timestamp, random seed, locale-sensitive formatting, current directory, or absolute input path enters the output;
- numeric parsing uses the C locale and rejects NaN/infinity.

`--version` prints machine-readable `key=value` lines for tool version, format version, both dependency revisions, and compiler target. `--stats-json` uses canonical UTF-8 JSON with lexicographically fixed keys and no timestamp.

### 7.4 Primitive selection and outputs

- With `--mesh` and `--primitive`, exactly that primitive is converted.
- With only `--mesh`, every primitive in that mesh is converted.
- With neither, every supported primitive in every mesh is converted.
- One selected primitive writes the exact `--output`.
- More than one selected primitive inserts `.meshNNN.primNNN` before `.mlod`, with three-digit zero-padded indices and source-order emission.
- All outputs are built and validated before publishing. Each final rename is atomic, but a rename failure after an earlier file was published can leave partial multi-primitive output; callers should inspect the exit code and output set.

For the repository statue, one invocation emits three containers because the GLB contains three meshes with one primitive each.

### 7.5 Normalization and hierarchy generation

1. Parse with cgltf and call cgltf validation before reading accessors.
2. Reject non-`TRIANGLES`, skins, morph targets, alpha blend/mask, transmission, unsupported compression extensions, sparse/unsupported component layouts, invalid strides, and non-finite values.
3. Materialize indexed geometry; create sequential indices for unindexed input.
4. Convert positions to `float32x3`, normals to `float32x3`, and UV0 to `float32x2`.
5. Generate angle-weighted finite normals when absent.
6. Preserve UV seams and other group boundaries with simplification protection bits.
7. Run `clodBuild` with the configured meshlet/group settings.
8. Record each callback's group, emitted clusters, each cluster's `refined` group ID, bounds, depth, and original vertex indices.
9. Run `clodLocalIndices` for each cluster.
10. Run `clodBuildHierarchy(..., node_width = 8, level_count)` to produce one 8-wide spatial tree per DAG depth. The first `level_count` nodes are the roots.
11. Mark terminal groups whose simplification error is `FLT_MAX`; serialize finite `FLT_MAX` plus the terminal flag.
12. Pack groups into pages, preferring all clusters of one group in as few pages as possible. A group may span pages only when its decoded geometry cannot fit one page.
13. Pin every page referenced by terminal groups. Those groups form the complete coarsest representation.

Boundary locking from `clusterlod.h` is mandatory. It is the offline basis of the crack-free contract; runtime atomic group residency completes that contract (`REQ-GEO-7`).

### 7.6 Deterministic encoding

Each cluster's unique vertices are emitted in `clodLocalIndices` order:

- vertex stride: 24 bytes;
- bytes 0–11: position `float32x3`;
- bytes 12–15: octahedral normal, two signed normalized 16-bit components;
- bytes 16–19: UV0, two IEEE 754 binary16 values;
- bytes 20–23: zero, reserved for a future optional attribute.

Local triangle indices are unsigned 16-bit. Vertex data is encoded using meshoptimizer's glTF-compatible `ATTRIBUTES/NONE` stream. Triangle indices are encoded using its glTF-compatible `TRIANGLES/NONE` stream. Page order, group order, cluster order, stream order, padding, and JSON provenance key order are fixed.

### 7.7 Tool exit codes

| Exit | Meaning |
| --- | --- |
| 0 | Success |
| 2 | CLI argument error |
| 3 | Input/output I/O error |
| 4 | Malformed glTF/GLB/accessor |
| 5 | Unsupported source feature/layout/material |
| 6 | Hierarchy generation failure |
| 7 | Output validation/integrity failure |
| 8 | Final write/rename failure |

Every diagnostic includes the input path and, when known, mesh index, primitive index, accessor index, extension name, or output byte range (`REQ-TOOL-9`).

## 8. `.mlod` Binary Contract

### 8.1 Global rules

- Format version: `1.0`.
- Byte order: little-endian only.
- Header size: 256 bytes.
- Section-directory entry size: 64 bytes.
- Required metadata sections begin on 64-byte boundaries.
- Every page begins on a 64 KiB boundary.
- Reserved fields and padding must be zero in v1.
- All offsets and lengths are absolute file-byte values unless explicitly described as element indices.
- Integer addition/multiplication is overflow-checked before bounds checks.
- Ranges may touch but may not overlap.
- `bootstrapBytes` ends after all metadata and all pinned pages.
- Unknown required sections fail. Unknown optional sections are skipped after validating their range and CRC.

### 8.2 Header: 256 bytes

| Offset | Size | Field |
| ---: | ---: | --- |
| 0 | 8 | ASCII `MESHLOD\0` |
| 8 | 2 | format major = 1 |
| 10 | 2 | format minor = 0 |
| 12 | 2 | minimum reader major = 1 |
| 14 | 2 | minimum reader minor = 0 |
| 16 | 4 | endian tag `0x01020304` |
| 20 | 4 | header bytes = 256 |
| 24 | 4 | container flags |
| 28 | 4 | section count |
| 32 | 8 | section-directory offset |
| 40 | 8 | section-directory bytes |
| 48 | 8 | bootstrap bytes |
| 56 | 8 | total file bytes |
| 64 | 32 | SHA-256 source-bundle digest |
| 96 | 32 | SHA-256 build fingerprint |
| 128 | 16 | deterministic hierarchy ID: first 16 bytes of SHA-256(source hash + mesh index + primitive index + canonical options) |
| 144 | 4 | source mesh index |
| 148 | 4 | source primitive index |
| 152 | 8 | source triangle count |
| 160 | 8 | total triangles across all emitted hierarchy clusters |
| 168 | 4 | cluster count |
| 172 | 4 | group count |
| 176 | 4 | hierarchy-node count |
| 180 | 4 | page count |
| 184 | 4 | pinned-page count |
| 188 | 4 | hierarchy level count |
| 192 | 4 | attribute mask: bit 0 position, bit 1 normal, bit 2 UV0 |
| 196 | 4 | decoded vertex stride = 24 |
| 200 | 12 | primitive-local bounds minimum `float32x3` |
| 212 | 12 | primitive-local bounds maximum `float32x3` |
| 224 | 4 | maximum finite nonterminal simplification error |
| 228 | 4 | header CRC32C, calculated with this field zero |
| 232 | 4 | section-directory CRC32C |
| 236 | 20 | zero reserved |

The source-bundle digest hashes the glTF/GLB bytes plus every external geometry buffer used by the selected primitive, in normalized URI/index order with length prefixes. Embedded GLB data is already covered by the GLB bytes. Images do not affect geometry output and are excluded. The build fingerprint hashes the tool version, format version, both dependency revisions, target architecture, and canonical conversion options. Neither digest contains a timestamp or host path.

### 8.3 Section-directory entry: 64 bytes

| Offset | Size | Field |
| ---: | ---: | --- |
| 0 | 4 | section type |
| 4 | 4 | flags: bit 0 required, bit 1 optional, bit 2 per-item CRC, bit 3 page data |
| 8 | 8 | absolute offset |
| 16 | 8 | stored bytes |
| 24 | 8 | decoded bytes; equal to stored bytes for metadata |
| 32 | 4 | element count |
| 36 | 4 | element stride; zero for byte blobs |
| 40 | 4 | CRC32C; zero only for `PAGE_DATA`, whose pages have individual CRCs |
| 44 | 4 | required alignment |
| 48 | 16 | zero reserved |

Required section types:

| Value | Name | Shape |
| ---: | --- | --- |
| 1 | `PROVENANCE_JSON` | canonical UTF-8 JSON bytes |
| 2 | `GROUPS` | 64-byte records |
| 3 | `CLUSTERS` | 64-byte records |
| 4 | `HIERARCHY_NODES` | 32-byte records |
| 5 | `GROUP_PAGE_REFS` | little-endian `u32` page IDs |
| 6 | `PAGE_TABLE` | 64-byte records |
| 7 | `PAGE_DATA` | page ranges, individually checksummed |

Directory entries are sorted by section type. Required sections appear exactly once.

### 8.4 Group record: 64 bytes

| Offset | Size | Field |
| ---: | ---: | --- |
| 0 | 16 | simplified sphere center/radius `float32x4` |
| 16 | 4 | simplified error; `FLT_MAX` only for terminal groups |
| 20 | 4 | DAG depth |
| 24 | 4 | first cluster index |
| 28 | 4 | cluster count |
| 32 | 4 | first `GROUP_PAGE_REFS` element |
| 36 | 2 | page-ref count |
| 38 | 2 | flags: bit 0 terminal, bit 1 pinned/coarse |
| 40 | 4 | source triangles represented by the group |
| 44 | 4 | triangles in the group's emitted clusters |
| 48 | 16 | zero reserved |

Groups and their clusters are contiguous and source ordered. Every cluster belongs to exactly one group.

### 8.5 Cluster record: 64 bytes

| Offset | Size | Field |
| ---: | ---: | --- |
| 0 | 16 | cluster sphere center/radius `float32x4` |
| 16 | 4 | accumulated finite cluster error |
| 20 | 4 | owning group ID |
| 24 | 4 | refined group ID as signed `i32`; `-1` means original finest geometry |
| 28 | 4 | page ID |
| 32 | 4 | first vertex in decoded page |
| 36 | 4 | first local index in decoded page, measured in `u16` elements |
| 40 | 2 | vertex count |
| 42 | 2 | triangle count |
| 44 | 4 | source triangles represented by this cluster |
| 48 | 4 | flags, zero in v1 |
| 52 | 4 | optional packed normal cone, zero in v1 selection |
| 56 | 4 | optional cone cutoff, zero in v1 selection |
| 60 | 4 | zero reserved |

The group DAG is implicit:

- clusters contiguous in group `G` are the geometry rendered for `G`;
- `cluster.refinedGroupId = R` means cluster geometry was produced by simplifying the finer group `R`;
- all clusters with the same nonnegative `refinedGroupId` are suppressed or shown together because residency is decided for the complete referenced group.

### 8.6 Eight-wide hierarchy node: 32 bytes

This is the exact persisted form of the approved per-level hierarchy forest.

| Offset | Size | Field |
| ---: | ---: | --- |
| 0 | 16 | node sphere center/radius `float32x4` |
| 16 | 4 | worst-case error in subtree |
| 20 | 4 | group ID as signed `i32`; `-1` for internal node |
| 24 | 4 | first child node |
| 28 | 4 | child count, 0 for leaf, otherwise 1–8 |

The first `levelCount` nodes are roots for DAG depths `0..levelCount-1`. Internal child ranges are contiguous.

### 8.7 Page-table record: 64 bytes

| Offset | Size | Field |
| ---: | ---: | --- |
| 0 | 8 | absolute page-file offset |
| 8 | 4 | stored bytes, multiple of 64 KiB, range 64–256 KiB |
| 12 | 4 | meaningful page bytes before zero padding |
| 16 | 4 | decoded bytes, multiple of 64 KiB, range 64–256 KiB |
| 20 | 4 | CRC32C over all stored bytes, including zero padding |
| 24 | 4 | decoded vertex count |
| 28 | 4 | decoded local-index count |
| 32 | 4 | decoded vertex-byte offset |
| 36 | 4 | decoded index-byte offset |
| 40 | 4 | first cluster index |
| 44 | 4 | cluster count |
| 48 | 4 | flags: bit 0 pinned, bit 1 coarse |
| 52 | 2 | minimum group depth represented |
| 54 | 2 | maximum group depth represented |
| 56 | 8 | zero reserved |

### 8.8 Stored page header: 64 bytes

| Offset | Size | Field |
| ---: | ---: | --- |
| 0 | 4 | ASCII `MLPG` |
| 4 | 2 | page major = 1 |
| 6 | 2 | header bytes = 64 |
| 8 | 4 | page ID |
| 12 | 4 | flags |
| 16 | 4 | vertex count |
| 20 | 4 | local-index count |
| 24 | 4 | encoded vertex-stream offset |
| 28 | 4 | encoded vertex-stream bytes |
| 32 | 4 | decoded vertex-stream bytes |
| 36 | 4 | encoded index-stream offset |
| 40 | 4 | encoded index-stream bytes |
| 44 | 4 | decoded index-stream bytes |
| 48 | 4 | vertex stride = 24 |
| 52 | 4 | index stride = 2 |
| 56 | 8 | zero reserved |

Offsets are page-relative and 4-byte aligned. Streams may not overlap. Decoded layout is vertex bytes followed by 4-byte-aligned index bytes and zero padding to the page's decoded allocation.

### 8.9 Compatibility and integrity

- Major mismatch: always reject.
- Reader version lower than `minReader`: reject.
- Newer minor version: allowed only if all unknown sections are optional and all known record strides are unchanged.
- Header CRC is checked before trusting offsets.
- Directory CRC is checked before reading entries.
- Every required metadata section CRC is checked before parsing records.
- Every page CRC is checked before page-header or codec interpretation.
- A full HTTP 200 response is retained only after its length equals `fileBytes` and every consumed range passes the same checks.
- CRC32C is integrity/error detection, not an authenticity guarantee. Applications requiring authenticity must enforce it in their custom fetch/cache layer.

## 9. Range Loading

### 9.1 URL bootstrap sequence

```text
GET Range: bytes=0-65535
  |
  +-- 206 exact range:
  |      validate header + directory location
  |      if bootstrapBytes > 65536:
  |          GET Range: bytes=65536-(bootstrapBytes-1)
  |
  +-- 200 full body:
         retain body as complete-file source
         require identity encoding and exact fileBytes
```

The first 64 KiB must contain the complete 256-byte header and section directory. Metadata may extend beyond it but must end before the first pinned page. Pinned pages are contiguous directly after metadata, so at most one additional bootstrap range is required.

### 9.2 Response validation

For a requested inclusive range `[start,end]`:

- `206` requires `Content-Range: bytes start-end/total`;
- response body length must equal `end-start+1`;
- `total` must match header `fileBytes` once known;
- `Content-Encoding` must be absent or `identity`;
- `200` is accepted only when the body is the complete file;
- `304`, multipart ranges, mismatched ranges, transformed encodings, redirects that lose authorization policy, and all other statuses fail explicitly;
- custom fetch functions must return a standards-compatible `Response`.

ArrayBuffer/Blob sources are treated as complete-file sources and never invoke fetch.

### 9.3 Fine page requests

Fine pages are requested individually from page-table ranges. Adjacent pages are not coalesced in v1; this keeps cancellation, retry, accounting, integrity, and deduplication page-granular. Multiple meshlets per page avoid one-resource-per-meshlet behavior.

## 10. Selection Model

### 10.1 Projection equation

For a group or hierarchy-node sphere in primitive-local space:

```text
worldCenter = worldMatrix * localCenter
worldScale  = max(length(worldMatrix.column0.xyz),
                  length(worldMatrix.column1.xyz),
                  length(worldMatrix.column2.xyz))
worldRadius = localRadius * worldScale
worldError  = localError  * worldScale
surfaceDistance = max(length(cameraPosition - worldCenter) - worldRadius,
                      cameraNear)
pixelScale = targetHeight / (2 * tan(verticalFov / 2))
screenErrorPx = worldError * pixelScale / surfaceDistance
```

For an orthographic camera:

```text
screenErrorPx = worldError * worldScale * targetHeight / orthographicHeight
```

Calculations use IEEE float32 semantics in both CPU fixtures and WGSL. CPU code explicitly rounds intermediate values with `Math.fround` where a comparison can change the cut.

### 10.2 Hysteresis

For threshold `T` and hysteresis fraction `h`:

```text
refine boundary  = T * (1 + h)
coarsen boundary = T * (1 - h)
```

Each group/instance retains one `wasFineRequired` bit:

- if false, `fineRequired = errorPx > refineBoundary`;
- if true, `fineRequired = errorPx >= coarsenBoundary`.

Default `T=2.0`, `h=0.15`. Equality is intentionally asymmetric to avoid a one-frame toggle at exact boundaries.

### 10.3 Crack-free group-DAG cut

Define:

```text
groupVisible(G)  = its hierarchy leaf survives frustum traversal
groupResident(G) = every page in G.pageRefs is GPU-resident
fineRequired(G)  = hysteretic screen-space decision
```

Cluster `C`, owned by group `G`, is selected iff:

```text
groupResident(G)
AND fineRequired(G)
AND (
    C.refinedGroupId == -1
    OR NOT fineRequired(C.refinedGroupId)
    OR NOT groupResident(C.refinedGroupId)
)
```

Terminal groups always have `fineRequired=true` because their serialized error is finite `FLT_MAX`. Their pages are pinned, so at least one complete coarse cut always exists.

This rule is the runtime equivalent of `clusterlod.h`'s group-DAG selection rule with one added residency term. If a finer group is desired but incomplete, every coarser cluster that references it remains selected. No subset of the finer group becomes visible.

### 10.4 Frustum culling

The 8-wide hierarchy forest is traversed separately for each DAG level and instance:

1. seed the work queue with the `levelCount` roots;
2. transform the node sphere by the instance world transform;
3. reject only if the sphere is strictly outside any normalized frustum plane;
4. enqueue 1–8 children for internal nodes;
5. mark the leaf group visible;
6. expand every selected cluster in a visible group without a second cluster-sphere test.

The conservative group/node bounds are the single visibility authority. Keeping each selected group atomic avoids view-dependent holes when tighter cluster bounds disagree with the conservative group coverage. Boundary intersection is visible.

### 10.5 CPU oracle

The CPU oracle:

- uses the exact equations and comparison operators above;
- performs deterministic depth/root traversal;
- evaluates groups in ascending group ID;
- evaluates clusters in ascending cluster ID;
- returns selected visible cluster IDs in ascending order;
- returns desired missing pages with deterministic priority/tie ordering;
- accepts explicit residency and prior-hysteresis bitsets.

The oracle is an internal module exported only from an internal testing path. It is not part of the package's public declaration surface.

## 11. Streaming Scheduler and Cache

### 11.1 Page demand priority

For each visible desired finer group with missing pages:

```text
projectedRadiusPx = worldRadius * pixelScale / surfaceDistance
projectedAreaPx   = min(pi * projectedRadiusPx^2, targetWidth * targetHeight)
qualityPressure   = max(0, errorPx / threshold - 1)
groupBenefit      = projectedAreaPx * qualityPressure
pageShare         = groupBenefit / missingPageCountForGroup
pagePriority      = sum(pageShare over demanding groups) / pageStoredBytes
```

Priority is represented as a saturated unsigned fixed-point value for GPU atomic accumulation. CPU scheduling sorts descending priority, then ascending page ID. Invisible groups contribute zero.

### 11.2 Scheduler invariants

- A page ID has at most one queued or in-flight request.
- Every demand records the current asset generation and demand frame.
- A queued page with no demand for two consecutive frames is removed.
- An in-flight page with no demand for two consecutive frames is aborted.
- A completion whose generation or request token is stale is discarded before decode/residency mutation.
- Streaming pause prevents new fine requests and retries; it does not abort bootstrap, evict resident geometry, or remove coarse fallback.
- Initial attempt plus two retries gives at most three transfers.
- Retry delays are 250 ms and 1,000 ms. Abort, 4xx other than 408/429, integrity errors, unsupported versions, and protocol errors are permanent. Network failures, 408, 429, and 5xx are retryable.

### 11.3 Page state machine

```text
unrequested
    |
    v
 queued --obsolete--> unrequested
    |
    v
 fetching --abort/stale--> unrequested
    | \
    |  \ retryable
    |   v
    | retry-wait --> queued
    |
    v
 received -> decoding -> cpu-resident -> uploading -> gpu-resident
                    \             \             |
                     \ failure     \ stale      | no use for hold period
                      v             v            v
                 terminal-failed  unrequested  evicting -> unrequested
```

Pinned pages enter through bootstrap and may reach only `cpu-resident`, `uploading`, `gpu-resident`, or `disposed`. A pinned failure fails initialization.

### 11.4 GPU cache

- One storage arena is allocated at immutable `cacheCapacityBytes`, rounded down to 64 KiB.
- The effective `cacheBudgetBytes` limits resident 64 KiB blocks; changing the budget does not replace the arena.
- Pinned pages are allocated first at the start of the arena.
- Every decoded page allocation is 64–256 KiB in 64 KiB blocks.
- First-fit contiguous-block allocation is deterministic.
- Before upload, enough unpinned victims are evicted to keep committed blocks within the effective budget.
- If fragmentation prevents a contiguous run, additional eligible pages are evicted; pinned pages are never relocated.
- The temporary CPU decoded page and `queue.writeBuffer` source are the only upload staging. No second GPU page copy is allocated, so the implementation normally remains strictly within budget; the requirement's one-upload exception remains available for future mapped staging.
- Victims must be unpinned, not fetching/decoding/uploading, have `frameRefCount=0`, and be older than the 120-frame residency hold.
- LRU age is the primary eviction key; lower current priority and higher page ID break ties.

The minimum viable budget is the total rounded allocation of all pinned pages. Loading fails with `MLOD_BUDGET_TOO_SMALL` before scene registration if either capacity or effective budget is smaller.

### 11.5 CPU page cache

Encoded page bytes are retained up to `cpuPageCacheBytes`, default 64 MiB. Pinned encoded pages are always retained and count toward this budget. Unpinned encoded pages use the same last-used ordering. Decoded bytes are released after upload. Device recovery decodes retained pinned pages; missing pinned bytes fail recovery explicitly. Fine pages stream again on demand.

## 12. GPU Data Layout and Algorithms

### 12.1 Persistent buffers

| Buffer | Layout | Usage |
| --- | --- | --- |
| hierarchy nodes | 8 × `u32` words per 32-byte node | storage read |
| groups | 16 × `u32` words per 64-byte group | storage read |
| clusters | 16 × `u32` words per 64-byte cluster | storage read |
| group page refs | packed `u32` page IDs | storage read |
| page state | 8 × `u32` words per page | storage read/write |
| geometry arena | raw `u32` words | storage read, copy destination |
| instances | 32 × `u32` words / 128 bytes | storage read |
| prior group state | one `u32` bitset per instance/group | storage read/write |

Page-state record, 32 bytes:

| Word | Meaning |
| ---: | --- |
| 0 | flags: resident, pinned, failed, uploading |
| 1 | arena base byte offset |
| 2 | vertex byte offset within arena |
| 3 | index byte offset within arena |
| 4 | vertex count |
| 5 | index count |
| 6 | residency generation |
| 7 | reserved |

Instance record, 128 bytes:

| Bytes | Meaning |
| ---: | --- |
| 0–63 | world matrix |
| 64–111 | inverse-transpose normal matrix as three padded `vec4<f32>` rows |
| 112–115 | maximum world scale |
| 116–119 | visibility flags |
| 120–123 | stable instance ID |
| 124–127 | zero |

### 12.2 Transient per-batch buffers

| Buffer | Record | Purpose |
| --- | --- | --- |
| hierarchy work queue | node ID + instance ID, 8 bytes | 8-wide traversal |
| visible group bitset | one bit per group/instance | group culling result |
| selected cluster list | cluster ID + instance ID, 8 bytes | normalized selection output |
| page demand words | priority and demanded generation per page | CPU streaming readback |
| draw vertices | 16-byte record | one expanded raster vertex |
| indirect draw args | 16 bytes | `drawIndirect` |
| compute indirect args | 12 bytes | selected-cluster expansion dispatch |
| diagnostics counters | `u32` counters and max-error fixed point | async readback |

Draw-vertex record:

| Word | Meaning |
| ---: | --- |
| 0 | absolute vertex word offset in geometry arena |
| 1 | cluster ID |
| 2 | instance ID |
| 3 | debug/group flags |

Draw indirect args:

| Offset | Field |
| ---: | --- |
| 0 | `vertexCount` |
| 4 | `instanceCount = 1` |
| 8 | `firstVertex = 0` |
| 12 | `firstInstance = 0` |

### 12.3 Compute sequence

The `MeshLoDUpdateBatch` submits one compute pass containing ordered dispatches:

1. **Reset:** zero transient counters, draw args, demand accumulators, and visible bitsets.
2. **Instance upload:** CPU writes changed world/normal matrices and instance flags, version-gated.
3. **Hierarchy traversal:** persistent work queue traverses the 8-wide per-level forest and marks visible groups.
4. **Group evaluation:** one invocation per group/instance computes screen error, applies prior-state hysteresis, checks all group pages, and updates the prior-state bit. Only hierarchy-visible groups atomically accumulate missing-page priorities and visible diagnostics.
5. **Cluster selection:** one invocation per cluster/instance evaluates the exact group-DAG/residency expression for hierarchy-visible groups. Selected pairs append to `selected cluster list`; triangle and error diagnostics accumulate.
6. **Prepare expansion dispatch:** selected count becomes `dispatchWorkgroupsIndirect` X count.
7. **Expand selected clusters:** one workgroup per selected cluster. Lane zero atomically reserves `triangleCount * 3` draw vertices; all lanes decode packed `u16` local indices, convert them to absolute geometry-arena word offsets, and write 16-byte draw-vertex records.
8. **Finalize:** publish `drawIndirect.vertexCount`, page-demand readback copy, selected-ID readback when testing/debugging, and diagnostics readback.

Workgroup size is 64. All transient capacities are checked before writes. Overflow sets an error flag; the frame renders the last valid coarse result and the asset transitions to failed with `MLOD_DEVICE_LIMIT` after readback rather than writing out of bounds.

### 12.4 WGSL vertex processing

The PBR-owned MeshLoD vertex variant uses `@builtin(vertex_index)`:

1. read the 16-byte draw-vertex record;
2. read six 32-bit words from the raw geometry arena;
3. bitcast words 0–2 to position;
4. unpack the octahedral signed-normal word and reconstruct the unit normal;
5. unpack the UV binary16 pair;
6. fetch the instance world and normal matrices;
7. transform position and normal;
8. produce the same world position, normal, UV0, clip position, and PBR varyings used by the guaranteed ordinary PBR subset;
9. derive debug color inputs from cluster/group/page IDs without changing selection.

The fragment stage remains material-owned PBR/unlit logic. Debug modes replace only the final material color through a material-owned fragment selection; they do not mutate hierarchy, residency, or request state.

## 13. Material-Owned Rendering

### 13.1 Supported batch key

A compatible render batch is keyed by:

```text
exact MeshLoDAsset identity
+ exact PbrMaterialProps object identity
+ render-target signature
+ MeshLoD debug-view pipeline key
```

All visible instances sharing the key are selected and expanded into one draw stream and one `drawIndirect`. Different materials or hierarchies remain separate batches.

### 13.2 PBR integration

The MeshLoD runtime dynamically imports `material/pbr/pbr-mesh-lod-renderable.ts`. That material module owns:

- supported-material validation;
- material feature detection;
- MeshLoD vertex WGSL composition;
- PBR/unlit fragment composition;
- pipeline descriptors;
- bind-group layouts;
- bind-group creation;
- material UBO packing/version updates;
- fallback textures;
- debug output variants;
- the `Renderable` and `DrawBinding`.

The generic renderer sees only a normal opaque `Renderable`. It never imports MeshLoD WGSL and never branches on MeshLoD.

### 13.3 Bind groups

Group 0 remains the existing scene bind group. Group 1 is a material-owned fixed v1 MeshLoD layout:

| Binding | Resource |
| ---: | --- |
| 0 | material UBO |
| 1–2 | base-color texture and sampler |
| 3–4 | normal texture and sampler |
| 5–6 | ORM/occlusion texture and sampler |
| 7–8 | emissive texture and sampler |
| 9 | geometry arena, read-only storage |
| 10 | draw-vertex buffer, read-only storage |
| 11 | instance buffer, read-only storage |
| 12 | cluster metadata, read-only storage |
| 13 | group metadata, read-only storage |
| 14 | page state, read-only storage |
| 15 | debug UBO |

Unused guaranteed textures bind existing 1×1 fallbacks. Alpha output is always opaque in v1. Primitive topology is triangle list, front face is CCW, culling follows `doubleSided`, depth uses the target signature's reverse-depth convention, and multisampling follows the target signature.

### 13.4 Draw behavior

The draw closure:

1. skips disposed/failed batches;
2. binds group 1;
3. calls `pass.drawIndirect(indirectArgs, 0)`;
4. returns one draw call when `vertexCount > 0`, otherwise zero.

No vertex or index buffer is bound. No CPU loop issues per-meshlet draws (`REQ-RENDER-2`).

## 14. Resource Replacement, Frames, and Device Loss

### 14.1 Frame references

When a page contributes any selected cluster, its `frameRefCount` is incremented for the command buffer being built. After submission, a retirement callback decrements those references. Eviction requires zero. Buffer growth/replacement follows make-before-break:

1. allocate replacement;
2. populate replacement;
3. switch future bindings;
4. submit a frame using the replacement;
5. retire the old resource through `retireGpuResources`.

The fixed geometry arena avoids normal arena replacement. Selection/draw buffers may grow to a validated maximum; their old versions follow this sequence.

### 14.2 Disposal

Asset disposal:

- changes state to `disposed`;
- increments generation;
- aborts the asset controller and all page controllers;
- clears queued/retry work;
- prevents stale completions from committing;
- marks scene batches non-drawable immediately;
- retires buffers after frame safety;
- releases retained CPU page bytes and metadata after scene registries have dropped references;
- is safe when repeated.

Scene disposal owns registry cleanup and removes its instances/batches without disposing an asset still used by another scene.

### 14.3 Device loss

```text
device lost
  |
  +-- stop submission
  +-- asset.state = recovering
  +-- invalidate device-keyed pipeline/BG caches
  +-- create new metadata, page-state, arena, transient buffers
  +-- decode/upload retained pinned pages
  +-- rebuild PBR-owned MeshLoD renderables
  +-- replay each renderable's _rebuild thunk
  +-- rebuild frame graph
  +-- state = ready; resume engine with coarse representation
  +-- stream fine pages on demand from their new unrequested state
```

Pinned coarse recovery is part of successful scene recovery. If it cannot be restored, recovery reports `MLOD_DEVICE_RECOVERY` and does not claim success. Fine recovery failure is terminal per page and leaves coarse fallback.

Old resources on a genuinely lost device are invalid and need no queue retirement. Normal device-preserving rebuilds still use make-before-break.

## 15. Demo Architecture

### 15.1 Files and entry

```text
lab/lite/
  demo-mesh-lod.html
  src/demos/
    mesh-lod.ts
    mesh-lod-controls.ts
    mesh-lod-diagnostics.ts
    mesh-lod-network-simulator.ts
    mesh-lod-camera-path.ts
  public/
    mesh-lod/
      harvard-yenching_institute_statue.mesh000.prim000.mlod
      harvard-yenching_institute_statue.mesh001.prim000.mlod
      harvard-yenching_institute_statue.mesh002.prim000.mlod
    thumbnails/demo-mesh-lod.jpg
```

`demos-config.json` gains a `mesh-lod` entry. `scripts/bundle-demos-core.ts` copies the `.mlod` assets to the standalone output. The page uses the existing production-bundled demo convention, loading overlay, `data-ready`/`data-error`, and JPG thumbnail.

### 15.2 Material and transform source

The initial demo loads the repository statue GLB to obtain its three existing PBR/unlit materials and node transforms, creates three MeshLoD instances from the generated primitive containers, and hides/removes the ordinary source meshes before scene registration. This is a demo asset-preparation compromise, not a MeshLoD runtime dependency: application code may supply any supported `PbrMaterialProps` and transform without loading glTF geometry. The MeshLoD loader, selector, scheduler, cache, and renderer remain the public production path.

Future asset packaging may separate textures/material metadata, but no new manifest or material container is introduced in v1.

### 15.3 Controls

- screen-space error: 0.5–16 px, default 2 px;
- effective cache budget: 32–256 MiB, default 128 MiB;
- streaming pause;
- simulated bandwidth: unlimited or 0.5–64 MiB/s, default 8 MiB/s;
- simulated latency: 0–2,000 ms, default 100 ms;
- debug-view selector with material, meshlet ID, and LOD depth.

The single shipped model is identified as text rather than a disabled selector. A compact viewer panel groups LOD, streaming, and display settings; a separate telemetry panel groups geometry, streaming, and GPU metrics. The network simulator is a custom fetch wrapper supplied through `MeshLoDRequestOptions.fetch`. It delays and throttles only `.mlod` range responses and does not inject fault scenarios.

### 15.4 Diagnostics

The overlay displays:

- source triangles;
- rendered triangles;
- selected meshlets;
- visible groups;
- hierarchy depth;
- maximum selected SSE;
- maximum unmet SSE/fallback groups;
- requested/queued/in-flight/resident/failed pages;
- downloaded MiB;
- GPU cache used/budget MiB;
- CPU page cache MiB;
- task GPU time status and duration.

GPU timing uses Babylon Lite's task timing API. Unsupported devices show `GPU timing: unsupported`; zero is never presented as a valid result.

### 15.5 Debug views

| View | Interpretation |
| --- | --- |
| meshlet ID | stable hash color of cluster ID |
| LOD depth | palette indexed by owning group depth |

A visible legend explains the active palette. Additional views supported by the runtime API are not exposed in this viewer.

### 15.6 Deterministic camera path

The optional `?pathTime=<seconds>` URL parameter samples a fixed path time and freezes the camera for repeatable capture; the normal viewer uses manual orbit and zoom without path controls:

- duration 20 seconds, looped;
- segment 0–10 s: azimuth `-0.8π` to `0.2π`, elevation 25° to 50°, radius 2.4 to 0.75 times the statue bounding-sphere radius;
- segment 10–20 s: azimuth `0.2π` to `1.2π`, elevation 50° to 25°, radius 0.75 to 2.4;
- cubic smoothstep interpolation at segment ends;
- target is the transformed aggregate statue-bounds center.

## 16. Error Handling

### 16.1 Converter failures

No unsupported condition is downgraded. The tool identifies unsupported primitive mode, skin/morph, alpha/transmission, compression extension, accessor layout, missing required UV, malformed indices, hierarchy invariant, page overflow, CRC mismatch, or file I/O location.

### 16.2 Runtime failures

Bootstrap errors reject `loadMeshLoD` and no asset is registered. Fine-page errors update page diagnostics and continue from a resident ancestor. Every runtime error carries a stable code and contextual fields.

Important mappings:

| Condition | Code |
| --- | --- |
| invalid threshold/budget/concurrency | `MLOD_INVALID_OPTION` |
| unsupported/short response | `MLOD_HTTP_STATUS` / `MLOD_HTTP_RANGE` |
| transformed response | `MLOD_HTTP_ENCODING` |
| file shorter than declared | `MLOD_TRUNCATED` |
| bad header/directory/section/page CRC | corresponding integrity code |
| invalid offsets, overlap, count, reference | `MLOD_INVALID_LAYOUT` |
| invalid DAG, terminal/coarse coverage, hierarchy forest | `MLOD_INVALID_HIERARCHY` |
| pinned pages exceed budget | `MLOD_BUDGET_TOO_SMALL` |
| unsupported PBR state | `MLOD_UNSUPPORTED_MATERIAL` |
| external decoder script failure | `MLOD_DECODER_LOAD` |
| codec failure | `MLOD_DECODER_FAILURE` |
| buffer/workgroup/capacity limit | `MLOD_DEVICE_LIMIT` |
| coarse device recovery failure | `MLOD_DEVICE_RECOVERY` |

## 17. Alternatives Considered

### One file per meshlet

Rejected: excessive resource count, poor scheduling overhead, and contrary to `REQ-FMT-1`/`REQ-STREAM-1`. Pages contain multiple meshlets.

### One file containing all glTF primitives

Rejected for v1: it weakens the primitive/material boundary and complicates independent material batches. Deterministic sibling containers preserve one hierarchy per primitive.

### Multi-pack output

Deferred: a single range-addressable container satisfies current requirements. Measurements must justify additional pack semantics.

### Renderer-owned MeshLoD shader

Rejected: violates material ownership and would duplicate PBR behavior.

### CPU-submitted draw per meshlet

Rejected: violates `REQ-RENDER-2`. A storage-fetch vertex variant plus one expanded indirect draw is used.

### Bind one GPU buffer per page

Rejected: WebGPU bind-group limits and dynamic page residency make this unsuitable for one draw. A fixed raw storage arena gives stable bindings.

### Compact or replace the geometry arena

Rejected for v1 steady state: it creates budget spikes and frame-safety complexity. Fixed 64 KiB blocks, pinned-prefix placement, and eviction handle fragmentation.

### Cryptographic hash per page

Rejected for v1: CRC32C is sufficient for transport/storage corruption and cheap for every range. Authenticity belongs to HTTPS or the custom fetch/cache layer. SHA-256 remains for deterministic provenance.

### Dedicated external-cache API

Rejected as YAGNI: a custom fetch function already composes with application caches.

## 18. Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| Group-DAG selection diverges CPU/GPU | One written equation, float32 CPU oracle, deterministic fixtures, normalized ID comparison |
| Partial residency creates holes | Group-level `all pages resident` gate and pinned terminal groups |
| Storage-fetch vertex path changes material pixels | Reuse the material's fragment composition and exact decoded attributes; add ordinary-vs-MeshLoD visual fixtures for supported materials |
| Page fragmentation blocks upload | Fixed 64 KiB units, pinned prefix, deterministic additional eviction |
| Range servers transform content | Require identity encoding and exact `Content-Range`; permit only validated full-body 200 fallback |
| Device loss drops optional renderables | Generic renderable-owned `_rebuild` thunks, pinned-first recovery |
| Non-feature bundles grow | Dynamic facade/runtime/material imports, no eager registry state, bundle-fetch tests |
| Debug/timing changes correctness | Debug is a material output variant only; timing uses existing optional task profiler |
| Converter output differs across hosts | Explicit byte order, stable ordering, canonical options/JSON, no timestamps/paths, pinned revisions, defined supported deterministic environment |
| Initial demo downloads source GLB for materials | Documented demo-only preparation; MeshLoD runtime API remains independent and future material packaging is not forced into v1 |

## 19. Migration and Code Removal

### Migration

None. Existing meshes, loaders, materials, scenes, and demos require no changes. MeshLoD applications explicitly import and call its APIs.

### Code removal

The former in-tree `mesh-lod-tool/` source moves to MegameshCLI. The demo keeps the source GLB and checked-in `.mlod` sidecars; ordinary statue meshes are removed before registration and replaced by MeshLoD instances. The existing `EXT_meshopt_compression` loader behavior remains intact.

## 20. Files to Create or Modify

This appendix describes implementation scope only; it is not an implementation task list.

### Create

```text
MegameshCLI/** (separate repository)
packages/babylon-lite/src/mesh-lod/
  mesh-lod.ts
  mesh-lod-runtime.ts
  mesh-lod-format.ts
  mesh-lod-range-source.ts
  mesh-lod-page-decoder.ts
  mesh-lod-scheduler.ts
  mesh-lod-cache.ts
  mesh-lod-selection-cpu.ts
  mesh-lod-selection-gpu.ts
  mesh-lod-scene.ts
  mesh-lod-errors.ts
  mesh-lod-selection.wgsl
packages/babylon-lite/src/material/pbr/
  pbr-mesh-lod-renderable.ts
  pbr-mesh-lod-compose.ts
lab/lite/src/demos/mesh-lod*.ts
lab/lite/demo-mesh-lod.html
lab/public/mesh-lod/*.mlod
lab/public/thumbnails/demo-mesh-lod.jpg
tests/lite/unit/mesh-lod/**
tests/lite/integration/mesh-lod/**
```

### Modify

```text
packages/babylon-lite/src/index.ts
packages/babylon-lite/src/scene/scene-core.ts
packages/babylon-lite/src/engine/recovery-rebuild.ts
packages/babylon-lite/src/render/renderable.ts
packages/babylon-lite/src/loader-gltf/meshopt-decode.ts   (shared decoder typing only; no glTF behavior change)
demos-config.json
scripts/bundle-demos-core.ts
```

### Delete

The former `mesh-lod-tool/` directory moves to MegameshCLI.

## 21. Verification Strategy and Requirement Traceability

No golden reference or bundle ceiling may be changed. Local validation uses focused nonvisual tests, filtered scene bundles, and lint; performance, visual/parity, and all-scene suites remain user/CI-only.

| Requirement | Verification evidence |
| --- | --- |
| `REQ-NAME-1` | API/docs/demo/tool/format string review for `MeshLoD`; dependency names appear only as dependencies, never feature branding |
| `REQ-NAME-2` | Clean CMake configure from the MegameshCLI root |
| `REQ-NAME-3` | Statue conversion and standalone demo asset URLs |
| `REQ-NAME-4` | Repository deliverable inventory and demo using engine APIs |
| `REQ-TOOL-1` | Windows Ninja/single-config and Visual Studio multi-config configure/build tests |
| `REQ-TOOL-2` | CMake inspection and `--version` exact SHA assertions |
| `REQ-TOOL-3` | Equivalent `.gltf`/`.glb` fixtures plus malformed container/JSON/buffer/accessor fixtures |
| `REQ-TOOL-4` | Statue nonzero statistics; hierarchy/meshlet validator |
| `REQ-TOOL-5` | CLI help, missing/invalid/conflicting option tests |
| `REQ-TOOL-6` | `--version` compared with provenance JSON |
| `REQ-TOOL-7` | Two clean conversions byte-compared; no timestamp/path scan |
| `REQ-TOOL-8` | Validator failure injection and canonical stats JSON |
| `REQ-TOOL-9` | One fixture per exit/failure class with mesh/primitive/accessor context assertions |
| `REQ-GEO-1` | Static opaque triangle success; topology/skin/morph/alpha/transmission rejection |
| `REQ-GEO-2` | Indexed/unindexed equivalent image and topology fixtures |
| `REQ-GEO-3` | Missing-normal finite generation; textured-without-UV failure; untextured-without-UV success |
| `REQ-GEO-4` | Compression-extension and accessor-layout rejection fixtures |
| `REQ-GEO-5` | Two transformed instances share one asset and select correctly |
| `REQ-GEO-6` | Multi-material input produces separate named containers and no cross-material references |
| `REQ-GEO-7` | Exhaustive small DAG cut coverage; incomplete-group residency never mixes parent/child coverage |
| `REQ-FMT-1` | One primitive per file; unsupported-major rejection; no per-meshlet files |
| `REQ-FMT-2` | Identity range server and transformed-encoding rejection |
| `REQ-FMT-3` | Bootstrap-only coarse render with fine requests disabled |
| `REQ-FMT-4` | Page size/padding validator; multi-meshlet page statistics |
| `REQ-FMT-5` | Metadata/provenance field inspection |
| `REQ-FMT-6` | Header/directory/section/page CRC, truncation, overlap, count, reference, and version mutation corpus |
| `REQ-FMT-7` | Exact 200 full-body cache test and invalid 200/206 tests |
| `REQ-LOAD-1` | Load promise resolves after coarse upload and before fine completion |
| `REQ-LOAD-2` | Invalid/effective budget and concurrency tests; diagnostics snapshot |
| `REQ-LOAD-3` | Abort race, repeated disposal, scene pruning, and resource-accounting tests |
| `REQ-LOAD-4` | Forced device-loss recovery from retained pages and deterministic refetch; terminal coarse failure |
| `REQ-SEL-1` | CPU oracle fixture suite with committed ordered IDs |
| `REQ-SEL-2` | GPU readback normalized against CPU IDs for every deterministic fixture |
| `REQ-SEL-3` | Perspective/orthographic threshold and unmet-error fixtures |
| `REQ-SEL-4` | Outside/intersecting hierarchy and cluster spheres |
| `REQ-SEL-5` | Exact refine/coarsen boundary and camera-jitter sequence |
| `REQ-SEL-6` | Group split across pages; switch only after final page is resident |
| `REQ-SEL-7` | Delay/cancel/fail/retry/evict scenarios retain terminal-group clusters |
| `REQ-STREAM-1` | Logged page-specific range requests against metadata |
| `REQ-STREAM-2` | Instrumented maximum in-flight count under stress and runtime bound change |
| `REQ-STREAM-3` | Repeated page demand produces one fetch and shared result |
| `REQ-STREAM-4` | Queued removal, in-flight abort, stale completion generation test |
| `REQ-STREAM-5` | Deterministic benefit/cost ordering and visible-demand starvation test |
| `REQ-STREAM-6` | Retryable/permanent status matrix, exact delay/count observation |
| `REQ-CACHE-1` | Block-accounting stress; no committed allocation over effective budget |
| `REQ-CACHE-2` | Pinned-size boundary success/failure and non-eviction |
| `REQ-CACHE-3` | Current-frame reference, upload, pinned, and in-flight victim exclusion |
| `REQ-CACHE-4` | 120-frame hold and two-frame obsolete grace camera-jitter test |
| `REQ-RENDER-1` | WebGPU raster pipeline inspection |
| `REQ-RENDER-2` | Draw-call instrumentation: one indirect draw per material/hierarchy batch while meshlet count varies |
| `REQ-RENDER-3` | Dependency review proving pipeline/WGSL/BGL creation resides under `material/pbr/`; supported material visual tests |
| `REQ-RENDER-4` | Buffer-growth, eviction, disposal, and recovery submission-safety tests |
| `REQ-INT-1` | Non-MeshLoD runtime fetch logs and bundle-size manifests |
| `REQ-INT-2` | Dynamic chunk graph: runtime/material/decoder chunks fetched only after MeshLoD call |
| `REQ-INT-3` | Public declaration review: state-only interfaces and standalone functions |
| `REQ-INT-4` | Runtime object graph review and two-scene removal/disposal tests |
| `REQ-INT-5` | Trimmed public `.d.ts` scan for prohibited GPU handle types in MeshLoD APIs |
| `REQ-INT-6` | Import-without-call test and source lint for eager collections/registration |
| `REQ-INT-7` | Shared asset with differently transformed instances; dispose one without affecting the other |
| `REQ-INT-8` | Full agent-allowed build/parity/bundle checks with unchanged ceilings and goldens |
| `REQ-DEMO-1` | Production demo build, gallery card, progress overlay, ready/error datasets, JPG thumbnail |
| `REQ-DEMO-2` | Demo import/load trace and removal of opt-in proving chunk absence |
| `REQ-DEMO-3` | Manual orbit/zoom plus frozen `?pathTime` timestamp assertions |
| `REQ-DEMO-4` | Control checklist and network wrapper request logs |
| `REQ-DEMO-5` | Diagnostics field checklist, unit labels, unsupported timing state |
| `REQ-DEMO-6` | Check meshlet ID and LOD depth debug views and legends |
| `REQ-DEMO-7` | Delay/pause coverage in demo; unavailable/failed fine-page coverage in runtime integration tests |
| `REQ-VERIFY-1` | Converter test inventory cross-referenced to tool/geometry rows above |
| `REQ-VERIFY-2` | Binary/range mutation corpus cross-referenced to format rows above |
| `REQ-VERIFY-3` | CPU/GPU fixture matrix: thresholds, frusta, residency, hysteresis, transforms |
| `REQ-VERIFY-4` | Deterministic fake-fetch/cache harness covering every scheduler/cache invariant |
| `REQ-VERIFY-5` | Existing parity and bundle suites plus explicit no-MeshLoD-fetch assertion |
| `REQ-VERIFY-6` | Demo verification checklist at camera times 0/5/10/15 s and each control/failure mode |

## 22. Final Architectural Invariants

An implementation conforms only if all of the following remain true:

1. A successfully loaded asset can always render pinned terminal-group geometry.
2. A finer group becomes visible only when every page referenced by that group is GPU-resident.
3. CPU and GPU use the same float32 equations, hysteresis comparisons, residency rule, and normalized cluster IDs.
4. Page requests are range-based, bounded, deduplicated, cancellable, retry-bounded, and generation-safe.
5. Logical GPU residency, including pinned pages, never exceeds the effective budget.
6. No page used by the submitted frame is evicted or destroyed.
7. One material/hierarchy batch issues at most one indirect raster draw.
8. The PBR material module owns all MeshLoD render-pipeline and shader decisions.
9. Scene ownership flows one way; assets and instances contain no scene reference.
10. Device recovery restores coarse rendering before reporting recovery success.
11. Non-MeshLoD applications fetch no MeshLoD runtime, material, shader, or decoder chunk.
12. Corruption, truncation, incompatibility, unsupported material state, and protocol errors are explicit and never silently approximated.
