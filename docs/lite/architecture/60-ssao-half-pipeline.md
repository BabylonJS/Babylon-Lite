# Half-resolution SSAO pipeline

## Purpose and API

`enableSsaoHalfPipeline(task: SsaoTask): SsaoHalfResolutionSettings` is a separate
opt-in from `enableSsaoHalfResolution`. The existing enabler preserves full-size
geometry and temporal reconstruction. This new enabler reduces geometry inputs,
depth preparation, estimation, denoising, motion pruning and temporal histories
to `ceil(width/2) x ceil(height/2)`, then reconstructs a full-size visibility
texture. It deliberately trades thin/contact detail and temporal resolution for
lower cost and memory. It does not replace the old mode or promise a 4x total
speedup: the source producer and final upsample remain full-resolution.

The returned plain settings have mutable `enabled` and readonly `active`.
Repeated calls return the same settings. A disposed task or another installed
resolution adapter is an error. Disabled settings, width below 320, or height
below 224 use the normal Full pipeline. No new scene ownership or raw GPU API
is exposed.

## Data flow and shaders

The source camera projection/aspect remains derived from the original full-size
depth target, including odd dimensions. One 8x8 compute prepare pass samples
every input at `min(2 * smallPixel + 1, fullSize - 1)`, including exact previous
positive view depth in velocity Z, and writes:

- raw device depth (R32F);
- linear view depth directly into reduced pyramid mip 0, so the reduced owner
  sets `depthPrepared` and skips its own copy dispatch;
- supplied signed normals, or, when the producer has none, a view normal
  reconstructed once with the shared `aoDepthNormal` from full-size depth
  (better than reconstructing from the decimated grid, and it removes every
  later per-stage depth-normal reconstruction);
- optional normalized velocity.

Copies preserve the source precision instead of widening it: normals are
RGBA32F only for an RGBA32F source and RGBA16F otherwise (including
reconstructed normals); velocity is RGBA16F for `rg16float`/`rgba16float`
sources and RGBA32F otherwise. The temporal tolerances in
[58-diligent-denoiser](58-diligent-denoiser.md) follow the reduced velocity
format. Source attachments are borrowed and never destroyed.

The reduced `SsaoGpu` uses kind `float`, stride 1, always-provided view-space
normals (world-space only when the producer supplied world normals) and its
own half-size depth pyramid, AO and edge buffers. Its public `outputTexture` is full-size RGBA16F.
`sourceVelocity` points to the reduced velocity view; temporal validation still
checks the original producer's full-size target, while the actual filter samples
the reduced view. All temporal textures derive their dimensions from the reduced
GPU owner. Sampling footprint is marked sparse for the existing response guards.

The standard task order becomes prepare filter -> upload parameters -> resolution
before -> filter execute -> optional resolution after. The before callback copies
geometry and executes the ordinary reduced estimator/spatial resolve. The after
callback runs the dedicated Half-pipeline joint bilateral upsampler
(`ssaoHalfPipelineUpsampleWGSL`) on the filtered half-size visibility, using a
separate full-size 176-byte parameter buffer. This avoids upsampling before
expensive temporal work. With temporal filtering disabled, the same after
callback upsamples the reduced spatial result.

Preparation group bindings: 0 = full-size AO parameter uniform, 1 = full depth,
2/5 = optional normal input / reduced normal output, 3/6 = optional velocity
input/output, 4 = reduced raw depth output (R32F), 7 = reduced linear depth mip
0 (R32F). Workgroups are 8x8; odd last samples clamp to the real source edge.

