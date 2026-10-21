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
  `linear` renders opaque discs at full resolution, independently of point
  density, render-scale divisor, and accumulated stochastic coverage.
  `alphaBlended` retains stochastic sampling and its premultiplied depth mean.
- `pointScale: number` (default `1`, finite and nonnegative).
- `renderScale: number | "auto"` (default `"auto"`; integer divisors 1–8).
- `occlusionCulling: boolean` (default `false`).
- `maxAccumFrames: number` (default `255`, integer 1–65535). Per-pixel samples
  after which accumulation converges and point compute stops; the composite
  keeps presenting the converged image. Mixed opaque scenes keep monitoring
  visibility without advancing progress or readbacks. Changing it never discards samples:
  raising it resumes refinement, lowering it stops sooner.
- `temporalReprojection: boolean` (default `false`, experimental, Lite-only).
  World/view/projection changes remap the accumulation into the new view
  instead of hard-resetting it, so sampling noise is limited to disocclusions
  and screen borders. See _Temporal reprojection_ below.
- Read-only `progress`, null before rendering and after disposal, otherwise
  `{ renderedFrameCount, accumulatedSamples, accumulationVersion, pixelCycleLength }`.
  `renderedFrameCount` counts dispatched frames since the last accumulation
  reset and stops growing once converged; `accumulatedSamples` is the completed
  per-pixel sample count, saturating at `maxAccumFrames`. A phase-preserving
  refresh can require up to one extra partial cycle after this sample limit
  before dispatches stop, so every cycle slot processes the changed content.

`GaussianPointSplattingOptions` is the partial form of the mutable settings.
Repeated enable calls update the existing handle after validating options.
A target cannot be enabled in two scenes simultaneously.

The Trogir streaming demo exposes this state in its HUD. Point sampling defaults
off (`?points=1` opts in at startup); the first activation creates one handle and
subsequent toggles change `colorRenderMode`, retaining its GPU resources. The
enabled-only controls mutate density, render-scale divisor (labels 1, 1/2, 1/3,
1/4 map to values 1, 2, 3, 4), occlusion culling, experimental temporal
reprojection (`?reproject=1` opts in at startup), and accumulation limit.
Read-only progress shows accumulated samples against the limit (`X / max`) and
pixel-cycle length. An always-visible
FPS/frame-time counter averages the existing frame hook's deltas over at least
500 ms. HUD teardown disables the handle before stream/scene disposal.
The demo bounds its canvas backing-store area by the engine's guaranteed buffer
limits divided by 16 bytes per full-resolution accumulation pixel. A
layout/DPR observer updates `maxDevicePixelRatio` and resizes the surface outside
the render callback, including after CSS resize, browser zoom, and display changes.
This cap is independent of the point render-scale divisor and also bounds the
optional reprojection history buffers. Failed activation clears the checkbox,
hides point controls, and displays a status message without stopping the classic
renderer or invoking the startup-failure overlay.

## Internal Architecture

`gps-suppression.ts` owns a lazy per-scene tracker shared by enabled handles.
It scans `scene._renderables` on enable and before every frame, including
renderables produced by deferred registration. It excludes point renderables.
For static targets, transparent renderables with order 200 are candidates.
For streams, the existing `stream._renderable` identifies the candidate directly.

Each candidate's `bind` is wrapped without changing its batch list, pipeline,
or binding receiver. Its `draw` receives a forwarding Proxy,
cached per render-pass or render-bundle encoder. All native encoder methods are
called with the real encoder as `this`.

An intercepted `setVertexBuffer` identifies a static target by GPUBuffer identity:
both base and SH classic pipelines bind `mesh._gs._splatIndexBuffer`. Ordinary
PLY/splat, SOG, SPZ, and glTF splats use `attachParsedSplat`; procedural splats
attach the same base classic pipeline directly. Thus neither path needs a mesh
backlink. Discovery runs even with color rendering off. Once a target is known,
only `draw`, `drawIndexed`, `drawIndirect`, and `drawIndexedIndirect` are
swallowed while its `colorRenderMode` is enabled. All binding-side notifications
and stream selection/canonical-gather work still execute. After the stream's
bootstrap draw notification, its shared batch's `queue` wrapper substitutes the
last completed projection key while point color is active. The existing batch
therefore gathers changed canonical records without repeating classic projection,
compaction, or radix sorting. Bootstrap projection/readback and draw notification
run normally; switching color mode off queues the real key again, so changed
content or view is sorted before the classic draw.

