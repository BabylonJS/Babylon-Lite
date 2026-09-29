# MeshLoD Requirements

> Approved source: `docs/lite/architecture/mesh-lod/goals.md`
>
> This document defines verifiable product requirements for the initial MeshLoD deliverable. It intentionally does not define implementation tasks or final public API signatures.

## 1. Scope and Terminology

- **MeshLoD asset**: a versioned `.mlod` sidecar containing one clustered LOD hierarchy and its paged geometry.
- **Cluster / meshlet**: a bounded unit of geometry selected as part of a hierarchy cut.
- **Group**: a hierarchy transition unit whose replacement geometry becomes visible atomically.
- **Coarse representation**: the pinned, always-renderable ancestor geometry loaded before fine-detail streaming.
- **Resident page**: a geometry page whose data is available for the current runtime stage.
- **CPU oracle**: the deterministic reference selector used to establish correctness before GPU selection is accepted.
- **Compatible render batch**: selected geometry that can share the same material-owned rendering configuration and hierarchy submission.

## 2. Naming and Deliverables

### REQ-NAME-1 — Feature name

The feature, public documentation, standalone demo, offline tool, diagnostics, and asset format MUST use the name **MeshLoD**.

**Acceptance criteria**

- User-visible names use `MeshLoD`.
- Third-party product names are not used as the Babylon Lite feature name.

### REQ-NAME-2 — Offline tool location

