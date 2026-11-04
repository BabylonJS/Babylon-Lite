# Module: Mesh opacity

> Package path: `packages/babylon-lite/src/mesh/opacity/`

## Purpose

Provide opt-in native per-mesh opacity for ordinary Standard and PBR meshes without
changing or cloning their materials. The compat layer implements `Mesh.visibility`
automatically through the same native API. Meshes sharing a material, including
glTF primitive meshes, can have independent opacity.

Opacity is separate from mesh visibility, hierarchy, picking, bounds and visibility
epochs. Thin instances share their owning mesh's opacity. Node/shader materials
cannot fade below 1. MeshLoD instances are not ordinary Mesh objects and are not
supported targets at any opacity. Per-instance opacity, submesh opacity and compat
`InstancedMesh.visibility` are outside this module's contract.

## Public API surface

Both functions are named exports from the sole package root:

```typescript
function setMeshOpacity(mesh: Mesh, opacity: number): void;
function getMeshOpacity(mesh: Mesh): number;
```

The default is 1. The native setter clamps finite numbers to `[0, 1]`; the getter
returns the stored clamped value, including after disposal.

The setter performs these operations in order:

1. Reject non-number, NaN and infinite input with `RangeError`:
   `setMeshOpacity: opacity must be a finite number, got <value>`.
2. Require an object with the existing `_gpu` Mesh discriminator. Otherwise throw:
   `setMeshOpacity: "<name>" is not a Lite Mesh (for example a MeshLoD instance); per-mesh opacity is not supported on MeshLoD in this release.`
   The getter performs the same target check with its own API-name prefix.
3. Reject `_disposed`:
   `Mesh "<name>" cannot set opacity: it was disposed when it left its last scene. Create a new mesh instead.`
4. Clamp the value.
5. If below 1, validate a non-null material's `_buildGroup._materialFamily`.
   Only `"standard"` and `"pbr"` are accepted; otherwise throw:
   `setMeshOpacity: mesh "<name>" uses a "<family>" material; mesh opacity supports only "standard" and "pbr" materials.`
6. Install the feature once. If the stored/default value already equals the new
   clamped value, return without storing, dirtying or writing.
7. Store the value, enqueue a rebuild on crossing 1, and update live binding
   uniforms whenever the new value is below 1.

A null material is permitted. An ordinary, non-disposed Mesh can reset to 1
regardless of material family. Invalid calls must not install hooks/extensions,
store state, allocate/write buffers, enqueue swaps or mutate scenes.

## Internal architecture

### Mesh value and binding records

The feature uses a local intersection, not a member on the core Mesh interface:

```typescript
type OpacityMesh = Mesh & { _opacity?: number };
interface OpacityBinding {
    readonly _buffer: GPUBuffer;
    readonly _device: GPUDevice;
    readonly _engine: EngineContext;
}
```

`mesh-opacity.ts` owns validation, the scalar, installation, transitions and GPU
records. A lazily created `WeakMap<Mesh, Set<OpacityBinding>>` tracks live
binding-owned buffers. Neither the map nor its sets are allocated at import time.
A reusable one-element `Float32Array` supplies writes.

Each active mesh bind-group creation creates a distinct 16-byte uniform buffer.
Only its first four bytes contain the opacity `f32`. Main, geometry and
signature-specific refraction bindings have separate records; no material owns
this buffer. Native shallow mesh clones copy the scalar but never the records.

### Lazy installation and chained installers

The first successful setter call runs this once-guarded sequence:

1. Register Standard extension `"0-mesh-opacity"`.
2. Register PBR extension `"z-mesh-opacity"`.
3. Install a mesh-feature encoder returning `1 << 22` iff opacity is below 1.
4. Install a PBR binding-context augmenter that copies the binding's disposer
   array into `context._disposers`.
5. Install the colour/geometry draw wrapper.
6. Install material-transition validation using the mesh's live opacity.

Extension registration invalidates sorted-extension caches. No registration,
map/set allocation or GPU work executes merely by importing the API.

The generic installers preserve earlier features in installation order:

| Installer                       | Composition                                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `_installMeshFeatureExtra`      | OR the previous encoder's result with the new encoder's result.                                        |
| `_installPbrBindingContext`     | Invoke the previous augmenter, then the new augmenter, with the same context, scalar id and disposers. |
| `_installMeshDrawWrap`          | Apply the previous wrapper to the draw first, then wrap its result.                                    |
| `_installMeshMaterialValidator` | Run the previous validator, then the new validator, before mutation.                                   |

This preserves mirrored-mesh encoding, rect-area binding context and indexed-indirect
borrow validation in either install order. Features installing into a chained slot
must guard their own one-time installation: opacity does so, and
`installRectAreaEmissionPbr` does so before installing its lighting-id/disposer
augmenter. Binding ids and disposer arrays remain per invocation, not captured from
the first prepare.

### Bit-22 transport and Standard folding

`material/mesh-features.ts` reserves mesh bit 22 with a comment. The opacity
encoder owns its meaning; it does not add a shared opacity constant or read opacity
from core code. PBR's feature module declares the local
`MESH_OPACITY_MESH_BIT = 1 << 22`.

Standard uses its existing extension hook:

```typescript
_meshFeatures?(meshFeatures: number, material?: StandardMaterialProps): number;
```

The opacity Standard hook tests mesh bit 22 and the source material's cached
`NO_COLOR_OUTPUT | ESM_SHADOW_OUTPUT` bits. For a fading colour mesh it returns
the feature-local `STD_MESH_OPACITY_BIT = 1 << 30` plus
`MATERIAL_ALPHA_BLEND`; otherwise it returns 0. Bit 30 is reserved by a comment
in `standard-flags.ts`. Both Standard forward and geometry fold this result into
their effective material features.

Standard forward queue classification retains the live `mat.alpha < 1` term and
tests the final `HAS_OPACITY_TEXTURE | MATERIAL_ALPHA_BLEND` word. Queue and
pipeline selection therefore use the opacity-folded blend bit without dropping
the existing live material-alpha behavior.

### PBR folding at three consumers

PBR has no per-mesh extension fold hook or scratch object. The existing generic
transport is:

```typescript
(meshFeatures >>> 16) & PBR_HAS_ALPHA_BLEND;
```

Mesh bit 22 maps to material alpha-blend bit 6. The feature bit remains in the
mesh word for the opacity PBR fragment; the generic fold supplies routing, blend
state and compose-key identity.

The three consumers are:

1. **`pbr-renderable.ts` forward rebuild.** OR the transport into
   `renderFeatures.features` only when `features2` contains neither
   `PBR2_NO_COLOR_OUTPUT` nor `PBR2_ESM_SHADOW_OUTPUT`. This effective word drives
   composition, binding/pipeline keys and transparent classification.
2. **`pbr-geometry-renderable.ts` geometry pipeline selection.** Geometry's
   composition view strips the material blend branch, but its source blend
   decision ORs the transport into `source._renderFeatures?.features ?? 0`.
   This colour-output route therefore blends and disables depth writes for a
   fading mesh while the geometry shader still gates on effective alpha.
3. **`pbr-built-variant.ts` composed-variant lookup.** Before `_pbrComposeKey`,
   fold the same transport into the source features with the same
   no-colour/ESM mask as forward. The lookup must ask for the variant the forward
   rebuild actually composes.

Shadow/no-colour/ESM outputs do not gain the alpha-blend bit or opacity fragment.
Mesh bit 22 may still distinguish otherwise identical shadow variant keys; it
does not change caster alpha.

`_pbrMeshRequest(scene, mesh, noShadows)` retains its four-item return:

```typescript
readonly[(context, meshFeatures, lightMode, singleLightType)];
```

Forward generation metadata remains:

```typescript
[geometryContext, meshFeatures, lightMode, singleLightType, renderFeatures];
```

There is no additional folded-material field in either tuple and no change to
`Renderable` or geometry-view generation metadata.

### Binding context and retirement transport

