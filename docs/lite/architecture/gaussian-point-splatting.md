# Module: Gaussian Point Splatting

> Package path: `packages/babylon-lite/src/gaussian-point-splatting/`

## Purpose

Opt-in stochastic Gaussian rendering for static splat meshes (including SH) and
streaming splats. All integration belongs to this folder: classic meshes,
loaders, and pipeline builders contain no point-renderer metadata or branches.
Importing the root package without enabling this feature must add exactly zero
runtime bytes to unrelated scenes.

## Public API Surface

The root package exports `enableGaussianPointSplatting(scene, target, options?)`
and `disableGaussianPointSplatting(scene, handle)`. The target is a
`GaussianSplattingMesh | GaussianSplatStream`; the returned
`GaussianPointSplatting` is mutable plain state with:

- `colorRenderMode: boolean` (default `true`).
- `depthRenderMode: boolean` (default `false`).
- `depthVisualization: "none" | "linear" | "alphaBlended"` (default `"none"`).
  This is the point-path equivalent of `gsLinearDepthFragment` /
  `gsAlphaBlendedDepthFragment`. The caller must set it consistently with the
  fragments applied to the classic mesh. Depth visualization is displayed when
  `depthRenderMode` is enabled; no fragment introspection is performed.
- `pointScale: number` (default `1`, finite and nonnegative).
- `renderScale: number | "auto"` (default `"auto"`; integer divisors 1–8).
- `occlusionCulling: boolean` (default `false`).
- `maxAccumFrames: number` (default `255`, integer 1–65535).
- Read-only `progress`, null before rendering and after disposal, otherwise
  `{ renderedFrameCount, accumulationVersion, pixelCycleLength }`.

`GaussianPointSplattingOptions` is the partial form of the mutable settings.
Repeated enable calls update the existing handle after validating options.
A target cannot be enabled in two scenes simultaneously.

The Trogir streaming demo exposes this state in its HUD. Point sampling defaults
off (`?points=1` opts in at startup); the first activation creates one handle and
subsequent toggles change `colorRenderMode`, retaining its GPU resources. The
enabled-only controls mutate density, render-scale divisor (labels 1, 1/2, 1/3,
1/4 map to values 1, 2, 3, 4), occlusion culling, and accumulation limit.
Read-only progress shows rendered frames and pixel-cycle length. An always-visible
FPS/frame-time counter averages the existing frame hook's deltas over at least
500 ms. HUD teardown disables the handle before stream/scene disposal.

## Internal Architecture

`gps-suppression.ts` owns a lazy per-scene tracker shared by enabled handles.
It scans `scene._renderables` on enable and before every frame, including
renderables produced by deferred registration. It excludes point renderables.
For static targets, transparent renderables with order 200 are candidates.
For streams, the existing `stream._renderable` identifies the candidate directly.

Each candidate's `bind` is wrapped without changing its update functions, batch
list, pipeline, or binding receiver. Its `draw` receives a forwarding Proxy,
cached per render-pass or render-bundle encoder. All native encoder methods are
called with the real encoder as `this`.

An intercepted `setVertexBuffer` identifies a static target by GPUBuffer identity:
both base and SH classic pipelines bind `mesh._gs._splatIndexBuffer`. Ordinary
PLY/splat, SOG, SPZ, and glTF splats use `attachParsedSplat`; procedural splats
attach the same base classic pipeline directly. Thus neither path needs a mesh
backlink. Discovery runs even with color rendering off. Once a target is known,
only `draw`, `drawIndexed`, `drawIndirect`, and `drawIndexedIndirect` are
swallowed while its `colorRenderMode` is enabled. All binding-side notifications
and stream gather/update work still execute. Suppressed bindings report zero
draw calls.

An observed draw without a matching buffer identifies a non-target candidate.
Its original `bind` is restored, its cached wrapper becomes a forwarding
no-op, and `scene._renderableVersion` is incremented. Rejected candidates are
not rewrapped each frame; enabling another target resets that rejection cache.
Disabling restores owned wrappers, including cached bindings, and removes the
scan hook when the last handle is removed.

## Pipeline Configuration

