# Complete Diligent-style AO reconstruction

This specifies the shipped owner selected by `enableSsaoTemporal`. It supersedes
the archived custom-guide-only prototype under `scripts/ao-reference/legacy/`.
The unmodified reference mode establishes the baseline; production mode adds
the explicitly described rejection, quantization, and occlusion-history transport
safeguards. Both compare against pinned DiligentFX
`eaf6ab785968bdee2393210c5a67033a4d9140cc`.

## Pipeline and ownership

The opt-in temporal owner retains the stable public AO target and redirects
spatial estimation to private scratch. It owns two feedback histories, one
geometry history, a temporal intermediate, a five-mip AO/depth convolution
texture, and a resampled intermediate. No allocations or bind-group creation
occur on an unchanged frame.

AO feedback, temporal AO, convolution AO, and repaired AO use **R8_UNORM render
attachments**, matching native sampling and render-target conversion. Counts
use separate R16_FLOAT attachments; convolution depth uses R32_FLOAT.
Geometry is RG32_UINT: the exact bits of raw device depth, then the signed world
normal in octahedral form as two snorm16 values (about 5e-5 rad). Device depth is
never quantized, and the normal error is far below the 0.9 agreement cosine and
the 1e-4 plane allowance, so the normal-rejection contract is unchanged.
Only one geometry texture is necessary: transport and temporal accumulation
read previous geometry, then the existing final-output pass overwrites it with
current depth/world normals for the next frame. Geometry is never sampled by
that final pass, and later reconstruction stages use current source geometry
directly. This eliminates geometry ping-pong without adding a pass. At
1920x1080 the single history is 15.82 MiB (two RGBA32F lanes were 63.28 MiB);
AO/count/geometry persistent histories together total 27.69 MiB.
Working resolution and every feedback format remain unchanged.
The earlier single RGBA32_FLOAT history (43.51 MiB of histories) was bandwidth
bound: at 1920x1080 Full/High it cost about 0.020 ms more in the output pass
(16-byte write) and 0.013 ms more in temporal accumulation (four 16-byte
bilinear fetches) than RG32_UINT, net of decoding.
A byte-valued RGBA16F compute prototype did not match native
UNORM sampling/conversion and is not retained. Each stage renders a fullscreen
triangle, with separate cached attachment views per mip and history lane.
Spatial reconstruction and output are one fullscreen pass with three MRT
targets: R8 feedback, the stable normalized RGBA16F public output (quantized
exactly like the R8 value, `floor(clamp(ao,0,1)*255+0.5)/255`) and geometry
history.
Native history length is 16; the API's configured
maximum continues to be an upper bound.

Omitting the current normal input reconstructs normals from depth; those normals
are still stored in geometry history. Live normal-source mode changes recreate
this temporal owner and the sparse upsampler, but preserve the full-size spatial
owner and public visibility allocation. This keeps pre-recorded copy consumers
valid without a frame-graph rebuild.

The spatial owner's full-size AO/edge working textures are absent during active
Half estimation. Base/scratch spatial resolve bind groups are then null; the
half upsampler writes the full-size scratch instead. Full/Half transitions
rebind these groups without recreating history textures. Synchronize bindings
while temporal filtering is disabled as well, so resuming Full cannot restore
a cached group that references destroyed working textures. See module 56 for
the lazy allocation and ownership contract.

An isolated R32_FLOAT history trial retained production radiometric, dither,
and transport controls, replacing normal/curvature rejection with native 1%
view-depth acceptance. It would reduce geometry history to 7.91 MiB and total
AO/count/geometry history to 19.78 MiB at 1080p. It passed the close-up half-mode
pause/reversal case, but failed the default moving-sphere surface-flicker budget:
temporal/spatial RMS ratio 0.589 versus 0.477 with normal-aware history (limit
0.5). Occluded-surface long-history retention fell from 94.97% to 60.33%.
It also retained stale AO after a same-depth normal discontinuity. This trial
is not a shipped mode; normal-aware history with exact depth remains the default.