`_PbrBindCtx._mesh` permits `Mesh | null`. The opacity extension requires an
actual mesh and its binding-owned disposer array.

`_installPbrBindingContext` also enables `_pbrBindingIdentity`, an identity
function for the optional numeric binding id, and `_createPbrBindingDisposers`,
a factory returning a fresh array. `createPbrMeshBindGroup` builds its ordinary
context, invokes the installed augmenters, then runs the fragment bind hooks.
Only feature-owned augmenters populate `_disposers` and `_lightingId`.

PBR geometry uses exactly:

```typescript
const bindingDisposers = _createPbrBindingDisposers?.();
```

There is no `?? []` fallback. Without an installer this remains undefined and
does not allocate an auxiliary lifetime collection. With opacity installed,
the factory exists before geometry binds. The same array reaches the PBR context
and geometry teardown. Standard passes its existing main/geometry binding-owned
array through `StdExt._bind`.

### Nullable module draw hook

`render/mesh-draw-hook.ts` owns the nullable module slot and its previous-first
installer, not an engine field:

```typescript
type MeshDrawWrap = (draw: DrawBinding["draw"], mesh: Mesh, colorOutput: boolean) => DrawBinding["draw"];

let _meshDrawWrap: MeshDrawWrap | null = null;
```

The slot is exported internally. General material builders import only this
generic module, never the opacity implementation. This module-slot seam is the
chosen alternative to an engine-installed seam. Callers pass a bound draw, mesh
and already-computed boolean, not a material or branch-gating context object.

Apply `_meshDrawWrap?.(draw, mesh, colorOutput) ?? draw` to the binding's final
draw function at these four sites:

| Site                            | `colorOutput`                                         |
| ------------------------------- | ----------------------------------------------------- |
| Standard forward `bind().draw`  | `!shadowOutput`                                       |
| PBR forward `bind().draw`       | `!shadowOutput`, derived from features2 no-colour/ESM |
| Standard geometry `bind().draw` | `true`                                                |
| PBR geometry `bind().draw`      | `true`                                                |

The opacity wrapper returns the original function for a non-colour route or
opacity 1. Otherwise it returns a per-binding closure that reads opacity on every
draw: return 0 at opacity 0; otherwise forward both original arguments and the
return value. `DrawBinding["draw"]` takes
`(pass: GPURenderPassEncoder | GPURenderBundleEncoder, engine: EngineContext)`
and returns a number.

This is CPU draw omission, not shader discard. The wrapper is not cached across
bindings. Fading meshes stay on the transparent/direct path; opaque twins keep
their independently recorded render bundles.

## Pipeline configuration

| Route                                  | Opacity 1                 | Opacity in (0, 1)                                      | Opacity 0            |
| -------------------------------------- | ------------------------- | ------------------------------------------------------ | -------------------- |
| Standard/PBR main and offscreen colour | Existing variant/bindings | Blend on, depth writes off, sorted transparent queue   | No draw              |
| PBR refraction                         | Existing variant          | Same per-mesh factor; texture-group policy unchanged   | No draw              |
| Standard/PBR geometry output           | Existing variant          | Blend on, depth writes off; alpha reaches `> 0.4` gate | No draw/outputs      |
| No-colour/CSM/PCF/ESM shadows          | Unchanged                 | Full-strength caster; no opacity fragment/binding      | Full-strength caster |
| Picking, culling, bounds and `visible` | Unchanged                 | Unchanged                                              | Unchanged            |
| Transmission opaque capture/GPS depth  | Existing classification   | Transparent, excluded from opaque/depth capture        | Transparent, no draw |

PBR main transparent order is 150; Standard main and both geometry routes use 200. Existing material-level alpha-to-coverage and `:a2c` pipeline identity
remain; A2C and blending both see final alpha. No material alpha, alpha-test cutoff,
alphaBlend flag or visible flag is mutated. Mirroring, VAT, thin instances and
transmission remain independent.

### Uniform layout

Each active opacity fragment contributes one structured declaration:

```typescript
{
    _name: "meshOpacity",
    _type: { _kind: "uniform-buffer" },
    _visibility: SS.FRAGMENT,
}
```