Upsample bindings: 0 = full-size parameters, 1 = full depth, 2 = supplied full
normals (absent when reconstructed), 3 = sparse visibility, 4 = RGBA16F output,
5 = reduced raw depth, 6 = reduced normals; override `SOURCE_WORLD` selects
world-to-view rotation of the sparse normals. The reduced inputs already hold
exactly the full-size samples of each sparse tap, so taps never re-read or
re-derive full-size data. Each 8x8 group first fills a 6x6 workgroup cache
(origin `group * 4 - 1`, indexed by the unclamped tap coordinate, holding the
data of the clamped one) with tap position, visibility and normal; receivers
then read their four bilinear taps from that cache. Receiver normals come from
the supplied texture or from a 12x12 full-depth workgroup tile (origin
`group * 8 - 2`) feeding `aoDepthNormal`. The normal weight uses repeated
squaring instead of `pow(x, 8)`. A GPU validation compares this upsampler with
the legacy full-tap reference (`ssaoHalfUpsampleWGSL`, still used by Half
estimation) over odd/even sizes, three patterns and both normal paths within
1/512.

At concave contacts, the scalar AO field can remain continuous across a sharp
normal crease. The upsampler must not reject an adjacent wall/floor tap solely
because normal agreement falls below 0.9: alternating Half-grid coverage then
changes the accepted support abruptly during camera rotation.
Allow that tap only when normals are not opposing (dot greater than -0.9),
the source point lies in front of the receiver plane and the receiver lies in
front of the source plane (signed-plane tolerance `max(1e-4, viewZ*1e-5)`),
and their world-distance separation is within both one quarter of AO radius
and 2.5 projected pixels adjusted for surface foreshortening (incidence floor
0.1). This recovers the existing bilinear support at a connected concave crease,
not an extra blur pass. Convex silhouettes, opposing faces and separated depth
layers retain rejection; coplanar reconstruction and its plane weights are unchanged.

## Lifecycle and isolation

The task owns the reduced GPU and public full-size output. The resolution
adapter owns only reduced input textures, its two parameter buffers and cached
preparation/upsample bindings. Device, dimensions, supplied normal format or
availability, and velocity format or availability changes replace these
resources and reset temporal history.
Replacement source views rebind preparation and reset history. Unchanged frames
create no textures, views, groups or pipelines. Disposal is idempotent and keeps
borrowed producer attachments alive.

The new module is imported only by its enabler; unused scenes retain no shader,
input texture or pipeline. The generic task pays only an optional `after` call.
The uniform writer accepts its exact parameter-buffer state, allowing reuse
without a fake GPU owner.

The public render-target object stays stable; device/size/mode/input-availability
changes can replace its backing texture, as with other AO resource replacements.
Sampled consumers must follow output-change notifications or re-record their
graph. The comparison reloads these configuration changes deliberately.

## Demo and validation

The comparison exposes reconstruction `full` (existing default) or `half` while
Half is selected. Full estimation disables that choice. URL reloads isolate
resource histories and retain the other settings. Status explicitly distinguishes
Half estimation/full reconstruction from a Half pipeline. Baseline PR839 is
unchanged and keeps its native scaled reconstruction.

Tests cover mode isolation, ceil dimensions, fallback, resource reuse/disposal,
normal/velocity availability, post-filter ordering and tree-shaking. Native GPU
checks cover reduced temporal execution, nontrivial AO, optional input paths,
animated skin/morph motion, odd resize and full-size output. Focused diagnostics
compare complete task time and texture payload; no golden or ceiling changes.

At 1146x1308, Contacts with supplied normals, temporal filtering and pruning,
64 native GPU task observations per case measured:

| Spatial quality |     Full | Half estimation/full reconstruction | Half pipeline |
| --------------- | -------: | ----------------------------------: | ------------: |
| Low             | 0.295 ms |                            0.289 ms |      0.182 ms |
| High            | 0.351 ms |                            0.308 ms |      0.196 ms |
| Ultra           | 0.554 ms |                            0.352 ms |      0.240 ms |

Nominal owned AO textures were 107.67, 101.96 and 51.22 MiB respectively.
The reduced owner and its histories were 573x654; public output remained
1146x1308. Memory clocks stayed at 14001 MHz across these local observations.
These are not cross-device guarantees or CI thresholds. Full-size input
production and edge-aware output limit the total speedup; the new mode is not
claimed to deliver PR839's 3–4x reduction in every configuration.