Geometry history stores exact current device depth. Temporal reprojection
uses current world position in previous camera space and closest-object motion
from a 3x3 reverse-Z depth search. Reference mode uses exactly native depth-only
acceptance and motion precision. Per-tap previous depth agreement is relative
view-depth error below 1%; bilinear coordinates clamp to screen bounds.
Compute each bilinear tap's weight before loading prior geometry/AO/counts.
Exactly zero-weight taps cannot affect these finite history accumulations;
skip their geometry reconstruction, normalization, and texture loads.
When a tap's stored normal word equals the encoding of the current world
normal, its previous-view normal is the already computed `previousNormal`;
curvature is exactly zero. Reuse that fact instead of transforming/normalizing the same
normal again. Nonidentical normals retain the original curvature calculation;
normal rejection, plane tolerance, locality, and confidence are unchanged.
Production mode additionally checks world-normal agreement (dot at least 0.9),
rejects invalid/background prior geometry, honors positive previous view depth
from RGBA velocity, and restarts a pixel on visibility jumps exceeding 0.5.
With exact previous surface depth, use the receiver's own XY motion rather than
dilated neighboring-object motion. Production per-tap acceptance uses the
previous-view tangent plane, with base tolerance
`max(1e-4,min(previousZ*0.005,radius*0.025))` plus curvature allowance
`0.5*length(deltaPosition)*length(deltaNormal)` and locality at most two AO radii.
The native 1% Z-only check otherwise rejects valid low-resolution curved
surface taps; it remains unchanged in reference mode.
The RGBA previous-depth path initializes previous pixel, motion, and previous
depth directly from the supplied material-point payload. Do not first compute
camera-only world reconstruction/projection whose results would be overwritten.
When the supplied previous depth agrees with the static camera-only previous
view depth within `max(1e-4, abs(cameraZ) * tolerance.x)`, substitute that exact
`cameraZ = dot(reprojectW, v) / dot(inverseW, v)` for current NDC `v`. Both rows
are row 3 of `previousVP * invVP` and of `invVP`, composed on the CPU in double
precision. Static receivers then reproject identically for RGBA32F and
RGBA16F velocity; only genuinely moving receivers see the source precision.
XY-only velocity and camera-only paths retain their original reprojection math.
These protections are disabled in the explicitly unmodified reference replay.
They do not introduce a broad clipping guide or a moving-floor history cap.
Production feedback also avoids the R8 accumulation deadband. When a mature
pixel's blended update is below half an R8 level, apply bounded unbiased
quantization dither using a spatially rotated bit-reversed frame sequence.
Include the exact half-level boundary with one float32 ULP of arithmetic
allowance (`0.5/255 + 1/8388608`); excluding that boundary leaves an eight-level
shadow stuck forever at the native sixteen-frame blend.
Otherwise an old shadow can remain permanently two levels dark with a four-frame
blend, or eight levels dark with a sixteen-frame blend, even when current AO is
white. Fresh/reset pixels and unmodified reference replay do not dither.
The dither lies strictly within half a level, so already-white background and
stable white receivers remain exactly white.
Do not dither an unchanged observation (`abs(current-old) <= 1/8388608`);
render-target conversion near the white endpoint can otherwise occasionally
move an already-cleared pixel down one byte.
Do not reduce production confidence for motion when current/history AO differ
by no more than one UNORM8 level plus half an input half-float ULP
(`1/255 + 1/4096`). Native strict inequalities otherwise treat unchanged white AO
as outside a zero-variance envelope and unnecessarily discard moving-surface
history. The unmodified oracle still retains its exact upstream behavior.
When that unchanged-observation condition holds, the variance envelope cannot
reduce confidence and the large-change condition cannot apply. Skip the unused
3x3 AO statistics, motion factor, square root, and gamma calculation entirely.
Otherwise retain the original neighborhood summation order, strict envelope,
and confidence update. This is work elimination, not looser clipping or a
change to history limits, R8 quantization, dither, or reconstruction.
Uniform control is reset, maximum samples, production guards, previous-depth
contract. Inverse view-projection recomputation is cached on ordinary unchanged
frames; cuts/projection changes invalidate it.

