# Module: Parallax Occlusion Mapping

> Package paths: `packages/babylon-lite/src/material/parallax/`,
> `material/pbr/fragments/parallax-occlusion-fragment.ts`,
> `material/standard/fragments/std-parallax-occlusion-fragment.ts`

## Purpose

Opt-in height-map UV displacement for PBR and Standard materials, implemented
independently in WGSL using adaptive coarse marching followed by contact
refinement and interpolation. This is **not Tore Lervik's FPOM implementation**,
and does not claim the same algorithm, quality, or performance.

The linked [FPOM 1.2 video](https://www.youtube.com/watch?v=X0eRzccNnPw) points to
[a paid Unreal material-function asset](https://www.fab.com/listings/f56aea7a-337f-4b6a-8333-9e4739574370).
Its [public documentation](https://github.com/hallatore/fpom-docs/blob/main/Settings.md)
describes the interface but does not disclose its acceleration algorithm.
The independently specified solver below follows the two-stage principle
described in [Andrea Riccardi's contact-refinement article](https://www.artstation.com/blogs/andreariccardi/3VPo/a-new-approach-for-parallax-mapping-presenting-the-contact-refinement-parallax-mapping-technique).
No implementation code is copied from either product or Babylon.js.

The initial feature deliberately keeps existing normal maps and does not
generate normals, write fragment depth, add self-shadowing, alter vertex
positions, affect picking/collisions, or change silhouettes. It is a material
texture-coordinate effect, not geometry displacement.

## Public API Surface

All exports are available from the package root:

```ts
export interface ParallaxOcclusionProps {
    readonly heightTexture: Texture2D;
    readonly heightScale?: number; // world-space height range; default 0.05
    readonly heightCenter?: number; // [0, 1]; default 0
    readonly heightChannel?: "r" | "g" | "b" | "a"; // default "r"
    readonly minSteps?: number; // integer [1, 64]; default 8; coarse budget at normal incidence
    readonly maxSteps?: number; // integer [minSteps, 64]; default 32; coarse budget at grazing incidence
    readonly refinementSteps?: number; // integer [1, 32]; default 8; maximum bisected subdivisions
}

export function setPbrParallaxOcclusion(material: PbrMaterialProps, props: ParallaxOcclusionProps | null): void;

export function setStandardParallaxOcclusion(material: StandardMaterialProps, props: ParallaxOcclusionProps | null): void;
```

Use `null` to disable the feature. Call the setter before `registerScene()`.
After a material has been built, changing the height texture or whether POM
has an active shader variant (including crossing zero height scale) requires
`rebuildMaterial(scene, material)`. Standard's separate feature UBO also needs
a rebuild for parameter updates. On an already-active PBR variant with the
same height texture, scalar/quality and height-UV-transform updates can use
`markMaterialUboDirty(material)` instead. The setters copy the settings;
mutating the original options object does not mutate the material. The texture
handle itself remains shared.

```ts
const heightTexture = await loadTexture2D(engine, "/textures/bricks-height.png", {
    srgb: false,
    mipMaps: true,
});

setPbrParallaxOcclusion(material, {
    heightTexture,
    heightScale: 0.04,
    heightCenter: 0,
    minSteps: 8,
    maxSteps: 32,
    refinementSteps: 8,
});
```

`heightCenter = 0` places the entire height range below the mesh; `1` places it
above the mesh; `0.5` splits the range evenly. A sampled height `h` corresponds
to world height `heightScale * (h - 1 + heightCenter)`.

The height texture must be a filterable color texture, not a depth, integer, or
32-bit floating-point texture. RGB height channels must use a linear texture
format; alpha may be used from an sRGB texture because sRGB decoding leaves
alpha unchanged. Height samples are clamped to `[0, 1]`. Addressing and
mag/min/mip filtering follow the texture's existing sampler. The solver selects
one mip level per pixel for its height reads, so the sampler's anisotropy
applies only to the displaced surface-texture lookups.

Invalid scale, center, channel, step counts, or texture kinds throw before
material state or the extension registry changes. Scale must be finite,
non-negative, and representable as `f32`; the step counts are integers in the
ranges above. A zero scale disables shader composition for the feature.

## Internal Architecture

Each material has an optional `@internal _parallaxOcclusion` state field of type
`ParallaxOcclusionProps`. No factory initializes it and no core builder imports
the feature. Each setter imports only its own material-family extension.
Registration occurs at setter-call time, never at module import time.

The PBR fragment owns material `features` bit 5. This does not collide with
`PBR_HAS_FOG`: that constant is used exclusively in the separate `sceneFeatures`
bank. The reservation is recorded in `pbr-flag-bits.ts`; the material-feature
constant is defined only in the opt-in fragment. Standard owns bit 31, likewise
defined only in its opt-in fragment.
Bits 28 and 29 remain reserved for the existing rectangular-area-light receiver
and emission extensions; bit 30 belongs to mesh opacity. Bitwise feature tests
preserve Standard's signed bit-31 value. The projection uses covariant world derivatives and
orients its normal toward the eye, so it needs no coordinate-handedness seam.

Standard detects the feature only when at least one UV-mapped surface texture
is present: diffuse, emissive, bump, specular, ambient, lightmap, or opacity.
With no surface texture there is nothing to displace, so no solver, bindings, or
extra varyings are composed. Reflection maps alone do not activate it.

Four `vec4<f32>` fields describe the feature:

| Field              | Components                                             |
| ------------------ | ------------------------------------------------------ |
| `parallaxHeight`   | heightScale, heightCenter, 0, 0                        |
| `parallaxSampling` | minSteps, maxSteps, refinementSteps, channel index 0-3 |
| `parallaxUVm`      | m00, m01, m10, m11                                     |
| `parallaxUVt`      | offsetU, offsetV, 0, 0                                 |

PBR appends these fields to its material UBO. Standard owns a separate 64-byte,
fragment-visible uniform buffer and releases it through the binding's existing
disposer list. Both bind one `texture_2d<f32>` and one filtering sampler and
enumerate the height texture through the existing acquire/release hooks.

The public `getMaterialTextures()` enumeration also appends the active height
texture after the existing slots. PBR includes it even for a factor-only
material. Standard includes it only when a UV-mapped surface texture activates
POM, using the same feature-owned accessor as its fragment detection and
ownership collector. Both families use the default height scale of `0.05` when
omitted and exclude the height slot at zero scale or after settings removal.
Material views enumerate their source; shared normal/height maps retain both
slot entries rather than being deduplicated. The enumeration imports no POM
shader or extension registry.

The height texture uses the mesh's first UV set. Its matrix follows the existing
texture convention:

```text
c = cos(uAng); s = sin(uAng)
M = [ c*uScale, s*vScale; -s*uScale, c*vScale ]
T = [ uOffset, vOffset ]
```

Height orientation follows the actual material-family surface convention:

- PBR composes the height texture's matrix without an `invertY` adjustment,
  matching its ordinary and per-texture-transformed surface sampling.
- Default Standard reuses `writeStandardUvTransformData` for the base
  transform. This honors the `enableStandardUvOffset()` gate and applies the
  height texture's codec flip before material scale/offset:
  `baseV = scaleV * (1 - v) + offsetV`. The height texture's own matrix follows.
- Per-texture-transformed Standard composes material scale and offset
  unconditionally before the height matrix, like its surface-channel writer.
  If the height texture has `invertY`, negate the final second matrix row and
  replace the final V translation with `1 - translationV`.

The shared writer accepts the base transform as four scalar entries and
captures them before writing its output, allowing Standard to reuse its
existing feature-UBO array as scratch without another allocation.

PBR already carries raw `input.uv`. Standard adds a `parallaxBaseUV` varying,
assigned from the existing raw vertex `uv` attribute, avoiding dependence on
whichever surface texture supplied its legacy shared UV inversion.

## Pipeline Configuration

Extensions use the existing material-owned shader composer and `_pc`
post-composition hook. They do not change render pipelines, target signatures,
vertex-buffer layouts, raster state, depth state, blending, or the renderer.

Forward and geometry/MRT material views use the same displaced texture
coordinates. Geometry position, depth, velocity, and existing normal-map frame
construction remain unchanged. No-color/depth-only and ESM caster views omit
the solver, extra bindings, and Standard varying: casting remains based on the
original mesh and original alpha-mask coordinates.

Only native UV-mapped surface texture samples are transformed. PBR includes
base color, ORM, normal, emissive, specular/glossiness, independent occlusion,
lightmap, clearcoat maps, sheen maps, reflectance maps, anisotropy, iridescence
maps, thickness/translucency maps, and native bent normals. Standard includes
diffuse, emissive, bump, specular, ambient, lightmap, and opacity. Environment/BRDF/reflection maps,
screen-space refraction, shadow maps, and arbitrary plugin-owned samplers are
not UV-displaced.

The post-composer transforms sampling expressions, not shader declarations or
layout metadata. It must handle nested coordinate expressions and whitespace-
minified WGSL. Layouts and fields remain typed composer data.

Standard's normal helper receives the additional screen-offset argument. Only
its texture lookup changes; its cotangent-frame derivatives still use the
original UV, preserving the existing normal-map orientation. The UV-transform
extension's post-composer runs before the parallax post-composer.

Standard geometry's MRT writes are contributed through a typed shader
geometry fragment's BA slot before material post-composition. This puts the native
specular RGB/alpha lookups inside the ordinary shader composition lifecycle,
so both UV transforms and parallax see them without any global sampling hook.
The same fragment owns the optional geometry UBO/varyings, the output struct,
and dependencies on the existing material fragments, so it observes their
final color/alpha without a second fragment or sampling hook. Only its return
signature and terminating return are patched afterward; no texture lookups
are appended late.

## Shader Logic

### Direction-aware projection

Evaluate world-position and height-UV derivatives before ray marching, at
uniform fragment-entry control flow. Perspective uses `eye - P` for the view
ray. Orthographic projection is identified by the zero XYZ entries in the
homogeneous W row of the existing scene view-projection matrix; its Z row is
the world-space gradient of reverse-Z depth and points back toward the camera.
Use that parallel direction instead of the point-to-eye vector, so normal
incidence has no lateral offset and axial camera movement does not change
relief. This needs no new scene uniforms or camera/renderer feature hook and
works with the existing left-/right-handed view convention.

Normalize the geometric normal and selected view vector; orient the normal
toward the eye for two-sided surfaces.

For `Px = dpdx(P)`, `Py = dpdy(P)`, normal `N`, and view direction `V`:

```text
X = cross(Py, N)
Y = cross(N, Px)
D = dot(Px, X)
A = dot(N, V)
screenRay = heightScale * [dot(V, X), dot(V, Y)] / (D * A)
heightRay = heightDx * screenRay.x + heightDy * screenRay.y
```

This derivative-based covariant frame preserves nonuniform world/UV scales,
rotated/flipped texture coordinates, and sloped surfaces without requiring
mesh tangents. A zero scale, zero view/normal length, degenerate derivative
frame, exactly normal-incidence ray, or nearly tangent view (`A <= 0.0001`)
returns zero displacement. The derivative-frame degeneracy check is relative:
`abs(D) <= 0.000001 * max(dot(Px, Px), dot(Py, Py))`.

### Contact-refinement search

Height reads use one explicit mip level per pixel rather than gradient
sampling. With `T = textureDimensions(heightTexture)`, `fx = |heightDx * T|²`,
and `fy = |heightDy * T|²`:

```text
lod = clamp(0.5 * log2(max(max(fx, fy) / 4, min(fx, fy))), 0, mipLevelCount - 1)
height(uv) = clamp(dot(textureSampleLevel(heightTexture, sampler, uv, lod), channelMask), 0, 1)
```

This is the level a 2x anisotropic filter would select: the footprint's major
axis spans at most two texels of that level. Every march read is therefore a
single trilinear tap without a gradient payload or multi-tap anisotropic
filtering; the march itself traverses the major axis at grazing angles. The
channel mask is built once per pixel from the uniform channel index, avoiding
dynamic vector indexing inside the loops.

At normalized ray depth `t`, use:

```text
uv(t) = heightUV + heightRay * (heightCenter - t)
error(t) = t + height(uv(t)) - 1
rayPixels = |screenRay|
rayTexels = |heightRay * T| * 2^-lod
coarseSteps = clamp(ceil(rayTexels), 1, ceil(mix(minSteps, maxSteps, 1 - clamp(A, 0, 1))))
```

The first read at `t = 0` is an immediate top-surface hit when its error is
non-negative. If `rayPixels < 0.5`, the entire parallax shift is below half a
pixel, so that read's offset-limited estimate `hitDepth = 1 - height` is
returned. Otherwise search `t = k / coarseSteps` for `k = 1..coarseSteps`,
retaining the last negative-error sample and first non-negative-error sample.
A step finer than one texel of the selected level adds no heightfield detail,
so the view-angle budget is an upper bound rather than a fixed count.

Bisect the first contact interval, reusing its endpoints:

```text
bisections = clamp(ceil(log2(rayPixels / coarseSteps)), 0, ceil(log2(refinementSteps)))
```

The refinement budget `ceil(log2(refinementSteps))` is computed exactly with
an integer leading-zero count. Bisection stops once the bracket spans at most
one pixel, then interpolates the final bracket:

```text
weight = clamp(-aboveError / (belowError - aboveError), 0, 1)
hitDepth = mix(aboveDepth, belowDepth, weight)
screenOffset = screenRay * (heightCenter - hitDepth)
```

The solver reads at most `1 + coarseSteps + ceil(log2(refinementSteps))`
heights: 36 with defaults and 70 at the maximum settings. Its contact bracket
is never wider than `1 / (coarseSteps * refinementSteps)` unless it already
spans at most one pixel. This is **not** equivalent to a fine search across
the entire ray: thin peaks missed by the coarse search can still be missed, and
bisection converges to one crossing inside the first coarse bracket. Increase
the coarse budgets for sharp/high-frequency height maps. Mipmaps remain a
filtered heightfield, not a conservative visibility hierarchy.

### Performance validation

The solver was selected with a relative WebGPU timestamp-query A/B
micro-benchmark of the actual WGSL helpers, not with frame captures: four
full-screen 2560x1440 draws per pass on an NVIDIA RTX 5070 Ti, median of seven
passes, both Scene 349 Playground assets, front/45°/70° views, depths
0.03/0.06/0.16, and the Low/Medium/High budgets (54 configurations). The
previous design (4x-anisotropic gradient reads, a fixed angle-based coarse
count, and linear refinement) cost 9.39 ms of summed POM overhead above a
surface-sampling floor; this design costs 3.34 ms (2.8x less). Per-configuration
overhead fell by a median of 2.2x at the front view, 1.8x at 45°, and 3.1x at
70°, up to 8.1x at grazing High; Low budgets with deep relief, which leave few
reads to remove, were unchanged within noise. With the same march, 4x-anisotropic
`textureSampleGrad` reads cost 1.5-1.9x the overhead of single-level reads at 70°.

Against a 4x4 supersampled dense reference over the 45° and 70° Medium/High
configurations, final color RMSE is 12.70 versus 12.79 8-bit levels for the
previous design, with 17.3% versus 16.8% of pixels more than 16 levels off.
A 4x-anisotropy level rule reached a lower RMSE of 12.38 but had more large
errors (17.9%) and 10% more overhead, so the 2x rule was kept.

### Surface texture sampling

For every affected surface lookup with its existing coordinate `uv`:

```text
dx = dpdx(uv); dy = dpdy(uv)
displacedUV = uv + dx * screenOffset.x + dy * screenOffset.y
textureSampleGrad(texture, sampler, displacedUV, dx, dy)
```

Each channel retains its own UV set, transform, orientation, and gradients.
Reusing the original gradients avoids deriving mip/anisotropic footprints from
discontinuous ray intersections. The helper never differentiates the ray-march
result and never uses implicit-derivative sampling inside the divergent search.

## State Machine / Lifecycle

1. Setter validates/copies settings and registers the owning extension.
2. Material feature detection selects only matching materials.
3. First renderable build composes/caches the matching shader and binds uniforms
   and the height texture through normal material lifecycle hooks.
4. Existing geometry views inherit the source settings but preserve mesh-depth
   outputs; caster views suppress parallax shader/binding contributions.
5. Rebuilding applies changes or removal. Old renderable resources release
   height-texture references and Standard UBOs through existing ownership.
6. Device recovery/rebuild reuses existing texture/uniform-buffer recovery
   mechanisms; there are no feature-owned device caches or scene references.

## Babylon.js Equivalence Map

This adds independently specified parallax occlusion mapping rather than a
pixel-identical port of Babylon.js's `useParallaxOcclusion` shader. Without the
explicit setters, native PBR/Standard behavior and bundles must be unchanged.
Normal maps, UV conventions, material views, and texture ownership reuse Lite's
existing contracts.

## Dependencies

The public props depend only on `Texture2D` types. Setters depend on their
family's extension registry and the shared validation module. Fragments depend
on the typed shader-fragment contract, shared WGSL/projection/post-composition
helpers, and existing texture/uniform ownership. No renderer, loader, external
shader package, precomputed cone map, or engine feature flag is required.

## Test Specification

- Validate public defaults, copied settings, null/zero-scale removal, all four
  channels, invalid numeric ranges, linear/sRGB-alpha rules, and invalid texture
  kinds before mutation/registration.
- Verify forward and geometry composition for both material families, native
  optional channels, UV1/UV2, transformed UVs, normal mapping, and production-
  minified source. Ensure BRDF, environment, screen-space, and shadow samplers
  remain untouched.
- Verify no-color/ESM variants omit parallax code/bindings and Standard UBO
  disposal and texture acquire/release enumeration are balanced.
- Verify public texture enumeration for both families with a separate height
  map, default/explicit/zero scale, material views, and shared normal/height
  slots. Cover factor-only PBR and inactive Standard materials with no
  UV-mapped surface textures, including reflection-only materials. Importing
  `getMaterialTextures` alone must retain neither POM shader nor extension.
- Compare height UVs with the actual PBR/Standard surface UBO writers for
  codec-flipped textures, non-integer scale/offset and rotation, default and
  transformed paths, and an absent/present Standard offset enabler.
- Compose native bent normals with all supported normal-frame variants and
  verify their lookup is displaced too.
- Compile Standard POM with transformed bump/reflectivity sampling and
  simultaneous geometry normals/velocity outputs, retaining previous-pose
  bindings and undisplaced geometric velocity.
- Numerically check off-axis orthographic normal incidence and normal/oblique
  axial-camera-movement invariance, alongside the perspective cases.
- For filtered ramps/ridges, measure the device sampler's error against the
  ideal heightfield at the actual lookup coordinates, require it to stay below
  one encoded 8-bit height unit, and propagate it through the reference ray's
  contact equation. Preserve the existing solver/refinement tolerances and
  exact sample-count bounds rather than widening a global UV tolerance.
  Test-only FP16 sampling cases must reproduce the old ideal-filter assertion
  failure while satisfying this measured-uncertainty model. Production shader
  sampling is unchanged.
- Compile actual composed vertex/fragment shaders on WebGPU without screenshots.
  Execute a numeric shader oracle for constant and linear-ramp heightfields,
  center/scale/view-direction cases, transformed height UVs, bounded sample
  counts, and finite degenerate-input behavior.
- Assert exact height-read counts where zero heightfields force the full march:
  top hits, the sub-half-pixel single read, the texel cap, mip-level selection
  versus single-level textures, angle budgets at three view angles, the
  refinement budget, and bottom hits that bisect without resampling endpoints.
- For a nonlinear ridge with multiple ray intersections, compare against an
  independent dense-search reference to verify the first contact, the refinement
  error bound, and improved accuracy over coarse-only interpolation. Explicitly
  verify that refinement cannot recover a ridge missed by the coarse search.
- Verify shipped-package root exports/tree-shaking and absence of the unused
  opposite material-family fragment.
- Compare non-visual runtime bundle bytes against the published baseline for
  the synchronized public master commit, not only against scene ceilings.
  Start with scene1/scene282/scene145 and expand to all scenes only when
  explicitly requested. Preserve all existing ceilings.

The scene bundler keeps identifier caches chunk-local and shares only the
property cache. It seeds local identifier names from short ESM export names
already assigned by Rolldown, avoiding redundant `local as export` aliases.
This keeps generated-name changes from adding five bytes per avoidable alias
to an unrelated scene. Bundle-tooling tests cover binding collisions,
multiple exported names for one binding, namespace access, and cross-chunk
property consistency.

The user explicitly authorized mathematical/shader/non-visual validation in
place of unavailable Spector.GPU captures for this independent feature.
Visual/parity and performance validation remain user/CI-owned; no golden
references or ceilings are changed.

The existing WebGPU integration CI job explicitly selects
`parallax-occlusion.spec.ts` alongside the two point-splatting specs and SSAO
depth-validity checks. It compiles
the actual minified material/geometry/caster shaders and executes the numerical
heightfield readbacks; screenshots, videos, traces, and performance runs remain
disabled in that job. The image-based comparison/UI specs are separate from
this numeric/pipeline selection.

## File Manifest

- `material/parallax/parallax-occlusion.ts`: props, validation, uniform writing,
  and feature-owned height-texture accessors.
- `material/parallax/parallax-occlusion-wgsl.ts`: shared WGSL solver and sampler.
- `material/parallax/parallax-occlusion-shader.ts`: shader sampling transforms.
- `material/pbr/set-parallax-occlusion.ts`: public PBR setter.
- `material/pbr/fragments/parallax-occlusion-fragment.ts`: PBR extension.
- `material/standard/set-std-parallax-occlusion.ts`: public Standard setter.
- `material/standard/fragments/std-parallax-occlusion-fragment.ts`: Standard extension.
- Existing material type modules and root `index.ts`: typed state and exports.
- `material/material-textures.ts`: public enumeration of active height slots.
- Focused unit/build specs: API, composition, lifecycle, GPU oracle, tree-shaking.

## Lab comparison: Scene 349

Scene 349 compares the existing, independently implemented Lite solver with
Babylon.js's **native** `useParallax` + `useParallaxOcclusion`, rather than
substituting a custom Babylon.js shader or changing Lite's solver to match it.
The user explicitly selected visual/behavioral comparison, not pixel parity.

The matching pages are `/scene349.html` and `/babylon-ref-scene349.html`.
`/lite/compare-scene349.html` embeds both with the same settings and relays
orbit/zoom state between the two canvases. Same-origin messages are accepted
only from the known counterpart/parent frame; camera values must be finite and
within the scene's front-facing orbit limits. Neither renderer exposes GPU
handles or engine instances for this UI.

Controls update these persistent scenes in place: neither a toolbar change nor
range input navigates the page, replaces a canvas, or reassigns an iframe's
`src`. URLs are kept shareable with `history.replaceState`. The inset slider
uses `input` events while dragging, coalesced to animation frames. Each renderer
serializes asynchronous updates and retains only the newest pending settings,
so texture loads and material rebuilds cannot race.

The comparison sends validated settings queries through same-origin messages
to its two known frame windows. A ready handshake reapplies the latest controls
when a frame finishes initial loading. Applied/error replies make update state
observable and surface failures rather than silently resetting a scene.
Standalone pages use the same updater directly.

Startup and live failures use the same `reportScene349Error` reporter: it records
the canvas error, displays an accessible status, logs the cause, and notifies the
comparison parent. The lab loader accepts a `scene-load-error` custom event with
a string message, stops its readiness polling/observer, and replaces its spinner
with the error presentation. Comparison status retains both renderers' errors;
a successful update clears only that renderer's error. Invalid comparison URLs
are reported before any renderer starts.

An explicit view-preset change updates camera angles/radius; all other settings
preserve the current custom orbit and zoom. Asset pairs are cached for
subsequent switches. Babylon.js changes its existing material properties and
waits for readiness only when texture or feature state changed. Lite uses
`markMaterialUboDirty` for existing PBR parallax scalar/quality uniforms,
`rebuildMaterial` for Standard's separate feature UBO, and rebuilds the
appropriate renderables when textures or POM/zero-depth feature state changes.
The cameras, scene, device, meshes, and material instances remain alive.
No core-renderer seam or shader-algorithm change is needed.

Both scenes have four 2.4-unit square planes facing -Z. Centers are
`(-1.35, 1.35, 0)`, `(1.35, 1.35, 0)`, `(-1.35, -1.35, 0)`, and
`(1.35, -1.35, 0)`. Standard materials occupy the top row, PBR the bottom.
The left column is the undisplaced normal-map control; only the right column
enables POM. Both engines use the exact assets from
[Babylon Playground 10I31V revision 408](https://playground.babylonjs.com/#10I31V#408):

| Asset           | Diffuse                                     | Normal RGB + height A                       |
| --------------- | ------------------------------------------- | ------------------------------------------- |
| Stone (default) | `https://i.imgur.com/VSbN3Fc.png` (256x256) | `https://i.imgur.com/zVGaZNi.png` (256x256) |
| Brick wall      | `https://i.imgur.com/Rkh1uFK.png` (512x512) | `https://i.imgur.com/GtIUsWW.png` (256x256) |

Images are loaded directly from their original URLs, not regenerated or
rehosted. All scene/reference/comparison entry pages set a `no-referrer` policy:
Imgur returns HTTP 403 for these image requests when sent a localhost
referrer, but serves the original PNGs when the referrer is omitted. The
authored normal RGB and alpha height are preserved; the previous
procedural texture and flat/baked-bevel variants are removed. A Stone/Wall
selector switches both renderers together. Existing orbit, POM, depth, and
Lite-quality controls remain available.

Both loaders use the established raster upload Y-flip, repeat addressing,
linear/trilinear filtering, mipmaps, and anisotropy 4. Normal/height data is
linear and must not be alpha-premultiplied. Diffuse values retain their authored
gamma encoding for Standard shading; PBR opts into the matching gamma-2.2
albedo decode (`setPbrGammaAlbedo` in Lite, `gammaSpace = true` in Babylon.js).
Both textures are awaited and load errors remain explicit.

Settings are URL-addressable and shared by both engines:

| Query     | Default   | Supported values                                                                                                       |
| --------- | --------- | ---------------------------------------------------------------------------------------------------------------------- |
| `pom`     | `on`      | `on`, `off`; controls the right column only                                                                            |
| `depth`   | `0.06`    | Finite UV-space inset ratio in `[0, 0.16]`                                                                             |
| `view`    | `grazing` | `front`, `oblique`, `grazing` camera presets                                                                           |
| `asset`   | `stone`   | `stone`, `wall`; selects the original diffuse/normal-height pair                                                       |
| `quality` | `medium`  | Lite-only `low` (4/8/4), `medium` (8/32/8), `high` (16/64/16) front/grazing coarse budgets and refinement subdivisions |
| `embed`   | off       | `1` hides the standalone toolbar for comparison/capture                                                                |

With one UV repeat per square plane, Lite's `heightScale` is `2.4 * depth`,
`heightCenter = 0`, and `heightChannel = "a"`. Babylon.js's left-handed native
POM uses `parallaxScaleBias = depth`, with the same positive sign as the
Playground. The previous negative reference bias inverted the apparent relief;
it was a scene-setup error, not a difference that should be hidden by a parity
tolerance. The UI displays both values rather than
pretending they have the same units. Babylon.js's native fixed loop/sample
selection and implicit texture derivatives remain unchanged. Its output can
differ from Lite's contact refinement, explicit mip selection, and geometric
world-space projection, particularly at coarse settings and grazing angles.
Because Lite's budgets are upper bounds, Medium and High coincide wherever the
ray crosses fewer texels than the Medium budget.

A scoped regression substitutes a UV-ramp color texture and a flat normal map
with constant alpha height at the original asset URLs. With the front-view
camera and positive depth, the right-column Standard and PBR center samples
must move in the same measured UV direction in both engines. Checking signed
red/green changes, rather than only the magnitude of the POM-on/off difference,
catches a reversed bias without requiring pixel-identical marching algorithms.

The scene uses a directional light and hemisphere fill, no IBL, no tone
mapping, identical clear color and camera near/far/FOV, and matching
texture assets/filtering. Orbit/zoom is interactive; panning is disabled so
synchronization has a fixed target. Resize behavior remains engine-native.

The live-update controller retains the last successfully applied settings on
failure. Requesting that same selection while an error is present still reapplies
and publishes it, clearing the renderer and comparison-page errors after recovery
without reloading either document.

The new BJS golden and its 1280x720 JPG thumbnail are captured once from the
Grazing embedded view (`?embed=1&view=grazing`), matching the interactive default
so the relief is easier to see. The saved-reference comparison selects Grazing
explicitly and verifies its actual camera pose. These are visual comparison assets, not a claim of
POM pixel equivalence. `scene-config.json` marks strict pixel parity skipped
with an explicit reason, while the scene-specific browser spec still verifies
that both pages render, both material families react to POM/depth, controls
remain undisplaced, settings are applied consistently, and comparison cameras
stay synchronized. The spec never regenerates the golden. Screenshot
comparisons produce artifacts for inspection instead of using a permissive
MAD threshold to hide algorithmic differences.

Vite's existing HTML-input discovery picks up the new scene/reference/comparison
pages automatically. The gallery and parameterized bundle-size test pick up
the scene card/ceiling from `scene-config.json`; they require no hardcoded
scene registration. The BJS bundle discovery uses the existing `bjsSceneEntry`
resolver rather than assuming the pre-migration `lab/src/bjs` directory, so the
new bundled reference works from `lab/lite/src/bjs` too. Only scene 349's Lite
and BJS bundles are built/measured. BJS bundling respects the upstream
package's `sideEffects` metadata: overriding every module as side-effect-free
removed required raw-texture prototypes, shader/include registration, and
file-loading support, leaving the new reference unable to render. This does
not change Lite bundling or retain any new engine bytes in unrelated scenes.
Captures wait for Lite's loading-overlay fade to finish; `ready` alone is not
enough to avoid compositing a partially visible overlay.

Additional files:

- `lab/lite/src/shared/scene349-parallax.ts`: constants, settings, and original Playground asset URLs.
- `lab/lite/src/shared/scene349-parallax-ui.ts`: standalone controls and bounded camera synchronization.
- `lab/lite/src/lite/scene349.ts`: Lite PBR/Standard opt-in setup.
- `lab/lite/src/bjs/scene349.ts`: native Babylon.js PBR/Standard POM setup.
- `lab/lite/src/scene349-comparison.ts`: synchronized side-by-side page.
- `lab/lite/scene349.html`, `lab/lite/babylon-ref-scene349.html`, `lab/lite/compare-scene349.html`, `lab/lite/bundle-scene349.html`, `lab/lite/bundle-bjs-scene349.html`, `lab/lite/scene349.css`: source/reference/comparison/production entry pages and shared UI presentation.
- `tests/lite/parity/scenes/scene349-parallax-occlusion.spec.ts`: scoped behavioral/render comparison.
- `tests/lite/integration/scene349-comparison.spec.ts`: both native algorithms' POM/depth behavior, original asset selection, and bidirectional camera synchronization.
- `tests/lite/integration/scene349-errors.spec.ts`: visible source/production/comparison startup errors, combined renderer-failure reporting, and recovery that clears only the successful renderer's error, without screenshots.
- `tests/lite/unit/scene349-parallax.test.ts`: deterministic input/settings tests.

Live-control regressions retain document/canvas identities, count document
requests and device creation, and inspect actual rendered changes while moving
the depth slider and changing quality, POM, and assets. They assert that custom
camera poses survive non-view changes, rapid inputs settle on the latest
settings, and explicit presets still synchronize. They do not refresh the
saved references, alter existing ceilings, run timing benchmarks, or expand
validation to other scenes.
