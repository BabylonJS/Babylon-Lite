# Module: Screen-Space Ambient Occlusion

> Package path: `packages/babylon-lite/src/post-process/ssao*`.
> Independent native oracle: `55-ao-reference.md`.

## Purpose

Provide an opt-in WebGPU AO buffer computed from a perspective camera's depth
attachment and optional signed surface normals. XeGTAO is the sole estimator;
the original and slope-safe VBAO implementations have been removed.
No existing Babylon scene, golden, or ceiling changes.

`depthTexture` directly borrows a single-sample **depth attachment**, including
`geometry.geometryDepthTexture` from `createGeometryRendererTask` or an existing
render target's depth attachment. It does not require a depth-valued color MRT
such as `geometryViewDepthTexture`, and creates no second current device-depth
attachment. The producing pass must store its depth and run before AO; a
multisampled attachment needs the existing depth-resolve task first. AO creates
only a depth-only sampling view of the borrowed attachment and never destroys
the producer's texture. Its owned linear/view-depth mip pyramid, convolution
depth, and previous-frame geometry history remain separate algorithm resources:
borrowing the input removes duplicate source-depth storage, not every depth
read, conversion, or temporal-history cost.

Implementation proceeds through numerical GPU buffer parity before scene
lighting composition. The AO task does not multiply the final scene image:
doing so would incorrectly darken direct light and emissive materials.
The AO-buffer task is independently validated. PBR lighting is enabled separately;
importing or adding the task alone does not change a material's lighting.

## Public API Surface

```ts
type SsaoQuality = "low" | "medium" | "high" | "ultra";

interface SsaoTaskConfig {
    name?: string;
    depthTexture: RenderTarget;
    normalTexture?: RenderTarget;
    normalSpace?: "view" | "world";
    camera: Camera;
    quality?: SsaoQuality;
    radius?: number;
    intensity?: number;
}

interface SsaoTask extends Task {
    readonly depthTexture: RenderTarget;
    normalTexture: RenderTarget | null;
    readonly camera: Camera;
    readonly outputTexture: RenderTarget;
    enabled: boolean;
    quality: SsaoQuality;
    radius: number;
    intensity: number;
}

function createSsaoTask(config: SsaoTaskConfig, engine: EngineContext, scene?: SceneContext): SsaoTask;
function enablePbrSsao(scene: SceneContext, task: SsaoTask, materials?: readonly PbrMaterialProps[]): Promise<void>;
```

All fields are plain state. The infrastructure's `Task` lifecycle is the same as
existing frame-graph tasks. Public configuration exposes no raw GPU handles.
Call after creating depth/geometry targets, add after their producing task, and
before a consumer of the AO target. The output uses visibility: white is
unoccluded; black is occluded. It is a filterable `rgba16float` render target.

Defaults: radius 0.5 view units, intensity 1, enabled.
There is no algorithm selector or constant-backface-thickness setting:
both belonged to the removed VBAO path. These experimental APIs were unpublished.
Spatial quality defaults to `"high"`, preserving the original three slices
and three steps per side. Presets select fixed GPU-specialized sampling:

| Quality | Slices | Steps per side | Depth samples per evaluated pixel |
| ------- | -----: | -------------: | --------------------------------: |
| low     |      1 |              2 |                                 4 |
| medium  |      2 |              2 |                                 8 |
| high    |      3 |              3 |                                18 |
| ultra   |      9 |              3 |                                54 |

These are Intel XeGTAO's preset counts.
XeGTAO normalizes by the slice count and uses it in slice/step noise indexing.
Presets change sampling only, not effect radius, intensity, render resolution,
spatial denoising, or temporal history. Low quality can lose detail or shimmer
more; it is an intentional quality/performance tradeoff, not an optimization
claimed to preserve high-quality output.
Preset cost is not a monotonic guarantee for the complete SSAO task. Transport
bypasses receivers only when both current AO and history are at least 0.999;
noisier low-sample estimates can keep substantially more stationary pixels in
the transport search. Likewise, temporal rejection/statistics and short-history
reconstruction have signal-dependent costs. It is therefore possible for Low's
estimation pass to be cheaper while its complete task is slower than Ultra.
The AO-only view still executes estimation and every enabled temporal pass;
it only replaces final scene shading/presentation with a visibility copy.
Motion pruning can remove that wasted transport work in static regions, but
remains a separate scene-dependent opt-in. Do not silently enable it or loosen
AO/transport thresholds to force total preset timings into sample-count order.
The showcase and comparison demos now visibly enable the existing pruning
option by default; their checkboxes allow an unpruned comparison. The runtime
API itself remains opt-in. This avoids spending most of the static-scene budget
searching noisy, stationary AO pixels, without changing sampling or history math.

Estimator pipelines are cached in a quality-keyed record, with one spatial resolve
pipeline per owner. An unchanged frame allocates no new
pipeline/cache key/container. Full and sparse owners receive the same preset;
half mode still evaluates its selected source pixels against full-size geometry.
Changing quality resets temporal history without reallocating the public output.
Unsupported preset strings fail explicitly at the task boundary and GPU entry.
Mutable
settings are validated at the API boundary and sampled before each dispatch.
Intensity is in [0,1]; radius is positive and finite.
Intensity keeps its existing unit gain, resolved as
`clamp(1 - intensity * (1 - rawVisibility), 0, 1)` before temporal filtering.
Zero remains neutral, and no negative visibility enters history. No direct light,
specular, emissive, or material base-color adjustment is introduced.

Perspective projection and full-target viewports are supported initially.
Orthographic and partial-viewport cameras fail explicitly instead of applying
perspective mathematics to unsupported input. MSAA depth must first pass through
the existing `createDepthResolveTask`. Normal input must match source dimensions;
signed unit view normals are the default, or world normals transformed by view
rotation. Missing normals use shared nine-tap depth reconstruction in estimation,
temporal filtering/history capture, and half-resolution upsampling. At interior
pixels, choose each one-sided derivative by the smaller second-order
extrapolation error `abs(2*neighborDepth-secondNeighborDepth-centerDepth)` in raw
device depth. Device depth, unlike linear view depth, is affine across a
perspective-projected plane. Comparing only immediate view-depth differences
can choose a sample across a continuous-depth crease, invent an intermediate
normal, and leave the bilateral upsampler with no compatible receiver samples
(white holes). Use the selected immediate neighbors' decoded view positions
for the cross product; normalize it, or use `(0,0,-1)` when degenerate.
If neither second-ring direction extrapolates the center within raw depth's
float32 roundoff bound (`max(centerDepth, immediateDepths)*4*2^-23`), an available
adjacent row/column's diagonal samples provide a plane-consistency check instead.
This also handles thin strips between two different faces, not only background
and image borders. Evaluate the extrapolation residual as a difference of
first differences to avoid cancellation from unnecessarily doubling raw depth.
Never
select background as a derivative endpoint. Where the immediate tangent crosses
a silhouette, derive that tangent on the selected neighboring row/column using
a valid diagonal, rather than crossing to the other face or to far-plane depth.
These bounded silhouette fallbacks add reads only at affected pixels.
If an axial derivative remains inconsistent after the diagonal check, and the
immediate stencil is fully covered, evaluate the 16 local triangles formed by
adjacent/orthogonal first-ring directions. Select the center-anchored raw-depth
plane with the most agreeing taps among the first ring and four second-ring
axial taps (13 unique depth samples including the center). Require at least
six coplanar samples, with residual at most twice the roundoff bound, and
strictly more support than the existing tangent plane before replacing it.
This avoids accepting a chance triangle/quad fit on curved triangulated
surfaces. This bounded fallback handles a thin receiver whose
axis-aligned stencils both encounter other faces. It runs only for inconsistent
stencils, not for ordinary planar pixels or supplied-normal variants.
Implement the search without runtime-indexed local arrays: keep the eight ring
samples, four second-ring samples and their constant offsets in `vec4f` values,
count support with three vectorized comparisons, and record the winning
triangle's two depths/offsets when it strictly improves `best`. Candidate order
(adjacent pairs, then pairs two steps apart) and arithmetic are unchanged.
Dynamically indexed `array<f32,12>`/`array<vec2i,12>` locals spill to slow
memory on common GPUs: in the 1080p Kitchen Half pipeline without supplied
normals this search, triggered at about 15% of pixels (edges and grazing-angle
roundoff), cost about 0.12 ms in the full-size upsample and 0.04 ms in prepare;
the vectorized form roughly halves it.
Image borders retain one-sided selection and single-pixel dimensions retain the
degenerate-normal fallback. This is one shared
shader helper, not a separate normal texture/pass or weaker compatibility rule.
Supplied-normal variants bypass reconstruction entirely.
Normal textures are never gamma decoded.