The quarter-resolution history experiment was removed with the unsupported
mode. Its lower-only clipping suppressed trailing but amplified localized
contact-shadow fluctuation, including at Ultra quality. The runtime retains
the accepted full/half temporal response without that clipping heuristic.

## Stages

Production history transport runs the original unmasked search by default.
`enableSsaoMotionPruning(task)` separately opts into a conservative object-motion
tile hierarchy. Its plain `enabled` setting supports live scene-specific toggles.
An 8x8 workgroup compares supplied material motion against
camera-only reprojection and ORs qualifying pixels within one tile through a
workgroup atomic. The whole hierarchy lives in one `STORAGE | COPY_DST` buffer
(`ssao-object-motion-mask`, `ssaoMotionMaskCellCount(w, h)` cells of four u32,
levels laid out consecutively). Each cell stores an inclusive pixel-space
bounding rectangle of its active base tiles as `(~minX, ~minY, maxX, maxY)`,
not an occupancy flag for its entire mip cell. A nonempty base tile contributes
its clipped 8x8 pixel extent. Clearing the buffer to zero therefore encodes the
empty rectangle `(0xffffffff, 0xffffffff, 0, 0)`.
The mask XY threshold is `0.025 + |suppliedMotion| * tolerance.y * 0.5` working
pixels, conservatively below the transport search's
`0.05 + |suppliedMotion| * tolerance.y`; its previous-depth test equals the
transport's. Background/reset pixels contribute zero.
Each moving tile's first lane updates every level in the same dispatch with
`atomicMax` on the four components: the level-m cell is
`min(tile >> m, levelSize_m - 1)`, which reproduces exactly the union of the
former stretched odd-edge mip reductions. Per frame the module clears the cell
buffer and the four-word indirect draw buffer, then records one dispatch.
A moving tile writes three vertices and one instance; otherwise the cleared
draw stays empty. A skipped transport draw clears its field to
zero and does not search an entirely static scene.

For a drawn transport pass, each receiver reads the hierarchy from the
read-only storage buffer at transport binding 8 over a
conservative square covering its exact clamped search circle. A mip whose
tile span covers the square needs at most four reads. Test the stored active
bounds against the receiver's clipped pixel-space search square. Thus one
moving object in a 512-pixel mip cell does not activate that whole cell.
If none of the bounds intersects, return the existing zero-transport result before the 36-tap
search. Otherwise execute the original search unchanged, in the same order.
The hierarchy changes work selection, not displacement, history confidence,
or AO arithmetic. The separate `ssao-motion-pruning.ts` module owns all mask
allocation, pipelines, bindings, dispatches, shader guard, and disposal.
The temporal controller exposes only an internal optional GPU-preparation
callback. The native-format owner exposes an optional transport extension:
its pipeline replaces the original transport pipeline, its cached resources
append to transport bindings, and it supplies the indirect draw buffer and
execution/disposal hooks. The owner compares the bound extension identity so
toggling rebuilds pass bindings without destroying any history.

The enabler installs the preparation callback only on temporal tasks with
velocity. It creates/rebinds the extension while both temporal filtering and
pruning are enabled; otherwise it releases the mask and removes the extension.
Source identity changes refresh mask bindings without replacing textures.
Size/device changes create a new owner; disposing an owner disposes its
extension exactly once. The default path imports no pruning module or mask
shader and records no mask work. The masked shader uses generic declaration
and pre-search injection arguments to the shared transport shader generator,
not string parsing or replacement. Both paths retain the original 36-tap
search and accumulation order, and mode changes preserve the history index,
counts, AO phase, feedback textures, and stable public output.

1. Temporal accumulation: current local unweighted 3x3 mean/variance, native
   motion-dependent variance gamma 0.5..2.5, and native observation-count update.
   Preserve the original unclipped-history behaviour for baseline validation.
   Let the R8_UNORM render attachment perform native AO conversion.
