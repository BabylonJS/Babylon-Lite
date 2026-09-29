# MeshLoD Goals

## Purpose

Add an opt-in MeshLoD feature to Babylon Lite that preprocesses large static meshes into meshlets and a clustered level-of-detail hierarchy, selects the appropriate meshlets from camera screen-space error, and renders them efficiently with WebGPU.

## Product Goals

- Add MeshLoD as a tree-shakable engine feature with no runtime cost or fetched code for scenes that do not enable it.
- Add a standalone Babylon Lite demo that makes meshlet selection, LOD transitions, hierarchy structure, and streaming residency observable.
- Use `harvard-yenching_institute_statue.glb` from the repository root as the first end-to-end asset.
- Preserve a coarse renderable fallback at all times so delayed or failed fine-detail streaming never creates holes.
- Design the asset format for streaming without producing one file per meshlet.

## Acceptance Criteria

- Existing non-MeshLoD scenes fetch no MeshLoD runtime chunks and continue to pass all bundle-size ceilings.
- The converter produces byte-identical `.mlod` output for the same input, options, dependency revisions, and tool version.
- CPU and GPU selection return the same cluster IDs for deterministic camera/error/residency fixtures.
- The selected cut respects the configured screen-space error threshold and remains stable under small camera movement through explicit hysteresis.
- The renderer submits no CPU draw call per meshlet. The initial target is one indirect draw per compatible material/hierarchy render batch.
- The GPU cache stays within its configured byte budget except for at most one page currently being uploaded; coarse pinned pages count toward and must fit inside the configured minimum budget.
- Streaming uses bounded request concurrency, deduplicates requests, supports cancellation, and never removes the last resident coarse representation.
- Corrupt, truncated, unsupported, or version-incompatible inputs fail with explicit errors rather than partial success or silent fallback.
- The statue demo exposes enough diagnostics to verify source/rendered triangle counts, selected meshlets, hierarchy depth, screen-space error, page requests/residency, downloaded bytes, cache use, and GPU timing.

## Offline Tool Goals

