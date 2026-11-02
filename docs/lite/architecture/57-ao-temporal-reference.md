# Module: Native temporal AO reference

> Test-tool path: `scripts/ao-reference/`. No engine runtime changes or package exports.

## Purpose

The spatial XeGTAO fixtures do not validate BLite's custom temporal denoiser.
Establish an independently executed, pinned DiligentFX temporal reference for the
same floor and moving sphere. Do not tune BLite while establishing this reference,
and do not assume Diligent is free of shimmer or trails before inspecting it.

DiligentFX pin: `eaf6ab785968bdee2393210c5a67033a4d9140cc` (Apache-2.0).
The original HLSL API preamble is pinned from DiligentCore commit
`074060cfd1db73064d7a18cf40df86af6531520c`.
Its GTAO is XeGTAO-derived, not bit-identical Intel XeGTAO. The reference executes
the upstream HLSL on hardware D3D11. A small native host replaces the framework's
resource scheduling, not its shaders. It is not a build of the complete engine.

## Tool surface

- `pnpm exec tsx scripts/ao-reference/diligent-reference.ts`: capture, execute,
  validate, and publish the comparison.
- `pnpm reference:ao:temporal` is the equivalent package command. `--smoke`
  selects a short 192x144 diagnostic, not the full-resolution reference.
- Source pins and SHA-256 checksums are in `diligent-source-lock.json`.
  Source preparation may create this lock once; it must refuse to overwrite it.
- Generated sources, raw frame buffers, and native outputs belong under the
  ignored `.ao-reference-cache/diligent/` directory.
- The generated comparison is served from an ignored
  `lab/public/ao-temporal-reference/` directory. It is not a new golden baseline.
- Existing native goldens, MAD/bundle ceilings, and the runtime are unchanged.

## Capture contract

Use the existing close-up regression's geometry: ground 6x6, a diameter-1.5
32-segment sphere at y=0.75, and the independent 0.8 box. Camera alpha
`-PI/2.7`, beta `1.08`, radius `4.5`, target `(0,0.75,0)`, near 0.1, far 30.
Capture at 668x536, MSAA 1, device pixel ratio 1, fixed time steps.
Capture warmup as part of the sequence, followed by translation, pause, and
reversal. Record every sphere position and phase; do not use wall-clock motion.
The capture-only texture allocator adds COPY_SRC to single-sample depth
allocations. It changes no format, clear, shader, or runtime source code.

Every frame supplies identical geometry to both pipelines:

- reverse-Z device depth, top-down, little-endian float32;
- raw BLite world-normal attachment, top-down RGBA16F, encoded `N*0.5+0.5`;
- rigid PBR motion, with Diligent's current-minus-previous NDC XY;
- current and previous camera matrices and viewport;
- BLite's actual noisy, spatially filtered XeGTAO AO and temporal result.

BLite motion is previous-minus-current NDC/2, Y up. Convert its XY to Diligent
by multiplying by -2. Do not change signs based on the image appearance.
BLite VIEW_NORMAL is signed, but WORLD_NORMAL is biased to [0,1]. The native
upload must decode each world-normal component with `2*value-1`, rounded to
RGBA16F before supplying Diligent's signed input. Verify unit length, floor +Y,
and sphere radial direction against the captured geometry; a finite [0,1]
vector alone does not validate the normal convention.
Camera matrices are captured in GPU column-major convention. Diligent's HLSL
uses row-vector multiplication, so transpose the mathematical matrices when
packing its column-major constant buffers. Jitter is zero; full-scene TAA is off.

The pinned `CameraAttribs` layout is 576 bytes: position and viewport vec4s;
clip and scene bounds; handedness/frame index/padding; lens parameters and
jitter; six 64-byte matrices; five extra vec4s. Two-camera buffers are 1152 bytes.
The SSAO constant buffer is 48 bytes, in upstream field order. Keep upstream
defaults except `EffectRadius=0.6`, explicit first-frame history reset, and
`AlphaInterpolation=1` to remove the framework's wall-clock fade-in.

## Native pipeline

