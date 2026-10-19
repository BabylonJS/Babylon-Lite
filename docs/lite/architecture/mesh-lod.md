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
clearcoat, sheen, UV2, gamma-albedo decoding, lightmaps, dielectric-reflectance
extensions, per-texture UV transforms (including material-side V-flips),
per-material environments/local probes, material stencil state, material plugins,
and other unsupported extensions
fail with `MLOD_UNSUPPORTED_MATERIAL` rather than silently dropping features.
Materials and scene transforms are supplied by the application, not stored
in `.mlod`.
The blending gate uses ordinary PBR's effective state: `alphaBlend === true`,
or `alpha < 1` when the alpha cutoff is absent/nonpositive. Explicitly setting
`alphaBlend: false` does not make an alpha-only transparent material opaque.
Registration, deferred build, and dirty-material updates all enforce this gate.
Any assigned `stencil` object is unsupported, including writer, tester, and
default state, regardless of the ordinary-material `enableMaterialStencil()`
opt-in. Registration rejects before installing scene batches; deferred build
validates every active batch before allocating material/draw resources or
acquiring textures. Dirty-material updates reject before GPU uploads. MeshLoD
must not silently ignore a mask test or omit stencil writes that affect later draws.

Only the scene's global environment is supported. Assignments through
`setPbrEnvironment`, `setPbrLocalEnvironment` (box or sphere), or
`setPbrLocalEnvironmentProbeSet` fail with `MLOD_UNSUPPORTED_MATERIAL`, whose
`actual` is `"per-material environments or local probes"`, even when there is a
global environment or `enablePbrLocalCubemap()` has not been called.
The shared validator checks `_getPbrLocalEnvironment(material) !== undefined`
using the lightweight state module, without importing the local-cubemap renderer.
Registration, deferred build, and dirty-material updates enforce this restriction
before scene mutation, draw allocation/texture acquisition, and uploads respectively.
`clearPbrLocalEnvironment(material)` removes the assignment and restores eligibility;
enabling local cubemaps alone does not make otherwise supported materials invalid.

MeshLoD v1 does not support engines created with `useFloatingOrigin: true`.
Scene registration and material build reject that configuration with
`MLOD_INVALID_OPTION` before installing a batch or allocating draw resources;
binding and updates also enforce the gate. Both CPU and GPU selection require
absolute world transforms and the ordinary, non-rebased camera matrices.

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

`cloneTransformNode` preserves MeshLoD instances through their specialized
SceneNode clone hook, including instances nested under ordinary transforms.
The clone shares the asset/material, copies visibility, the error override,
TRS and any raw local matrix, and receives a fresh asset-local instance ID.
Its transform storage and selection history are independent; it starts
unregistered and can be added to the same or another scene separately, provided
the destination scene uses the asset's engine.

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
New asset/material batches must be added before scene registration; adding
instances to an existing batch afterward is supported and grows its CPU/GPU
instance capacity before drawing.

Cross-scene sharing requires exact engine identity: the asset's loading engine
must equal `scene.surface.engine`. Separate surfaces of that engine are supported.
Registration rejects a different engine with `MLOD_INVALID_OPTION` before
installing a registry, material-rebuild hook, deferred builder, or instance.
Rejection leaves both scenes and the asset's geometry, streaming, and frame-retirement
ownership unchanged; resources must never migrate to a second engine.

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
options are maintained in MegameshCLI. Hierarchy nodes begin with one root
per level; the parser rejects cycles, shared children, unreachable nodes,
and out-of-range group/page/cluster references before selection.
The reachable leaf records must also cover every group owning geometry.
Node reachability alone cannot establish this: redirecting leaves to another
valid group can hide the pinned fallback or omit a finer replacement.
After the forest walk validates reachability, reference validation records covered
leaf group IDs in a group-count-sized bitset;
any nonempty group without a reachable leaf fails with
`MLOD_INVALID_HIERARCHY` and the group's cluster-count field offset.
CRC-resealed full-file, bootstrap, and public URL-load regressions cover
both omitted pinned groups and omitted fine groups before decode/allocation.