2. Convolution mip 0: temporal AO plus current device depth, written directly
   by temporal accumulation's MRT outputs. The temporal intermediate aliases
   convolution AO mip zero; no copy shader/pass or separate R8 texture exists.
   Four reductions
   reproduce the native 4/6/9-sample odd-dimension rule and summation order.
   AO is converted to R8 at each mip; depth remains float32.
3. History repair: for count below five, select mip
   `int(4*(1-saturate((count-1)/4)))`, descending until geometry-weighted bilinear
   coverage is at least 0.995. Use the native fractional virtual mip resolution,
   nearest AO lookup, bilinear device depth, and tangent-plane weighting
   `saturate(1-abs(dot(delta,normal))*10/(1+viewDepth))`.
4. Spatial reconstruction and output (one pass): native eight-point Poisson
   disk and frame-stable Bayer rotation; radius
   `4*(1-saturate(pow(abs((count-1)/8),0.2)))`. Gaussian weight is
   `exp(-distanceSquared/(2*0.9*0.9))`, multiplied by geometry weight. Counts
   at least nine bypass the filter and keep the repaired value.
5. The same pass writes final AO to R8 and feeds that reconstructed value back
   into history, matching the native pipeline, and writes normalized public
   visibility and current geometry as two further MRT attachments. It reads the
   exact current depth attachment and computes the same signed normalized world
   normal used by temporal accumulation, including zero normal for background.
   Both geometry consumers have already completed.

## Internal interfaces and binding layout

```ts
function createDiligentTemporalGpu(
    owner: SsaoGpu,
    velocity: GPUTextureView | null,
    transport?: boolean, // default false
    previousDepth?: boolean // default false
): DiligentTemporalGpu;
function bindDiligentTemporalGpu(state: DiligentTemporalGpu, velocity: GPUTextureView | null): void;
function executeDiligentTemporalGpu(state: DiligentTemporalGpu, encoder: GPUCommandEncoder): void;
function disposeDiligentTemporalGpu(state: DiligentTemporalGpu): void;
```

The owner retains `scratch`, two `history`, two `counts`, one `geometry`,
`convolution`, `convolutionDepth`, `repaired`, and optional
`closestMotion`/`transport` textures; the 384-byte `uniform` and 96-float `data`;
the borrowed source identities; original/scratch spatial resolve bind groups;
`index`, `disposed`, pipelines, and two arrays of cached
`{ pipeline, group, pass: GPURenderPassDescriptor }` stages. It owns no scene.
An internal `DiligentTransportExtension` optionally supplies `pipeline`,
`resources`, `indirect`, `execute(encoder)`, and `dispose()`.
The last bound extension identity is cached separately. There is no default
motion-pruning flag on the factory.
`intermediate` is a diagnostic alias of `convolution`, not another allocation,
and must not be destroyed separately. The convolution AO texture keeps the
`ssao-diligent-temporal` label for existing capture observers.
Every owned texture supports sampling, rendering, and readback; only RGBA16F
scratch additionally supports storage writes for the estimator. Convolution
mip count is `min(5,floor(log2(max(width,height)))+1)`.

All shaders share the estimator's 176-byte AO parameters at binding zero except
reductions. The temporal uniform consists of inverse current
view at byte 0, previous view at 64, previous VP at 128, four control floats at
192, inverse current VP at 208, inverse previous VP at 272, `tolerance` at 336
(x: relative previous-depth tolerance, y: relative motion tolerance; `1e-5`/0
for float32 velocity, `2^-10` for both with `rg16float`/`rgba16float`),
`reprojectW` at 352 and `inverseW` at 368 (384 bytes). Temporal binding
order is AO parameters, raw depth, current scratch AO, closest motion, prior R8
AO, prior geometry, prior count, temporal parameters, current transport,
current normal, original supplied velocity. Targets are convolution mip-zero
R8 AO, next R16 count, and convolution mip-zero R32 depth.
Three attachments use 7 logical bytes per sample, within the baseline WebGPU 32-byte
limit. AO still goes through native R8 render-target conversion exactly once;
depth remains exact float32. Subsequent reductions use separate single-mip
views and separate passes, so sampled/attachment usage never overlaps.