Its helper is `struct meshOpacityUniforms{value:f32}`. The composer assigns the
group-1 binding index from declarations; never parse emitted WGSL for an index.
The bind hook pushes `{ binding, resource: { buffer } }` and returns
`binding + 1`. It initializes the uniform from current mesh state, records the
buffer and appends its disposer. Missing mesh/scene or lifetime transport throws
a route-specific internal invariant error rather than silently allocating a
fallback collection.

Standard's leading `"0-mesh-opacity"` extension/fragment id aligns registry and
composer ordering before `"0-std-uv-transform"`. PBR uses
`id: "z-mesh-opacity", phase: "fragment"`; its bind order follows the composed
fragment key. Main, refraction and geometry each use the layout they composed.

## Shader logic

### Standard

Use slot `BC`:

```wgsl
alpha = alpha * meshOpacity.value;
color = vec4<f32>(color.rgb, color.a * meshOpacity.value);
```

The original `AT` alpha-test discard has already run; fog `BA` has not.
Colour returns `color.a`, while geometry gates on `alpha > 0.4`, so both alpha
representations must be multiplied. No-colour/ESM templates return without this
fragment. OPAQUE and surviving MASK fragments can therefore fade without
changing their original discard threshold.

### PBR

Return no fragment unless mesh bit 22 is set and features2 is neither no-colour
nor ESM. Select exactly one alpha slot:

| Composed features                               | Slot | Statement                                      |
| ----------------------------------------------- | ---- | ---------------------------------------------- |
| `PBR_HAS_ALPHA_BLEND` set                       | `FA` | `finalAlpha = finalAlpha * meshOpacity.value;` |
| Geometry composition with blend branch stripped | `BC` | `alpha = alpha * meshOpacity.value;`           |

Main colour computes
`saturate(alpha * materialAlpha + luminanceOverAlpha²) * opacity`, not a
multiply inside the saturate. The original alpha-test discard precedes the
multiplier.

The shadow-only fragment owns and internally exports
`PBR2_HAS_SHADOW_ONLY = 1 << 30`. The lazy opacity fragment imports it from
`fragments/shadow-only-fragment.ts`, not shared flags or the public root. When
that features2 bit is set, declare dependency `["shadow-only"]`; otherwise omit
the dependency. This places opacity after shadow-only's alpha writes without a
missing-dependency error.

Refraction opens its conditional in `NI` and closes it in `BC`. The `"z-"` id
places the geometry multiplier after that closing brace. Transmission/refraction
write colour, not alpha. Opacity is the final alpha multiplication before output
or the geometry gate.

## State machine and lifecycle

| Transition          | Dirtying                                         | Existing uniform writes                       | Buffer lifecycle                     |
| ------------------- | ------------------------------------------------ | --------------------------------------------- | ------------------------------------ |
| 1 → 0.6             | Once per crossing; enqueue in every owning scene | Latest factor to any still-live records       | New binding allocates                |
| 0.6 → 0.4 → 0 → 0.3 | None                                             | Four bytes per live binding per changed value | No setter allocation/destruction     |
| 0.3 → 1             | Once per crossing; enqueue in every owning scene | None                                          | Old buffers retire with old bindings |
| Equal clamped value | None                                             | None                                          | None                                 |
| Unregistered mesh   | No scene enqueue                                 | No records unless already bound               | First bind reads stored value        |

Dirtying uses `markMeshRenderableDirty` and existing per-scene swap-queue
deduplication; it never bumps the visibility epoch. Boundary enqueueing and
sub-1 direct writes are independent.

**Rapid double crossing:** for `0.3 → 1 → 0.6` before asynchronous replacement
settles, the retained transparent binding must receive 0.6, even though a rebuild
was enqueued. A replacement binding initializes from the latest stored value.
Transitions to 1 do not write old buffers. Zero/fraction changes require no
rebuild because the wrapper reads the live scalar.

For each direct write, require
`record._engine._device === record._device`. Skip stale-device records without
destroying them in the setter. The binding disposer removes its record before
destroying the buffer and is idempotent.