The numerical regression constructs analytic projected planes meeting at
subpixel creases, with an adjacent background silhouette or a foreground
occluder leaving a narrow receiver strip. It compares
GPU-reconstructed normals against the planes and upsamples constant 0.25 sparse
AO with supplied and reconstructed normals. Every covered interior pixel must
retain 0.25 within one half-float step (1/4096), not fall back to white. Where the
full planar stencil is available, normal agreement must be at least 0.999;
silhouette fallback normals must remain compatible with their face (dot 0.9).
`task.normalTexture` is mutable: assign a compatible signed-normal target to
sample it, or `null` to reconstruct normals from depth. A change between these
two shader variants invalidates cached estimator pipelines and recreates the
temporal owner on the next record/execute, resetting history. The full-size
owner, public GPU texture, and managed output target stay unchanged, so PBR leases
and pre-recorded AO-only consumers remain valid. The half adapter recreates its
sparse owner and specialized upsampler, not the full-size output. Replacing one supplied
normal target with another of the same contract only rebinds sources and resets
history. Invalid formats, multisampling, or mismatched/unbuilt dimensions fail
explicitly. The task never owns or destroys either normal source. The same
selection propagates to half-resolution estimation and bilateral reconstruction;
unchanged frames retain cached resources.

## Internal Architecture

An internal GPU owner has no scene reference. It owns cached compute pipelines,
uniforms, five-level view-depth pyramid, point-clamp depth sampler, one packed AO/edge working texture, dummy normal
binding, and final visibility target. A task drives it using the engine encoder.
Sources remain borrowed. GPU objects are created only at factory/build/resize or working-mode changes,
not per frame. Bind groups are rebuilt only on source or allocation identity
changes. A replacement device invalidates the owner's GPU state.

The task aliases its output texture through one stable managed `RenderTarget`.
Rebuilding the graph resizes this output and recreates dependent bindings, as
with existing frame-graph post-process tasks. Disposal is idempotent and does not
destroy source depth/normal attachments.

## Pipeline Configuration

1. Copy reverse-Z depth into view-depth mip 0 (`r32float`).
2. Weighted reductions into mip levels 1..4 (`r32float`).
3. XeGTAO estimator: one `r32uint` working texture holding the packed visibility
   byte (bits 0-7) and the packed edge byte (bits 8-15), preserving upstream byte
   values. The resolve reads one word per tap instead of two textures.
4. XeGTAO edge-aware denoising into
   `rgba16float` visibility.

Each reduction dispatch reads only its preceding mip view and writes one
destination mip view. This avoids the five simultaneous storage bindings used
by the native reference, preserving baseline WebGPU limits. Eight-by-eight
workgroups bounds-check output coordinates. Odd-size reductions include the
final source row/column; one-dimensional and small targets remain valid.

Uniform layout: 176 bytes. The first 96 bytes match the native GTAO constants:
size(u32x2), reciprocal size, depth unpack, tan half-FOV, NDC multiply/add,
per-pixel view scale, radius/falloff, radius multiplier/padding/final power/blur
beta, sample power/thin compensation/mip offset/noise index. Next: far depth,
intensity, two reserved zero padding values (four f32); then view matrix. Supplied/world normal
selection is specialized with pipeline overrides, not branched per frame.
Offsets are explicit typed data, never parsed from generated WGSL.

## Shader Logic

### Depth

View depth is `depthUnpack.x / (depthUnpack.y - reverseDepth)`.
Reduction uses the original XeGTAO farthest-depth-relative weighted average:
effective radius = `0.75 * radius * 1.457`, falloff = `0.615 * effectiveRadius`,
and weights clamped to [0,1]. No min/max Hi-Z substitution.

### XeGTAO

Use upstream Hilbert/R2 spatial noise at static phase zero, quadratic near-field
sampling, pixel-snapped slice samples, nearest mip selection, the normal's
projected slice length correction, cosine-weighted horizon integration,
radius attenuation, final power 2.2, and minimum visibility 0.03.
The reference fast square-root and acos approximations are retained for
algorithm parity. Packed working AO is round(visibility / 1.5 * 255).
Left/right/top/bottom slope-adjusted edges use the original two-bit packing.
Depth samples use a point-clamp sampler (`textureSampleLevel`, nearest mip and
texel), like XeGTAO's `g_samplerPointClamp`. Per-sample size/level queries and
manual clamping made the estimator about 40% slower at Full/High. Edges are
packed after the horizon loop: holding them across it raises register pressure.

### Memory access

These passes are bound by fetch latency and bandwidth rather than arithmetic, so:

- `aoRawDepth` clamps with `ao.size`, never `textureDimensions`: raw depth
  always has the AoParams size, and a size query would serialize ahead of every
  depth fetch. Uniform-derived sizes likewise replace queries in the resolve
  (`ceil(size / stride)`) and the Half prepare (`ceil(size / 2)`).
- Independent per-pixel inputs (supplied normal via `aoSuppliedNormal`, view
  depth, velocity, transport, current/history AO and counts, resolve words) are
  fetched before background or convergence tests and before dependent rejection
  arithmetic, so their latency overlaps instead of following each branch.
- Workgroup memory is zero-initialized by WGSL; the motion mask relies on that
  instead of clearing its flag behind an extra barrier.

Reordering loads leaves the arithmetic unchanged. At 1920x1080 it reduced
temporal accumulation from 0.120 to 0.092 ms (Full/High) and the resolve from
0.036 to 0.032 ms; native and temporal validations are unchanged.

Denoising uses the original symmetric edge weighting, diagonal weights, edge
leak correction, center weight 1.2, and final scale 1.5. Saturating conversion
to the upstream final eight-bit value precedes conversion to half-float output.
No physical-quality change is disguised as a port correction.

Background is neutral visibility 1. Disabled tasks clear the
output to white once instead of continuing all AO work.

## State Machine / Lifecycle

Create -> allocate output/resources -> record sources -> execute per frame.
Resize/graph rebuild -> replace owner resources and bind groups -> publish output.
Device change -> recreate owner -> republish output.
Disable -> neutralize once; enable -> resume current-frame computation.
Dispose -> destroy owned resources once and detach output state.

Invalid dimensions, unsupported camera modes, missing source attachments,
multisample inputs, and invalid mutable settings are explicit errors.

## Babylon.js Equivalence Map