Transport bindings are AO parameters, current depth/normal/velocity, current
scratch AO, prior R8 AO, prior geometry, temporal parameters. It writes RGBA32:
previous normalized UV, previous device depth, and positive projected physical
AO radius (zero radius means no transport). Search three radial rings and
twelve directions; offset angle is `direction*pi/6`. Ignore background, points
outside physical/search radius or below 0.005 receiver-plane height, and
camera-subtracted motion below 0.05 pixels. Weight by squared distance falloff
and positive elevation cosine. Reject recovered motion beyond the smaller of
0.1 search radius and twice its projected displacement, or predominantly
normal rather than tangential displacement. Static competition uses the
physical radius even during an expanded departing-shadow search.
Ring radius is invariant within its direction loop. Keep the original
f32 sine/cosine expressions and ring/direction order; there is no angular
approximation, sample-count reduction, or change to the search footprint.
Reject samples below the receiver plane before calculating their Euclidean
distance. Reuse that same plane dot product for the elevation cosine. This
preserves tap order and all acceptance thresholds while avoiding square roots
for coplanar/below-plane samples.

Reduction bindings are preceding AO/depth mip views; targets are R8 AO plus
R32 depth. There is no mip-zero pipeline or bind group.
History repair bindings are AO parameters, current depth/normal/count, all AO
mips, all depth mips, linear-clamp depth sampler, point-clamp AO sampler.
Use hardware linear depth only with `float32-filterable`; otherwise emit manual
bilinear texture loads. Repair targets R8.
The spatial/output pass binds AO parameters, raw current depth, current normal
(or the existing dummy normal), current count, repaired AO, and the temporal
uniform buffer (for its leading inverse-current-view matrix), at bindings 0..5.
It targets next R8 feedback, the original managed RGBA16F visibility
allocation and the single RG32_UINT geometry history: 20 bytes per sample
under WebGPU attachment alignment, within the baseline 32-byte limit. The
geometry target is not also bound as an input. Ping-pong applies only to
AO/count feedback, not geometry; both cached history lanes sample the same
geometry texture.

Without velocity, omit motion and transport passes. With exact previous-depth
velocity, omit both allocation and dispatch of the closest-motion pass: material
point reprojection reads the original RGBA payload. XY-only input retains
native closest-motion preparation. On source/size/device changes recreate
bindings/owners; unchanged frames create no GPU objects or pass descriptors.
After execution flip the history index. Disposal restores the original spatial
resolve group if installed, destroys only owned resources, and is idempotent.

Native inputs are signed world normals. Engine inputs can be signed view
normals or signed world normals; convert explicitly. Do not mistake encoded
geometry WORLD_NORMAL for a signed texture.

## Verification

Replay immutable captured spatial AO, depth, decoded normals, motion and camera
bytes through native and WGSL owners. Compare temporal, history count,
convolution, repaired, and final buffers separately. Native references stay
unchanged. An aggregate flicker threshold is not a substitute for matching the
smoother reference's actual outputs.

Motion-pruning queries must conservatively cover every intersecting active
base tile. Focused GPU checks compare queries with CPU rectangle overlap for
empty masks, separated movers, unrelated content in a shared coarse cell,
inclusive radius boundaries, and stretched odd mip edges. Single-active-tile
queries must also reject unrelated regions, not merely avoid false negatives.
Replay the same saved moving sequence with `--transport --production`, with
and without `--motion-pruning`, and compare every temporal, repaired, final,
and history-count output byte-for-byte. The pruning flag requires transport;
it does not modify the immutable native oracle or any quality budget.
Geometry lifetime tests must establish one full-size RG32Uint allocation, prior
geometry bound identically in both history lanes, no geometry attachment in
the temporal pass, geometry written only by final output, exact current depth
bits and normal word readback after that write, unchanged resource reuse, and single
disposal. Compare the geometry-ping-pong baseline and single-history replay
byte-for-byte before accepting the lifetime change.

