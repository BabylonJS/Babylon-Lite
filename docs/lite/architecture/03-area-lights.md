# Module: Rectangular area lights

> Package paths: `packages/babylon-lite/src/light/`, material-owned extensions in `src/material/{pbr,standard}/fragments/`.

## Purpose

Opt-in, single-sided rectangular emitters, optionally textured, using the exact Babylon.js LTC lookup tables and lighting equations. No point-light surrogate, custom baked LUT, photometric conversion, or area shadow map is used. Light objects know nothing about scenes or GPU resources.

This specification precedes implementation. Source inspection covers Babylon.js PRs [16078](https://github.com/BabylonJS/Babylon.js/pull/16078), [16123](https://github.com/BabylonJS/Babylon.js/pull/16123), [16577](https://github.com/BabylonJS/Babylon.js/pull/16577), [16723](https://github.com/BabylonJS/Babylon.js/pull/16723), and [18605](https://github.com/BabylonJS/Babylon.js/pull/18605). Spector.GPU is unavailable in this environment: source-derived mathematics and focused tests are not claimed to be live GPU captures. New-scene visual validation is an integration responsibility.

## Public API surface

All exports are from the existing package root:

```typescript
interface RectAreaLight extends LightBase {
    readonly lightType: "rectArea";
    width: number;
    height: number;
    diffuse: [number, number, number];
    specular: [number, number, number];
    intensity: number;
    emissionTexture: Texture2D | null;
}
function createRectAreaLight(position: [number, number, number], width: number, height: number, intensity?: number): RectAreaLight;
function enableRectAreaLights(scene: SceneContext): Promise<void>;
function processAreaLightTexture(engine: EngineContext, source: Texture2D): Promise<Texture2D>;
```

Defaults: white diffuse/specular and intensity 1. Dimensions must be finite and nonnegative; zero produces no contribution. Intensity must be finite and nonnegative. Position uses ordinary SceneNode local coordinates. Emission is along **local -Z**. Rotation, quaternion, scaling, parenting, visibility, metadata, and mesh inclusion/exclusion are ordinary SceneNode/LightBase state. Changes to dimensions, intensity, and color (including tuple element writes) bump the light version.

```typescript
const light = createRectAreaLight([0, 3, 0], 4, 2, 1);
light.rotation.x = Math.PI / 2;
addToScene(scene, light);
await enableRectAreaLights(scene);
await registerScene(scene);
```

Enable before registering the scene, including if the first area light will be added later. The promise resolves after validated LUT decoding, current-device texture upload, and registration of material extensions. It rejects on network, HTTP, payload, upload, disposal-during-load, or unsupported-lighting errors. Repeated/concurrent enables are idempotent. After a device replacement, material group preparation revalidates and uploads against the replacement device.

`StandardMaterialProps.roughness?: number` supplies the LTC roughness (default 0), independently of Blinn-Phong specularPower. Ordinary non-area Standard lighting is unchanged.

## Internal architecture and memory layout

Every light retains the existing four-vec4 **64-byte** entry and the existing configurable `MAX_LIGHTS` capacity. At float offset `o`:

| Entry                      | Values                                 |
| -------------------------- | -------------------------------------- |
| `data` / `o..o+3`          | world center X, Y, Z, type **4**       |
| `diffuse` / `o+4..o+7`     | diffuse RGB × intensity, half-width X  |
| `specular` / `o+8..o+11`   | specular RGB × intensity, half-width Y |
| `direction` / `o+12..o+15` | half-width Z, half-height X, Y, Z      |

For column-major world matrix W, the center is W[12..14]; half-width is `(W[0],W[1],W[2]) × width/2`; half-height is `(W[4],W[5],W[6]) × height/2`. Do not normalize either axis: nonuniform scaling, parent rotation, and shear must affect the quadrilateral geometry. Mirrored transforms follow the transformed vertex winding. The floating-origin path may subtract the active camera offset from the center only.

The factory installs the standard `_cloneNode` callback. `cloneTransformNode(source: SceneNode): SceneNode` invokes it for specialized nodes and deep-clones children. Clones reconstruct from the actual local position, width, height, and intensity before copying common transform/filter state. Color tuples copy caller input before tracking and are independent between clones. Emission image wrappers are borrowed/shared by light clones without acquiring scene-specific resource ownership. A cloned subtree reassigns each cloned child to its cloned parent; a standalone clone has no parent. No Lite scene serialization framework exists for this feature; no serializer is invented. PR18605's position and zero-photometric-scale regressions are prevented by preserving state and using intensity directly.

### Optional material seam

An internal, typed, scene-owned lighting contribution carries preparation, single-light source resolution, multi-light source resolution, scene feature bits, Standard shader context, and Node validation. General modules only invoke this optional seam or transport its opaque data; they never compare the area type, decode axes, fetch LTC, or import area modules.

PBR preserves the actual lightType through single-light source selection. An optional source is resolved before falling back to existing dynamic single-light imports. Mixed lighting augments the existing punctual loop using an explicit WGSL injection argument, not emitted-WGSL parsing/replacement. A feature-owned wrapper returns neutral aliases for area lights so the ordinary punctual helper never interprets packed half axes as range/cone values. The registered PbrExt owns the shared LTC helper and all texture/sampler declarations together, gated by scene bit `1<<6` and nonzero light mode. Resource preparation reuses the existing awaited `_registerPbrSceneHook` registry: the hook gates on the feature's scene ownership WeakMap and prepares current-device LTC before material composition/binding. No additional generic PBR preparation call is required.

The scene's feature-owned `_pbrFeatures(meshId)` resolver also returns scene bit `1<<7` only if an area light belongs to the actual mesh selection. It mirrors the packed-light cap, skips lights without writers, and uses the same inclusion/exclusion predicate as mesh-light packing. Only this selected-area bit gates layered-BRDF rejection; merely enabling area support, or excluding an area light from a layered punctual receiver, must not reject that material. Forward and geometry PBR builders pass the already-computed mesh ID scalar, merge the opaque contribution before composition, and include it in cache keys. They never interpret the bits or receive a material/mesh branch-gating object.

Standard supplies a feature-owned lighting function through its scene shader context. It reuses the ordinary Standard function with an explicit additional early-return block. Its StdExt declares LTC bindings/helpers and writes roughness into existing material float 22 (`mat._0`) through an optional material-UBO writer. Material bit `1<<28` gates the extension; Standard scene bit `1<<1` distinguishes cached variants, combined with fog bit `1<<0`. The async group builder awaits the optional scene preparation callback. Feature bits are declared only in lazy feature modules, with reservation comments in shared flag files.

Both forward and `createStandardGeometryMaterialView` builders merge `_materialFeatures` before extension enumeration and cache-key construction. Geometry output reuses Standard lighting code even if its color is dead, so it still requires matching LTC helpers, declarations, and binding entries. `enableMaterialTracking(material)` tracks optional Standard roughness even when its initial value is undefined; assignments bump the source `_uboVersion` and update float 22 in forward and geometry material UBOs.

Node lighting is explicitly validated during scene build. Initial implementation rejects Node lighting blocks in area-enabled scenes containing an area light rather than silently interpreting type 4 as a point light. Unlit node graphs remain supported. Full Node/PBR-MR LTC composition is deferred; the shared helper/bindings remain suitable for that future extension.

## Pipeline configuration

No vertex-stage, raster, topology, depth, blending, render-pass, or scene-light layout changes. Existing material pipelines continue to own shaders. Each active area material extension contributes, in fragment phase, two `texture_2d<f32>` bindings and two filtering samplers. Binding descriptor order and entry order are identical: LTC1 texture/sampler followed by LTC2 texture/sampler. Bindings and helpers are emitted as one fragment, avoiding PR16577's missing-NME-sampler regression.

LUT textures are 64×64, one mip, `rgba16float`, `TEXTURE_BINDING | COPY_DST`, sampled with linear min/mag filtering and clamp-to-edge U/V/W. No flip, gamma conversion, mip generation, or Float32 expansion occurs. Upload uses 512 bytes/row and 64 rows/image.

## Shader logic

Reconstruct axes A and B from the packed six scalars. Corners, in order, are C+A-B, C-A-B, C-A+B, C+A+B. Their cross-product points local -Z. Reject the back face when `dot(cross(corner1-corner0,corner3-corner0),P-corner0)<0`. Collapsed axes return zero.

Use V normalized from surface to eye and the material's perturbed unit normal N. Lookup UV is `(roughness,sqrt(1-clamp(dot(N,V),0,1))) × 63/64 + 0.5/64`. Sample t1/t2 at level zero. The inverse LTC matrix has columns `(t1.x,0,t1.y)`, `(0,1,0)`, `(t1.z,0,t1.w)`.

Construct tangent T1 from `V-N*dot(V,N)`, and T2=`-cross(N,T1)`, retaining Babylon's handedness. At exactly normal view, choose a deterministic perpendicular tangent instead of normalizing zero. This is the continuous isotropic limit, not an alternate BRDF. Transform each corner delta by `inverseLtc × transpose(mat3(T1,T2,N))`, then normalize.

For normalized edges u,v, x=`dot(u,v)` and y=`abs(x)`. The factor is:

```text
a = 0.8543985 + (0.4965155 + 0.0145206*y)*y
b = 3.4175940 + (4.1616724 + y)*y
q = a/b
k = x>0 ? q : 0.5/sqrt(max(1-x*x,1e-8))-q
edge = cross(u,v)*k
```

Sum four edge vectors to f. The horizon-clipped scalar form factor is `max((dot(f,f)+f.z)/(length(f)+1),0)`. This is Babylon's specified LTC approximation, using the same coefficients and textures, not a newly introduced approximation. Evaluate once with the LTC matrix (S) and once with identity (D).

PBR uses the surfaceAlbedo and colorF0/colorF90 already computed by the existing material workflow:

```text
diffuse += surfaceAlbedo * light.diffuse.rgb * D * material.directIntensity
F = colorF0 * light.specular.rgb * t2.x
  + (1-light.specular.rgb) * t2.y * colorF90
specular += light.specular.rgb * F * S * material.directIntensity
```

No extra 1/PI, inverse-square attenuation, punctual NdotL, or photometric scale is applied. The repeated specular color multiplication is intentional Babylon PR16723 behavior, including when intensity exceeds one. Standard uses `F=light.specular.rgb*t2.x+(1-light.specular.rgb)*t2.y`, returns `light.diffuse.rgb*D` and `light.specular.rgb*F*S`, and retains the material's existing final diffuse clamp/albedo/specular-color multiplication.

The initial PBR area path covers ordinary metallic-roughness/specular-glossiness surface diffuse/specular. Optional layered direct-light BRDFs are explicitly rejected if used with area lighting instead of approximated.

## State machine and lifecycle

CPU payload cache is lazy, shares one in-flight fetch, retains decoded Uint16 arrays on success, and removes a rejected request so retry is possible. Validate **exactly 65,536 bytes** before reading. Read little-endian words with DataView. For texel i and channel c, LTC1 word is input[i*8+c], LTC2 is input[i*8+4+c]. Preserve raw half-float bits, including signed/subnormal encodings.

GPU resources are lazy, cached per GPUDevice and reference-owned by enabled scenes. Use the existing texture acquire/release and sampler pool. Device identity must be checked before using cached views. A scene owns an idempotent disposal closure registered before any await; if it dies during loading, no handles are installed. On device change it releases its old allocation ownership and acquires replacement-device resources. Last release destroys both textures and removes that cache entry; other scenes retain theirs. A failed partial upload destroys allocated textures and surfaces the error. Each allocation carries a readiness promise for a WebGPU validation error scope; validation failure rejects preparation and releases every waiting scene's allocation claim. Disposal during that promise destroys its ownership and causes preparation to reject. A device replacement during validation retries preparation against the replacement device. No public GPU handles, top-level Map/WeakMap allocations, or import-time registration.

Area shadows are unsupported. Node lighting is rejected in scenes containing area lights. Layered PBR direct-light BRDFs are rejected only when an area light is selected for that mesh. Errors are actionable. Arbitrary ShaderMaterial code remains caller-owned. Changing scene lighting topology requires the existing scene rebuild/registration path. Material-group preparation replaces device-specific LTC allocations when the engine's device changes; no stale bind group is valid across device replacement.

## Textured emission specification

### Preprocessing, orientation, and ownership

`processAreaLightTexture(engine, source)` is standalone, asynchronous, scene-free, and root-exported. It accepts a live, single-sampled, sampleable color `Texture2D` on the engine's current device. Depth, integer, unfilterable, array/3D, malformed size, released resource, and wrong-device resources reject explicitly. Ordinary raster textures should use `srgb:false`: Babylon's preprocessing works in the sampled RGB byte domain, with no extra gamma conversion. Source UV transforms are not applied, matching the upstream fullscreen processor. `invertY` is respected for top-origin codec/pixel sources; the ordinary raster-upload flip already supplies Babylon Y-up texels.

Create a 1024×1024 `rgba8unorm` render attachment, with COPY_SRC/COPY_DST/TEXTURE_BINDING and 11 mip levels. Render a fullscreen triangle whose storage row 0 samples Y-up source V=0, using UV `(uv-0.125)/0.75`, mirror-repeat U/V, and implicit source LOD from pixel derivatives. Retain the source's pooled min/mag/mip/anisotropy settings; ordinary raster sources are trilinear. The existing sampler pool's canonical descriptor key supplies these settings without a second retained metadata cache; an unknown sampler falls back to trilinear. This creates the same orientation as the upstream effect render followed by its raw-texture update: processed storage rows are sampled directly, without an additional V flip in the LTC helper. The processor owns its sampler rather than modifying any source fields.

Read the scaled level-zero bytes with a MAP_READ staging buffer. For each output pixel `(x,y)`, exterior distance is `max(128-x,128-y,x-896,y-896,0)`. The separable Gaussian has length `7+2*distance`, sigma `length/4`, and half-length `floor(length/2)`. Compute each exponential in double precision, store it into Float32, sum the original doubles, then divide the stored Float32 coefficients by that sum and store back into Float32. Each axis convolves RGB in double precision and rounds to nearest byte with `Math.round`, clamps to [0,255], and copies alpha unchanged. Reflect indices about boundary texel centers (`-i` below zero and `2046-i` above 1023). The second axis reads the first axis's rounded bytes. Upload the final bytes and use the existing GPU mipmap blitter for the complete chain. The returned sampler is linear min/mag/mip with clamp-to-edge.

Source ownership remains with the caller. The source is borrowed only for the synchronous scale submission, before the processor's first await; WebGPU retains already-submitted resource references for that work. The processor creates no transient ordinary ownership claim that device recovery could incorrectly transfer to a replacement facade. It snapshots the source allocation and rejects if that allocation is released or the facade/device is replaced during any await, without releasing or touching a replacement resource. It retains no source, GPU pipeline, kernel library, or promise after completion. The returned wrapper owns one ordinary caller reference (`releaseTexture(result)`); it has internal device provenance and processed-image identity shared by `cloneTexture2D`. Assignments and light clones borrow/share this wrapper, never acquire or release GPU resources. Scene preparation acquires its snapshot's processed images, so callers may release their result reference after successful enable. Releasing before enable or assigning an ordinary unprocessed texture is an actionable error. Disposing the source's last caller claim during the await rejects the operation rather than publishing an abandoned result. Device replacement during preprocessing rejects and cleans staging/partial output; reprocess on the new device. WebGPU validation errors, readback failures, and upload failures reject. No new public API exposes a raw GPU handle.

### Compact binding and synchronization

Successful preprocessing installs a module-local preparation seam; only the scene enabler invokes it. When preprocessing is not consumed, the setter, preparation seam, and complete emission import graph tree-shake away from solid consumers. The lazy scene setup detects packed emission maps and dynamically imports textured runtime/material modules only when such maps are present. Assigning an ordinary texture without preprocessing rejects during enable, rather than silently using a solid shader. Solid scenes never load preprocessing or emission-sampling modules. They retain their existing shaders, four LTC bindings, and 64-byte light entries.

The emission runtime owns a scene snapshot: current GPUDevice, packed-light identities (writers only, capped at MAX_LIGHTS), unique processed GPUTexture images, a compact 1024×1024×N 2D array with 11 mips, and a mapping uniform. Copy all mip levels directly from each processed image into a distinct array layer; no resampling or sampler mutation. Two wrappers sharing an image share a layer; different images at identical light positions remain different layers. Mapping is by packed scene slot, not mesh selection order, world position, or mutable per-light scene fields. A slot maps to layer+1, with zero meaning solid/punctual. The uniform is an array of vec4<u32>, padded to `ceil(MAX_LIGHTS/4)` vectors. Selected-single and multilight shaders use the existing `mli` packed indices to resolve it, so filters and changes to slot order remain correct.

Snapshots capture the active light capacity as well as the packed list. A capacity change invalidates allocation reuse even if light identities and images are unchanged, including changes within the same padded vector count. Allocate the mapping from that captured capacity and generate its WGSL declaration at material composition time, never module import time. Thus an initial enable at 16 followed by a glTF auto-raise before first pipeline compilation supports a textured emitter at packed slot 16 or beyond. Capacity changes during an awaited upload reject and clean candidate resources; binding a snapshot prepared for a different current capacity rejects with an enable/rebuild diagnostic rather than pairing mismatched shader and buffer sizes. The existing `setMaxLights` contract still requires capacity changes before pipelines are compiled; arbitrary post-compilation mutation is not supported.

Bind three extra entries only for textured variants: `texture_2d_array<f32>`, one filtering sampler, and the mapping uniform. All textured-light counts therefore consume one additional texture and sampler, rather than MAX_LIGHTS pairs. PBR binds through a generic scalar scene-binding ID and an optional disposal collection; Standard already receives its scene and disposer collection. The ID has no feature meaning in shared modules. Binding owners retain snapshot allocations independently of scene ownership: old forward/geometry materials remain valid while replacements are built. Last allocation owner destroys its array and mapping buffer and releases the acquired image snapshots. Disposed scenes delete their scalar ID registry entry; no promise or scene is retained indefinitely.

The async preparation hooks run for both PBR and Standard groups. They validate image provenance/current device and rebuild snapshots when packed identities or assignments change. Enable detects whether textured variants are needed and atomically publishes the new scene shader seam only after successful preparation; cached variants distinguish solid and textured feature bits. Cross-scene snapshots never share mappings or mutable indices. Initial use is preprocess → assign → await enable → register. For assignment/clear/add/remove/reorder after registration, stop rendering, mutate state, `await enableRectAreaLights(scene)`, then `await rebuildSceneRenderables(scene)`, and resume. This existing full-group rebuild path synchronizes forward, geometry, selection, and shader context. Do not change lighting topology midway through an awaited rebuild. A preparation that observes a changed topology during await rejects with a rebuild-again diagnostic rather than installing a stale snapshot. Clear-to-solid releases the scene's emission owner, while old bound materials release theirs through normal rebuilding/disposal.

Standard scene preparation/context resolution is installed explicitly through a module-local generic seam: when the enabler is absent those optional calls fold away, avoiding the PR806 scene103 footprint regression. Standard lighting-source transport and extra helper parameters/arguments similarly have nullable installers; no extra string fields are read when the relevant enablers are absent. The emission Standard module supplies the packed-index scalar for its exact helper identity. It compares known helper string values, never parses emitted WGSL and never passes a branch-gating object. PBR also transports its scalar scene binding ID and binding-owned disposer collection only through lazily installed callbacks; auxiliary ownership collections are never allocated when the binding extension is absent. The scene/material core contains no emission semantics. Textured extension ID `rect-area-emission` does not overlap the solid `rect-area-light` ID: PBR's existing hierarchical prefix binding dispatch must not accidentally select the solid binder for the textured fragment.

Reject disposed scenes before creating an LTC/emission owner or registering any disposer, and recheck disposal after every asynchronous resource phase. A public `disposeScene(scene)` before the first enable must create no resources and install no owner.

### Textured LTC mathematics

Use the existing back-face/degenerate checks, normal-view tangent fallback, LTC lookup, and corrected diffuse/F0/specular-color multiplication. Textured results change diffuse/specular from scalars to RGB vectors. For each diffuse identity-basis transform and each specular inverse-LTC transform, transform corners first; sample emission before normalizing corner directions. Solid slots return RGB one times the existing form factor.

For transformed corners q0,q1,q2,q3, take axes X=q1-q0 and Y=q3-q0, normal n=cross(X,Y), squared area a=dot(n,n), and h=dot(n,q0). Project the origin onto the light plane: p=h*n/a-q0. Remove the component of Y along X: Y'=Y-X*dot(X,Y)/dot(X,X). Solve v=dot(Y',p)/dot(Y',Y'), u=dot(X,p)/dot(X,X)-dot(X,Y)/dot(X,X)*v. This explicitly handles nonorthogonal transformed axes. UV is `0.125+0.75*(u,v)` with X flipped. Distance d=abs(h)/pow(a,0.75); LOD=`log(2048*d)/log(3)`. Clamp the zero-distance case to LOD zero rather than computing log(0). Degenerate transformed axes produce zero; finite valid rectangles use the exact reference equations. Trilinear clamp sampling supplies RGB. Compute diffuse and specular samples separately; never reuse the diffuse projection for specular.

