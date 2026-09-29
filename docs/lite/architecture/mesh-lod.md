# MeshLoD Architecture

> Runtime: `packages/babylon-lite/src/mesh-lod/` and
> `packages/babylon-lite/src/material/pbr/pbr-mesh-lod-renderable.ts`.
> Offline conversion: [MegameshCLI](https://github.com/CedricGuillemet/MegameshCLI).

## 1. Purpose

MeshLoD is an opt-in path for large, static triangle meshes. The native
`mesh-lod-tool` converts each glTF primitive into a deterministic `.mlod`
hierarchy. Babylon Lite loads its metadata and pinned coarse pages first,
selects a resident, crack-free cluster cut per instance, requests finer pages
as needed, and submits one indirect draw per asset/material batch. This does
not replace the ordinary glTF loader or require MeshLoD code in scenes that
do not import the feature.

## 2. Supported materials

The material-owned renderer supports opaque PBR metallic-roughness (including
unlit and double-sided) with the base-color, normal, ORM/occlusion, and
emissive properties used by the statue. Alpha blending/masking, transmission,
clearcoat, sheen, UV2, material plugins, and other unsupported extensions
fail with `MLOD_UNSUPPORTED_MATERIAL` rather than silently dropping features.
Materials and scene transforms are supplied by the application, not stored
in `.mlod`.

## 3. Public API

All exports come from the root `@babylonjs/lite` entry point. An asset owns
immutable `metadata`, live `diagnostics`, and shared runtime resources, but
no scene reference. An instance is plain `SceneNode` state referencing that
asset and its `PbrMaterialProps`; a scene owns registration and cleanup.

```ts
const asset = await loadMeshLoD(engine, "/mesh-lod/model.mesh000.prim000.mlod");
const instance = createMeshLoDInstance(asset, material);
addMeshLoDToScene(scene, instance);
```

`loadMeshLoD(engine, source, options)` accepts a URL, `ArrayBuffer`, or `Blob`.
Options include screen-space error, hysteresis, GPU/CPU cache limits, request
concurrency/retries, `"gpu"` (default) or `"cpu"` selection, `AbortSignal`,
and request `fetch`/headers/credentials. Independent setters adjust error,
cache budget, streaming pause, debug view, and selection mode at runtime;
`getMeshLoDDiagnostics` reads the live snapshot. Removing an instance or
disposing its asset uses the corresponding root API. The current types and
exact signatures live in `mesh-lod.ts`.

## 4. Ownership and frame flow

```text
MegameshCLI: glTF primitive -> clustered hierarchy -> packed pages -> .mlod
loadMeshLoD: range source -> validated metadata -> pinned coarse residency
createMeshLoDInstance -> addMeshLoDToScene -> scene-owned batch registry
render task update -> MeshLoD selection/expansion batch -> PBR indirect draw
streaming step -> request scheduler -> decode/upload -> page residency
```

The scene registry groups instances by exact asset and material identity.
Each batch owns one opaque renderable. Neither the asset nor an instance
points back at a scene; the PBR MeshLoD module owns its shader, pipeline,
bind group, and render packet. The generic frame graph only handles the
feature through normal renderables and the opt-in draw-update batch seam.

## 5. Lazy boundaries

The public facade is tree-shakable. Loading and scene registration import
their implementation only on use, and the page decoder is loaded lazily.
GPU selection buffers are created on the first GPU-mode update; CPU
selection remains available as a reference and for diagnostic views.
No feature registration or mutable cache allocation runs at module import.
`tests/lite/build/mesh-lod-tree-shaking.test.ts` guards the unused path.

## 6. Container contract

Version 1 `.mlod` is little-endian: a 256-byte header, 64-byte directory
entries, required provenance/groups/clusters/hierarchy/page-reference/
page-table/page-data sections, and 64 KiB-aligned stored pages of at most
256 KiB. The header records the source mesh/primitive, bounds, counts,
source digest, and build fingerprint. Header, directory, metadata, and
individual stored pages carry CRC32C checks; required unknown sections or
incompatible versions fail explicitly. The reader's authoritative layout
and validators are in `mesh-lod-format.ts`; the writer and conversion
options are maintained in MegameshCLI.

One output file contains one primitive hierarchy. A multi-primitive
conversion gives each output a deterministic `.meshNNN.primNNN.mlod`
suffix, so each primitive retains its own material and transform.

## 7. Range loading and coarse bootstrap

`mesh-lod-range-source.ts` requests bytes `0-65535` first, then at most one
continuation through the declared bootstrap extent. It validates the
`Content-Range`, body length, file size, and identity encoding on `206`;
a complete `200` response is retained rather than downloaded repeatedly.
In-memory sources are sliced directly. `mesh-lod-runtime.ts` parses all
metadata and decodes/uploads pinned coarse pages before `loadMeshLoD`
resolves. A bad bootstrap or insufficient pinned-page budget rejects
the asset; an unavailable fine page does not discard its coarse surface.
Fine-page requests later use the same byte-range source.

## 8. Scene integration

`mesh-lod-scene.ts` installs a single deferred scene builder and registers
batches by asset/material identity. Instance world matrices, visibility,
and per-instance error overrides are read during updates. The builder
validates the supported PBR subset before constructing material-owned
renderables. Ordinary source glTF meshes are unnecessary to render MeshLoD;
the demo loads a GLB only to reuse its PBR materials and node transforms.

## 9. Diagnostics and verification

Diagnostics expose source/rendered triangles, selected meshlets, visible
groups, maximum selected/unmet error, page demand and residency, downloaded
bytes, cache use, and selection mode. Integration tests compare the CPU
oracle to GPU selection, streaming, lifecycle, and indirect-draw behavior.
The demo workflow test checks startup, controls, and source-asset loading
without changing reference screenshots. Demo GPU timing uses the
non-additive `totalDurationMs` from `getRenderTaskGpuTimings`.

## 10. Selection model

### 10.1 Screen-space projection

`mesh-lod-selection-math.ts` mirrors comparison-sensitive operations with
`Math.fround` in the CPU oracle and GPU model. For perspective cameras the
pixel scale is `viewportHeight / (2 * tan(verticalFov / 2))`; geometric
error is transformed by the instance scale and divided by the distance
from the camera to the bounding sphere surface (clamped by the near plane).
Orthographic cameras use their visible height instead. Sphere/frustum and
safe normal-cone culling reject invisible work. Hysteresis keeps the prior
fine-required state near an error threshold.

The hierarchy uses group dependencies and page residency to choose a
complete cut: a child replaces its parent only when the required finer
geometry is available. Selection never exposes a hole while streaming.
`mesh-lod-selection-cpu.ts` is the reference implementation;
`mesh-lod-selection-gpu.ts` packs the same metadata and evaluates it on
the device.

## 11. Streaming scheduler and caches

### 11.1 Page demand

Visible groups accumulate missing-page demand using screen-space benefit
relative to transfer size. The scheduler sorts by descending priority,
then page ID to break ties, rather than fetching every missing page.

### 11.2 Request scheduling

`mesh-lod-scheduler.ts` deduplicates requests by page, bounds concurrency
(default four), and cancels obsolete work after a two-frame grace period.
Transient network/408/429/5xx failures receive up to two retries with
250 ms and 1,000 ms delays; protocol, integrity, and other permanent
errors remain terminal for that fine page. Abort and generation tokens
prevent stale completions from changing a disposed or superseded asset.
Pausing streaming stops new fine requests, not rendering.

### 11.3 Page states

Pinned pages begin GPU-resident. Fine pages move from `unrequested` through
`queued`, `fetching`, `received`, `decoding`, `cpu-resident`, `uploading`,
and `gpu-resident`; retry, eviction, and terminal-failure states are
explicit. The scheduler owns transfers and retries; the asset runtime
owns decoding and residency commits.

### 11.4 GPU arena

The immutable allocation has a default 128 MiB capacity and budget.
Decoded page data occupies rounded 64 KiB slots. Pinned coarse pages
cannot be evicted. Fine pages follow age/priority eviction after the
120-frame hold, but pages referenced by an in-flight frame cannot be
reclaimed. Capacity and effective budget cannot be smaller than the
pinned allocation.

### 11.5 CPU page cache

The encoded-byte cache defaults to 64 MiB; pinned bytes remain retained
for device recovery. Fine cached bytes may be evicted independently of
GPU page residency. Decoded staging bytes are not held indefinitely.

## 12. GPU data and passes

### 12.1 Persistent layout

The device stores eight-word hierarchy nodes, 16-word group and cluster
records, group-to-page references, eight-word page-state records, and
the immutable packed geometry arena. A 128-byte instance record contains
the world and normal transforms, scale, flags, and stable instance ID.
These typed layouts are packed by `mesh-lod-selection-gpu.ts`.

### 12.2 Per-batch resources

Selection work queues, group bitsets, selected-cluster pairs, page-demand
words, expanded draw vertices, and 16-byte indirect draw arguments are
transient. The renderer rebuilds storage bindings make-before-break when
a draw buffer grows. Capacities are checked before GPU writes.

### 12.3 Compute order

The feature-owned `MeshLoDUpdateBatch` opts into renderer batch collection.
Per frame it clears scratch buffers; traverses visible hierarchy nodes;
evaluates group error/residency; selects clusters; prepares an indirect
dispatch; then expands selected triangles into draw-vertex records and
publishes `drawIndirect` arguments. Selection and expansion are ordered
in two compute passes before the opaque render pass. Async readback of
page demand and counters drives subsequent streaming and diagnostics
without blocking the current draw.

## 13. Material-owned drawing

### 13.1 Shader

The PBR module composes a vertex variant that reads the arena, expanded
draw vertices, and per-instance transforms. Its fragment variant uses the
supported PBR/unlit material properties; debug color does not affect
selection or page residency.

### 13.2 Bind groups

Scene bindings occupy group 0. The material's group 1 binds its UBO, four
optional texture/sampler pairs, and three storage buffers (arena, draw
vertices, instances); missing textures use the material fallbacks.

### 13.3 Pipeline

The pipeline is an opaque triangle list with target-specific depth and
multisampling. Front faces are CCW; culling respects `doubleSided`.

### 13.4 Indirect draw

Each asset/material batch uses one `drawIndirect`, regardless of selected
meshlet count; an empty or disposed batch issues no draw. Opaque render
bundles cache the resolved bind group and indirect buffer. Changes to
either resource (including CPU/GPU selection switches and growth) invalidate
the cached bundle before the next draw.

## 14. Resource lifetime

### 14.1 Frame references

Frame references protect pages in use. Buffer replacement retires old
resources only after submitted frames drain.

### 14.2 Disposal

Disposal aborts outstanding work and clears draw state. Once disposed,
an asset cannot be rendered again.

### 14.3 Device recovery

Renderable rebuild thunks recreate material packets and GPU selection
state on the new device. Retained pinned bytes are decoded/uploaded again;
fine pages can stream again on demand. A missing pinned page fails recovery
explicitly instead of displaying incomplete coarse geometry.

## 15. Demo

### 15.1 Sidecar packaging

`lab/lite/src/demos/mesh-lod.ts` uses the three checked-in `.mlod` sidecars.
Production demo output keeps those pages beside its script; the lab serves
them through a byte-range-capable `/mesh-lod/` route.

### 15.2 Material and transform source

The demo fetches the original statue GLB from
[BabylonJS/Assets](https://raw.githubusercontent.com/BabylonJS/Assets/master/meshes/harvard-yenching/harvard-yenching_institute_statue.glb)
solely for material and node-transform data. The source GLB is not stored
in this repository or copied into the standalone demo bundle.

### 15.3 Demo controls

The inspector adjusts selection error, GPU budget, network bandwidth/
latency, pause, and the shipped debug views. Its network simulation wraps
only `.mlod` requests (initially 8 MiB/s and 100 ms), not the remote GLB.
The normal camera is interactive; `?pathTime=` samples deterministic
frozen poses for workflow verification. The source model is credited to
Alexandre Tokovinine under CC BY 4.0.