Hierarchy, group, and cluster sphere centers must contain only finite float32
values, and their radii must be finite and nonnegative. Metadata parsing rejects
invalid components with `MLOD_INVALID_HIERARCHY`, the section type, and the exact
field byte offset before decode or GPU allocation. Zero-radius spheres remain valid.

Every nonterminal group's `simplifiedError` must be finite and nonnegative,
including groups on unpinned fine pages. Negative values, negative infinity,
positive infinity, and NaN reject with `MLOD_INVALID_HIERARCHY`, the groups section
type, and the exact error-field byte offset in both full-file and bootstrap parsing.
Zero remains valid. Terminal groups retain their sentinel error (`FLT_MAX`);
their terminal flag forces fine-required selection independently of the error.
Validation occurs before decoding or GPU allocation so CPU and GPU selection
cannot disagree over invalid nonterminal errors.

Every group's page-reference slice must include every page containing a cluster
whose `groupId` identifies that group. Slice bounds and in-range page IDs alone
are insufficient: an empty list or references to an unrelated resident page must
not make unfetched fine geometry appear resident. Metadata validation collects
each group's cluster-owning page IDs in a set, then removes the IDs covered by
its bounded reference slice. Temporary membership storage is bounded by the
cluster ownership records, not by potentially overlapping reference slices.
A remaining page fails explicitly with
`MLOD_INVALID_HIERARCHY`, the omitted page ID, and the group's page-reference
field offset. This runs for full files and coarse bootstraps before any page
decode or GPU allocation, without fetching fine-page bodies.

Directory and metadata spans must fit both the supplied bytes and the declared
coarse bootstrap before CRC scans or record reads. Only the page-data section
may extend beyond the bootstrap into the unfetched remainder of the file.
Metadata entries cannot masquerade as page data to bypass these bounds.
Decoded page allocations must be positive, no larger than 256 KiB, and divisible
by four for WebGPU uploads. The decoder independently enforces the same alignment.
Decoded vertex offsets must be multiples of four and decoded index offsets
multiples of two. Metadata rejects misaligned offsets with `MLOD_INVALID_LAYOUT`
before fetching fine pages or allocating the arena; direct decoder calls recheck
them with `MLOD_PAGE_INTEGRITY` before allocation or codec invocation.
Nonempty hierarchies must contain a terminal group; every terminal/pinned group's
referenced pages and every coarse page must belong to the pinned prefix, ensuring
a complete resident fallback before the loader reports `ready`.
A prefix table of the last unpinned reference validates each fallback slice in
constant time, including overlapping slices, without repeatedly scanning it.

Deferred scene builds stage packets transactionally. If any later batch fails,
all staged packets are disposed and their previous packet/renderable markers
restored, so retry cannot orphan buffers or acquired texture references.
If the deferred build rejects, it re-arms exactly one feature-owned builder in
the scene queue. A repaired `registerScene`/`buildScene` call drains that work
normally; successful batches are not appended twice, and disposed scenes do
not re-arm asynchronous work.

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
pixel scale is `viewportHeight * abs(projection[5]) / 2`, rounded to float32
and passed unchanged through the shared camera/selection contract to CPU
selection, the GPU model, and the selection UBO. The projection is resolved
at the render target's viewport-adjusted aspect, so XR uses its injected
per-eye projection rather than the advisory camera `fov`. For symmetric
perspective this equals `viewportHeight / (2 * tan(verticalFov / 2))`;
direct oracle fixtures without a projection-derived scale retain that FOV
formula. Geometric
error is transformed by the instance scale and divided by the distance
from the camera to the bounding sphere surface (clamped by the near plane).
The shared scale bound is `sqrt(max row sum(abs(A^T A)))`, rounded upward
to float32, where `A` is the world transform's linear part. It bounds the
operator norm even for sheared transforms, and reduces to maximum axis
scale for orthogonal bases. The GPU caches this bound in the instance record
and refreshes it through version-gated instance uploads.
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
Demand presence is independent of priority: a fine-required group in the
lower hysteresis band still renews its missing-page requests when its
quality-pressure priority is zero. GPU control readback carries a separate
per-page demand bitset alongside benefit accumulators and selected-page use.
Each benefit word stores a nonnegative float32 sum as its u32 bit pattern,
updated with an atomic compare/exchange loop. Addition saturates at the largest
finite float32 rather than overflowing a fixed-point u32 and wrapping a highly
demanded page to zero. Readback decodes the float and divides by stored bytes;
the CPU oracle and deterministic GPU model share float32 benefit math and
saturating accumulation matching the shader's operation order.
The CPU selector also returns its unnormalized per-page benefit map. A CPU
render binding adds those benefits across all demanding instances with the same
finite-float32 saturation, then divides each total by that page's stored bytes.
Only the subsequent merge across distinct render bindings takes the maximum;
sharing a missing page within one binding must increase its request priority
equally in CPU and GPU selection.