Refraction rebinds create separate records and buffers, retained until their
owning renderable retires. There is no new signature cache. Teardown of one
scene removes only that scene's records when a mesh belongs to several scenes.
The existing last-scene removal disposes mesh GPU resources and marks it
disposed; opacity adds no mesh-disposal or retirement observer.

Recovery retires old bindings and rebuilds on the replacement device using the
latest scalar. Setters during recovery skip mismatched records and are safe
before replacement bindings exist. Opacity owns no device-scoped cache.

### Material replacement and target exclusion

For a faded registered mesh, the chained validator rejects an unsupported
material synchronously before `mesh.material` stores the value or queues work.
Registration validates an unregistered mesh's pending raw assignment before
enrollment. Previous validators retain their ordering and atomicity.

MeshLoD instances lack `_gpu` and cannot be passed to either opacity API.
Their asset/instance enrollment paths do not accept an ordinary Mesh, so neither
operation order puts an opacity-bearing Mesh into a MeshLoD batch. No MeshLoD
hook, scan or metadata is added. Sharing a material with a fading ordinary Mesh
does not mutate that material.

## Babylon.js equivalence map

Compat `Mesh.visibility` statically imports the native API; there is no compat
enabler. The wrapper stores the raw finite value but renders the clamped native
value. Non-finite assignments throw. Family checks use the compat
`unsupported(...)` helper.

Validate all owned primitives before writing any; publish the wrapper's raw value
only after native writes succeed. A GPU wrapper owns itself. A transform-only
glTF-node wrapper owns its immediate GPU primitive children, not descendants
through child nodes. The synthetic root owns no geometry. `_fromLite` reads
native opacity for an actual GPU wrapper; transform-only wrappers start at 1.

Raw getters belong to the wrapper assigned, not to an inherited parent factor.
Owner fan-out changes primitive rendering factors without changing primitive
wrappers' independent raw getters. Effective native opacity is also checked for
material replacement. Pending NodeMaterial handles are rejected below 1 before
their native material exists. Clone copies the raw value without a redundant
setter. `isVisible` and `_syncVisibility` are unchanged.

| Behavior                                                         | Equivalence/deviation                                        |
| ---------------------------------------------------------------- | ------------------------------------------------------------ |
| Programmatic Standard/PBR with no explicit BJS transparency mode | Visibility/blend parity                                      |
| Native glTF OPAQUE/MASK fading                                   | Intentional Lite policy; compare against a normalized oracle |
| Finite out-of-range values                                       | Raw compat getter, clamped rendering                         |
| NaN/Infinity                                                     | RangeError deviation                                         |
| Node/shader materials below 1                                    | Explicit unsupported error                                   |
| Shadows                                                          | Full strength even at zero                                   |
| Picking, hierarchy and clones                                    | Picking unchanged, no inheritance, scalar copied             |
| InstancedMesh/submeshes                                          | No new support                                               |

## Dependencies

Use the existing Standard/PBR registries, structured shader composer, material
family tags, scene validator/dirty registry, binding-owned lifetime arrays and
clone/recovery paths. Runtime family code imports only generic seams, never this
feature. Internal hooks and WebGPU handles do not leak through root declarations.
The package still exposes one root export.

Core transport and draw call sites can survive across production chunk boundaries
even when feature bodies are absent. Absence of opacity implementation markers is
not proof of zero runtime-byte cost. Runtime-size checks count actually fetched JS
with the repository's existing exclusions and gzip accounting, not artifact
inventories.

## Test specification

- Native input/error atomicity, finite clamping, disposal, clone isolation,
  unchanged material/picking/visibility, MeshLoD rejection and null-material policy.
- All boundary/non-boundary transition counts, multi-scene records, idempotent
  disposal, recovery/device mismatch and rapid-double-crossing buffer freshness.
- Atomic unsupported material swaps and both installation orders with the real
  indexed-indirect borrow validator; previous-first feature/context chains.