For static meshes, classic updates run through first-sort completion, preserving
`firstSortReady`, then pause while point color is active. This avoids worker sorts
and sorted-order uploads. On classic reactivation, pending orders are recycled
without uploading and the existing two-buffer worker pool drains. The next
classic update forces a fresh sort; classic draws remain gated until that result
is uploaded. Subsequent camera motion uses the normal asynchronous classic sort
policy, so continued motion cannot indefinitely delay reactivation. This gate also survives
feature disposal: restoration of the classic `bind` waits for fresh ordering.
All of this policy lives in the opt-in suppression module, with no feature
imports, metadata, or branches added to classic loaders or mesh pipelines.
Suppressed bindings report zero draw calls.

An observed draw without a matching buffer identifies a non-target candidate.
Its original `bind` is restored, its cached wrapper becomes a forwarding
no-op, and `scene._renderableVersion` is incremented. Rejected candidates are
not rewrapped each frame; enabling another target resets that rejection cache.
Disabling restores owned wrappers, including cached bindings, and removes the
scan hook when the last handle is removed.

## Pipeline Configuration

The feature owns compute pipelines for preprocessing, block/sum prefix scans,
scan addition, partitioning, stochastic sampling, resolve, and optional Hi-Z.
Compute and composite variants are retained in a lazily initialized
`WeakMap<GPUDevice, DeviceCache>` so alternating engines reuse their own pipelines
after warm-up without retaining unused devices or allocating caches at import time.
The composite is a fullscreen triangle with premultiplied-alpha blending,
unconditional composite depth comparison, optional geometric depth writes,
and the target's multisample count. Color writes are enabled for color
mode or for depth mode with an explicit non-`none` depth visualization.

Splat working buffers track active count separately from capacity. They retain
their allocations and compute bind groups across decreases and increases within
capacity, grow geometrically when needed (bounded by device buffer limits), and
retire replaced buffers after submission. Allocation sizes use capacity; uniforms,
scan lengths, and dispatch workgroups use only the active count.

The shared `Params` uniform is 80 floats / 320 bytes. The first 76 floats retain
their existing matrix, resolution, sampling, generation and visualization layout.
The final vec4 is `(historySampleIndex, historySamples, viewportX, viewportY)`.
Each native sample owns separate full-resolution color/depth/count/native-depth
buffers indexed by `y * width + x`. Separate planes preserve the original
single-sample maximum dimensions under default storage-binding limits; four
samples must not require one four-times-larger binding. Resolve and monitoring
process each plane with its own 320-byte parameter buffer. Resolve loads shared
point keys for earlier planes and clears them only in the last plane.
The composite binds one color/depth pair per plane (eight storage bindings for
four samples) and selects the appropriate pair with `sample_index`.
Splat-only stochastic views share one history across destination samples; mixed
views and deterministic disc rasters retain every native sample.

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

The point-count buffer contains two `u32` words: total points and the positive
float bits of the stream's maximum sampled radiance. Each streamed preprocess
clears the second word, then atomically reduces the maximum nonnegative RGB
component of its sampled screen records. Sampling divides by the greater of
this maximum and the static radiance scale (1, or 8 for static SH); resolve
multiplies by exactly the same scale. Thus RGB565 quantization does not clip
streamed HDR colors before averaging coverage, and each frame's accumulation
remains in radiance units even when the scale changes.

Depth visualization reconstructs view depth from all four Z/W projection
coefficients: `(P32 - z * P33) / (z * P23 - P22)`. Evaluating this at the
stored reverse-Z depth, 1, and 0 gives surface depth, near, and far respectively,
so linear and alpha-blended grayscale support both perspective and orthographic
static cameras. Alpha-blended resolve converts each visualization sample to linear
depth before averaging, storing premultiplied grayscale in the existing color
history; geometric depth remains separate for depth writes/reprojection.
Non-alpha-blended linear resolve instead displays the nearest deterministic
disc's depth with full coverage, as detailed below. Visualization
camera changes reset history rather than reprojecting depth-dependent grayscale.