### 11.2 Request scheduling

`mesh-lod-scheduler.ts` deduplicates requests by page, bounds concurrency
(default four), and cancels obsolete work after a two-frame grace period.
Each rendered engine frame contributes one merged demand snapshot per asset,
regardless of the number of scene/material batches, render bindings, or GPU
readbacks. Per-page priority is the maximum from all active bindings; page-ID
order breaks ties. An asynchronous GPU readback updates its binding's latest
snapshot and may refresh scheduling at the already submitted frame index, but never advances
the asset clock. While readback is pending, the last successful snapshot is
retained for batches that still render; an explicit empty result clears it.
Frames without a contributing batch submit empty demand until outstanding
requests have aged out; removed batches never renew a stale snapshot.
Only frames _after_ the last demanded frame may count toward obsolescence:
zero grace retains demand for the current frame and cancels it on the next
undemanded frame. Positive grace retains its existing cutoff.
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
After device-limit clamping and block rounding, effective settings and diagnostics
use the actual arena capacity; the effective residency budget is capped at that
capacity. The public budget setter rejects values above the allocated arena,
not the originally requested capacity. Replacement-device recovery reconciles
both effective settings and diagnostics with its new arena before returning.
Decoded page data occupies rounded 64 KiB slots. Every page must declare
a positive decoded allocation no larger than
256 KiB. Metadata validation rejects larger declarations even when the
fine-page bytes have not been fetched, and the decoder rechecks the bound
before allocating staging memory or invoking the codec. Pinned coarse pages
cannot be evicted. Fine pages follow age/priority eviction after the
120-frame hold, but pages referenced by an in-flight frame cannot be
reclaimed. Protection is acquired while recording GPU selection (before
the page-state buffer is consumed), and released behind that submission's
fence; it does not update the page's last-used frame. Only pages actually
selected by a completed GPU pass update LRU age, using the source frame
rather than readback completion time. A cold page still referenced by prior
GPU submissions can be marked evicting under a lowered budget or allocation
pressure from a demanded replacement: future
selection excludes it, but its allocation is reclaimed only after the last
in-flight reference drains. Replacement-pressure retirement considers both the
rounded byte budget and a prospective contiguous run after existing retiring
pages drain. It retires only enough eligible cold victims, retaining pinned,
young, and current-frame-selected pages. Demand can then commit the replacement
while other submissions remain in flight; no queue-idle interval is required.
Capacity and effective budget cannot be smaller
than the pinned allocation.

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
Both render paths use the same instance packer. Shading normals use the
cofactor matrix multiplied by the determinant sign, then normalize in WGSL.
Cone axes use the same inverse-transpose orientation: they describe the
authored exterior, not the uncorrected winding of a reflected triangle. Non-finite
or singular world matrices reject with `MLOD_INVALID_OPTION` rather than
producing undefined lighting. The sign occupies normal-column padding word 23.
MLOD v1 retains glTF's right-handed, counter-clockwise local triangle order.
In Lite's left-handed camera convention, its ordinary RH-to-LH instances
have a negative determinant and need no index swap. Both CPU expansion and
GPU `expandClusters` normalize positive-determinant instances to the batch's
CCW rasterizer by swapping corners 1 and 2 of each triangle. The CPU path and
deterministic GPU model share `meshLoDTriangleIndex(index, handedness)`; WGSL
uses the same corner permutation and packed sign. Each update uses the current
world transform, so a runtime reflection changes winding without rebuilding
the batch or splitting its indirect draw. This also preserves the fragment
shader's `front_facing` classification for double-sided normal correction.
Cone rejection must follow that normalized exterior on both selection paths.