### Focused verification

Upstream-derived, independently expressed numeric oracles verify Float32 kernel normalization, boundary reflection, exterior-radius selection, per-axis byte rounding, unchanged alpha, asymmetric image orientation, full mip descriptors, and projection/LOD with nonorthogonal axes. Mock device tests cover sampler nonmutation, invalid/unprocessed/released/wrong-device images, GPU/map failures, disposal/device/capacity changes during awaits, cleanup and retry. Mapping/binding tests cover multiple maps at identical positions, shared maps/clones, mixed punctual/solid/textured lights, filters, MAX_LIGHTS, reordered slots, clear/rebind, cross-scene isolation, and forward/geometry paths. Real Standard and mixed PBR group builders verify initial preparation at 16 followed by capacity growth before registration/first pipeline compilation, with the emitter at packed slot 16 and exactly paired declaration/upload/binding sizes. Unchanged-list growth/shrink invalidates allocations while preserving old binding generations until their last owners release them. Build tests ensure root-only declarations and tree-shaken emission modules for solid/no-area consumers. Integration owns real-GPU comparisons and scoped runtime-byte measurements; existing ceilings and goldens are untouched.

Allocation replacement and cleanup are unit-tested with distinct mock GPUDevices, and ordinary native WebGPU rendering is integration-tested. The complete opt-in device-lost recovery orchestrator has not been exercised end-to-end for area lights; no claim of verified full recovery is made.