Visibility uses the consuming task's actual depth attachment, not a geometry replay
with a different sample count or depth/stencil format. A feature-owned task/encoder
adapter defers point compute until the point binding is reached in the native pass.
It ends that pass, samples its depth-only view, and resumes color/depth/stencil
attachments with `load`, restoring dynamic viewport/scissor/stencil/blend state and
the scene bind group. Native geometry executes only once. Consequently native
alpha-to-coverage, stencil writer/tester ordering, merged ShaderMaterial geometry,
thin-instance LOD, and depth loaded from earlier shared/eager tasks remain intact.
The adapter forwards all native methods with their real receivers and cooperates
with transmission's existing split passes; it is removed on last-handle disposal.
It instruments the command encoder's `beginRenderPass` method temporarily, never
the command encoder's identity, so submission fences and readbacks still match.
Original method descriptors are restored in `finally`; existing GPU timing
instrumentation remains in the call chain. Added/replaced tasks are discovered
before rendering and when point bindings are built. Superseded, removed and
disposed wrappers are deactivated, so another feature retaining a captured wrapper
cannot keep point instrumentation alive. Last-handle release is idempotent.

The adapter tracks actual preceding draw commands, including transparent depth
writers and earlier point draws. Unknown render bundles conservatively count as
possible depth contributors; only the task's native opaque bundles with an empty
opaque binding list are proven empty. A depth clear resets this evidence; LOAD
segments retain it. Loaded shared/eager depth remains a source even without any
preceding draws in the current task. Transparency, missing mesh backlinks,
pipeline labels and order never prove a native draw cannot write depth.
Preparation checks convergence before pausing the native pass, so unchanged
unmonitored point-only views composite without an extra pass boundary or resolve.

Mixed MSAA visibility keeps separate color/depth/count/previous-depth histories for
each consuming-pass sample. Resolve compares the current stochastic hit with each
native depth sample before averaging; the composite selects that sample's history
with `sample_index`. Averaging coverage into one pixel alpha would incorrectly dim
the opaque foreground and is not permitted. Camera viewport offsets address the
original full-size depth texture. Every plane is checked against device limits
before allocation, without reducing native sample coverage. Camera-less or empty effective
viewports are rejected before recording; restoring eligibility resets accumulation.
Previous-depth histories detect per-sample occluder changes and clear affected
histories, including cycle pixels not sampled in the current frame.
Visibility continues to be checked after convergence; unchanged converged pixels
remain frozen, while changed pixels resume independently. The sampling seed keeps
advancing the jitter cycle even though converged frame progress remains frozen.
The monitor reduces remaining work into a GPU flag and generates indirect
dispatches: words 1-3 are preprocessing/block-scan/scan-add arguments, 4-6 are
scan-sums arguments, 7-9 partition arguments, and each Hi-Z level has three
arguments starting at word 10. Level zero also drives resolve. An unchanged
converged view dispatches zero groups for these stages and stochastic sampling;
only cheap native-depth monitoring and the composite execute. This also handles
meshless native HDR/DDS backgrounds without guessing whether a renderable writes
depth. Changed depth resets the affected sample's history and wakes processing
until that sample independently reaches the accumulation limit.
Splat-only scenes retain
their original converged dispatch skip and allocate no opaque depth resources.

Hi-Z is never derived from stochastic splat hits. For supported reverse-Z opaque
passes, a dedicated compute pass reduces the current opaque texture to the farthest
view depth in each full-resolution pixel block (uncovered pixels contribute
infinity), then builds the maximum-depth hierarchy before preprocessing.
Without a conservative opaque source, or for other depth-comparison conventions,
culling is disabled rather than biasing translucent/background sampling.

Non-alpha-blended `linear` visualization uses a separate deterministic depth-only
disc rasterization at full output resolution. Preprocessing retains every valid
splat independently of point density/Poisson sampling and native Hi-Z. A reusable
disc cache must include geometry currently hidden behind a moving occluder.
The depth texture and raster pipeline use the consuming pass's sample count.
Disc support is
`delta^T inverseCovariance delta <= 2 * opacity`; surviving fragments are opaque
and reverse-Z depth testing selects the nearest disc. A resolve variant reads this
depth texture directly into opaque linear-depth output, without temporal averaging.
`alphaBlended` retains the stochastic premultiplied depth mean. Linear disc depth
uses the unquantized projected center depth, stored in the otherwise unused screen
RGB field for this mode.
An unchanged deterministic view completes after its first disc rasterization,
independently of `maxAccumFrames`. Its raw-disc validity key contains dimensions,
sample count, world/view/projection, streamed content generation and static-data
version, independently of the accumulation/visibility key. Adding or removing the
last native contributor resets visibility histories without invalidating the
unchanged raw discs. When opaque visibility still
needs monitoring, reuse the completed disc texture and run only visibility resolve;
do not repeat preprocessing or rasterization of unchanged discs.