### 12.2 Per-binding resources

Selection work queues, group bitsets, selected-cluster pairs, page-demand
words, expanded draw vertices, and 16-byte indirect draw arguments are
transient. The renderer rebuilds storage bindings make-before-break when
a draw buffer grows. Before selection, the draw buffer reserves the sum of
resident cluster vertices for the currently visible instances, capped at the
device's storage-buffer limit. This envelope includes mutually exclusive LODs,
but exceeding it alone is not an error: the selected cut can still fit the
device. Selection checks the actual cut against the draw capacity; if it
cannot fit, the whole draw is suppressed rather than drawing a partial cut,
and a device-limit error is surfaced after GPU readback. In GPU mode, the
material packet keeps only a minimal placeholder for its unused CPU draw
stream; GPU selection owns the actual draw buffer.
The selected-pair append list is bounded independently of the instance and
group-state buffers. With `L = min(maxStorageBufferBindingSize, maxBufferSize)`,
its pair capacity is `max(1, min(clusterCount * instanceCapacity, floor((L - 4) / 8)))`:
one four-byte header followed by eight-byte `(cluster, instance)` records.
The final byte size still undergoes device-limit validation. Hidden instances,
unused geometrically reserved slots, nonresident geometry, and mutually exclusive
LODs may increase the potential pair count without making a fitting cut invalid.
The bounded capacity is uploaded to the selection parameters. Only actual append
overflow suppresses the whole expansion/draw and surfaces `MLOD_DEVICE_LIMIT`
through the existing asynchronous readback; no prefix of an overflowing cut draws.
CPU draw and instance storage are checked against the smaller of
`maxStorageBufferBindingSize` and `maxBufferSize`, including initial allocation
and GPU-to-CPU switches. Geometric growth is capped at the largest complete
record that fits those limits. Both required capacities are prevalidated before
replacing either buffer; an oversized selected cut throws `MLOD_DEVICE_LIMIT`
with required/allowed bytes instead of allocating an invalid binding. Valid
growth publishes its replacement buffer, scratch and bind group together,
then retires the previous buffer behind the frame fence.
Each render binding owns independent selection parameters, hysteresis, and
draw buffers, including the two stereo-eye bindings recorded before a single
submission. Immutable asset metadata and material resources remain shared.
CPU hysteresis lives in each binding packet, never in the scene-batch registry.
Its `cpuHistory` map keys stable instance IDs and stores
`{ selectionVersion: number, fineRequired: Uint8Array }`; the version is the
instance's removal/reinsertion selection version, defaulting to zero. An unmatched version
or group count starts from zero; removed IDs are pruned on the next binding
update, including an empty batch. Rebinding a live target reuses that history;
a new or retired/replaced binding starts independently. GPU hysteresis retains
its existing per-binding state.
CPU streaming observations are likewise keyed by the binding packet, so one
camera's empty/coarse selection cannot replace another camera's fine demand.
The frame coordinator merges those active observations once per submission.
The render task's stable target-signature identity keys these resources;
rebinding that target reuses them without allocating or invalidating bundles.
Each packet registers cleanup with the target's MeshLoD update batch. Task
retirement releases the packet behind the existing GPU fence and removes
its strong reference, without destroying shared material or asset resources.
Packet disposal clears its CPU history and deletes its CPU/GPU streaming
observations without disturbing other live bindings.
Hysteresis rows follow stable instance identity when slots move: retained rows
are copied into a zero-initialized replacement, never overlapping in place.
A removal/re-registration version resets a reused identity, even when removal
and insertion occur between two uploads without growing the buffers.