- Maintain the self-contained converter at the root of [MegameshCLI](https://github.com/CedricGuillemet/MegameshCLI), independently of Babylon Lite.
- Build the tool with CMake.
- Use CMake `FetchContent` to fetch pinned meshoptimizer and cgltf revisions.
- Use cgltf to read glTF and GLB assets.
- Use meshoptimizer's clustered LOD and meshlet facilities to build the hierarchy and payloads.
- Generate a versioned `.mlod` sidecar from `harvard-yenching_institute_statue.glb`.
- Provide validation and useful statistics for groups, meshlets, triangles, hierarchy depth, bounds, and simplification errors.
- Provide a non-interactive CLI accepting input and output paths plus explicit conversion options.
- Make dependency revisions and format/tool versions visible in the generated metadata and `--version` output; report the compiler target in `--version`, not in the deterministic `.mlod` fingerprint.
- Return a non-zero exit code with a precise diagnostic for unsupported primitive modes, compression extensions, malformed accessors, invalid hierarchy output, or file I/O failures.

The expected initial workflow is:

```text
cd MegameshCLI
cmake -S . -B build
cmake --build build --config Release
build/.../mesh-lod-tool --input assets/harvard-yenching_institute_statue.glb --output harvard-yenching_institute_statue.mlod
```

The exact executable location remains generator-dependent; documentation must show Windows single-config and multi-config forms used by this repository.

## Asset Contract

- The initial deliverable is one versioned `.mlod` binary container per converted glTF primitive hierarchy.
- The container is served with `Content-Encoding: identity` and supports HTTP byte-range requests.
- Resident metadata and pinned coarse pages are at known ranges near the beginning of the container.
- Streamed geometry is organized into independently decodable 64-256 KiB pages containing multiple meshlets.
- If a server ignores a range request and returns HTTP 200 with the full file, the loader may retain and use that complete response. Other range/protocol failures are surfaced explicitly.
- One-file-per-meshlet output and thousands of network resources are out of scope.
- Optional multi-pack output is deferred until measurements show that a single range-addressable container is operationally unsuitable.

## Runtime Goals

- Load resident hierarchy metadata and coarse meshlet pages first.
- Select a crack-free clustered LOD cut using camera position, projection, and a screen-space error threshold.
- Frustum-cull clusters and render selected meshlets without CPU submission of one draw call per meshlet.
- Organize geometry into independently loadable pages suitable for HTTP range requests or a small number of packfiles.
- Refine a group only after all geometry required for that transition is resident.
- Make runtime memory and streaming budgets explicit and bounded.
- Prioritize page requests by visible screen-space benefit relative to transfer cost.
- Deduplicate and cancel obsolete requests as the camera moves.
- Retry only according to an explicit bounded policy; report terminal failures while continuing to render the nearest resident ancestor.
- Use LOD and residency hysteresis to avoid request/eviction thrashing.
- Evict only unpinned pages that are not in flight or required by the current submitted frame.
- Dispose CPU/GPU caches and abort outstanding requests when the MeshLoD asset is disposed.
- Recreate resident GPU state after WebGPU device loss using retained metadata and CPU page data or deterministic re-fetches.

## Babylon Lite Integration Constraints

- Public MeshLoD objects are pure state with behavior implemented as standalone functions.
- MeshLoD objects do not hold scene references; the scene owns registered renderables and lifecycle callbacks.
- Public APIs expose no raw WebGPU handles.
- Modules have no import-time side effects or eager module-level collections.
- The loader and render path are enabled through lazy, opt-in extension seams so unrelated bundles retain zero fetched MeshLoD bytes.
- Materials continue to own shaders, pipeline descriptors, and bind-group creation. MeshLoD integrates through material-owned renderable/vertex-processing variants rather than a renderer-owned shader path.
- GPU resources use make-before-break retirement and participate in device-loss recovery.

## Geometry Rules

- The initial converter accepts glTF `TRIANGLES` primitives with required `POSITION`.
- Indexed and unindexed primitives are accepted; unindexed input is indexed during preprocessing.
- Missing normals are generated offline. `TEXCOORD_0` is optional when the material does not require it.
- Unsupported compressed source primitives or unsupported accessor/component layouts fail with a precise converter error in the initial version.
- Hierarchies are built in primitive-local space. Normal scene/node world transforms remain runtime state, and multiple instances may share one hierarchy.
- Each material primitive is converted independently; simplification never crosses a material boundary.
- "Crack-free" means every rendered cut covers each source surface region at exactly one hierarchy resolution, shared group boundaries are protected during simplification, and refinement becomes visible only when the complete replacement group is resident.

## Initial Scope

- Static triangle meshes.
- Opaque geometry.
- One glTF material primitive per hierarchy.
- Hardware rasterization.
- Position, normal, and UV attributes required by the statue demo.
- CPU reference selection followed by GPU selection and indirect rendering.
- A configurable screen-space error threshold, page-cache budget, and bounded fetch concurrency.

## Deferred Scope

- Skinned or morphed meshes.
- Alpha blended or transmissive materials.
- Simplification across material boundaries.
- Software rasterization or visibility-buffer rendering.
- Browser-side hierarchy generation.
- General-purpose asset conversion UI.
- Multi-pack output and service-worker-specific caching policies.

## Demo Requirements

- Load the generated statue `.mlod` through the same public/lazy path intended for applications.
- Provide camera orbit/zoom and an optional deterministic camera path.
- Provide controls for screen-space error, cache budget, streaming pause, and simulated bandwidth/latency.
- Provide debug views for meshlet ID, LOD depth, selected group, page residency, and requested pages.
- Demonstrate uninterrupted coarse fallback while fine pages are delayed or unavailable.

## Naming

The feature, public documentation, demo, tool, and asset format use the name **MeshLoD**. Do not use third-party product names for the Babylon Lite feature.