Not SSAO2 parity. This is an independent XeGTAO implementation.
An unused feature leaves Babylon parity and unrelated bundles unchanged.
Scene 321 nevertheless compares the shipped integration against Babylon.js
`SSAO2RenderingPipeline` on the same environment-lit Kitchen, as a coarse
regression bound rather than an equivalence claim (see Test Specification).

## Dependencies

WebGPU, existing camera/math/task/render-target helpers, and opt-in WGSL modules.
No native reference, downloaded vendor source, test fixture, or CPU ray tracer is
imported by the runtime.

## PBR Integration Milestone

`enablePbrSsao(scene, task, materials?)` is an explicit asynchronous enabler,
called before `registerScene`. It attaches a material plugin only to selected PBR
materials (all PBR scene materials by default), preserving pre-existing plugins.
The plugin applies to opaque and alpha-tested PBR diffuse IBL, not direct light,
emissive, unlit, transparent, refractive, shadow, or geometry-output passes.
The consuming pass must use the AO camera and matching effective aspect ratio;
camera overrides fail explicitly instead of sampling another view's occlusion.
The task is bound to one owning scene. New material attachment happens before
scene registration; repeated enabling for already attached materials is idempotent.
Shared source materials retain one dispatcher plugin. Its weak consuming-scene
mapping selects each scene's own sampling state before bind-group creation and
before dynamic updates; nonparticipating scenes sample engine-owned neutral white.
Camera/aspect validation applies only to the selected participating scene.
Disposal removes only that scene's membership and detaches the dispatcher after
the last member. First attachment and last removal invalidate cached PBR feature
selection, including materials already composed in another scene.

The screen visibility is sampled in normalized coordinates reconstructed from
the material's world position and current scene view-projection. Existing baked
material AO and screen AO combine by `min`, rather than being multiplied twice.
An opt-in expression modifier changes the diffuse IBL scalar from `occlusion`
to `min(occlusion, ssaoDiffuseVisibility)`. This modifies `finalIrradiance`
before clearcoat, sheen, and subsurface composition, rather than subtracting
from an already composed color. Separate sheen/refraction environment lobes
are not independently occluded. Specular/GTSO and bent-normal treatment are
not silently approximated by final-color multiplication.

Material-plugin support selects matching IBL-only shader and binding variants,
and gains an internal resource-version callback. A nullable binding decorator
and nullable diffuse-IBL expression modifier fold away when not enabled.
The ordinary fragment/vertex plugin bridges keep a single fragment per signature.
Only `enableDynamicPbrBindings` installs the `pbr-plugin-passes.ts` decorator via
the nullable `pbr-plugin-decorator.ts` seam. It reuses the active bridge to build
the full and IBL-excluded signatures, allocates a separate identity for each
pass policy, and retains only immutable fragment indices and enabled names.
This keeps IBL-only filtering, dynamic lease selection, and policy signatures
out of scenes that use ordinary material plugins. The same decorator applies
when the vertex-resource bridge is installed before or after the SSAO enabler.
Dynamic bindings reuse the existing render-bundle invalidation mechanism.
Replacement bind groups receive the original scene resource identity and binding
disposer collection, preserving contextual extensions such as textured area lights.
The expression installer is isolated in `pbr-diffuse-occlusion.ts`, not exported
from the lazily imported IBL fragment namespace. Existing three-argument calls
to the internal `createIblFragment` factory retain their behavior. An optional
fourth `WgslSource` parameter selects diffuse occlusion and defaults to
`occlusion`; it is not a new root-package API.
The extension resolves the installed modifier before creating the fragment,
passing `undefined` when no modification is needed. The factory emits the
selected calculation exactly once, without an extra calculation helper or
discarded default shader string. No emitted WGSL is parsed or patched.
Pre-baked skybox calculations bypass both expression selection and normal-IBL
generation. Feature selection occurs at the opt-in fragment
hook, not inside the common emitter. The binding decorator has an explicit
early return when absent, so downstream minification can reproduce the original
undecorated return path without an unnecessary nullable-call temporary.
On an AO output replacement,
affected bind groups refresh before rendering and cached opaque bundles rebuild
once. Unchanged frames keep the normal cached-bundle path, with no GPU-object
creation. Geometry/shadow passes exclude the AO plugin and cannot feed back from
the AO output while producing its depth/normals.

The feature owns sampled-texture leases, neutral fallback, and old-generation
retirement. Materials capture only a sampled-texture state object, never the
scene or AO task. Disposal restores neutral sampling and respects queued GPU
work and material-held texture references.
Dynamic textures are excluded from the mesh's static texture lease list:
only their current bind-group generations keep them alive. The white fallback
is recreated when the engine device changes, including during material rebuild
before the AO task has published its replacement output.

## Temporal AO

Temporal filtering is a separate opt-in, before PBR composition:

```ts
interface SsaoTemporalOptions {
    velocityTexture?: RenderTarget;
    velocityHasPreviousDepth?: boolean;
    historySamples?: number;
}
interface SsaoTemporalSettings {
    enabled: boolean;
    historySamples: number;
    resetVersion: number;
}
function enableSsaoTemporal(task: SsaoTask, options?: SsaoTemporalOptions): SsaoTemporalSettings;
function resetSsaoTemporal(settings: SsaoTemporalSettings): void;
```

For example, `ao.quality = "medium"` selects eight spatial depth samples per
evaluated pixel. Independently,
`enableSsaoTemporal(ao, { velocityTexture, historySamples: 8 })` bounds mature
temporal history at eight observations. Changing either does not change the
other setting or implicitly enable/disable half resolution.

Motion-mask pruning is a separate, disabled-by-default optimization:

```ts
interface SsaoMotionPruningSettings {
    enabled: boolean;
}
function enableSsaoMotionPruning(task: SsaoTask): SsaoMotionPruningSettings;

const temporal = enableSsaoTemporal(ao, { velocityTexture, velocityHasPreviousDepth: true });
const pruning = enableSsaoMotionPruning(ao);
pruning.enabled = false; // Restore unpruned transport for a highly dynamic scene.
```

Call the pruning enabler only after temporal filtering has been enabled with
object velocity. Missing temporal filtering, missing velocity, and disposed
tasks are explicit errors. Repeated calls return the same plain settings.
Calling the enabler opts in (`enabled: true`); omitting it retains the original
transport search, with no mask shader, mask allocations, classification or
reduction dispatches, hierarchy lookups, or indirect draw buffer.
The separate module is tree-shaken from temporal-only consumers.

Changes to `enabled` apply on the next executed AO frame. Enabling allocates
the optional resources and selects the masked transport pipeline; disabling
destroys those resources and restores the original pipeline and direct draw.
Neither transition resets temporal history or replaces the public AO target.
Disabling temporal filtering also releases the optional mask; re-enabling
recreates it if pruning is still requested. Resize/device/source changes and
disposal follow the temporal owner's lifecycle. No GPU resources are created
on an unchanged frame. This changes work selection, not AO quality; gains
depend on motion coverage and AO radius, and dense motion can make its extra
classification/query overhead unprofitable.

Temporal defaults: enabled, configured upper bound 32 accumulated samples; the native-style
reconstruction uses at most 16. `historySamples` is an integer in
`[1,64]`. `resetVersion` is a nonnegative safe integer; the reset function
increments it for explicit camera cuts or externally changed scene content.
Disabling temporal filtering restores static phase zero and the original
spatial-only output. All existing native goldens remain unchanged.

The existing contact/GI temporal owner provides camera-only, depth-validated
accumulation, but lacks object velocity, normal rejection, and per-pixel
history confidence. Reuse its running-mean/phase conventions, not its GPU
resolver. AO owns a dedicated native-format fullscreen reconstruction pipeline;
no full-scene TAA is required. The active implementation and exact native/production
contracts are specified in [58-diligent-denoiser.md](58-diligent-denoiser.md).