### 12.3 Compute order

The feature-owned `MeshLoDUpdateBatch` opts into renderer batch collection.
Per frame it clears scratch buffers; traverses visible hierarchy nodes;
evaluates group error/residency; selects clusters; prepares an indirect
dispatch; then expands selected triangles into draw-vertex records and
publishes `drawIndirect` arguments. Selection and expansion are ordered
in two compute passes before the opaque render pass. Async readback of
page demand, a page-use bitset, and counters drives subsequent
streaming, actual page-use aging, and diagnostics without blocking the
current draw. Readback completion is an observation of its source
selection, not an additional rendered frame.
Readback copies only the control header, one benefit word per page, and
two `ceil(pageCount / 32)` bitsets, independent of selected-list capacity.
The selected-page-use bitset precedes the missing-page-demand bitset;
`Params.execution.z` and `.w` contain their word offsets. A demand bit
remains set even when its accumulated benefit is zero. The nonvisual
`mesh-lod-demand.spec.ts` plumbing test runs the production WGSL and
readback decoder, moves a pending refinement request from 2.4 to 1.9 px,
and verifies that only genuinely withdrawn demand cancels the request.
It also sums shared missing-page demand from multiple viewport-filling instances,
including 18 px error at a 2 px threshold on a 1024-by-1024 target, and compares
the positive accumulated priorities with the packed-buffer GPU model.
The same probe also compares actual CPU binding demand. Its browser module URLs
use canonical `/@fs/` paths on Windows and POSIX: an extra slash creates a distinct
ES module URL and must not split the injected decoder from the loader's singleton.
The probe verifies that the loader actually calls the injected decoder.
The selected list has a count header. Indirect expansion uses bounded XYZ
dimensions based on `maxComputeWorkgroupsPerDimension`; the shader flattens
workgroup IDs and skips padding beyond the count. Direct selection kernels
use the same multidimensional flattening. No valid cut is truncated to fit X.

## 13. Material-owned drawing

### 13.1 Shader

The PBR module composes a vertex variant that reads the arena, expanded
draw vertices, and per-instance transforms. Its fragment variant uses the
supported PBR/unlit material properties. With a scene environment, diffuse
irradiance uses its spherical harmonics and specular IBL samples the
prefiltered environment cubemap and BRDF LUT with the normal PBR material's
roughness, horizon-occlusion, and energy-conservation math. Without a scene
environment, only direct lighting contributes. Debug color does not affect
selection or page residency.
GPU expansion fills diagnostic attributes from group metadata, page state,
and cone margins. `setMeshLoDDebugView` works in the default GPU mode without
changing selection modes; the CPU path uses the same attribute meanings.
Lit and unlit variants share ordinary PBR output processing: live exposure,
the enabled scene tone-mapping algorithm, display gamma, then contrast.
Bindings refresh their shader/pipeline keys before drawing when tone mapping
is enabled, disabled, or its algorithm changes; exposure/contrast remain live
scene UBO values and require no shader rebuild.
Fog configured with `setFog` before scene registration dynamically imports the
ordinary PBR fog helper/blend. Its presence participates in the shader key.
Lit and unlit color mixes the linearized fog color and factor before tone
mapping; the scene UBO supplies live fog modes/parameters. Introducing fog after
a non-fog packet was built rejects with `MLOD_INVALID_OPTION` rather than
silently rendering unfogged; configure it before registration, as ordinary PBR.
Hemispheric and other lights differ only in diffuse evaluation; both contribute
GGX specular using the shared light result's direction, attenuation, and unmixed
specular color. Metallic-roughness clamps roughness to `[0, 1]`, without a smooth
material floor. Ordinary PBR and MeshLoD share the BRDF and alpha-G/AA WGSL:
base `alphaG = roughness * roughness + 0.0005`. When `enableSpecularAA` is true,
normal derivatives give `slopeSquare = max(dot(dpdx(N), dpdx(N)),
dot(dpdy(N), dpdy(N)))`, `AA_factor_x = pow(saturate(slopeSquare), 0.333)`,
and `AA_factor_y = sqrt(slopeSquare) * 0.75`. IBL adds `AA_factor_y` to alpha-G;
direct lights instead square `max(roughness, AA_factor_x)` and add `0.0005`.
The AA flag participates in every target's shader/pipeline key, including
changes on existing bindings.