## State Machine / Lifecycle

Each target/signature owns view state and GPU buffers. The generation key
includes the invalidating options (everything except `maxAccumFrames`, including
depth visualization), static target data version, world/view/projection
matrices, dimensions, and effective render scale. Any change hard-resets
accumulation. Static `updateData` is wrapped to bump a feature-owned content
version, then restored on disable.

Streamed content refreshes under a still camera soft-reset instead: the frame
counter is clamped to `min(GPS_SOFT_RESET_SAMPLES (8), maxAccumFrames - 1)`
samples while preserving the sub-pixel jitter phase. Each refresh also requires
at least one complete `n²`-frame cycle before convergence can stop dispatches,
including refreshes during a partial cycle and limits of one sample. Hi-Z rejection
is disabled for that whole refresh cycle; a current opaque hierarchy is built
before each subsequent eligible preprocessing pass. Resolve
clamps each pixel's running-mean count to the uploaded history cap (at most
`maxAccumFrames - 1`, allowing zero), so the incoming sample never exceeds the
limit and new LODs blend in without blanking sparse content
such as the environment sky. If a stream deferred its canonical gather
(`gatheredGeneration !== contentGeneration`), point compute is skipped for that
frame and the previous accumulation stays on screen. The automatic render scale
increases immediately but only refines once `sqrt(points/budget)` falls 1.25
below the current divisor, so noisy point-count readbacks cannot flip it and
reset every few frames. Once `floor(frames / cycle) >= maxAccumFrames` and the
pending refresh cycle is complete, the
compute dispatch and readback are skipped. Stream canonical gather
batches remain ahead of point compute. Resources are retired after submission;
busy asynchronous readbacks clean up after their mapping completes.

### Temporal reprojection (experimental)

The shaders and passes live in `gps-reproject.ts`, which is dynamically imported
on first use so scenes that leave the option off do not load them. Until the
module arrives, view changes keep restarting the accumulation.

Native-depth-monitored views conservatively hard-reset on world/view/projection
changes even when reprojection is enabled. Reprojecting an already mixed history
cannot safely test its individual samples against native geometry: moving a target
behind an unchanged occluder must not preserve its foreground color. The existing
single-history reprojection path remains available for splat-only color views.

With `temporalReprojection`, world/view/projection matrices leave the
generation key and are tracked separately. When they change, `prepare()` builds
`M = P·V·W · (P'·V'·W')⁻¹` and its inverse from the previous matrices. The
lazy module packs both column-major matrices at float offsets 0 and 16, then
the current inverse projection at offset 32 in a 52-float, 208-byte uniform.
`(width, height, generation, history cap)` follows at offset 48. If any inverse
is singular or non-finite, accumulation hard-resets. The full inverse projection
reconstructs positive finite current view depth as
`(P⁻¹ · clip).z / (P⁻¹ · clip).w`, supporting perspective (finite or infinite
far plane), orthographic, and off-axis projections without inferring depth from
the homogeneous scale of the inter-frame transform.
Before preprocessing, `record()` runs:

1. Copy accumulation, depth, and counts into lazily allocated history buffers
   (about 32 extra bytes per full-resolution pixel) and clear two scatter
   targets.
2. Scatter each valid previous pixel (current generation, nonzero count,
   positive depth in `(0, 1]`) through `M` from its pixel center and stored NDC
   depth. Reject nonpositive/non-finite W, out-of-range projected Z, and
   nonpositive/non-finite reconstructed view depth. Keep the nearest current
   reverse-Z projected depth `zc = clip.z / clip.w` per destination with
   `atomicMax(bits(zc))`; positive float bits preserve reverse-Z ordering.
3. Record the winning source pixel per destination. These scatter passes only
   estimate current depth; they no longer determine where history color is sampled.
4. Pull gather: choose the winner as the depth source. When at least six of eight
   neighbors have reconstructed current view depth more than 10% nearer, the pixel is a crack in a magnified
   surface and chooses the nearest neighbor's source. Empty pixels choose the
   farthest neighbor's source because disocclusions usually reveal background.
   Near/far neighbor selection uses reconstructed view depth, not homogeneous W
   or raw projected-depth ratios.
   Pixels without any source get zero color/depth and `generation << 16` (zero
   samples), preserving resolve's provisional hole fills.