The offline converter MUST be rooted in the independent
[`CedricGuillemet/MegameshCLI`](https://github.com/CedricGuillemet/MegameshCLI)
repository, not in the Babylon Lite runtime workspace.

**Acceptance criteria**

- A clean MegameshCLI checkout can configure the converter with `cmake -S . -B build`.
- The converter does not require Babylon Lite source files or build tools; its input assets are supplied by path.

### REQ-NAME-3 — Initial end-to-end asset

The first end-to-end conversion and demo asset MUST be `assets/harvard-yenching_institute_statue.glb`
in MegameshCLI (also retained at the Babylon Lite repository root for the demo).

**Acceptance criteria**

- The documented conversion workflow accepts that file as input.
- The standalone demo loads its generated `.mlod` output through the same public, lazy runtime path intended for applications.

### REQ-NAME-4 — Required deliverables

The initial feature MUST include an offline converter, a versioned `.mlod` asset contract, an opt-in Babylon Lite engine feature, and a standalone Babylon Lite demo.

**Acceptance criteria**

- Each deliverable is independently identifiable in repository documentation.
- The demo depends on the engine feature rather than a demo-only rendering path.

## 3. Offline Converter

### REQ-TOOL-1 — Build system

The converter MUST build with CMake.

**Acceptance criteria**

- Configuration and release builds succeed from a clean checkout using documented commands.
- Documentation covers Windows single-config and multi-config generator invocation and executable locations.

### REQ-TOOL-2 — Pinned dependencies

CMake MUST use `FetchContent` to acquire pinned revisions of **meshoptimizer** and **cgltf**.

**Acceptance criteria**

- Dependency revisions are immutable identifiers rather than floating branches or unpinned tags.
- Reconfiguring with the same inputs resolves the same dependency revisions.

### REQ-TOOL-3 — glTF ingestion

The converter MUST use cgltf to read both glTF and GLB input.

**Acceptance criteria**

- Valid supported `.gltf` and `.glb` fixtures produce equivalent normalized primitive inputs.
- Malformed container, JSON, buffer, buffer-view, or accessor data produces an explicit failure.

### REQ-TOOL-4 — MeshLoD generation

The converter MUST use meshoptimizer's clustered LOD and meshlet capabilities to produce hierarchy and geometry payloads.

**Acceptance criteria**

- Output metadata reports non-zero groups, meshlets, and triangles for the statue asset.
- Every emitted meshlet and hierarchy relationship passes converter validation.

### REQ-TOOL-5 — Non-interactive CLI

The converter MUST provide a non-interactive command-line interface accepting input and output paths plus explicit conversion options.

**Acceptance criteria**

- The expected workflow can run without prompts.
- Missing, invalid, or conflicting arguments return a non-zero exit code and identify the offending argument.
- `--help` documents every supported option and its default.

### REQ-TOOL-6 — Version reporting

The converter MUST expose its tool version, `.mlod` format version, and pinned dependency revisions through `--version`.

**Acceptance criteria**

- `--version` is machine-invocable without an input asset.
- Reported values match the metadata written by the same tool build.

### REQ-TOOL-7 — Deterministic conversion

The converter MUST produce byte-identical `.mlod` output for identical input bytes, explicit options, dependency revisions, tool version, and target format version.

**Acceptance criteria**

- Two clean conversions under the same supported environment compare byte-for-byte equal.
- Output ordering and metadata contain no timestamps, random values, unstable paths, or other nondeterministic fields.

### REQ-TOOL-8 — Validation and statistics

The converter MUST validate its output and report useful statistics for groups, meshlets, source and output triangles, hierarchy depth, bounds, simplification errors, and page layout.

**Acceptance criteria**

- Validation runs before a conversion is reported successful.
- Invalid hierarchy references, invalid bounds, non-finite errors, and out-of-range payload references fail conversion.
- Statistics are available in a non-interactive form suitable for automated verification.

### REQ-TOOL-9 — Failure behavior

The converter MUST return a non-zero exit code and a precise diagnostic for unsupported primitive modes, unsupported compression extensions, unsupported accessor/component layouts, malformed accessors, invalid hierarchy output, and file I/O failures.

**Acceptance criteria**

- A fixture exists for every listed failure class.
- No listed failure produces a successful or partially valid output.
- Diagnostics identify the source primitive or data location when that information is available.

## 4. Supported Source Geometry

### REQ-GEO-1 — Initial geometry scope

The initial converter MUST support static, opaque glTF triangle primitives with a required `POSITION` attribute.

**Acceptance criteria**

- Supported `TRIANGLES` primitives convert successfully.
- Non-triangle primitive modes fail explicitly.
- Skinned, morphed, alpha-blended, and transmissive primitives are rejected as unsupported in the initial version.

### REQ-GEO-2 — Index handling

The converter MUST accept indexed and unindexed supported primitives and MUST index unindexed input during preprocessing.

**Acceptance criteria**

- Equivalent indexed and unindexed fixtures preserve equivalent visible geometry.
- Emitted geometry uses valid indices within the emitted vertex range.

### REQ-GEO-3 — Vertex attributes

The initial output MUST preserve position, normal, and UV data required by the statue demo. Missing normals MUST be generated offline. `TEXCOORD_0` MAY be absent only when the primitive's material does not require it.

**Acceptance criteria**

- A supported primitive without normals converts with valid finite generated normals.
- A textured material without required UVs fails explicitly.
- A material that does not require UVs can convert without `TEXCOORD_0`.

### REQ-GEO-4 — Unsupported encodings

Unsupported compressed source primitives and unsupported accessor or component layouts MUST fail with a precise converter error.

**Acceptance criteria**

- Unsupported compression is never silently decoded incorrectly, ignored, or passed through.
- The error identifies the unsupported extension or accessor layout.

### REQ-GEO-5 — Hierarchy coordinate space

Each hierarchy MUST be built in primitive-local space. Normal glTF node and scene world transforms MUST remain runtime state.

**Acceptance criteria**

- Multiple instances with different world transforms can share one immutable hierarchy.
- Selection and bounds remain correct after applying each instance's runtime transform.

### REQ-GEO-6 — Material boundaries

Each glTF material primitive MUST be converted independently, and simplification MUST NOT cross a material boundary.

**Acceptance criteria**

- No emitted group or meshlet combines triangles from different source material primitives.
- Material assignment remains stable across all hierarchy levels.

### REQ-GEO-7 — Crack-free hierarchy contract

Every valid rendered cut MUST cover each source surface region at exactly one hierarchy resolution. Shared group boundaries MUST be protected, and a refinement MUST become visible only when its complete replacement group is resident.

**Acceptance criteria**

- Deterministic cut fixtures contain no missing or duplicate hierarchy regions.
- Partial residency cannot expose only part of a replacement group.

## 5. `.mlod` Asset Contract

### REQ-FMT-1 — Initial container model

The initial format MUST be a single versioned, range-addressable `.mlod` binary container per converted glTF primitive hierarchy.

**Acceptance criteria**

- A hierarchy does not require one file per meshlet.
- Multi-pack output is not required by the initial reader or converter.
- The reader rejects unsupported format versions explicitly.

### REQ-FMT-2 — HTTP serving contract

The `.mlod` container MUST be usable when served with `Content-Encoding: identity` and HTTP byte-range support.

**Acceptance criteria**

- The runtime can load metadata, coarse pages, and selected fine pages using byte ranges.
- Documentation states that content transformation or compression by intermediaries is incompatible unless byte offsets are preserved.

### REQ-FMT-3 — Bootstrap layout

Resident hierarchy metadata and pinned coarse pages MUST occupy known ranges near the beginning of the container.

**Acceptance criteria**

- The runtime can discover all ranges required for initial coarse rendering without downloading fine-detail pages.
- The initial coarse representation is renderable before optional fine pages complete.

### REQ-FMT-4 — Streamed page size

Streamed geometry MUST be organized into independently decodable pages between 64 KiB and 256 KiB, with each page containing multiple meshlets where the hierarchy permits.

**Acceptance criteria**

- Converter validation rejects streamed pages outside the allowed range.
- Decoding one page does not require fetching an unrelated fine-detail page.

### REQ-FMT-5 — Self-description and provenance

The container metadata MUST identify the format version, tool version, pinned dependency revisions, conversion options that affect output, hierarchy counts, and byte ranges required by the reader.

**Acceptance criteria**

- Runtime compatibility can be determined before interpreting unsupported payload data.
- Conversion provenance can be compared with `mesh-lod-tool --version`.

### REQ-FMT-6 — Integrity and compatibility failures

Corrupt, truncated, unsupported, or version-incompatible `.mlod` inputs MUST fail explicitly rather than producing partial success or silent format fallback.

**Acceptance criteria**

- Corruption, truncation, invalid offsets, overlapping or out-of-bounds ranges, invalid hierarchy references, and unsupported versions have deterministic error fixtures.
- A failed asset never becomes registered as successfully loaded.

### REQ-FMT-7 — Full-response range fallback

If a server ignores a valid range request and returns HTTP 200 with the complete file, the loader MAY retain and use that complete response. Other range or protocol failures MUST be surfaced explicitly.

**Acceptance criteria**

- A complete HTTP 200 response can satisfy subsequent range reads without repeated downloads.
- Invalid partial responses, mismatched lengths, and unusable status codes fail with explicit diagnostics.

## 6. Runtime Loading and Lifecycle

### REQ-LOAD-1 — Coarse-first loading

The runtime MUST load and validate resident hierarchy metadata and pinned coarse pages before requesting optional fine-detail pages.

**Acceptance criteria**

- A successfully initialized asset can render a complete coarse representation with fine streaming disabled.
- Fine-page requests do not block availability of the validated coarse representation.

### REQ-LOAD-2 — Explicit budgets

The runtime MUST require or provide explicit, observable limits for page-cache bytes and concurrent fetches.

**Acceptance criteria**

- Effective limits are available to diagnostics.
- Invalid limits fail before streaming begins.

### REQ-LOAD-3 — Disposal

Disposing a MeshLoD asset MUST abort its outstanding requests, unregister its scene-owned work, and release its CPU and GPU cache allocations when they are no longer shared.

**Acceptance criteria**

- No request completion mutates a disposed asset.
- Repeated disposal is safe.
- Resource accounting returns to the expected shared baseline.

### REQ-LOAD-4 — Device loss

After WebGPU device loss, the runtime MUST recreate resident GPU state from retained metadata and CPU page data or by deterministic re-fetch, while preserving a valid coarse fallback.

**Acceptance criteria**

- A device-loss fixture restores rendering without reconverting the source asset.
- Resources are replaced make-before-break whenever an old device resource remains usable during replacement.
- Terminal recovery failure is reported explicitly and does not expose raw GPU objects.

## 7. Selection Correctness

### REQ-SEL-1 — CPU oracle first

A deterministic CPU selector MUST be completed and accepted as the correctness oracle before GPU selection is considered conformant.

**Acceptance criteria**

- CPU fixtures cover camera, projection, error threshold, hierarchy, and residency inputs.
- Each fixture has a stable expected ordered set of selected cluster IDs.

### REQ-SEL-2 — GPU equivalence

GPU selection MUST return the same cluster IDs as the CPU oracle for deterministic camera, error, hierarchy, culling, and residency fixtures.

**Acceptance criteria**

- Automated comparisons report no missing, extra, or duplicate cluster IDs.
- Ordering differences are permitted only if ordering is declared semantically irrelevant and normalized by the test.

### REQ-SEL-3 — Screen-space error

Selection MUST use camera position, projection, and a configurable screen-space error threshold, and the selected cut MUST respect that threshold subject to residency fallback.

**Acceptance criteria**

- Fully resident fixtures refine when projected error exceeds the threshold and stop refining when it does not.
- When required fine data is absent, the nearest resident ancestor is selected and the unmet error is observable.

### REQ-SEL-4 — Frustum culling

Selection MUST exclude clusters outside the camera frustum without removing hierarchy coverage needed by visible regions.

**Acceptance criteria**

- Fully outside fixtures select no renderable clusters.
- Boundary-intersecting fixtures remain visible.

### REQ-SEL-5 — Selection hysteresis

Selection MUST apply explicit LOD hysteresis so small camera movement near a threshold does not repeatedly change the selected cut.

**Acceptance criteria**

- A deterministic camera-jitter fixture remains on a stable cut inside the hysteresis band.
- Crossing the configured refinement or coarsening boundary causes the expected transition.

### REQ-SEL-6 — Atomic refinement

A group MUST refine only after all geometry required for its transition is resident.

**Acceptance criteria**

- Incomplete replacement residency keeps the nearest complete resident ancestor visible.
- Completion switches the group without a frame containing a hole or mixed partial replacement.

### REQ-SEL-7 — Coarse fallback

The runtime MUST preserve a complete coarse renderable fallback at all times after successful initialization.

**Acceptance criteria**

- Delayed, cancelled, failed, retried, or evicted fine-detail requests never create visible holes.
- The last resident coarse representation cannot be evicted.

## 8. Streaming and Cache Management

### REQ-STREAM-1 — Range-based page requests

Fine geometry MUST be requestable as independently useful byte ranges from the single `.mlod` container.

**Acceptance criteria**

- Camera movement can request a subset of fine pages without downloading the full container.
- Requested ranges correspond to container metadata.

### REQ-STREAM-2 — Bounded concurrency

Streaming MUST enforce a configurable upper bound on simultaneous page requests.

**Acceptance criteria**

- Stress fixtures never exceed the configured in-flight request count.
- Reducing the bound affects scheduling without breaking coarse rendering.

### REQ-STREAM-3 — Request deduplication

Concurrent demand for the same page MUST share one in-flight request.

**Acceptance criteria**

- Repeated demand produces one network transfer and one committed page result.
- All current consumers observe the same terminal success or failure.

### REQ-STREAM-4 — Cancellation

Requests that are no longer useful because of camera movement or asset disposal MUST be cancellable.

**Acceptance criteria**

- Obsolete queued requests do not start.
- Obsolete in-flight requests are aborted when safe and do not become resident solely because a stale completion races cancellation.

### REQ-STREAM-5 — Prioritization

The scheduler MUST prioritize page requests by visible screen-space benefit relative to transfer cost.

**Acceptance criteria**

- Given a deterministic pending set, pages with higher configured benefit-to-cost priority start first.
- Invisible work cannot indefinitely block visible coarse-to-fine improvement.

### REQ-STREAM-6 — Retry policy

Retries MUST follow an explicit bounded policy. Terminal failures MUST be reported while rendering continues from the nearest resident ancestor.

**Acceptance criteria**

- Retry count and delay are bounded and observable.
- Permanent failures stop retrying.
- Failure of a fine page does not remove valid resident fallback geometry.

### REQ-CACHE-1 — Byte budget

The GPU page cache MUST remain within its configured byte budget except for at most one page currently being uploaded.

**Acceptance criteria**

- Accounting includes resident fine pages and pinned coarse pages.
- Stress fixtures exceed the budget only by the byte size of at most one active upload.
- The cache returns within budget after the upload commits or fails.

### REQ-CACHE-2 — Minimum viable budget

Pinned coarse pages MUST count toward the cache budget and MUST fit within the configured minimum viable budget.

**Acceptance criteria**

- Initialization fails explicitly when the budget cannot hold all required pinned coarse pages.
- Coarse pages remain pinned after successful initialization.

### REQ-CACHE-3 — Safe eviction

The cache MUST evict only unpinned pages that are not in flight and are not required by the current submitted frame.

**Acceptance criteria**

- Eviction stress fixtures never invalidate geometry referenced by the current frame.
- Pinned coarse pages and in-flight pages are never selected as eviction victims.

### REQ-CACHE-4 — Residency hysteresis

Cache and request scheduling MUST apply explicit residency hysteresis to avoid repeated request and eviction thrashing.

**Acceptance criteria**

- A deterministic camera-jitter fixture does not repeatedly fetch and evict the same page inside the hysteresis policy.
- Sustained demand eventually makes the page eligible for retention or re-request according to the documented policy.

## 9. Rendering and Materials

### REQ-RENDER-1 — Hardware rasterization

The initial MeshLoD renderer MUST use WebGPU hardware rasterization.

**Acceptance criteria**

- The initial path does not depend on software rasterization or a visibility-buffer renderer.

### REQ-RENDER-2 — No CPU draw per meshlet

The renderer MUST NOT submit one CPU draw call per selected meshlet.

**Acceptance criteria**

- Draw submission count does not scale one-for-one with selected meshlet count.
- The initial target is one indirect draw per compatible material/hierarchy render batch.

### REQ-RENDER-3 — Material ownership

Materials MUST continue to own shader source, pipeline descriptors, bind-group layout, and bind-group creation for MeshLoD rendering.

**Acceptance criteria**

- MeshLoD uses material-owned renderable or vertex-processing variants.
- The generic renderer does not introduce a MeshLoD-owned public shader path.
- Different compatible opaque materials retain their own rendering behavior.

### REQ-RENDER-4 — Frame-safe resource replacement

GPU buffer and cache replacement MUST use make-before-break retirement and MUST not destroy resources still referenced by submitted work.

**Acceptance criteria**

- Upload, eviction, and device-recovery tests do not reuse or destroy resources before their last submitted frame is safe.

## 10. Babylon Lite Integration

### REQ-INT-1 — Opt-in and tree-shakable

MeshLoD MUST be an opt-in, tree-shakable engine feature with no runtime cost or fetched MeshLoD code for scenes that do not enable it.

**Acceptance criteria**

- Existing non-MeshLoD scenes fetch no MeshLoD runtime chunks.
- Existing bundle-size ceilings continue to pass.
- Importing unrelated Babylon Lite entry points does not initialize MeshLoD state.

### REQ-INT-2 — Lazy extension integration

Loading and rendering integration MUST use lazy, opt-in extension seams rather than hardcoded eager feature logic in core loader or renderer paths.

**Acceptance criteria**

- MeshLoD runtime modules load only after an application explicitly selects the feature or a MeshLoD asset path.
- Non-MeshLoD glTF loading behavior and fetched chunks remain unchanged.

### REQ-INT-3 — Pure public state

Public MeshLoD objects MUST be pure state, with behavior supplied by standalone functions.

**Acceptance criteria**

- Public state interfaces expose no attached behavior methods.
- Unused standalone behavior can be tree-shaken.

### REQ-INT-4 — One-way ownership

MeshLoD objects MUST NOT hold scene references. The scene MUST own registered renderables and lifecycle callbacks.

**Acceptance criteria**

- One MeshLoD hierarchy can be instantiated without embedding a scene in its asset state.
- Removing an instance unregisters scene-owned work without mutating unrelated instances.

### REQ-INT-5 — No raw GPU public API

No public MeshLoD API MUST expose raw WebGPU handles, including `GPUDevice`, `GPUBuffer`, `GPUTexture`, `GPUTextureView`, or `GPUSampler`.

**Acceptance criteria**

- Public declaration review contains none of the prohibited handle types.
- Diagnostics expose values and identifiers rather than raw handles.

### REQ-INT-6 — No import-time side effects

MeshLoD modules MUST have no import-time registration, global mutation, or eager module-level collection allocation.

**Acceptance criteria**

- Importing a MeshLoD module without calling it creates no runtime registration or cache.
- Caches initialize lazily and are isolated or invalidated across device changes.

### REQ-INT-7 — Shared hierarchy instances

Multiple runtime instances MAY share one immutable primitive-local hierarchy while retaining independent transforms, visibility, selection state where required, and scene ownership.

**Acceptance criteria**

- Two differently transformed instances render correctly from one hierarchy payload.
- Disposing one instance does not invalidate another live instance.

### REQ-INT-8 — Existing behavior preservation

Introducing MeshLoD MUST preserve existing Babylon Lite scene behavior, visual parity, loader behavior, lifecycle behavior, and bundle-size guarantees when the feature is unused.

**Acceptance criteria**

- All agent-allowed existing build, parity, and bundle-size checks remain green when engine implementation is introduced.
- No existing golden reference or bundle ceiling is changed to accommodate MeshLoD.

## 11. Standalone Demo

### REQ-DEMO-1 — Babylon Lite standalone conventions

The MeshLoD demo MUST follow current Babylon Lite standalone demo conventions: a standalone WebGPU page, production-bundled demo entry, gallery metadata, loading/progress presentation, ready/error signaling, and a JPG gallery thumbnail.

**Acceptance criteria**

- The demo is discoverable from the existing demo gallery.
- The page reports loading progress or an indeterminate loading state and hides the overlay on ready or error.
- The page renders the same tree-shaken artifact measured by demo bundle tooling.

### REQ-DEMO-2 — Application-equivalent loading

The demo MUST load the statue `.mlod` through the same public and lazy path intended for applications.

**Acceptance criteria**

- No demo-only loader, selector, cache, or renderer bypass is used.
- Disabling or removing the MeshLoD opt-in prevents the MeshLoD runtime chunk from loading.

### REQ-DEMO-3 — Camera behavior

The demo MUST provide orbit and zoom controls and SHOULD support deterministic camera poses for repeatable observation.

**Acceptance criteria**

- A user can orbit and zoom around the statue.
- `?pathTime=<seconds>` produces a repeatable frozen camera pose without adding camera-animation controls to the viewer.

### REQ-DEMO-4 — Runtime controls

The demo MUST provide controls for screen-space error, cache budget, streaming pause, simulated bandwidth, and simulated latency.

**Acceptance criteria**

- Control changes expose their effective values.
- Streaming pause stops new fine-detail progress without removing the coarse fallback.
- Bandwidth and latency simulation affects MeshLoD page traffic rather than unrelated page resources.

### REQ-DEMO-5 — Diagnostics

The demo MUST make source triangle count, rendered triangle count, selected meshlet count, hierarchy depth, effective screen-space error, page requests, page residency, downloaded bytes, cache use, and GPU timing observable.

**Acceptance criteria**

- Values update while the camera, threshold, and streaming state change.
- Unsupported GPU timing capability is identified explicitly rather than displayed as a valid zero.
- Downloaded-byte and cache-use values have documented units.

### REQ-DEMO-6 — Debug views

The demo MUST provide debug views for meshlet ID and LOD depth. The runtime MAY expose additional programmatic debug views independently of the demo UI.

**Acceptance criteria**

- Each view can be enabled without changing the hierarchy or streaming correctness.
- The active view and legend or value interpretation are visible to the user.

### REQ-DEMO-7 — Coarse fallback resilience

The demo MUST keep coarse geometry visible while fine pages are delayed or streaming is paused. Runtime integration tests MUST cover unavailable and terminally failed fine pages without injecting faults through viewer controls.

**Acceptance criteria**

- The statue remains completely represented during delayed and paused streaming.
- The runtime tests verify coarse coverage for unavailable and failed pages.

## 12. Verification Requirements

### REQ-VERIFY-1 — Converter fixtures

Automated converter verification MUST cover deterministic output, supported GLB/glTF ingestion, indexed and unindexed geometry, missing-normal generation, metadata/statistics, and every required failure class.

**Acceptance criteria**

- The converter test inventory maps each listed behavior and failure class to at least one passing fixture.

### REQ-VERIFY-2 — Format fixtures

Automated format verification MUST cover bootstrap ranges, page boundaries, version compatibility, invalid offsets, corruption, truncation, full-file HTTP 200 handling, and invalid partial responses.

**Acceptance criteria**

- The format test inventory maps each listed protocol and validation case to at least one passing fixture.

### REQ-VERIFY-3 — Selection fixtures

Automated deterministic fixtures MUST compare CPU and GPU cluster IDs across threshold boundaries, frustum boundaries, incomplete residency, hysteresis, and multiple transformed instances.

**Acceptance criteria**

- All fixture comparisons pass without missing, extra, or duplicate normalized cluster IDs.

### REQ-VERIFY-4 — Streaming and cache fixtures

Automated deterministic fixtures MUST verify concurrency bounds, deduplication, cancellation, priority ordering, bounded retries, cache accounting, pinned pages, frame-safe eviction, and residency hysteresis.

**Acceptance criteria**

- Instrumented tests demonstrate every listed bound and lifecycle invariant under both success and failure.

### REQ-VERIFY-5 — Integration verification

Verification MUST prove that non-MeshLoD scenes fetch no MeshLoD chunks and retain existing visual parity and bundle-size compliance.

**Acceptance criteria**

- Applicable existing parity and bundle checks pass with no MeshLoD chunk in non-MeshLoD runtime fetch logs.

### REQ-VERIFY-6 — Demo verification

The standalone demo MUST be manually or automatically verifiable for every required control, diagnostic, debug view, fallback scenario, and ready/error state.

**Acceptance criteria**

- A verification checklist or automated suite records a passing result for every `REQ-DEMO-*` requirement.

## 13. Out of Scope

The following are explicitly out of scope for the initial MeshLoD deliverable:

- Skinned meshes.
- Morphed meshes.
- Alpha-blended or transmissive materials.
- Simplification across material boundaries.
- Software rasterization.
- Visibility-buffer rendering.
- Browser-side hierarchy generation.
- A general-purpose asset conversion UI.
- One-file-per-meshlet output.
- Multi-pack output.
- Service-worker-specific caching policies.
- Raising existing bundle-size ceilings.
- Changing existing golden reference images.

## 14. Open Decisions

These decisions are not resolved by the approved goals and require user approval before architecture or implementation is finalized:

1. **Multi-primitive output naming:** whether one CLI `--output` path creates exactly one primitive container, a deterministic set of sibling `.mlod` files, or rejects inputs selecting more than one primitive.
2. **Binary compatibility details:** initial format version number, byte order, alignment, checksum/integrity mechanism, and forward-compatible optional-section rules.
3. **Page boundary exception:** whether the final streamed page may be smaller than 64 KiB or must be padded/combined.
4. **Default policies:** default screen-space error, LOD/residency hysteresis bands, cache budget, fetch concurrency, retry count/backoff, and simulated demo network values.
5. **Material support boundary:** the exact set of opaque Babylon Lite material features and texture combinations guaranteed in the initial renderer beyond the statue's needs.
6. **Runtime request customization:** whether applications must be able to supply request headers, credentials, a custom fetch function, or external cache integration.
7. **GPU timing fallback:** whether unavailable timestamp queries should hide the metric, show CPU timing, or report only “unsupported.”
8. **Deterministic camera path:** the exact path, duration, looping behavior, and whether it is required for automated demo verification.

## 15. Acceptance Criteria Summary

| Requirement group | Primary verification evidence |
| --- | --- |
| `REQ-NAME-*` | Repository layout, naming review, documented deliverables, statue workflow |
| `REQ-TOOL-*` | Clean CMake builds, CLI tests, dependency/version inspection, deterministic binary comparison |
| `REQ-GEO-*` | Supported and rejected glTF fixtures, hierarchy/material validation, crack-free cut fixtures |
| `REQ-FMT-*` | Binary parser fixtures, range server tests, metadata inspection, corruption/version tests |
| `REQ-LOAD-*` | Coarse-first initialization, invalid-budget tests, disposal and device-loss tests |
| `REQ-SEL-*` | Deterministic CPU oracle fixtures and CPU/GPU cluster-ID comparisons |
| `REQ-STREAM-*` | Instrumented request scheduler tests for range use, bounds, priority, deduplication, cancellation, and retry |
| `REQ-CACHE-*` | Byte-accounting and eviction stress tests with pinned/in-flight/current-frame pages |
| `REQ-RENDER-*` | Draw-submission instrumentation, material ownership review, frame-safe resource tests |
| `REQ-INT-*` | Public declaration review, import/fetch graph inspection, existing parity and bundle-size suites |
| `REQ-DEMO-*` | Standalone demo inspection covering controls, diagnostics, debug views, loading, and fallback |
| `REQ-VERIFY-*` | Automated test inventory and recorded passing results for the applicable implementation |