After the single-prepare/tap-cache upsampler, atomic motion mask, merged
spatial/output pass, exact static previous depth and RGBA16F velocity, a
same-page alternation at 1920x1080 (High, temporal, pruning, supplied normals,
Half pipeline; averages of 8 alternating rounds) measured these task totals:

| Scene    | Before (XeGTAO) | After (XeGTAO) | PR839 (same page) |
| -------- | --------------: | -------------: | ----------------: |
| Kitchen  |        0.604 ms |       0.439 ms |          0.448 ms |
| Contacts |        0.329 ms |       0.252 ms |          0.234 ms |

Kitchen's AO work alone dropped from 0.295 to 0.236 ms (PR839: 0.256 ms).
Without supplied normals, AO dropped from about 0.83 ms (before this pass) to
0.33 ms, but it remains more expensive than with supplied normals (0.24 ms):
the producer saves only about 0.017 ms by omitting the normal MRT, while
robust depth-normal reconstruction runs in prepare and at every full-size
upsample receiver. Enabling geometry normals is therefore the faster
configuration. A planar fast path and workgroup compaction of unresolved
receivers were measured and rejected: the coplanarity test, barriers and
divergence cost more than they saved on dense geometry.
Static pruning stays byte-equivalent in all 16 `pnpm diagnose:ao --compare-pruning` cases.
At that point the remaining Contacts difference was pass count (about twelve
versus five) and the full-resolution edge-aware upsample (about 0.04 ms there),
which PR839 replaces with a plain bilinear relay of its half-size output.

A later pass timed every SSAO pass with GPU timestamps at 1920x1080 (temporal,
pruning, supplied normals; minimum over five alternating page loads). Each
dispatch was timed as its own pass, which slightly inflates tiny dispatches.
AO-only time, excluding geometry inputs and presentation:

| Configuration                   |   Before |    After | PR839 Half |
| ------------------------------- | -------: | -------: | ---------: |
| Kitchen, Half pipeline, Medium  | 0.224 ms | 0.189 ms |   0.250 ms |
| Kitchen, Half pipeline, High    |        — | 0.213 ms |   0.250 ms |
| Contacts, Half pipeline, Medium | 0.153 ms | 0.133 ms |   0.160 ms |
| Kitchen, Full, High             | 0.577 ms | 0.422 ms |          — |

Contacts' before value already includes the estimator fetch and working-texture
changes; it was first measured after them.

The gains come from the sampler-based estimator depth fetch and packed working
texture (module 56), load-first ordering without texture-size queries, and the
RG32_UINT geometry history (module 58). The full-size upsample, about 0.075 ms,
is now the largest Half pass. It is bound by its compatibility arithmetic:
removing that arithmetic saves 0.023 ms, while removing the full-size normal
fetch saves nothing. These were measured and rejected:

- Exact early-outs for receivers whose taps are all unoccluded or background,
  per workgroup (atomic flag) or per receiver (3x3 tap window). They help scenes
  with large open areas (Contacts upsample 0.042 to 0.036 ms) but cost the
  Kitchen 0.006 to 0.008 ms.
- Regrouping lanes by grid parity so SIMD groups skip zero-weight taps: slower,
  because of the scattered row access.
- Hoisting receiver loads above the barrier, removing its two size queries, and
  precomputing receiver-only terms: no change, as the compiler already does it.
- Fusing depth mip 1 into the linearizing copy or the Half prepare (three
  variants): breaks coalescing, or adds barriers that cost more than a separate
  small dispatch.
- An R32_FLOAT temporal scratch instead of RGBA16F: no measurable change, since
  L2 absorbs the traffic.
- Manual unrolling of the estimator steps, and reading view-depth level 0 from
  source depth to drop the linearizing copy: no gain, and +0.037 ms against the
  copy's 0.029 ms, respectively.

## File manifest

- `post-process/ssao-half-pipeline.ts`: isolated adapter, input shader and resources.
- `post-process/ssao.ts`: optional post-filter resolution callback.
- `post-process/ssao-gpu.ts`: reusable typed parameter-buffer writer.
- `index.ts`: root-only enabler export.
- Comparison demo/configuration: explicit opt-in reconstruction choice.