### 13.2 Bind groups

`rebuildMaterial(scene, material, options)` reaches MeshLoD through an opt-in
scene material-rebuild hook; the generic rebuild path contains no MeshLoD
imports or semantics. The hook shares the caller's material/view matching and
serializes rebuilds in the feature registry. It builds every matching live
batch transactionally, preserves unrelated renderables, and publishes packet
and renderable replacements only on success. Scene renderable/material epochs
invalidate task bindings even without `rebuildFrameGraph`; that option rebuilds
the graph after all material work completes. Failed replacements roll back
without dropping the old draw. Old packets/texture leases retire behind their
submission fence. Scene disposal during an asynchronous build discards candidates.
Texture replacements and structural flags such as `doubleSided` require this
rebuild; UBO-only edits continue to use `markMaterialUboDirty`.

Scene bindings occupy group 0. The material's group 1 binds its UBO, four
optional texture/sampler pairs, and three storage buffers (arena, draw
vertices, instances); missing textures use the material fallbacks. The lit
environment variant also binds the scene BRDF LUT/sampler and prefiltered
cubemap/sampler at bindings 12–15.
The material UBO and its reusable packing scratch are shared across target
packets. Updates observe `material._uboVersion`, so `markMaterialUboDirty`
refreshes supported scalar/vector properties once per mutation while
preserving the current debug selector.
The four material texture bindings are captured when the shared batch is built.
It acquires the application-supplied textures once, independently of ordinary
PBR scenes using the same material. Target packets and buffer-growth bind-group
rebuilds reuse those captured bindings without acquiring additional references.
Fallback textures remain owned by the device-keyed fallback cache. Shared-batch
teardown releases the captured texture references and material UBO behind the
engine's GPU-retirement fence, exactly once.
The deferred scene builder validates every active batch before allocating any
packet, so unsupported material mutations in a later batch cannot strand texture
references acquired for an earlier one.

### 13.3 Pipeline

The pipeline is an opaque triangle list with target-specific depth and
multisampling. Front faces are CCW; culling respects `doubleSided`.
Normal-mapped materials use ordinary PBR's scale-invariant cotangent frame:
`det = max(dot(T, T), dot(B, B))` and
`invmax = select(inverseSqrt(det), 0, det == 0)`. No additive epsilon may attenuate
the tangent columns relative to the geometric normal. A degenerate UV frame
has zero tangent columns; otherwise normalization is independent of world
scale, projection, and viewport size. Production-shader float readbacks compare
ordinary PBR and MeshLoD over multiple projected sizes and a zero-UV case.

### 13.4 Indirect draw

Each asset/material batch uses one `drawIndirect`, regardless of selected
meshlet count; an empty or disposed batch issues no draw. Opaque render
bundles cache the resolved bind group and indirect buffer. Changes to
either resource (including CPU/GPU selection switches and growth) invalidate
the cached bundle before the next draw.

## 14. Resource lifetime

GPU instance/prior-state capacity is bounded by complete records under both
`maxStorageBufferBindingSize` and `maxBufferSize`. Fitting growth caps geometric
reservations at that limit; oversized requirements fail before replacement.
Transient group-state/selected-list growth uses the already bounded capacity,
validates all required buffer sizes first, and publishes replacements together.