The optional velocity target is a same-size, single-sample signed floating-point
RG/RGBA texture. XY equals half the previous-minus-current NDC position,
with Y up, matching `GeometryTextureType.LINEAR_VELOCITY`. The resolver changes
the Y sign exactly once when converting to top-down texture coordinates.
Without velocity, previous view-projection provides camera-only reprojection
for static geometry. With valid velocity, rigid/object motion is supported;
XY-only input conservatively rejects depth-changing motion. Opting into
`velocityHasPreviousDepth` requires signed floating-point RGBA input with
previous positive view depth in Z. Native PBR linear-velocity output supplies
this value as previous clip W for perspective projection when
`enableGeometryVelocity(geometry, { previousDepth: true })` is called on a floating-point
RGBA target. Float32 velocity keeps a `1e-5` relative previous-depth tolerance;
half-float velocity uses `2^-10` for depth and motion, and static receivers
substitute the exact camera-only previous depth (module 58). The AO and
comparison demos use `rgba16float`; pruning remains byte-equivalent.
History acceptance and occluder material-point reconstruction use that previous surface
depth, not the old-camera projection of the current surface position.
An independently moving receiver with valid 3D motion is not blindly capped
as if it were a stationary receiver under a changing occluder. Radiometric
change detection still handles genuine AO changes on that surface.
Live skeletal and morph meshes receive deformation-aware input velocity from
PBR and Standard geometry passes, as specified in
[module 31](31-geometry-renderer.md). Floating-origin temporal
reprojection is explicitly unsupported initially.

The PBR geometry velocity path binds a per-renderable `gm` uniform (80 bytes):
previous-from-current world matrix followed by enabled/padding vec4f.
On a world-version change, compute `previousPackedWorld * inverse(currentPackedWorld)`;
apply it to the already transformed current world position before the previous
view-projection. Reset the delta to identity on the following static frame.
First-frame and excluded meshes select current clip coordinates. Per-mesh
uniforms are disposed with the geometry generation; shared material views
never retain another mesh's previous-world buffer. Singular world transforms
fail explicitly. For deforming meshes, previous morph weights and previous
four/eight-influence bone matrices reconstruct the previous local position
before applying previous world/view-projection. Both deformations can change
together; first-frame, hidden and excluded histories initialize neutrally.
Independently animated thin instances, baked VAT and arbitrary custom graph
deformations remain separate velocity contracts.
This per-mesh state and its vertex WGSL live in
`material/pbr/pbr-geometry-velocity.ts`, retained only by the explicit
`enableGeometryVelocity` enabler. Nullable implementation seams fold away in
ordinary PBR geometry scenes, including historical camera-only velocity passes.
The AO producers opt in before scene registration; the temporal consumer still
uses its separate `velocityHasPreviousDepth` option. Error codes for these
optional modules are assigned after established core/compute/accessibility
errors so unused features do not renumber and grow ordinary scenes.

The estimator phase cycles through 64 frames. XeGTAO uses its existing Hilbert/R2
temporal offset, with phase zero identical to the upstream adapter.
Temporal-off estimation always uses phase zero.

### Production reconstruction

`enableSsaoTemporal` selects the complete native-format owner specified in
[module 58](58-diligent-denoiser.md): R8 AO feedback, R16 observation counts,
one full-resolution RG32Uint geometry history, AO/depth convolution, history repair, and spatial
reconstruction. Supplied velocity additionally enables geometry-driven
occlusion-history transport. Optional motion pruning changes work selection,
not the reconstruction or history policy. There is no independent guide
history, confidence-finishing blur, or mandatory motion-activity hierarchy.

The superseded guide-only specification is preserved in the
[historical reconstruction archive](history/ssao-guide-only.md). Its owner and
shaders live only under `scripts/ao-reference/legacy/` and are selected explicitly
with `--legacy`; they are not part of the runtime package.

### Temporal lifecycle and regression scope

History/phase reset on allocation, resize, device or input identity changes,
projection/clip-plane changes, radius/intensity changes,
enable transitions, sample-limit changes, explicit reset, and large camera cuts.
Ordinary camera motion reprojects rather than resetting every frame.
If `executionEnabled` skips the AO task while its velocity producer continues,
explicitly reset before resuming; `enabled` is the supported neutral-output gate.
Disable clears neutral output and invalidates history; disposal releases
private textures/buffers once. Matrix storage and parameter scratch are reused;
no per-frame pipeline, bind-group, or temporary-matrix allocations.

Focused numerical GPU checks must establish decreasing noise against a
multi-phase mean, unchanged background, phase diversity, camera and supplied
object-velocity reprojection, depth/normal disocclusion rejection, history
clipping, resets, odd/small dimensions, and stable public texture identity.
Temporal-off mode must still pass every frozen native-buffer comparison.
The moving-occluder harness also has a `--close-up` profile at 668x536, matching
the supplied recording's resolution, with slow object motion and a closer camera.
It must report absolute floor flicker RMS as well as the relative spatial-only
ratio; passing the relative check alone is not evidence of visually stable AO.
Earlier prototypes exhibited user-visible shimmer despite passing the scoped
budgets. Supplement them with the independent same-input native comparison in
[57-ao-temporal-reference.md](57-ao-temporal-reference.md); a numerical score alone
does not establish production-ready visual quality.
This close-up profile targets the floor; the original profile continues to enforce
the existing moving-surface history and flicker bounds. Close-up floor residual
flicker RMS must not exceed 0.01, and discrepancy from the current 64-phase AO
mean must not exceed 0.02, so blurring away the shadow cannot satisfy the test.
The `--close-up-reversal` profile advances for eight frames, pauses for eight,
then reverses to its starting position. It retains the same floor noise,
signal-error, and ghosting limits, exercising transitions into and out of the
short-history footprint. Material-point matching uses each frame's actual
displacement, including zero and negative displacement.
The shipped path retains long native-format history and transports the changing
occlusion field using nearby occluders' actual motion. Rejected guide-only and
low-history-resolution experiments are historical comparisons, not alternate
production modes. Unused feature code must remain absent from unrelated bundles.

## Lit Demonstration

`demo-ambient-occlusion.html` uses high-level root exports exclusively.
A procedural room contains a ground, two walls, contacting boxes, a sphere,
and a thin occluder. A loaded environment supplies diffuse IBL, with a separate
toggleable directional light and an emissive material for lighting isolation.
The single-sample geometry prepass produces signed view normals and depth;
the AO task consumes both before the ordinary forward PBR color pass.
The demo identifies XeGTAO as its estimator. Controls toggle AO or the
direct light; adjust radius and intensity; and optionally display AO alone.
A checked **Use normal texture** checkbox selects the geometry pass's signed
view-normal attachment. Unchecking assigns `ao.normalTexture = null`, so
estimation, temporal reconstruction/transport, final history capture, and sparse
upsampling all reconstruct normals from the existing depth attachment. The
status names the selected normal source. This is an AO input comparison, not
removal of the demo's geometry pass: it still produces velocity and keeps its
normal attachment available for switching back. It does not disable normal
history or the production anti-ghosting safeguards.
An **AO quality** selector exposes Low/Medium/High/Ultra spatial sampling
independently of the resolution selector. It defaults to High (18 samples
per evaluated pixel). Temporal filtering is enabled by default with a 16-sample limit, equivalent to
the API default of 32 after its native cap. An **Advanced temporal settings**
section contains a **History sample limit** slider that sets
`SsaoTemporalSettings.historySamples` from 1 to 16 and displays
the limit and `1 - 1 / historySamples` as the maximum history weight. Thus the initial maximum
history weight is 0.9375 (93.75% history, 6.25% current AO); one sample means
zero temporal history weight. This is a maximum, not a fixed blend factor:
history age/validity, rejection, and transported-footprint limits can increase
the current-frame contribution. The shader uses current weight
`max(1 / count, 1 / blendLimit)`. Existing sample-limit changes reset temporal
history before reconverging. The slider is disabled while temporal filtering
is off and preserves its value for re-enabling. No new runtime setting or
history-cap change is introduced.
The name `historySamples` replaces the ambiguous `samples` in the new temporal
API and its callers; it is never the per-frame spatial sampling count.
Separate temporal and moving-sphere toggles demonstrate convergence and rigid motion handling.
A checked **Motion-mask pruning** checkbox opts into the optional transport
optimization and allows live comparison without resetting temporal history.
The AO-only view is a copy of the visibility target, never a multiply of
the final lit image.