Compile the original upstream vertex/pixel shaders with their original includes,
using D3D11 API-convention definitions, inverted depth, full resolution, and
32-bit depth. Reflect resource bindings instead of guessing register numbers.
No WGSL translation, filter reimplementation, modified sampling, or brightness
fitting is permitted in the oracle.

Execute the upstream `PostFXContext` preparation: temporal blue-noise ZW,
reprojected depth, closest motion vectors, and previous-depth copy. Preserve the
source's native texture formats and sampler modes. Blue-noise ZW is generated
by the original upstream shader, not a replacement random generator.
Match Diligent's D3D11 frame-index transport: update an index buffer with
`3*frame + {0,1,2}` and draw indexed. Base vertex/instance offsets on a
non-indexed D3D draw do not carry this index. Require distinct native raw AO
buffers during held geometry; repeatability without sample variation is invalid.

Then execute:

1. Copy current depth to depth mip 0 and run depth prefiltering through mip 4.
2. Compute native GTAO with upstream noise and settings.
3. Accumulate AO and history length using upstream temporal accumulation.
4. Copy accumulated AO/current depth to convolution mip 0, then build four
   convolution mips with the upstream odd-size handling.
5. Execute resampled history and spatial reconstruction.
6. Copy reconstructed AO to the current history, matching upstream feedback.

AO targets are R8_UNORM, history length R16_FLOAT, and depth R32_FLOAT.
Use per-mip views and the upstream full-screen triangle. Clear AO and history
targets to 1 where the framework does; do not retain unwritten background.
Read back raw, accumulated, history-length, resampled, and final output.
The AO pipeline consumes only blue-noise ZW, generated by its original Hilbert/R2
shader. The unused XY output receives zero-filled Sobol inputs; those resources
do not participate in ZW or any SSAO computation.

Run two independent history lanes:

- **Native DiligentFX**: upstream GTAO plus its complete denoiser.
- **Shared BLite input**: replace only the current AO input with the captured
  BLite spatial AO; execute all upstream denoising stages unchanged.

The shared lane isolates temporal/spatial reconstruction from estimator
differences. It is explicitly an adapter experiment, not stock whole-pipeline
Diligent output. BLite's temporal image and this lane receive the same noisy AO.

## Validation and presentation

Fail on compilation, missing resources, invalid input dimensions, non-finite
values, or empty/constant foreground coverage. Validate camera/depth
reconstruction and motion conventions before interpreting AO differences.
Verify static-plane neutrality and history growth, first-frame reset, and a
second identical native execution before treating captures as reproducible.

The viewer must synchronize frame index, playback, and scrub position across
BLite, native DiligentFX, and shared-input DiligentFX. Provide raw versus final
stages, exact settings/provenance, and full-frame versus floor-detail views.
Display AO linearly as grayscale without exposure, gamma, contrast fitting, or
image blur. Playback is only presentation; recorded frames are immutable.

Report temporal residual change against fixed-input multi-phase means where
available, trails, and native/shared differences separately. A difference from
Diligent is not automatically a BLite correctness bug because the algorithms
differ. Do not call the shimmer solved from a numerical threshold alone.
The viewer reports variation during the settled half of the outgoing pause.
It also reports a departing-floor signed residual proxy: current incoming AO
minus final AO, averaged over originally shadowed floor behind the moving sphere.
This proxy includes filtering bias and noisy-input error; it is not ground truth
or a pure measurement of lag. Publish its contributing sample count; require
100 contributing pixels for a full capture (8 for the small diagnostic).
An insufficient sample population is reported as unavailable, not a zero error.
The original recordings compared native history capped at 16 with R8_UNORM
feedback against the now-superseded BLite guide-only prototype (configured 32,
active-area cap of four, RGBA16F feedback). Those labels describe the recorded
experiment, not the current runtime. The shipped Diligent-style owner now uses
R8 feedback and a native history cap of 16; see
[module 58](58-diligent-denoiser.md). New recordings must identify their BLite
implementation and actual settings rather than describe unequal paths as identical.

## Dependencies and file manifest