## Babylon.js equivalence map

| Reference                                        | Lite responsibility                                                                           |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `rectAreaLight.pure.ts`                          | local -Z rectangle, transformed center and scaled half axes                                   |
| `LTC/ltcTextureTool.ts`                          | exact interleaved, little-endian rgba16float data                                             |
| WGSL `ltcHelperFunctions.fx`                     | tangent basis, matrix orientation, edges, clipping, Fresnel lookup                            |
| `pbrDirectLighting{SetupFunctions,Functions}.fx` | material F0/F90 and area diffuse/specular                                                     |
| `lightFragment.fx`, `lightsFragmentFunctions.fx` | Standard roughness and material multiplication                                                |
| PR16078                                          | untextured/no-shadow initial scope                                                            |
| PR16123                                          | transform scale and independent diffuse/specular, explicit Node contract                      |
| PR16577                                          | declarations coupled to shared helper                                                         |
| PR16723                                          | metallic/albedo/F0-correct contributions                                                      |
| PR18605                                          | preserve position/dimensions/intensity, unity photometric scale, shared emission image clones |
| `areaLightsTextureTools.ts`, WGSL processing     | exact scale/mirror-repeat, varying Gaussian, byte quantization, full mips                     |
| WGSL `FetchDiffuseFilteredTexture`               | nonorthogonal plane projection, X flip, distance-based mip selection                          |