Any subsequent anti-ghosting changes must preserve this baseline's temporal
stability rather than reject long history using noisy instantaneous color.

The native-format 128-frame baseline matches final visibility within one byte;
2395 of 45,830,144 values differ. All initial convolution/depth mips match
exactly. A single repaired intermediate differs by five bytes, while its final
reconstruction differs by at most one. Floating-point count/envelope decisions
on moving geometry can differ; these are reported separately, not concealed.

## Occlusion-history transport

The public temporal enabler uses this production transport whenever a velocity
source is supplied. Future changes still require scoped behavioral checks and
the visual comparison; aggregate numerical measurements alone are insufficient.
An additional pass searches dynamic occluders in the receiver's physical AO
radius. Reconstruct their previous world positions from actual receiver motion
and previous depth, subtract camera-only motion, and average their displacement.
When the velocity contract supplies previous positive view depth, use it
directly to reconstruct the occluder's material-point position. Sampling old
visible depth is a fallback for XY-only sources, not a substitute for the
exact payload; its curvature error is especially large on small projected
objects.
Static and moving receivers use the same receiver-relative transport. Reconstruct
the receiver's previous material-point position from its velocity and previous
depth, with the same normal-validated old-geometry fallback for XY-only sources.
Receiver motion below 0.05 pixels may skip this reconstruction as numerical
stationary motion, but must never disable the occluder search: that former gate
made a visible line between pinned and bending vertices on the skinned beam.
For exact-depth velocity, also compare previous material depth with the previous
camera-only clip W; a difference exceeding `max(1e-4, abs(clipW)*tolerance.x)` is
receiver motion even when screen-space XY is zero. This prevents depth-only movement from
placing transported history on the current rather than previous receiver plane.
The optional motion mask uses the same previous-depth discrepancy test as
transport, in addition to its conservative 0.025-pixel XY threshold. Otherwise
a receiver moving along the view ray can be incorrectly excluded from transport.

Let `receiverShift = receiver - previousReceiver`,
`meanDynamicShift = sum(weight * occluderShift) / dynamicWeight`, and
`support = dynamicWeight + staticWeight`. Use zero mean dynamic shift when only
stationary occluders contribute. The effective motion relative to the receiver is
`relative = meanDynamicShift * (dynamicWeight / support) - receiverShift`.
Project it onto the current receiver tangent plane and sample previous AO at
`previousReceiver - tangentialRelative`. This preserves the stationary-receiver
result, keeps moving-occluder history continuous across skin-weight transitions,
and handles a moving receiver beneath stationary occluders. Validate normal
motion against `meanDynamicShift - receiverShift`, retaining the conservative
relation to the effective tangential displacement and all existing depth,
normal, curvature, and locality checks.

