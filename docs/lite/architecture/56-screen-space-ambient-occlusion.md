# Module: Screen-Space Ambient Occlusion

> Entry point: `packages/babylon-lite/src/post-process/ssao.ts`.
> Support modules: `packages/babylon-lite/src/post-process/ssao/`.

## Purpose

Provide an opt-in WebGPU AO buffer computed from a perspective camera's depth
attachment and optional signed surface normals, with spatial/temporal
reconstruction enabled by default. XeGTAO is the sole estimator.
No existing Babylon scene, golden, or ceiling changes.

`createSsaoTask` constructs the complete production pipeline. Reconstruction is
not a second feature that callers must enable: low/medium spatial sampling and
Half rendering depend on it for usable noise levels. Explicit spatial-only
operation remains available for diagnostics or an alternative consumer filter.

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

## Algorithm identity and provenance

Babylon Lite ships one AO estimator: XeGTAO, based on
[Intel's implementation](https://github.com/GameTechDev/XeGTAO/tree/a5b1686c7ea37788eeb3576b5be47f7c03db532c).
The default temporal accumulation, convolution, history repair, and spatial
reconstruction described here are adapted from
[DiligentFX's AO reconstruction](https://github.com/DiligentGraphics/DiligentFX/tree/eaf6ab785968bdee2393210c5a67033a4d9140cc).
They filter the XeGTAO output; there is no separate runtime "Diligent" AO
implementation or algorithm selector. This combination is not presented as
Intel's unmodified whole pipeline.

The runtime modules, internal symbols, and GPU labels use `xegtao`.
The upstream license retains the DiligentFX name to identify the
actual source implementation.
XeGTAO's MIT license and DiligentFX's Apache-2.0 license (which has no
accompanying NOTICE file at the pinned commit) are preserved under
`packages/babylon-lite/third-party-notices/` and included in the published
package's generated `NOTICE.txt`. The adapted reconstruction modules
(`ssao-xegtao-wgsl.ts`, `ssao-xegtao-gpu.ts`) state that they are adapted from DiligentFX.

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
    temporal?: boolean | SsaoTemporalOptions;
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
    readonly temporal: SsaoTemporalSettings;
}

function createSsaoTask(config: SsaoTaskConfig, engine: EngineContext, scene?: SceneContext): SsaoTask;
function enablePbrSsao(scene: SceneContext, task: SsaoTask, materials?: readonly PbrMaterialProps[]): Promise<void>;
```

All fields are plain state. The infrastructure's `Task` lifecycle is the same as
existing frame-graph tasks. Public configuration exposes no raw GPU handles.
Call after creating depth/geometry targets, add after their producing task, and
before a consumer of the AO target. The output uses visibility: white is
unoccluded; black is occluded. It is a filterable `rgba16float` render target.

Defaults: radius 0.5 view units, intensity 1, enabled, and temporal reconstruction
enabled. `temporal: false` explicitly selects spatial-only output;
`temporal: { enabled: false, ...options }` can also configure its future velocity
input before starting disabled. `ao.temporal` is one stable readonly reference
to mutable plain settings. Change `ao.temporal.enabled` or
`ao.temporal.historySamples` at runtime; use `resetSsaoTemporal(ao.temporal)` for
cuts. Configured velocity source/depth contracts are captured at construction,
not changed by mutating the original config object.

No temporal GPU history or temporal-owner passes are allocated/executed while
initially disabled. The controller and its small CPU state remain available
for an explicit live re-enable. Floating-origin reprojection is unsupported:
default enabled construction fails explicitly there, and enabling a previously
disabled controller also fails before allocating temporal GPU resources.
Spatial-only operation requires an explicit opt-out in that environment.
There is no algorithm selector.
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
The standalone showcase demo visibly enables the existing pruning
option by default; its checkbox allows an unpruned comparison. The runtime
API itself remains opt-in. This avoids spending most of the static-scene budget
searching noisy, stationary AO pixels, without changing sampling or history math.

Estimator pipelines are cached in a quality-keyed record, with one spatial resolve
pipeline per owner. An unchanged frame allocates no new
pipeline/cache key/container. Full and Half owners receive the same preset;
Half evaluates the reduced geometry grid with the original camera projection.
Changing quality resets temporal history without reallocating the public output.
Unsupported preset strings fail explicitly at the task boundary, before any dispatch.
Mutable
settings are validated at the API boundary and sampled before each dispatch.
Intensity is in [0,1]; radius is positive and finite.
Intensity keeps its existing unit gain, resolved as
`clamp(1 - intensity * (1 - rawVisibility), 0, 1)` before temporal filtering.
Zero remains neutral, and no negative visibility enters history. No direct light,
specular, emissive, or material base-color adjustment is introduced.

Perspective projection and full-target viewports are supported initially.
The initial SSAO pipeline supports left-handed builds only. The right-handed
geometry normal attachment has a different Z convention; construction in a
`babylon-lite-rh` build fails explicitly rather than feeding it to this estimator.
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
sample it, or `null` to reconstruct normals from depth. In Full, changing between
these variants invalidates estimator pipelines and recreates the temporal owner,
resetting history without replacing public visibility. In Half, it recreates the
reduced-input/estimation/reconstruction owner and full-size output because input
preparation and final upsampling have different shader variants. The managed
output target stays the same; PBR bindings follow backing-texture replacements,
and other pre-recorded consumers must re-record their graph. Replacing a normal
target with another of the same format only rebinds sources and resets history.
Invalid formats, multisampling, or mismatched/unbuilt dimensions fail explicitly.
The task never owns or destroys either normal source. The same selection
propagates to input preparation and bilateral reconstruction; unchanged frames
retain cached resources.

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
4. XeGTAO edge-aware denoising into the reconstruction scratch target.
5. Default temporal accumulation, AO/depth convolution, history repair, and
   spatial reconstruction into stable `rgba16float` visibility. An explicit
   temporal opt-out sends step 4 directly to visibility and skips step 5.

Each reduction dispatch reads only its preceding mip view and writes one
destination mip view. This avoids the five simultaneous storage bindings used
by the native reference, preserving baseline WebGPU limits. Eight-by-eight
workgroups bounds-check output coordinates. Odd-size reductions include the
final source row/column; one-dimensional and small targets remain valid.

Uniform layout: 176 bytes. The first 96 bytes match the native GTAO constants:
size(u32x2), reciprocal size, depth unpack, tan half-FOV, NDC multiply/add,
per-pixel view scale, radius/falloff, radius multiplier/padding/final power/blur
beta, sample power/thin compensation/mip offset/noise index. Next: one reserved
zero, intensity, two reserved zero padding values (four f32); then view matrix. Supplied/world normal
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
  (`ao.size`) and the Half prepare (`ceil(size / 2)`).
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
Scene 348 nevertheless compares the shipped integration against Babylon.js
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
Only a consuming pass using the AO camera samples its visibility. A pass using
another camera (including a secondary view or reflection/probe camera), or no
camera, samples the existing neutral white texture instead: it renders normally
without borrowing another view's occlusion. A pass using the AO camera must still
have the same effective aspect ratio; a mismatched projection remains an explicit
configuration error. The pass publishes the actual viewport-adjusted aspect used
to pack its scene UBO, including canvas dimensions when `RenderTaskConfig.cs` is
enabled. Validation uses that value, not the physical offscreen target shape:
a square target using the AO camera's canvas-aspect projection is valid.
The task is bound to one owning scene. New material attachment happens before
scene registration; repeated enabling for already attached materials is idempotent.
Shared source materials retain one dispatcher plugin. Its weak consuming-scene
mapping selects each scene's own sampling state before bind-group creation and
before dynamic updates; nonparticipating scenes sample engine-owned neutral white.
Camera selection and aspect validation apply only to the selected participating scene.
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

Dynamic groups and their texture leases are cached by renderable, pipeline, and
the render task's stable `DrawUpdateContext` identity. Groups are created lazily
on the first update, after the plugin's internal `_prepareDraw` hook selects
the correct resources for the pass camera. Each binding retains its own selected
group, so updating two passes before either draws cannot cross-contaminate them,
even when both use the same material/renderable and GPU pipeline. The selected
AO/neutral variant is part of the binding token. Changing a pass camera refreshes
that pass's group; alternating unchanged cameras across passes does not recreate
groups or invalidate render bundles every frame. Each watched plugin's token is
compared independently, rather than summed, so opposite selection changes cannot
cancel each other. Scene selection still runs before camera selection. Disposal,
output replacement and device replacement retain fenced texture-generation leases.
Binding users reference-count each cached pass state. Successful generation
replacement, mesh removal and task disposal retire their removed bindings;
candidate rollback preserves bindings retained by the live generation.
The last binding user immediately removes its cached state and schedules its
texture leases for fenced release, even while the mesh remains alive. One
mesh-lifetime cleanup callback is retained as a fallback, not one callback per
temporary pass or output resize. These cold retirement hooks and the pass-aspect
publisher are installed only by the dynamic-binding enabler through
`render/draw-binding-lifecycle.ts`, and fold away from ordinary passes.

The feature owns sampled-texture leases, neutral fallback, and old-generation
retirement. Materials capture only a sampled-texture state object, never the
scene or AO task. Disposal restores neutral sampling and respects queued GPU
work and material-held texture references.
Dynamic textures are excluded from the mesh's static texture lease list:
only their current bind-group generations keep them alive. The white fallback
is recreated when the engine device changes, including during material rebuild
before the AO task has published its replacement output.

## Temporal AO

Reconstruction is initialized by `createSsaoTask`, before PBR composition:

```ts
interface SsaoTemporalOptions {
    enabled?: boolean;
    velocityTexture?: RenderTarget;
    velocityHasPreviousDepth?: boolean;
    historySamples?: number;
}
interface SsaoTemporalSettings {
    enabled: boolean;
    historySamples: number;
    resetVersion: number;
}
function resetSsaoTemporal(settings: SsaoTemporalSettings): void;
```

For example, `ao.quality = "medium"` selects eight spatial depth samples per
evaluated pixel. Independently,
`createSsaoTask({ depthTexture, camera, temporal: { velocityTexture, historySamples: 8 } }, engine, scene)`
bounds mature temporal history at eight observations. Changing either does not change the
other setting or implicitly enable/disable half resolution.

Motion-mask pruning is a separate, disabled-by-default optimization:

```ts
interface SsaoMotionPruningSettings {
    enabled: boolean;
}
function enableSsaoMotionPruning(task: SsaoTask): SsaoMotionPruningSettings;

const ao = createSsaoTask({ depthTexture, camera, temporal: { velocityTexture, velocityHasPreviousDepth: true } }, engine, scene);
const temporal = ao.temporal;
const pruning = enableSsaoMotionPruning(ao);
pruning.enabled = false; // Restore unpruned transport for a highly dynamic scene.
```

Call the pruning enabler on an AO task constructed with object velocity.
Missing velocity and disposed
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

Temporal defaults: enabled, with 16 accumulated history samples (the native
reconstruction length). `historySamples` is an integer in
`[1,16]`. `resetVersion` is a nonnegative safe integer; the reset function
increments it for explicit camera cuts or externally changed scene content.
Disabling temporal filtering restores static phase zero and the original
spatial-only output. All existing native goldens remain unchanged.

The existing contact/GI temporal owner provides camera-only, depth-validated
accumulation, but lacks object velocity, normal rejection, and per-pixel
history confidence. Reuse its running-mean/phase conventions, not its GPU
resolver. AO owns a dedicated native-format fullscreen reconstruction pipeline;
no full-scene TAA is required. The active implementation and exact native/production
contracts are specified in [#reconstruction-pipeline-and-ownership](#reconstruction-pipeline-and-ownership).

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
substitute the exact camera-only previous depth (see temporal reconstruction below). The standalone
demo uses `rgba16float`; pruning remains byte-equivalent.
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
never retain another mesh's previous-world buffer. Registration and world-version
changes use one allocation-free inverse attempt, cached until the next change.
Its singularity threshold is relative to the sum of absolute determinant terms,
not an absolute mesh-scale cutoff; small invertible scales (including `0.0001`)
are valid. Singular, non-finite or GPU-unrepresentable inverses fail explicitly
for tracked meshes, without substituting identity. Excluded/hidden meshes remain
neutral and must have an invertible transform when tracking resumes.
For deforming meshes, previous morph weights and previous
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
The library build also appends SSAO/velocity modules and their binding seams to
its entry traversal, following the existing opt-in accessibility rule. Otherwise
new entries can reorder ordinary emitted imports and perturb minifier names,
growing unrelated scene bundles even when no SSAO code survives tree-shaking.

The estimator phase cycles through 64 frames. XeGTAO uses its existing Hilbert/R2
temporal offset, with phase zero identical to the upstream adapter.
Temporal-off estimation always uses phase zero.

### Production reconstruction

The default reconstruction controller selects the complete native-format owner:
R8 AO feedback, R16 observation counts,
one full-resolution RG32Uint geometry history, AO/depth convolution, history repair, and spatial
reconstruction. Supplied velocity additionally enables geometry-driven
occlusion-history transport. Optional motion pruning changes work selection,
not the reconstruction or history policy. There is no independent guide
history, confidence-finishing blur, or mandatory motion-activity hierarchy.

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

### Reconstruction pipeline and ownership

The default temporal owner retains the stable public AO target and redirects
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
Native history length is 16, which is also the largest accepted
`historySamples` value.

Omitting the current normal input reconstructs normals from depth; those normals
are still stored in geometry history. In Half, preparation reconstructs reduced
normals once from full-size source depth, and the final upsampler reconstructs
full-size receiver normals. Every estimation and history resource matches the
active working resolution. Full/Half transitions replace the GPU and temporal
owners, reset history and republish full-size output. Bindings are recreated
even when temporal filtering is disabled, so re-enabling cannot restore groups
referencing destroyed resources.

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
The native 1% Z-only check would reject valid low-resolution curved surface
taps, so it is not used.
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
They do not introduce a broad clipping guide or a moving-floor history cap.
Production feedback also avoids the R8 accumulation deadband. When a mature
pixel's blended update is below half an R8 level, apply bounded unbiased
quantization dither using a spatially rotated bit-reversed frame sequence.
Include the exact half-level boundary with one float32 ULP of arithmetic
allowance (`0.5/255 + 1/8388608`); excluding that boundary leaves an eight-level
shadow stuck forever at the native sixteen-frame blend.
Otherwise an old shadow can remain permanently two levels dark with a four-frame
blend, or eight levels dark with a sixteen-frame blend, even when current AO is
white. Fresh/reset pixels do not dither.
The dither lies strictly within half a level, so already-white background and
stable white receivers remain exactly white.
Do not dither an unchanged observation (`abs(current-old) <= 1/8388608`);
render-target conversion near the white endpoint can otherwise occasionally
move an already-cleared pixel down one byte.
Do not reduce production confidence for motion when current/history AO differ
by no more than one UNORM8 level plus half an input half-float ULP
(`1/255 + 1/4096`). Native strict inequalities otherwise treat unchanged white AO
as outside a zero-variance envelope and unnecessarily discard moving-surface
history.
When that unchanged-observation condition holds, the variance envelope cannot
reduce confidence and the large-change condition cannot apply. Skip the unused
3x3 AO statistics, motion factor, square root, and gamma calculation entirely.
Otherwise retain the original neighborhood summation order, strict envelope,
and confidence update. This is work elimination, not looser clipping or a
change to history limits, R8 quantization, dither, or reconstruction.
Uniform control is reset, maximum samples, a reserved lane, and the previous-depth
contract. Inverse view-projection recomputation is cached on ordinary unchanged
frames; cuts/projection changes invalidate it.

The quarter-resolution history experiment was removed with the unsupported
mode. Its lower-only clipping suppressed trailing but amplified localized
contact-shadow fluctuation, including at Ultra quality. The runtime retains
the accepted full/half temporal response without that clipping heuristic.

### Reconstruction stages

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

### Temporal GPU interfaces and binding layout

```ts
function createXegtaoTemporalGpu(
    owner: SsaoGpu,
    velocity: GPUTextureView | null,
    transport?: boolean, // default false
    previousDepth?: boolean // default false
): XegtaoTemporalGpu;
function bindXegtaoTemporalGpu(state: XegtaoTemporalGpu, velocity: GPUTextureView | null): void;
function executeXegtaoTemporalGpu(state: XegtaoTemporalGpu, encoder: GPUCommandEncoder): void;
function disposeXegtaoTemporalGpu(state: XegtaoTemporalGpu): void;
```

The owner retains `scratch`, two `history`, two `counts`, one `geometry`,
`convolution`, `convolutionDepth`, `repaired`, and optional
`closestMotion`/`transport` textures; the 384-byte `uniform` and 96-float `data`;
the borrowed source identities; original/scratch spatial resolve bind groups;
`index`, `disposed`, pipelines, and two arrays of cached
`{ pipeline, group, pass: GPURenderPassDescriptor }` stages. It owns no scene.
An internal `XegtaoTransportExtension` optionally supplies `pipeline`,
`resources`, `indirect`, `execute(encoder)`, and `dispose()`.
The last bound extension identity is cached separately. There is no default
motion-pruning flag on the factory.
The convolution AO texture uses the
`ssao-xegtao-temporal` label, also matched by the capture observer.
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

### Occlusion-history transport

The reconstruction controller uses this transport whenever a velocity source is
supplied. An additional pass searches dynamic occluders in the receiver's physical AO
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

## Half-resolution pipeline

### Half API

`enableSsaoHalfResolution(task: SsaoTask): SsaoHalfResolutionSettings` is the sole
Half enabler. It reduces geometry inputs,
depth preparation, estimation, denoising, motion pruning and temporal histories
to `ceil(width/2) x ceil(height/2)`, then reconstructs a full-size visibility
texture. It deliberately trades thin/contact detail and temporal resolution for
lower cost and memory. It does not promise a 4x total
speedup: the source producer and final upsample remain full-resolution.

```ts
interface SsaoHalfResolutionSettings {
    enabled: boolean;
    readonly active: boolean;
}
function enableSsaoHalfResolution(task: SsaoTask): SsaoHalfResolutionSettings;
const resolution = enableSsaoHalfResolution(ao);
resolution.enabled = false; // Full estimation and reconstruction.
```

The returned plain settings start at `{ enabled: true, active: false }`.
Mutable `enabled` requests Half; readonly `active` reports the effective mode.
Repeated calls return the same settings. A disposed task or another installed
resolution adapter is an error. Disabled settings, width below 320, or height
below 224 use the normal Full pipeline. No new scene ownership or raw GPU API
is exposed. There is no estimation-only Half mode or separate reconstruction
resolution control.

### Half-pipeline data flow and shaders

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
[Temporal GPU binding layout](#temporal-gpu-interfaces-and-binding-layout) follow the reduced velocity
format. Source attachments are borrowed and never destroyed.

The reduced `SsaoGpu` uses kind `float`, always-provided view-space
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
(`ssaoHalfUpsampleWGSL`) on the filtered half-size visibility, using a
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
`group * 8 - 2`) feeding `aoDepthNormal`. Normal agreement normally must reach
0.9; tangent-plane weight uses `max(1e-4,min(z*0.005,radius*0.025))` plus
`0.5*length(deltaPosition)*length(deltaNormal)` curvature allowance.
The normal weight uses repeated squaring instead of `pow(x,8)`. If the four
bilinear taps have total weight below `1e-6`, search a nearest-centered 3x3
neighborhood, weighted by compatibility divided by `1+distanceSquared`.
No compatible support yields neutral visibility; background stays white.
Odd trailing pixels use their actual clamped source positions.
The workgroup barrier precedes bounds/background
returns, so partial groups and odd image edges remain valid.

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

### Half-pipeline lifecycle and isolation

The task owns the reduced GPU and public full-size output. The resolution
adapter owns only reduced input textures, its full-size parameter buffer and cached
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
graph.

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
per evaluated pixel). Temporal filtering is enabled by default with the API's
16-sample history limit. An **Advanced temporal settings**
section contains a **History sample limit** slider that sets
`SsaoTemporalSettings.historySamples` from 1 to 16 and displays
the limit and `1 - 1 / historySamples` as the maximum history weight. Thus the initial maximum
history weight is 0.9375 (93.75% history, 6.25% current AO); one sample means
zero temporal history weight. This is a maximum, not a fixed blend factor:
history age/validity, rejection, and transported-footprint limits can increase
the current-frame contribution. The shader uses current weight
`max(1 / count, 1 / blendLimit)`. Sample-limit changes reset temporal
history before reconverging. The slider is disabled while temporal filtering
is off and preserves its value for re-enabling.
`historySamples` is never the per-frame spatial sampling count.
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
data can serve other temporal algorithms. The regular live demo keeps these animations enabled.

### Opt-in reduced-resolution rendering

The demo's Full/Half selector controls the single
[`enableSsaoHalfResolution`](#half-resolution-pipeline) mode. Half reduces both
estimation and temporal reconstruction, including geometry inputs and motion
pruning, and is selected by default. The scene and public AO output remain
full-size. Its status distinguishes active Half from the small-viewport Full
safeguard. Toggling Full/Half replaces the private owner and resets history;
PBR bindings follow the new output generation.
The demo re-records the AO task and its AO-only copy when the resolution or
normal-input mode changes, so that pre-recorded copy never samples a retired
output generation.

A reduced-signal marker in AO parameter slot 17 bounds transported history to
two observations for projected footprints below 16 working pixels. Full mode
keeps that marker zero. The same RGBA previous-depth velocity contract applies
in both modes.

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

### Scene 348 Babylon.js comparison

`scene348` renders the
[Diligent Kitchen hosted in BabylonJS/Assets](https://github.com/BabylonJS/Assets/tree/master/meshes/DiligentKitchen)
with original vertex colors on a white, rough,
non-metallic PBR base. It is lit by `environment.env` only, because
`enablePbrSsao` occludes environment lighting rather than direct lights. Lite runs a
non-MSAA geometry pass, XeGTAO (`radius` 0.3, `quality` "medium") with default
temporal filtering, `enableSsaoHalfResolution` and `enablePbrSsao`. The Babylon.js reference uses `SSAO2RenderingPipeline`
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
Bundle measurement uses a separate `bundleReady` signal after registration, the
first rendered frame and its GPU submission completing. All of this static scene's
size-relevant code paths have loaded by then; visual stabilization does not load
additional runtime modules. The ordinary `ready` signal still waits for frame 144
and remains the parity/capture contract. Measurement keeps its normal 50-second
budget and rejects reported errors or missing readiness. This changes neither the
177 KiB ceiling nor the rendering or reference pixels.

Without AO the two renders differ by a full-image MAD of 1.1. The AO algorithms
and compositing differ (Lite occludes diffuse IBL before tone mapping; SSAO2
darkens the tone-mapped color), so the measured MAD is 5.26 (4.95 with full-resolution,
high-quality AO) and the ceiling is
7: a coarse bound on lighting, geometry and occlusion placement, not an
equivalence claim.

### Final implementation coverage

The production unit suites cover task configuration, resource lifetime,
PBR diffuse-lighting scope, temporal history/reset state, reduced-resolution
ownership, motion-pruning dispatch, and root-entry tree-shaking. Geometry
velocity has its own task and deformation-history unit coverage.
Scene 348 remains the gallery/parity example with its existing immutable
Babylon.js golden and error ceiling.

The Kitchen URL is shared by the Lite and Babylon.js scenes through
`lab/lite/src/shared/kitchen-asset.ts`. It loads directly from Assets; no local
model copy or asset-preparation command is required. The asset's Apache-2.0
license and conversion provenance are maintained in its Assets directory.
Native generators, prototype comparisons, and research datasets are archived
separately and are not dependencies of the public build or CI.

## File Manifest

- `post-process/ssao.ts`: public frame-graph AO task.
- `post-process/ssao/ssao-gpu.ts`: internal WebGPU owner and bindings.
- `post-process/ssao/ssao-half-resolution.ts`: sole Half enabler, reduced geometry inputs, estimation/history ownership, quality floor and full-size output.
- `post-process/ssao/ssao-half-wgsl.ts`: full-size joint bilateral upsampling after reduced-resolution reconstruction.
- `post-process/ssao/ssao-wgsl.ts`: depth, XeGTAO, and output shader factories.
- `post-process/ssao/ssao-temporal.ts`: default reconstruction initialization, settings, phases, camera matrices, and history lifecycle.
- `post-process/ssao/ssao-xegtao-gpu.ts`: shipped native-format temporal/history owner and cached render passes.
- `post-process/ssao/ssao-xegtao-wgsl.ts`: shipped temporal accumulation, transport, convolution, repair, and reconstruction shaders.
- `post-process/ssao/ssao-motion-pruning.ts`: separate opt-in transport-pruning resources and lifecycle.
- `post-process/ssao/ssao-motion-mask-wgsl.ts`: camera-relative motion bounds, hierarchy union, and conservative transport queries.
- `post-process/ssao/ssao-pbr.ts`: opt-in diffuse-IBL composition and sampled-output ownership.
- `material/plugin/dynamic-pbr-bindings.ts`: resource-versioned material bindings and fenced generation leases.
- `render/draw-binding-lifecycle.ts`: opt-in binding retirement and actual pass-projection metadata hooks.
- `material/plugin/pbr-plugin-passes.ts`: IBL-only plugin pass policy, signatures and binding selection, installed by `enableDynamicPbrBindings`.
- `material/plugin/pbr-plugin-decorator.ts`: nullable plugin-bridge decoration seam with a separately tree-shakable installer.
- `material/pbr/pbr-diffuse-occlusion.ts`: nullable generic shader-expression seam, isolated from lazy namespace exports.
- `material/pbr/pbr-binding-decorator.ts`: nullable generic binding seam with a separately tree-shakable installer.
- Geometry velocity producer files (`frame-graph/enable-geometry-velocity.ts`, `material/geometry-deformation-*.ts`, `material/pbr/pbr-geometry-velocity*.ts`) are listed in [module 31](31-geometry-renderer.md).
- `tests/lite/unit/ssao.test.ts`: scoped CPU contract/lifecycle tests.
- `tests/lite/unit/ssao-pbr.test.ts`: lighting scope and texture/binding ownership contracts.
- `tests/lite/unit/ssao-temporal.test.ts`: temporal settings, phase/reset, input validation, and lifetime contracts.
- `tests/lite/unit/ssao-xegtao.test.ts`: final temporal GPU resource and dispatch contracts.
- `tests/lite/unit/ssao-half-resolution.test.ts`: reduced-resolution input and history ownership.
- `lab/lite/src/demos/ambient-occlusion.ts`, `lab/lite/demo-ambient-occlusion.html`: lit procedural demonstration.
- `lab/lite/src/lite/scene348.ts`, `lab/lite/src/bjs/scene348.ts`: final Kitchen comparison against Babylon.js SSAO2.
- `lab/lite/src/shared/kitchen-asset.ts`: common Assets-hosted model URL.
- `tests/lite/unit/ssao-treeshake.test.ts`: root-entry opt-in proof.
- `packages/babylon-lite/third-party-notices/*`: verified upstream licenses included by the existing package notice generator.