5. Reproject the chosen source through `M` to obtain `zc = clip.z / clip.w`
   and reconstruct its current view depth `vc`. Build the destination's exact pixel-center NDC point
   `((d + 0.5) / size * 2 - 1)` with Y negated and Z set to `zc`, then transform
   through `M⁻¹` and divide by W. Previous fractional pixel coordinates are
   `(previousNdc.xy * (0.5, -0.5) + 0.5) * size - 0.5`, so integers denote
   centers. This backward mapping preserves subpixel motion instead of freezing
   at a rounded scatter destination.
6. Bilinearly sample the four history taps around that coordinate. A tap must
   be in bounds, have the current generation, positive count and depth, and
   have valid projected/current view depths and agree with the estimated depth:
   `abs(viewDepth(reprojectedTap) - vc) <= 0.05 * vc`.
   The 5% relative view-depth tolerance rejects different surfaces while allowing
   small local depth variation. Multiply bilinear weights by tap validity and
   renormalize. Count is the minimum count among positive-weight accepted taps,
   capped at `min(GPS_REPROJECTION_SAMPLES (16), maxAccumFrames - 1)` (at least
   one). If total weight is below `1e-4` or the backward transform has invalid W,
   copy the chosen source's color/count instead. Crack/hole neighbor fills halve
   the resulting count, with a minimum of one. Store `clamp(zc, 0, 1)` as depth.
   Gather still binds eight storage buffers; no extra storage is needed.

The frame counter is soft-reset to the same sample cap so accumulation resumes,
and a complete pixel cycle is required before convergence, even when motion
occurred partway through a previous cycle. Occlusion culling is skipped throughout
that refresh cycle, and resumes only from the current opaque depth. For the next
`n²` dispatched frames, resolve uses fill mode
(`state.z = 2`, versus `1` for a hard reset and `0` for normal accumulation).
The existing counts buffer is the hole mask: pixels in the current generation
with count zero receive the current low-resolution point sample's color and
depth across their `n×n` block, except for the cycle pixel. These provisional
fills keep count zero and are refreshed every frame, showing point-sampling
noise rather than the underlying scene until each pixel's cycle slot supplies
its first real sample with weight one. A new reprojection restarts the fill
window; hard resets clear it. No extra mask buffer is allocated.

History buffers are owned by the pixel-buffer target and retired with it;
the lazily initialized reprojection pipeline cache is keyed weakly by device.

Known limitations: one depth per pixel misplaces semi-transparent
edges, view-dependent SH color is reused until refreshed, repeated bilinear
resampling can soften moving surfaces, and the copy/scatter/gather passes cost
bandwidth on every moving frame. Neighbor depth estimates and nearest fallback
can still produce artifacts near disocclusions. Babylon.js has no equivalent.

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

`tests/lite/unit/gaussian-point-splatting-device-cache.test.ts` alternates two
devices after convergence and asserts that compute/render pipelines, shader
modules, and composite bind groups stop being created after warm-up. The same
test retains all three reprojection pipelines per device. A low-tier device
granting exactly 64,640,000 bytes per buffer/binding exercises the actual
accumulation/history allocation paths after a 2560×1600 high-DPI target is
bounded, then repeats after CSS resize and DPR changes. Observer disposal is
verified separately from GPU resource retirement.
`tests/lite/unit/trogir-point-sampling-activation.test.ts` exercises both
`?points=1` and interactive activation failures, verifies continued classic
streaming and visible status, and confirms that retry succeeds.