A self-contained procedural glTF adds a green, four-influence skinned beam and
a purple morph-target beam. It reuses the shared subdivided beam geometry from
scene231, carries its own embedded buffer and animation, and uses the public
loader/animation APIs rather than raw GPU handles in scene code.
The shared left-handed beam indices are reversed once when encoding glTF's
counter-clockwise triangles; its outward normals and the shared source geometry
remain unchanged. Back-face culling stays enabled for both examples.
**Skin/morph animation** starts checked and pauses/resumes both examples. Geometry velocity
contains previous deformation and optional previous view depth, so the same
data can serve other temporal algorithms. The contact/profiling drivers pause
these animations explicitly; the regular live demo keeps them enabled.

### Opt-in reduced-resolution rendering

`enableSsaoHalfResolution(task): SsaoHalfResolutionSettings` returns shared
plain state `{ enabled: true, active: false }`. `enabled = false` selects full
resolution. `active` is readonly and indicates whether half-resolution
estimation is actually running. Repeated calls are idempotent.

```ts
interface SsaoHalfResolutionSettings {
    enabled: boolean;
    readonly active: boolean;
}
function enableSsaoHalfResolution(task: SsaoTask): SsaoHalfResolutionSettings;
const resolution = enableSsaoHalfResolution(ao);
resolution.enabled = false;
```

Changing `enabled` selects full- or half-resolution **estimation**. Geometry,
the depth pyramid, temporal reconstruction/history, material sampling and final
scene rendering remain full resolution. The enabler stays inactive below a
320x224 source viewport, retaining at least a 160x112 working grid.
Smaller grids failed the existing motion-quality
budgets. This quality floor is explicit in `active` and in the demo's status,
not a CPU-timing or image fallback disguised as reduced rendering. An inactive
request uses full resolution.

Working AO/edge/visibility dimensions are `ceil(sourceDimension / 2)`.
The estimator executes once per working texel at the full-size source pixel
`min(2 * workingPixel + 1, sourceSize - 1)`. Projection, radius, phase noise,
normals and depth sampling remain in full-size source coordinates.
Full-resolution depth mip sampling retains fine occluder geometry instead of
expanding a nearest-depth corner across a whole 2x2 block. The original
full-resolution shaders use `PIXEL_STRIDE = 1`; sparse estimation uses `2`.
Edge packing compares source neighbors at that stride, and the spatial resolve
operates on the actual working texture dimensions.

Four-tap joint bilateral upsampling reconstructs the spatial signal into the
existing full-size temporal scratch target (or directly into visibility when
temporal filtering is disabled). Tap geometry comes from each actual sampled
full-size source pixel. Normal agreement normally must reach 0.9, and tangent-plane
weight uses `max(1e-4, min(z * 0.005, radius * 0.025))` plus the existing
curvature allowance. A nearest-centered 3x3 search recovers rejected four-tap
coverage; absent compatible geometry yields neutral visibility. Background
remains exactly white. Odd-edge texels use their actual clamped sample location.
Connected concave contacts are an exception to normal-only rejection: retain
bilinear support across a wall/floor crease only when the two signed-plane
tests and a projected pixel/radius bound prove a nearby contact. Opposing
normals, convex silhouettes and separated layers remain rejected. The exact
conditions are specified in [module 60](60-ssao-half-pipeline.md). This avoids
camera-dependent support switches without adding an AO blur pass.

When current normals are reconstructed, the existing 8x8 upsampling dispatch
cooperatively caches raw depth and the reconstructed normals in workgroup
storage. For a workgroup with full-size origin `B`, the normal footprint is
`B-3 .. B+9` in each axis: this includes both bilinear taps and every possible
rounded-nearest 3x3 fallback tap. The reconstruction's two-pixel stencil expands
the depth footprint to `B-5 .. B+11`, a 17x17 float tile. A 13x13 vec3 normal
array and shared origin keep total workgroup storage below 4 KiB.

Load all 289 clamped raw depths, then synchronize. Reconstruct the 64 receiver
normals and the sparse halo, not all 169 normal slots: a 7x7 odd-source grid
has 16 samples inside the 8x8 receiver tile, leaving 33 additional halo normals.
Those 97 writes are disjoint; a second barrier makes them visible to all
threads. Background entries use a defined neutral normal without running the
reconstruction. Both barriers precede output bounds/background returns, so
partial workgroups and single-pixel dimensions remain valid.

Normal-cache slots correspond to **unclamped** tile coordinates; their values
are reconstructed at clamped image coordinates. Receiver lookups use their own
full-size pixel; sparse compatibility lookups use `2*q+1` before image clamping.
This distinction preserves odd trailing edges without reading an unpopulated
cache slot. The existing plane-selection helper accepts a depth-load function
name, letting it read the shared tile without changing its arithmetic.
Bilateral order, acceptance, fallback search, and output conversion are unchanged.
Supplied-normal variants do not declare or initialize any workgroup cache.
No new dispatch, global texture, buffer, or public setting is introduced.
The numerical GPU regression compares cached and uncached RGBA16 output bytes
for patterned sparse AO, discontinuous/background geometry, odd/multi-workgroup
targets, and one-dimensional/single-pixel targets.
For constant-depth geometry, an independent CPU reference brackets each pixel
between the actual clamped receiver positions and verifies patterned AO
interpolation within one maximum-range half-float step, rather than checking
only normalized bounds or comparing two shaders with the same coordinate formula.

The original full-resolution temporal geometry and RGBA previous-depth motion
contracts are retained. A sparse-signal marker in the reserved AO parameter
slot bounds transported history to two observations only for projected
footprints below 16 pixels; resolved footprints retain the accepted native
history response. Full-resolution mode keeps the marker zero.
The marker is `0` for full resolution and `1` for half resolution.

The sparse owner borrows the primary owner's depth pyramid and the selected
full-size resolve destination. It owns only its reduced-area AO/edge/visibility
buffers and its own uniforms/dummy input; it never destroys the borrowed
pyramid or destination. The primary task's public visibility allocation and
PBR leases remain stable when toggling full/half estimation. Mode/source changes
reset temporal history; resize/device changes rebuild the sparse owner.
Unchanged frames allocate nothing. Disabling AO still clears the existing
full-size public output. This mode intentionally trades estimation detail
for fewer receiver evaluations, not for lower-resolution temporal history.