Each reserved GPU readback belongs to its frame encoder. A frame-scoped
post-submit hook maps it only after successful submission; cancellation or a
reset before flush returns the slot immediately. Reset after flush must not
release a slot whose map is still pending. Aborted frames never exhaust the ring.

### 14.1 Frame references

Frame references protect pages in use. CPU selection holds selected pages;
GPU selection temporarily holds all pages advertised as resident until
readback identifies the selected subset, without refreshing unused pages'
LRU age. Holds and buffer replacement retire only after submitted frames
drain. Recovery and disposal invalidate late readbacks.

### 14.2 Disposal

Disposal releases range-source full-file backing storage and replaces
`runtime.coarseBytes` with an empty array immediately, including HTTP 200
fallbacks retained by still-live scene registries. Range sources reject later
reads with `MLOD_DISPOSED` and cannot restore backing bytes from a late response.
Public metadata and transferred-byte diagnostics remain available.

Disposal aborts outstanding work and clears draw state. Once disposed,
an asset cannot be rendered again.

### 14.3 Device recovery

Renderable rebuild thunks recreate material packets and GPU selection
state on the new device. Retained pinned bytes are decoded/uploaded again;
fine pages can stream again on demand. A missing pinned page fails recovery
explicitly instead of displaying incomplete coarse geometry.
Each successful rebuild synchronizes the batch's `renderable` marker with its
result, including clearing it when an empty batch returns `null` and recovery
omits that batch from the scene's renderables. After registration, instance
additions require an existing batch with a live renderable. Reactivating a batch
dropped during recovery rejects with `MLOD_INVALID_OPTION` before changing its
instances or registering deferred work; the one-time scene builder is not replayed.
An empty batch that still has a live renderable can accept an instance again.
Recovery acquires the replacement packet's texture leases before disposing the
outgoing packet generation, including when a persistent target reuses its update
batch. Outgoing disposal unregisters its target disposers, clears CPU scratch and
hysteresis, and releases GPU selection/instance state independently of task teardown.
Packet texture leases capture their acquired GPU allocations: a deferred release
must never decrement or destroy a replacement allocation after recovery mutates a
`Texture2D` wrapper in place. Release notifications apply only if the wrapper
still identifies that outgoing allocation. Repeated bound-target recovery tests
cover both selection modes, stable disposer counts, released scratch/resources,
and replacement texture ownership through final teardown.

## 15. Demo

### 15.1 Sidecar packaging

`lab/lite/src/demos/mesh-lod.ts` uses the three checked-in `.mlod` sidecars.
Production demo output keeps those pages beside its script; the lab serves
them through a byte-range-capable `/mesh-lod/` route.

### 15.2 Material and transform source