`tests/lite/unit/gaussian-point-splatting.test.ts` covers numeric helpers,
option validation/invalidation, pre/post-registration discovery, unrelated
renderables, native encoder receivers and proxy reuse, all four draw commands,
multiple targets, stream bootstrap/batches, disable/dispose restoration, buffer
retirement, capacity reuse and device-bounded growth with active-count dispatches,
accumulation resets, low-limit streamed refreshes with occlusion disabled across
every cycle slot, paired reprojection matrices and inverse projection, the 208-byte
uniform layout, and hard-reset fallback for singular/non-finite transforms.
Native-pass adapter tests cover receivers, dynamic state, LOAD/clear segments,
unknown and proven-empty bundles, captured wrapper deactivation and idempotent
release. Four-sample 2560x1440 allocations must fit the default 128 MiB storage
binding limit without changing sample coverage.
Numerical tests and hardware compute readbacks cover backward-motion foreground
collisions, lateral-motion depth rejection, orthographic and finite/infinite
perspective projections. The nonvisual hardware regression lives in
`tests/lite/integration/gaussian-point-reprojection.spec.ts`: it runs the actual
three compute passes on 12 pixels, reads winning source/color/depth/count
buffers, and checks a red foreground at view depth 2 against a green background
at depth 10. Backward translation by one unit must retain the foreground
(current view depth 3 versus 11); lateral translation must reject the background
bilinear tap despite both homogeneous scale ratios being one. It also rejects
history moved behind the camera or beyond the far plane, non-finite/out-of-range
stored depths, and verifies that hole filling selects the farther neighbor
using view depth during lateral motion. The test can reuse the running lab server by
setting `LAB_TEST_PORT` and requires WebGPU; it makes no screenshots or timing
assertions. Experimental reprojection has no Babylon.js equivalent/reference
capture; Spector inspection verifies its own three-pass layout and shader state,
not cross-engine pixel equivalence. Filtered bundle builds of scenes
120/122/123/124/226 must have exactly zero raw-byte growth against the clean tree.
Hardware WebGPU smoke checks exercise base and SH static pipelines without
visual comparison or performance measurements.
`tests/lite/integration/gaussian-point-sampling.spec.ts` runs real stream
preprocess, RGB565 sampling, resolve, and composite shaders with buffer/texture
readbacks. It verifies rejection against stale Hi-Z versus an unculled refresh,
per-frame HDR maxima that can increase or decrease, quarter-coverage radiance
accumulation (including radiance 2 producing 0.5), static base/SH shader compilation,
and both depth visualization modes at near/middle/far depths for perspective and
orthographic cameras with near/far planes 1/11. Alternating foreground/background
samples verify per-sample opaque rejection and mean linear-depth visualization;
occluder removal and arrival reset converged history. A real opaque render binding
also exercises native task execution, scene uniforms, attachments, and texture
sampling on WebGPU. Two meshes sharing one actual opaque ShaderMaterial produce
a meshless merged renderable: its depth must reject background samples, and hiding
both packets must reveal them. Actual thin-instance LOD bucket publication and
partner consumption must contribute depth, sharing one signature across source,
partner, and renderable-version refreshes. A 300-frame translucent red foreground /
blue background sequence must produce identical converged RGBA with conservative
culling enabled and disabled when opaque depth is empty. Both colors must survive.
Deterministic linear-depth rasterization must cover the opacity-scaled discs,
select the nearer of overlapping discs regardless of submission order, and work
with point density zero; the separate alpha-blended cases retain the weighted mean.
Real four-sample native ShaderMaterial tasks cover zero/partial alpha-to-coverage,
ordinary silhouettes, stencil-conditioned depth, shared-RT loaded depth, eager
external depth, transmission splits around the point draw, and a fractional
101-pixel right-half viewport including its 51st pixel. A real native HDR cubemap
skybox plus the full point runtime must converge to zero indirect work, wake on
native depth changes, and reconverge. Moving the target across a fixed occluder
with reprojection enabled must reset rather than preserve stale foreground color.
Four-sample linear discs rasterize once, including initially occluded geometry;
hiding that occluder reveals the cached discs without rerasterization.
`gaussian-point-scene-depth.test.ts` covers borrowed native attachment ownership,
render-task filtering, loaded-only overlays, native viewport rounding,
shared persistent signature identity, and missing-camera / empty-viewport rejection.
It also verifies encoder identity, native receivers, load-descriptor cloning,
dynamic state restoration, multiple native pass segments, reference-counted
installation, late/replaced/removed tasks, and exception cleanup.
Runtime tests also exercise restored
eligibility and generation resets. The two GPU readback specs run in the dedicated nonvisual
BrowserStack WebGPU CI job without screenshots, video, or trace artifacts.

## File Manifest

- `gaussian-point-splatting.ts`: public enabler, ownership, and teardown.
- `gps-suppression.ts`: opt-in classic-draw discovery and suppression.
- `gps-state.ts`: state types, validation, invalidation, numeric helpers.
- `gps-runtime.ts`: GPU resources, compute batches, composite material.
- `gps-pass.ts`: feature-owned native-pass barriers and lifecycle.
- `gps-scene-depth.ts`: borrowed consuming-pass depth and native viewport mapping.
- `gps-reproject.ts`: lazy experimental depth scatter and bilinear pull gather.
- `gps-shaders.ts`: compute and composite WGSL.