AO and edge working textures are allocated lazily when estimation bindings are
requested. `bindSsaoGpuSources` accepts an internal `estimation = true` argument;
the half adapter passes false for its primary full-size owner while Half is
active. The primary owner still owns its full-size depth pyramid, visibility,
uniforms and depth-copy bindings, but its `working`, `estimatorGroup` and
`resolveGroup` are null. No dummy working texture is substituted. The sparse
owner alone allocates its packed working texture at `ceil(sourceSize/2)`. Thus
active Half removes the unused full-size R32 working texture: exactly 8,294,400
bytes (7.91 MiB) at 1920x1080. With the sparse owner's own reduced textures, the
measured owned total goes from 124.56 to 122.58 MiB; history formats, sizes,
geometry and shader arithmetic do not change.

When Full is selected, or the viewport safeguard selects it, source binding
allocates the two working textures and rebuilds estimator/resolve bindings
before dispatch. Returning to Half releases those textures and clears bindings
that reference them, without replacing the primary owner or public output.
Source identity and working-texture presence jointly govern the binding cache;
unchanged Half and Full frames allocate nothing. Cached pipeline variants
remain reusable across allocation changes.

The temporal owner permits nullable base/scratch resolve bindings. It creates
the scratch resolve group only when its spatial owner has working textures;
Half writes scratch through the upsampler instead. Working-allocation changes
invalidate these bindings, not temporal textures. Synchronize the temporal
bindings even while temporal filtering is disabled, so a Full/Half transition
cannot restore a stale group referring to destroyed working textures. Existing
mode-change history reset behavior is retained. Temporal disable/re-enable,
same-presence normal replacement, supplied/reconstructed normal changes,
resize, small-viewport fallback, device replacement and disposal must retain
correct ownership and never dispatch a destroyed texture.

The quarter-width/quarter-height experiment was removed. Its moving-shadow
history correction caused visible sphere-contact flicker even at Ultra quality,
despite passing aggregate numerical limits. Removing or weakening that correction
reintroduced trailing. Local contact-region measurements, not only broad floor
averages, must inform any future reduced-resolution reconstruction experiment.
The small end-to-end gain did not justify retaining the quality tradeoff.
The runtime and demo support only Full/Half, with Half selected by default.

The GPU-timings toggle starts enabled in this diagnostic demo. It uses the
existing root APIs `setRenderTaskGpuTimingEnabled` and
`getRenderTaskGpuTimings`, not CPU wall-clock measurements or new SSAO
instrumentation. A readout updates at most four times per second from the
mean of newly completed GPU timestamp snapshots over each display interval.
Samples are accumulated without per-frame DOM updates or per-frame containers.
This makes differences smaller than one browser timestamp increment visible
over multiple frames. It lists active
frame-graph tasks in execution order and their summed measured time in
milliseconds. The SSAO task includes all active estimation and denoising passes;
the task sum is not presented as an independently measured full-frame interval.
Disabled, pending, unsupported, readback-error, and dropped-task states are
explicit. Unsupported devices disable the toggle and do not substitute CPU
timings. Disabling profiling releases the existing profiler's GPU resources.
The throttled DOM update shares the demo's existing before-render callback;
it adds no independent animation loop or interval.

GPU timestamps are not normalized for GPU core or memory clocks. Disabling
temporal filtering lowers the workload and can let the driver downclock VRAM;
re-enabling it need not immediately restore the previous memory frequency.
In a captured NVIDIA off/on sequence, memory fell from 7001 MHz (P3) to 810 MHz
(P5). SSAO rose from about 0.6 ms to 2.6 ms, with geometry and lighting also
slowing down. Returning to 7001 MHz restored about 0.6 ms without another
temporal toggle. The pass topology, viewport, and temporal controls were unchanged.