The demo fetches the original statue GLB from
[BabylonJS Assets](https://assets.babylonjs.com/meshes/harvard-yenching/harvard-yenching_institute_statue.glb)
solely for material and node-transform data. The source GLB is not stored
in this repository or copied into the standalone demo bundle.

### 15.3 Demo controls

The inspector adjusts selection error, GPU budget, network bandwidth/
latency, pause, and the shipped debug views. Its network simulation wraps
only `.mlod` requests (initially 8 MiB/s and 100 ms), not the remote GLB.
The cache-budget slider is per asset and uses the smallest immutable capacity
reported by the loaded assets as its maximum: the shipped statue's default
arenas permit 32-128 MiB, not 256 MiB. Its initial value comes from the current
budget diagnostics. Slider labels update only after their setters succeed;
a rejected change preserves the last accepted label and restores the slider
thumb while surfacing the validation error. The diagnostics panel sums the
three assets' budgets, so 128 MiB per asset appears as 384 MiB there.
The normal camera is interactive; `?pathTime=` samples deterministic
frozen poses for workflow verification. The source model is credited to
Alexandre Tokovinine under CC BY 4.0.

## 16. Automated regression coverage

PR CI runs the Node-hosted `lite-integration` Vitest project alongside unit
tests, so loader, streaming, shared-lifetime, recovery, and render-equivalence
regressions gate changes without requiring local visual or performance tests.
Bounded metadata mutations abort on any attempted checksum scan into an invalid
span. Shared ordinary-PBR/MeshLoD texture tests cover both selection modes,
target retirement, instance-buffer growth, and fenced, idempotent batch teardown.
Registration/build gates cover public lightmap and dielectric-reflectance
setters, plus translated-camera floating-origin configurations in both modes.
Recovery tests drain the initial builder, remove the last instance, recover,
and verify that reactivation rejects without changing registration in both
selection modes. Live recovered batches retain their remove/re-add behavior.
Alpha-only rejection covers omitted and false blend flags at registration,
deferred build, and dirty updates in both selection modes. Static instance SSE
overrides are compared in float32, matching their cached/uploaded representation;
nonexact values such as `0.1` do not trigger repeated uploads, while changes and
removal still do. A nonvisual GPU plumbing regression compares float readbacks
from the actual ordinary-PBR and storage-fetch MeshLoD shaders on the same packed
triangle, with hemispheric-only metallic lighting, zero/sub-0.045 roughness,
and varying normals with AA enabled/disabled. The same PR-gated spec exercises
actual CPU/GPU selection, expansion, and indirect rasterization with opposite
determinant signs in one batch, repeated runtime sign changes, front/back views,
cone rejection enabled/disabled, and lit double-sided front-facing correction.
Float readbacks require both exteriors to render and both backfaces to retain
the appropriate culling/lighting; every nonempty batch remains one indirect draw.
Stencil writer/tester regressions explicitly enable ordinary material stencil
and require `MLOD_UNSUPPORTED_MATERIAL` at registration, deferred build, and
dirty updates in both selection modes, without scene mutation or GPU allocation/
upload. Unit coverage also rejects a default/empty stencil object.
Per-material environment regressions enable local cubemaps and use the public
override, box/sphere projection, and probe-set setters. Both selection modes
reject registration, deferred builds (including an earlier valid batch), and
dirty updates without scene mutation or new material/draw resources. Cleared
assignments still build and draw with the global environment. The MeshLoD-only
build regression also requires the local-cubemap renderer to remain absent.
The demo workflow verifies the cache slider's lower/upper bounds, clamping
above the advertised maximum, and agreement between the label and aggregate
effective budget. A forced out-of-capacity input verifies that rejection leaves
the accepted value intact and reports an error; a subsequent valid input clears it.
CPU storage regressions cover both device limits, bounded growth, initial
allocation, and GPU-to-CPU switches, including rejected cuts without resource
replacement. GPU selected-pair regressions use the shipped 2,491-cluster statue
with 4,097 registered instances (8,192 reserved slots), only one visible, and a
128 MiB limit. Each storage limit is exercised independently. The potential
163,250,180-byte list is capped to complete records within the limit, selection
receives that exact capacity, and the real hierarchy's resident pinned cut fits.
Both selected-list and draw-vertex overflow still surface the device-limit error.
Injected XR projection regressions require both selectors to use
the actual vertical scale, agree on refinement/page demand, and upload that
same scale per eye. Hierarchy cloning tests preserve MeshLoD state, independent
TRS/raw matrix storage, fresh IDs, and separate registration/drawing.
Two-camera CPU regressions establish opposite refinement histories at 2.4/1.5 px,
then repeatedly hold both at 1.9 px with the default 2 px / 0.15 hysteresis.
Both pass orders retain each camera's own history and fine-page demand (including
zero-priority demand with zero cancellation grace). Rebinding preserves history;
remove/reinsert without an intervening update resets it, and binding retirement
clears only the retired packet's history/observations behind its task fence.
CRC-resealed page-membership regressions reject a nonempty fine group with no
page references and an in-range list replaced by the pinned page. Both complete
files and coarse-only bootstraps fail with `MLOD_INVALID_HIERARCHY`; public CPU/GPU
loads reject after the two bootstrap requests with no page decode or GPU upload.