- Standard/PBR composition, fragment slots, original discard before multiplication,
  PBR saturate before multiplication, shadow-only dependency, refraction closing
  brace, geometry `> 0.4` gate and composer/bind-index equality.
- All four forward/geometry routes skip colour draws at zero; no-colour/ESM
  casters remain full strength. Wrapper tests forward both arguments and numeric
  return values and read live opacity. Twin-bundle tests replay the same opaque
  bundle while only the faded direct draw changes.
- Preserve Standard's live material-alpha classification, A2C plus blending,
  mirroring/VAT bindings, PBR generation identity and composed-key consistency.
- Repeated rect-area emission installer calls register one context augmenter;
  that augmenter forwards each bind's current identity and lifetime array.
- Compat raw/clamped values, independent isVisible, atomic glTF fan-out,
  no inheritance, clone/_fromLite and unsupported material assignments.
- Build probes: unused entries contain no feature body markers; opted-in entries
  retain them. Root declaration trimming and root-only exports hold;
  MeshLoDInstance is a compile-time-invalid opacity target.
- Scene348 supplies static Standard/PBR 1/0.5/0 and opaque twins, normalized
  OPAQUE/MASK cases, full-strength shadows and A2C. Its BJS golden is immutable;
  pixel/MAD coverage belongs to the existing scene parity infrastructure.

## File manifest

`src/` below means `packages/babylon-lite/src/`. Listed generic files contain
transport or integration, not feature-owned opacity comparisons.

| Area                      | Files                                                                                                                                                                 |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native API/feature        | `src/mesh/opacity/mesh-opacity.ts`, `mesh-opacity-standard.ts`, `mesh-opacity-pbr.ts`; root exports in `src/index.ts`                                                 |
| Mesh transport            | `src/material/mesh-features.ts`                                                                                                                                       |
| Standard integration      | `src/material/standard/standard-flags.ts`, `standard-renderable.ts`, `standard-geometry-renderable.ts`                                                                |
| PBR integration           | `src/material/pbr/pbr-flags.ts`, `pbr-pipeline.ts`, `pbr-renderable.ts`, `pbr-geometry-renderable.ts`, `pbr-built-variant.ts`                                         |
| Shadow-only predicate     | `src/material/pbr/fragments/shadow-only-fragment.ts`                                                                                                                  |
| Draw/validation seams     | `src/render/mesh-draw-hook.ts`, `src/scene/mesh-scene-registry.ts`                                                                                                    |
| Rect-area installer guard | `src/material/pbr/fragments/rect-area-light-emission-fragment.ts`                                                                                                     |
| Compat                    | `packages/babylon-lite-compat/src/meshes/meshes.ts`, `README.md`, `COMPAT-STATUS.md`                                                                                  |
| Architecture index        | `docs/lite/architecture/00-overview.md`                                                                                                                               |
| Native unit tests         | `tests/lite/unit/mesh-opacity.test.ts`, `mesh-opacity-shader.test.ts`, `render-pass-task.test.ts`, `geometry-renderer-task.test.ts`, `pbr-forward-generation.test.ts` |
| Rect-area regression      | `tests/lite/unit/area-light-emission-opt-in.test.ts`                                                                                                                  |
| Build tests               | `tests/lite/build/mesh-opacity-treeshake.test.ts`, `public-api-types.test.ts`                                                                                         |
| Compat tests              | `packages/babylon-lite-compat/tests/mesh-visibility.test.ts`, `mesh-clone.test.ts`                                                                                    |
| Fixture                   | `lab/lite/scene348.html`, `bundle-scene348.html`, `babylon-ref-scene348.html`, `src/lite/scene348.ts`, `src/bjs/scene348.ts`, `src/shared/scene348-opacity.ts`        |
| Registration              | `scene-config.json`; HTML inputs, gallery and bundle tests auto-discover entries                                                                                      |
| Parity/assets             | `tests/lite/parity/scenes/scene348-mesh-opacity.spec.ts`, `reference/lite/scene348-mesh-opacity/babylon-ref-golden.png`, `lab/public/thumbnails/scene348.jpg`         |