Correlate timing comparisons with **both core and memory clocks** before
attributing a post-toggle change to resource retention or additional passes.
WebGPU's adapter `powerPreference` does not lock either clock. For reproducible
profiling, a consistent per-application driver power policy (for example
NVIDIA's **Prefer maximum performance**) can avoid this power-state variation.
The engine must not change system power settings, run dummy GPU work to keep
clocks high, or hide the slower measurements.

## Test Specification

### Scene 321 Babylon.js comparison

`scene321` renders the Diligent Kitchen (see [module 61](61-diligent-kitchen-comparison.md);
the GLB is restored by `pnpm fetch:ssao-kitchen`, which lab dev/build and scene
bundle builds run automatically) with original vertex colors on a white, rough,
non-metallic PBR base. It is lit by `environment.env` only, because
`enablePbrSsao` occludes environment lighting rather than direct lights. Lite runs a
non-MSAA geometry pass, XeGTAO (`radius` 0.3, `quality` "medium") with default
temporal filtering, `enableSsaoHalfPipeline` and `enablePbrSsao`. The Babylon.js reference uses `SSAO2RenderingPipeline`
(`radius` 0.25, `totalStrength` 1.5, 16 samples), which multiplies the final
color; those values minimize the difference to Lite. Both clear to black because
SSAO2 multiplies the clear color by zero background visibility.

Setup can recreate the reduced AO owners, and reset history, during the first frames
at a timing-dependent frame. The Lite page therefore calls `resetSsaoTemporal`
at frame 16 and stops its render loop 128 frames later; the reference stops after
128 frames. Temporal accumulation and the presented frames are then deterministic;
`?interactive` keeps rendering for manual inspection. The spec also waits for the
lab loader overlay to detach before capturing. SSAO2 draws its hemisphere and noise from
`Math.random`, so the reference seeds it while creating the pipeline. Repeated
captures of both pages are bit-exact.

Without AO the two renders differ by a full-image MAD of 1.1. The AO algorithms
and compositing differ (Lite occludes diffuse IBL before tone mapping; SSAO2
darkens the tone-mapped color), so the measured MAD is 5.26 (4.95 with full-resolution,
high-quality AO) and the ceiling is
7: a coarse bound on lighting, geometry and occlusion placement, not an
equivalence claim.

### Test-only pass and texture-memory audit

`pnpm diagnose:ao` profiles the actual ambient-occlusion demo at 1920x1080,
High quality, radius 0.35, AO-only, temporal history 16 and motion pruning off.
The bounded matrix is Full/Half estimation, supplied/reconstructed normals,
and static/moving sphere. `--samples=N` selects 16..512 measured frames
(default 120); `--quality=low|medium|high|ultra` selects the spatial preset.
Unknown/invalid options fail before starting any server/browser. This is an
explicit diagnostic, not a CI performance gate or the repository perf suite.

The Node runner bundles the unchanged demo through a test-only, exact-source
adapter. Each hook must occur exactly once. It installs allocation/pipeline
observers immediately after engine creation and exposes manual 16-ms stepping
in place of `startEngine`. The ordinary demo, public API and runtime package
contain no profiling hook, new import, timestamp branch or texture accounting.
The isolated page disables the ordinary task timer to avoid nested profiling.

Require GPU timestamp queries and device adapter information identifying a
non-fallback adapter; no software/CPU fallback. Record the reported GPU identity.
Warm 64 frames
after every history/motion reset. Compare all RGBA16 AO output bytes at identical
frame/geometry states before and after diagnostic pass splitting. An output
change fails the run, rather than presenting performance for a changed image.
Collect timestamps in batches of eight frames. Resolve/map only between batches;
never include query readback or CPU wall-clock time in GPU durations. Zero
pass samples remain valid quantized measurements, not missing data.

Baseline measurements bracket the unmodified AO task with standard empty
timestamp passes. Detailed measurements split its compute pass at pipeline
changes, retaining dispatch/binding order, to expose depth copy, depth mips,
XeGTAO estimation and spatial denoising independently. Upsampling and the
existing labeled transport, temporal, convolution, repair, spatial and output
passes are timed directly. Sum repeated labels within each frame before
calculating mean/median/p95; do not sum independently calculated medians.
Report baseline and detailed-pass totals separately: diagnostic splitting and
timestamp instrumentation can change scheduling/cost, so their sum is not
claimed to equal the uninstrumented task time.

Observe real `createTexture`/`destroy` calls. Count live AO textures by object
identity, including every mip and sample; aliases and borrowed pyramids count
only once. Separate persistent AO/count/geometry histories, other owned AO
textures, and borrowed geometry depth/normal/velocity inputs. The demo still
allocates its normal attachment when AO reconstructs normals; report that
retained allocation explicitly. Values are nominal texel payloads, not driver
allocation/residency, transient compression, buffers or texture traffic.
Unsupported formats/dimensions fail explicitly. Save configuration, raw samples,
summary statistics, texture inventory, output-equivalence evidence and browser
identity in `.ao-reference-cache/ssao-profile/profile.json`. No reference image,
golden, ceiling or live user control is changed.

`pnpm diagnose:ao --compare-pruning` selects a paired comparison instead of the
original eight-case audit. It covers Full/Half, both normal sources, and four
deterministic trajectories: static, moving sphere, moving camera, and combined
motion. Camera motion is a smooth bounded orbit, not a camera cut. The demo's
ordinary sphere animation and camera/geometry motion producers remain active.
Every replay resets the trajectory and temporal history, then warms 64 frames.
Default demo/runtime pruning settings stay unchanged.

For each configuration, independently replay 32 consecutive post-warmup frames
with pruning off and on. SHA-256 covers every byte of the full-size RGBA16 AO
output and active R16 history count texture at every frame; dimensions, formats,
frame indices and byte counts must also match. Reject the comparison at the
first mismatch and report its configuration/frame instead of silently accepting
a tolerance. This verifies temporal evolution, not only a final converged image.
Read the masked path's indirect draw during these replays, record active-mask
frame counts, and require nonempty masks for moving-object configurations.
Separately verify diagnostic pass splitting against unsplit output in both modes.
Readbacks and hashing run only in correctness replays, never timed frames.

For whole-task and detailed timings, divide the requested samples among four
paired blocks, with off/on, on/off, on/off, off/on order. Both variants replay
the same post-warmup trajectory in every block, reducing systematic order bias.
Record block order, individual samples and block means; report dispersion rather
than a machine-independent performance guarantee. Whole-task comparison includes
mask construction/reduction, indirect draw and transport. Detailed results retain
the mask/reduction stages, transport, other reconstruction passes and extra live
mask texture bytes. Do not subtract mask costs or compare unrelated trajectories.
The masked path may still issue a zero-vertex transport render pass to clear its
output; its measured time is not proof that any transport fragments executed.

Save the paired results and evidence to
`.ao-reference-cache/ssao-profile/pruning-comparison.json`, separate from the
original `profile.json`. On failure, preserve a clearly failed report with the
error and completed configurations; it must not be mistaken for a successful
full comparison. No default changes follow automatically from a speedup.

### Numerical rendering regressions

`pnpm test:ao:contact` is a focused numerical contact-shadow regression, separate
from screenshot/parity and performance suites. It bundles the unchanged demo
through an exact, unique replacement of `startEngine` with a test-only manual
frame driver. The adapter also omits the lighting-only environment download:
AO-only numerical checks retain all demo meshes/material geometry but require
no network asset or BRDF LUT. No test hooks enter the runtime package or ordinary demo.
Use the historical probe's 1146x1308 viewport, radius 0.35, Ultra, intensity 1,
history 16, pruning off, and Full/Half with both normal sources. `--software`
explicitly selects SwiftShader; other options fail before browser allocation.
This intentionally checks a high-sample stability floor, not every quality preset.

Warm 64 stationary frames, then capture 64 stationary, 96 moving, 32 paused,
64 reversed-motion and 64 smoothly orbiting-camera frames at 16 ms. Project a
32x24 world-space floor grid immediately in front of the sphere: lateral
-0.4..0.4 and camera-facing distance 0.1..0.65, at floor height zero.
For stationary/moving probes the grid follows the sphere, matching the original
localized investigation. Camera motion samples a fixed world-space grid, not
fixed screen pixels. Bilinearly sample temporal output and current spatial AO;
accept a sample only if all four previous-geometry-history normals identify
floor (world Y > 0.98). Require at least half the grid consistently visible
throughout each segment; background, occlusion, NaNs, and insufficient coverage
must not manufacture a passing result.

Measure each point's temporal second difference, its p95 point RMS, and the
second-difference RMS of the coherent patch average. Segment boundaries are
excluded from second differences. Limits are one R8 level RMS (`1/255`),
1.5 R8 levels for p95 (`1.5/255`), and 0.1 R8 level for coherent patch RMS
(`0.1/255`). These absolute limits supplement, not replace, spatial-relative
diagnostics: comparing only to very noisy spatial AO can hide visible shimmer.
The same metric must accept the retained Half/Ultra traces and reject the
recorded quarter/Ultra contact flicker; the old mode is not reintroduced.

Check trailing independently on two fixed floor grids at the initial and
paused sphere positions. At initial/moving-24/moving-48/end-motion/mid-pause/early-reversal/end-
reversal/end-camera checkpoints, average 64 independently dispatched spatial
phases against the current unchanged geometry, projection and normal source.
Reference owners never render the scene or update production temporal history.
Verify their same-phase samples equal the production spatial signal before
using their mean. Newly lit receivers must have previous mean visibility below
0.94 and brighten by over 0.04; require at least 16 per measured checkpoint
and 64 in total. Mean positive temporal trailing minus same-phase spatial
trailing must stay within the existing 0.015 visibility budget. Report current
signal error and spatial noise separately. A frozen dark history must not pass
merely because its second differences are zero.

Keep all segment metrics, localized traces, checkpoint errors, coverage,
source/bundle fingerprints, browser identity and explicit success/failure in
`.ao-reference-cache/ssao-contact/`. Evaluate all four supported configurations
and report all metric failures together. Never loosen existing scene thresholds,
change goldens, or infer general visual correctness from these bounded checks.

Run numerical WebGPU readback against frozen native buffers for all nine
fixtures. Compare every depth mip, working AO/edges, and final visibility.
Assert dimensions and finite values before comparisons.
Never regenerate goldens from the WGSL implementation.

Account separately for GPU arithmetic rounding, eight-bit working/output
quantization, and the half-float public target. Establish actual tolerances from
stage errors; preserve all existing scene and bundle ceilings.

`pnpm test:ao:gpu` runs the focused numeric checks in an actual WebGPU browser,
not a mock or a screenshot diff. Enforced budgets:

- Depth mips: maximum relative error `1e-6`.
- Packed edges: exact byte values.
- Raw XeGTAO: maximum one byte; mean below 0.001 byte.
- Final XeGTAO: maximum one `1/255` quantum plus half-float rounding;
  mean below 0.0001 visibility.

These are new algorithm-port budgets, not increases to any existing scene
threshold. The independent native fixtures and their lock remain untouched.
The output explicitly rounds its normalized AO value to half precision before
storage instead of relying on backend-dependent texture-format truncation.
The scalar Hilbert walk is retained: replacing its scalar swap with a vector
swizzle changed the sampling sequence on the validation backend and was caught
by raw-buffer parity.

Add scoped configuration/lifecycle tests, missing-normal tests, odd/small-size
dispatch checks, disabled identity, resize/source replacement, double disposal,
and root-entry opt-in tree-shaking. Do not run all scenes, performance tests, or
unrequested screenshot parity.
Each preset must select its documented specialization constants and reuse
cached estimator pipelines when revisited; changing only quality must not
recreate resolve pipelines or public textures. Check XeGTAO in
full and sparse modes. Non-high presets must produce finite normalized results
and genuinely alter an occluded fixture; returning to High must reproduce the
original default output exactly. Compare each sparse preset's raw receivers
against that same full-resolution preset, including odd and one-pixel targets.
History-limit and quality changes must reset temporal accumulation independently
while leaving the other control unchanged.

`pnpm test:ao:pbr` uses a controlled PBR environment and GPU color readback.
Injected constant AO isolates composition from the separately validated estimator.
Assert diffuse-IBL attenuation, unchanged direct/emissive contributions,
`min` with baked AO, same-frame bind-group/bundle refresh after reallocation,
unchanged specular IBL, complete old-generation lease retirement,
and neutral sampling after disposal. CPU tests cover pass exclusion, signature
identity, camera/aspect guards, device fallback, idempotence, and fenced leases.

`pnpm test:ao:temporal` defaults to the shipped Diligent-based temporal owner.
It checks native feedback formats, production rejection and R8 convergence,
motion-pruning bounds and toggles, small/odd targets, and actual PBR geometry
world-motion/exclusions/resize. `--diligent` remains an explicit alias for that
same production suite. `--half` selects sparse-estimation numerical checks,
including cache/scalar byte equality and independently calculated interpolation
at clamped trailing edges;
`--moving` selects the moving-occluder regression, with optional `--half`,
`--close-up`, or `--close-up-reversal`. Profile flags also imply `--moving`.
`--legacy` explicitly selects the archived guide-only prototype instead;
it cannot be combined with production/reduced-resolution/moving selectors.
The retired `--quarter` selector and other unknown flags
and conflicting profiles fail before creating a server or browser.

Local Windows validation uses installed Edge and the hardware GPU by default;
other platforms use Playwright Chromium. Explicit `--software` selects
Playwright Chromium with `--enable-unsafe-webgpu` and explicit
`--use-webgpu-adapter=swiftshader` selection for Dawn. Do not force ANGLE or
the compositor's Vulkan backend: those unrelated overrides can prevent Dawn's
software adapter from initializing. There is no automatic hardware-to-software fallback, successful
skip, or CPU timing substitute when WebGPU is unavailable. The PR Unit Tests
job installs Chromium and runs the production and half suites with `--software`.
These are scoped numerical GPU checks, not screenshot/parity or performance
tests, and they never regenerate reference data.

For XeGTAO it compares a 32-frame accumulated image with an
independently CPU-averaged 64-phase spatial-output mean and requires lower
noise error than one spatial-only frame. This is a temporal-convergence check,
not a ray-traced quality oracle or a replacement for the native phase-zero goldens.
Moving-shadow regression cases keep receiver depth, normals, and velocity
unchanged, warm history, and move the AO shadow. A separate real moving-sphere
test compares newly lit floor receivers with current-frame 64-phase AO and
the same-phase spatial-only output; excess mean trailing error must stay below
0.015 visibility. This distinguishes temporal lag from current-frame sampling
noise and fails the original ghosting implementation.
The moving-scene test also samples an unrelated stationary box and limits
per-pixel temporal residual RMS to 0.003 visibility. On changing floor
receivers, residual frame-to-frame flicker must be below 60% of the same-phase
spatial-only result, while the 0.015 trailing-error budget remains unchanged.
The static convergence oracle averages the base spatial estimates from fresh
history, not the confidence-dependent final display pass.

## File Manifest

- `post-process/ssao.ts`: public frame-graph AO task.
- `post-process/ssao-gpu.ts`: internal WebGPU owner and bindings.
- `post-process/ssao-half-resolution.ts`: opt-in sparse receiver estimation, quality floor, borrowed-pyramid ownership and lifecycle.
- `post-process/ssao-half-wgsl.ts`: full-geometry joint bilateral upsampling into the full-size spatial signal.
- `post-process/ssao-wgsl.ts`: depth, XeGTAO, and output shader factories.
- `post-process/ssao-temporal.ts`: opt-in temporal settings, phases, camera matrices, and history lifecycle.
- `post-process/ssao-diligent-gpu.ts`: shipped native-format temporal/history owner and cached render passes.
- `post-process/ssao-diligent-wgsl.ts`: shipped temporal accumulation, transport, convolution, repair, and reconstruction shaders.
- `post-process/ssao-motion-pruning.ts`: separate opt-in transport-pruning resources and lifecycle.
- `post-process/ssao-motion-mask-wgsl.ts`: camera-relative motion bounds, hierarchy union, and conservative transport queries.
- `post-process/ssao-pbr.ts`: opt-in diffuse-IBL composition and sampled-output ownership.
- `material/plugin/dynamic-pbr-bindings.ts`: resource-versioned material bindings and fenced generation leases.
- `material/pbr/pbr-diffuse-occlusion.ts`: nullable generic shader-expression seam, isolated from lazy namespace exports.
- `material/pbr/pbr-binding-decorator.ts`: nullable generic binding seam with a separately tree-shakable installer.
- `tests/lite/unit/ssao.test.ts`: scoped CPU contract/lifecycle tests.
- `tests/lite/unit/ssao-pbr.test.ts`: lighting scope and texture/binding ownership contracts.
- `tests/lite/unit/ssao-temporal.test.ts`: temporal settings, phase/reset, input validation, and lifetime contracts.
- `scripts/ao-reference/validate-webgpu.ts`: numerical GPU oracle comparisons.
- `scripts/ao-reference/profile-ssao.ts`: bounded isolated-demo pass/memory audit runner.
- `scripts/ao-reference/ssao-profile-client.ts`: test-only timestamp and live-allocation observer, output-equivalence check and manual frame driver.
- `scripts/ao-reference/ssao-profile-contract.ts`: diagnostic options, exact source adapter, texture-byte accounting and timing statistics.
- `tests/lite/unit/ssao-profile.test.ts`: diagnostic validation, accounting, timestamp, adapter and source-hook contracts.
- `scripts/ao-reference/contact-contract.ts`: localized shimmer, coverage and separate trailing metrics.
- `scripts/ao-reference/validate-contact-client.ts`: deterministic actual-demo floor probes and independent 64-phase spatial oracle.
- `scripts/ao-reference/validate-contact.ts`: bounded Full/Half and normal-source numerical runner and failure reports.
- `tests/lite/unit/ssao-contact.test.ts`: localized metric sensitivity, stale-shadow and invalid-data regressions.
- `scripts/ao-reference/validate-webgpu-client.ts`: real browser GPU execution/readback, odd/small-size and missing-normal checks.
- `scripts/ao-reference/validate-pbr.ts`, `validate-pbr-client.ts`: focused real-GPU PBR composition checks.
- `scripts/ao-reference/validate-temporal.ts`, `temporal-validation-options.ts`: production-first validation routing and explicit browser/backend selection.
- `scripts/ao-reference/validate-diligent-client.ts`, `validate-temporal-scene-client.ts`: production convergence, rejection/reprojection, small dimensions, and actual PBR geometry velocity/resize checks.
- `scripts/ao-reference/legacy/`: archived guide-only owner, shaders, and explicit legacy validation; excluded from the runtime package.
- `lab/lite/src/demos/ambient-occlusion.ts`, `lab/lite/demo-ambient-occlusion.html`: lit procedural demonstration.
- `tests/lite/unit/ssao-treeshake.test.ts`: root-entry opt-in proof.
- `packages/babylon-lite/third-party-notices/*`: verified upstream licenses included by the existing package notice generator.