Project that virtually displaced previous receiver into the previous camera.
Preserve native
long accumulation and reconstruction, instead of tight noisy color clipping.
The current observation is never replaced or spatially broadened.
Static fully lit regions and reset frames bypass the search.
For newly lit receivers retaining old occlusion, search up to twice the physical
radius to retain the departing occluder's transport direction. Its current
influence can be gone while old history still needs to move out of the pixel.
Bound transported receivers' effective temporal blend to
`min(configuredLimit,clamp(projectedAoRadius/4,2,16))`. This resolution-aware
response preserves the established four-observation maximum for tiny
footprints, reaches the full native limit above 64 pixels, and avoids a hard
quality-mode transition during zoom. Their subpixel
estimator field is not invariant under world-space translation. Preserve their
geometrically valid history age for reconstruction: permanently capping that
age at four repeatedly blurred and fed back the shadow every frame, causing
additional trailing. New/disoccluded pixels still receive native repair and
spatial reconstruction. Uninfluenced regions and the large-footprint close-up
path retain the full native blend limit. Both static and moving receivers retain
their geometrically valid native history age. No broad clipping guide is restored.
Interpolate previous occluder depth only from taps whose stored world normals
agree with the current occluder (dot at least 0.9), renormalizing bilinear
weights and requiring at least half coverage. A fixed absolute depth-spread
guard failed at low resolution by discarding nearly every valid curved-surface
sample; it is not used. This prevents foreground/background mixing without
mistaking a steep but continuous surface for a silhouette.
Reject occluder motion reconstructed across previous-depth discontinuities;
also bound recovered 3D displacement by its actual projected motion. Without
these guards, silhouette/background interpolation corrupts inferred movement.
Weight physical occluder support by distance falloff and elevation angle.
Measure stationary competing occluders in that same support. Scale the moving
occluders' mean tangential displacement continuously by
`dynamicWeight/(dynamicWeight+staticWeight)`: stationary occluders contribute
zero displacement, not a threshold that switches the entire history field off.
The former `smoothstep(0.9,1,...)` gate left angular, blocky history boundaries
when a sphere approached a stationary beam. Full, unconditional translation
instead drags the stationary contact shadow, so retain the static contribution
in the denominator. Preserve the existing normal-motion and geometry guards.
Keep bilinear history reprojection: a trial bicubic variant increased shimmer
and signal error and was removed.
Camera uniforms append current and previous inverse view-projection, velocity
tolerances and the two static-depth reprojection rows after the existing
matrices and control vector (384 bytes total).

The integrated renderer retains native history. In the earlier capture, before
continuous mixed-support weighting, the matched 128-frame
forward/hold/reverse/rest sequence measured moving-floor residual flicker of
0.005610 (native shared input: 0.006833), residual error from the exact
64-phase mean is 0.008370 (native: 0.054400), and maximum excess trail is zero
(native: 0.066914). Held-floor RMS is 0.001825 versus native 0.003190.
The previous rejected recording's complete camera/depth/normal/motion/spatial
inputs were verified byte-identical before reusing it as the first preview
column. These measurements supplement the visual comparison rather than
standing in for it. Public `enableSsaoTemporal`
now selects this owner, enables production guards, and enables transport only
when a velocity source exists. Without velocity it uses camera reprojection.

## Files

- `post-process/ssao-diligent-wgsl.ts`: typed shader assembly for all stages.
- `post-process/ssao-diligent-gpu.ts`: private cached ownership and dispatch.
- AO reference replay tooling: stage-wise native/WGSL comparisons.
- `scripts/ao-reference/diligent-port.ts`: bounded browser replay with a
  failing native-stage agreement check. `--transport --production` selects the
  shipped transport/guard behavior; `--motion-pruning` adds the optional pruning
  extension. The default replay remains the unmodified native-format baseline.
- `scripts/ao-reference/diligent-port-quality.ts`: exact fixed-pose moving-floor
  noise/signal/trail comparison and opt-in `--publish` recorded preview.
- `tests/lite/unit/ssao-diligent.test.ts`: native resource formats, cached
  dispatch/binding ownership, optional filtering, and idempotent disposal.
- `scripts/ao-reference/validate-diligent-client.ts`: real native-format GPU
  contracts, optional-filtering fallback, actual three-estimator convergence,
  and frame-graph motion/lifecycle checks (the default `pnpm test:ao:temporal`;
  `--diligent` remains a compatibility alias). Its mixed-occluder contract checks
  the real transport pass: stationary support produces no warp, either moving
  half contributes a nonzero partial warp, and the two partial displacements
  sum to the all-moving displacement without translating static support at
  full moving speed. It also sweeps pinned/moving receiver velocities across
  0.05 pixels, checks stationary occlusion on a moving receiver, and covers both
  exact previous-depth and XY-only velocity contracts, including depth-only
  receiver motion.

Original static AO goldens, scene ceilings, and unrelated feature bundles must
remain unchanged. The public temporal API remains opt-in, plain state, and
root-exported; no GPU handles or package subpaths are added.