The feature owns compute pipelines for preprocessing, block/sum prefix scans,
scan addition, partitioning, stochastic sampling, resolve, and optional Hi-Z.
The composite is a fullscreen triangle with premultiplied-alpha blending,
the target's depth compare (default reverse-Z `greater-equal`), optional depth
writes, and the target's multisample count. Color writes are enabled for color
mode or for depth mode with an explicit non-`none` depth visualization.

## Shader Logic

Preprocessing reads static center/covariance/color textures and optional SH
textures, or the stream's 64-byte canonical records. It projects covariance,
computes a Poisson sample count, and stores a 64-byte screen record. Prefix scans
and a 65537-entry partition table map point indices to Gaussians. Sampling
atomically chooses the nearest depth/RGB565 key per pixel. Resolve clears these
keys and updates generation-tagged running color averages and depths.
The composite displays accumulated color or the explicit linear/alpha-blended
depth mode. Shader definitions and SH degree specialization are in
`gps-shaders.ts`.

## State Machine / Lifecycle

Each target/signature owns view state and GPU buffers. The generation key
includes all mutable options (including depth visualization), target data/content
generation, world/view/projection matrices, dimensions, and effective render
scale. Any change resets accumulation. Static `updateData` is wrapped to bump a
feature-owned content version, then restored on disable. Stream canonical gather
batches remain ahead of point compute. Resources are retired after submission;
busy asynchronous readbacks clean up after their mapping completes.

## Babylon.js Equivalence Map

Color/depth switches, stochastic sampling density, automatic render scale,
accumulation progress, and depth visualization correspond to the upstream point
splatting modes. Classic shader fragment selection is explicitly mirrored by the
caller rather than inferred through metadata added to classic meshes.

## Dependencies

Scene/renderable contracts, cameras, engine GPU retirement and flags, streaming
canonical buffers/batches, and the local state/shader modules. No general-purpose
module imports this feature.

## Test Specification

`tests/lite/unit/gaussian-point-splatting.test.ts` covers numeric helpers,
option validation/invalidation, pre/post-registration discovery, unrelated
renderables, native encoder receivers and proxy reuse, all four draw commands,
multiple targets, stream bootstrap/batches, disable/dispose restoration, buffer
retirement, and accumulation resets. Filtered bundle builds of scenes
120/122/123/124/226 must have exactly zero raw-byte growth against the clean tree.
Hardware WebGPU smoke checks exercise base and SH static pipelines without
visual comparison or performance measurements.

### Scene 331 — converged point sampling

`lab/lite/src/lite/scene331.ts` reuses scene 122's hornedlizard SOG, SH
shading, black clear color, and fixed initial camera (alpha 4.6, beta 0.956,
radius 3, target `[0, -0.2, 0.2]`, near 0.001, far 1000). It enables point
splatting with `renderScale: 1`: this API uses integer resolution divisors,
so 1 samples every output pixel each frame (`pixelCycleLength === 1`).
All other point settings retain their defaults. Readiness waits for
`firstSortReady` and at least 300 accumulated frames before publishing
`canvas.dataset.ready`, `renderedFrameCount`, `pixelCycleLength`, `drawCalls`,
and `initMs`. Camera controls remain available for interactive inspection.

The BJS reference feature-detects `pointSplattingRenderMode`, sets
`pointSplattingRenderScale = 1`, and waits for
`pointSplattingProgress.renderedFrameCount >= 300`. Importing the non-pure
`gaussianSplattingMesh` module registers its optional controller in releases
containing BabylonJS/Babylon.js#18962. Until such a release is installed, the
reference uses scene 122's classic sorted-SH rendering and reports
`dataset.renderMode = "classic"`. npm 9.31.0 was published on 2026-10-15 at
08:13 UTC, before that PR merged at 13:53 UTC; it does not contain the feature.
The scene's MAD ceiling is provisionally 1; the reference golden must be
recaptured explicitly when the dependency is upgraded to the first release
containing the PR. Scene 331's thumbnail is captured from the converged Lite
render while the BJS reference remains on the classic fallback.

## File Manifest

- `gaussian-point-splatting.ts`: public enabler, ownership, and teardown.
- `gps-suppression.ts`: opt-in classic-draw discovery and suppression.
- `gps-state.ts`: state types, validation, invalidation, numeric helpers.
- `gps-runtime.ts`: GPU resources, compute batches, composite material.
- `gps-shaders.ts`: compute and composite WGSL.