- Existing WebGPU scene/geometry/AO numerical harness and Playwright.
- Existing PowerShell/.NET D3D11 reference host. Its source and generator hashes
  remain byte-identical: prepare a cache-only copy with partial class declarations
  and an additional texture bind flag, then compile the new pixel host with it.
  These four guarded mechanical changes affect only host declarations/bind flags,
  not shader math or the legacy compute runner. A changed base-host hash fails.
- Pinned DiligentFX shader sources and Apache license, downloaded into cache.
- `diligent-sources.ts`, `diligent-source-lock.json`: source preparation/integrity.
- `diligent-native.cs`: original-shader pixel-pass host.
- `diligent-capture-client.ts`: fixed scene and GPU frame export.
- `diligent-reference.ts`: orchestration, native execution, integrity, and viewer.
- Focused unit tests for pins, byte layouts, motion conversion, and sequence.

Half-resolution rendering, bundle-size cleanup, and changes to BLite's temporal
algorithm remain outside this reference-establishment step.

## Historical labelled anti-ghosting adaptation

This derived native/reference experiment is retained for reproducibility.
It is not the anti-ghosting design used by the shipped `enableSsaoTemporal`;
production uses the geometry-driven occlusion-history transport in module 58.

The original temporal shader computes a current AO variance envelope, but does
not clip the previous AO to it. Outside that envelope it only scales history
length by receiver motion. A stationary floor has zero receiver motion even
when its occluder moves, so the history remains long and retains stale darkness.

Keep the pinned native/full and shared-input references unchanged. Add a separate
derived temporal shader that clamps `Reprojection.Occlusion` to the current
mean/variance envelope, using the upstream minimum variance gamma (0.5) for the
accumulated mean. Do not widen the tighter upstream moving-receiver bound.
Preserve the existing history
count, sampling, and reconstruction. This targets the stale value rather than
globally shortening accumulation. Generate the derived file with a guarded
single insertion; do not rewrite any pinned upstream shader.

The candidate has independent history resources and explicitly labelled images.
Compare it against the unchanged third path on identical inputs, including
pauses and reversals. Do not integrate it into BLite merely because ghosting is
lower: shimmer must remain comparable to the smoother reference.

For anti-ghosting evaluation, `--quality` additionally captures a 64-phase
spatial-AO mean at each frozen geometry pose. Use the exact live depth/view-normal
inputs and the unchanged XeGTAO estimator. Accumulate on the GPU in float32 and
read back once per pose; do not average already accumulated temporal outputs.
The sampler must reproduce the captured noisy phase byte-for-byte. Reuse a mean
only for an identical sphere position in this fixed-camera, otherwise static
fixture. Store the means separately from immutable frame packets.

Measure floor temporal residual changes and newly lit floor trails against this
fixed-pose mean, not only against one noisy observation. Compare the candidate's
noise against the unmodified shared-input baseline. A low ghosting score alone
does not qualify a candidate that reintroduces shimmer.

Direct clipping to a noisy one-pixel neighborhood can itself shimmer. The
adaptation therefore uses a frame-stable guide: nine current-AO samples with
three-pixel spacing, rejecting background, world-normal disagreement, tangent-plane
distance, and unrelated geometry. The guide supplies only the clipping mean;
the actual current AO observation is not blurred. Bound variance by the smaller
of the original local variance and the guide variance so cross-silhouette
contrast cannot legitimize old darkness. Preserve the native accumulation count.
Reproject the guide with the same depth-validated bilinear weights as AO, but
blend its mean with the current spatial guide at 0.75. This short, independent
guide suppresses stochastic clipping-bound fluctuations without imposing the
long AO history's lag. Reset it on genuine geometry rejection. The native
candidate owns two R16_FLOAT guide targets; BLite can use the existing history
alpha channel for the same state. The guide's mean delay is one third of a frame,
not the long AO history's many-frame delay.

Publishing a `--quality` recording requires both the integrated BLite result and
the adapted native candidate to keep excess trail below 0.015, floor residual
RMS below 0.02, and moving residual-change RMS below 0.01. Additionally the
candidate's moving and held noise must stay within 10% of the smoother unmodified
shared-input reference. Missing/non-finite coverage fails. `--metrics-only`
records rejected experiments without replacing the visible comparison.