## Dependencies

Existing SceneNode transforms/clone, shared mesh light selection, shader composition and material registries, texture ownership and sampler pool, native fetch, WebGPU. No package dependency changes.

## Test specification

Focused unit tests cover packing bounds, dirty dimensions/colors/intensity, parent scale/rotation, cloning/reconstruction, mixed mesh filtering, exact endian deinterleaving, malformed length, HTTP/retry/deduplication, upload descriptors, shared-scene disposal, disposal during await, partial allocation failure, device replacement, PBR single/mixed shader outputs, Standard roughness, declarations/bindings, and explicit Node rejection. Keep existing punctual single/multilight material tests green. Run only scoped Vitest, ESLint/Prettier, and package typecheck. The integration owner runs new visual fixtures and scoped bundle measurements without existing golden or ceiling changes.

## File manifest

- `light/rect-area-light.ts`: state, tracked properties, packing, clone.
- `light/enable-rect-area-lights.ts`: public opt-in and generic seam installation.
- `light/area-light-ltc.ts`: binary decoding, request and GPU ownership.
- `light/area-light-wgsl.ts`: shared LTC mathematics and binding declarations.
- `light/process-area-light-texture.ts`, `light/area-light-blur.ts`, `light/area-light-image.ts`: standalone processing, exact CPU Gaussian math and processed-image validation/provenance.
- `light/area-light-emission.ts`, `light/area-light-emission-wgsl.ts`: scene snapshots, compact array ownership/mapping, transformed projection and emission sampling.
- `light/area-light-emission-setup.ts`: lazy scene preparation/extension registration installed by successful preprocessing.
- `texture/read-texture-pixels.ts`, `effect/effect-renderer.ts`: generic standalone fullscreen recording and alpha-preserving texture readback; reuse existing mipmap generation.
- `resource/texture-sampler-pool.ts`: recover ordinary pooled sampler settings without a second cache.
- `material/{pbr,standard}/fragments/rect-area-light-emission-fragment.ts`: lazy textured material declarations/bindings and scalar selected-slot transport.
- `light/lighting-extension.ts`: generic internal seam types only.
- `material/pbr/fragments/rect-area-light-fragment.ts`: PbrExt and light-source contributions.
- `material/standard/fragments/rect-area-light-fragment.ts`: StdExt and area Standard lighting.
- Existing scene/material builders and flags: generic transport/optional calls and bit reservations only.
- `index.ts`: root exports.
- `tests/lite/unit/rect-area-light*.test.ts`: focused state, lifecycle, shader tests.
- `tests/lite/unit/area-light-{texture-processing,texture-lifetime,emission-runtime,emission-opt-in}.test.ts`: exact preprocessing math, failure cleanup, real texture recovery and fresh-runtime opt-in rejection, real forward/geometry/full-scene rebuild binding lifetimes.
- `tests/lite/build/rect-area-light-treeshake.test.ts`: in-memory Rollup consumption of shipped ESM and AST verification of trimmed public declarations; no temporary directories or scene builds.
