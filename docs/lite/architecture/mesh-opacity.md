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
7. Store the value and synchronously set `mesh._skipColorDraw = value === 0`,
   enqueue a rebuild on crossing 1, and update live binding uniforms with every
   changed value, including 1.

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
    readonly _disposers: (() => void)[];
}
```

`mesh-opacity.ts` owns validation, the scalar, installation, transitions and GPU
records. A lazily created `WeakMap<Mesh, Set<OpacityBinding>>` tracks live
binding-owned buffers. Neither the map nor its sets are allocated at import time.
A reusable one-element `Float32Array` supplies writes.

Each mesh's binding lifetime and device pair owns one 16-byte uniform buffer.
Only its first four bytes contain the opacity `f32`. Repeated binds with the same
disposer-array identity and device reuse the existing buffer and record without
another allocation, initial upload or disposer. Different lifetime arrays or
devices create separate records; no material owns this buffer. Native shallow
mesh clones copy the scalar and its corresponding skip flag but never the records.

### Lazy installation and chained installers

The first successful setter call runs this once-guarded sequence:

1. Register Standard extension `"0-mesh-opacity"`.
2. Register PBR extension `"z-mesh-opacity"`.
3. Install a mesh-feature encoder returning `1 << 22` iff opacity is below 1.
4. Install a PBR binding-context augmenter that copies the binding's disposer
   array into `context._disposers`.
5. Install material-transition validation using the mesh's live opacity.

Extension registration invalidates sorted-extension caches. No registration,
map/set allocation or GPU work executes merely by importing the API.

The generic installers preserve earlier features in installation order:

| Installer                       | Composition                                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `_installMeshFeatureExtra`      | OR the previous encoder's result with the new encoder's result.                                        |
| `_installPbrBindingContext`     | Invoke the previous augmenter, then the new augmenter, with the same context, scalar id and disposers. |
| `_installMeshMaterialValidator` | Run the previous validator, then the new validator, before mutation.                                   |

This preserves mirrored-mesh encoding, rect-area binding context and indexed-indirect
borrow validation in either install order. Features installing into a chained slot
must guard their own one-time installation: opacity does so, and
`installRectAreaEmissionPbr` does so before installing its lighting-id/disposer
augmenter. Binding ids and disposer arrays remain per invocation, not captured from
the first prepare.

### Mesh-bit transport and Standard folding

`material/mesh-features.ts` reserves mesh bits 22–23 with a comment. The opacity
encoder owns its meaning; it does not add a shared opacity constant or read opacity
from core code. The installed encoder returns 0 at opacity 1 and sets bit 22
below 1. It also sets bit 23 below 1 when the mesh's material has
`_buildGroup._materialFamily === "pbr"` and no alpha policy of its own:
`alphaBlend` is false/unset, `_alphaCutOff` is not greater than 0, and `alpha`
is not below 1. These are live plain-field reads inside the opt-in module;
there is no static runtime import of PBR material construction.

PBR's opacity fragment declares the feature-local
`MESH_OPACITY_MESH_BIT = 1 << 22` and
`MESH_OPACITY_OPAQUE_ALPHA_BIT = 1 << 23`. Bit 23 selects only its OPAQUE
alpha override, never queue routing. A material swap recomputes the policy bit
alongside the other mesh features.

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
state and compose-key identity. Bit 23 survives in the full mesh word and
composed key but is masked out of this alpha-blend transport.

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

### Transparent and geometry loop skip

The Mesh interface declares an optional `@internal _skipColorDraw?: boolean`.
It has no factory initializer and is absent from public declarations. Only
`setMeshOpacity` writes it, immediately after storing the clamped scalar. It is
true exactly at opacity 0 and false at every other assigned value. It lives with
the mesh and owns no resources, so no additional disposal hook is needed.

The general render loops read this generic flag alongside their existing
`visible === false` test. For this feature, a plain internal-field read is an
explicitly approved exception to GUIDANCE's engine-installed-seam requirement:
it costs about 16–25 B in scenes that never use opacity, less than the
alternative opt-in per-renderable draw-wrapper hook, which measured up to 148 B
in the same scenes. No renderer imports opacity or reads the opacity scalar.

| Loop                                      | Skip condition                                                               | Routing                                                                                                                                   |
| ----------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `render-task-base.ts` `drawList`          | `mesh && (mesh.visible === false \|\| (transparent && mesh._skipColorDraw))` | Fourth optional boolean is true only for the transparent list and transmission overlay. Opaque bundle recording and direct lists omit it. |
| `transmission.ts` transparent loop        | `mesh && (mesh.visible === false \|\| mesh._skipColorDraw)`                  | Checked at the existing position, after any transmissive texture update. The renderOnTop overlay uses `drawList(..., true)`.              |
| `geometry-renderer-task.ts` geometry loop | `mesh.visible === false \|\| mesh._skipColorDraw`                            | Geometry bindings are colour/output bindings, never shadow casters.                                                                       |

Fading Standard/PBR colour bindings are forced into transparent lists by the
existing feature folding. Shadow renderables are never transparent, so their
opaque/direct lists ignore the skip flag and preserve full-strength casting.
Opaque render-bundle recording and visibility epochs are unchanged.

The loops read the flag every frame. A `0.5 → 0 → 0.5` transition skips and resumes
without rebuilding or caching a stale skip. Opaque twins replay the same bundle.
Public `visible`, compat `isVisible`, picking and accessibility are independent
and never changed by opacity.

This is CPU draw omission, not shader discard. Standard/PBR builders return
their ordinary unwrapped draws; there is no mesh draw-hook module, wrapper or
installer. Direct invocation of a raw binding bypasses task-level filtering.
The diagnostic overdraw probe remains unchanged and may count opacity-0
transparent bindings.

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
`binding + 1`. It reuses a record with the same lifetime array and device when
present; otherwise it initializes the uniform from current mesh state, records
the buffer and appends its disposer. Missing mesh/scene or lifetime transport throws
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
nor ESM. Select exactly one alpha slot, with the bit-23 branch taking precedence:

| Alpha policy / composed features                           | Slot | Statement                                      |
| ---------------------------------------------------------- | ---- | ---------------------------------------------- |
| Bit 23: PBR OPAQUE without an own alpha policy             | `BC` | `alpha = meshOpacity.value;`                   |
| Otherwise, `PBR_HAS_ALPHA_BLEND` set                       | `FA` | `finalAlpha = finalAlpha * meshOpacity.value;` |
| Otherwise, geometry composition with blend branch stripped | `BC` | `alpha = alpha * meshOpacity.value;`           |

**OPAQUE alpha policy:** without material blending, positive cutoff, or material
alpha below 1, source alpha is treated as 1 even if the base-colour texture,
base-colour factor or vertex colours carry alpha. `BC` replaces the decoded
`alpha` with `meshOpacity.value`; the normal PBR output-alpha block then runs,
without a second `FA` multiply. Texture/factor/vertex-colour decoding precedes
`BC`, which precedes that output block. Gamma-albedo and unlit paths still
declare `alpha`, so they use the same override. Forward, geometry and composed
variant lookup retain the same policy bit and extension.

**Own alpha policies:** BLEND and material alpha below 1 retain the existing
forward `FA` multiply after the normal output-alpha calculation:
`saturate(alpha * materialAlpha + luminanceOverAlpha²) * opacity`. Geometry
strips the blend branch and retains `BC` multiplication. MASK also keeps its
existing forward `FA` / geometry `BC` behavior. Both occur **after** the original
`AT` cutoff, so that cutoff tests the material's own alpha, not mesh opacity.
Mesh opacity does not change which MASK fragments survive.

The shadow-only fragment owns and internally exports
`PBR2_HAS_SHADOW_ONLY = 1 << 30`. The lazy opacity fragment imports it from
`fragments/shadow-only-fragment.ts`, not shared flags or the public root. When
that features2 bit is set, declare dependency `["shadow-only"]`; otherwise omit
the dependency. This places opacity after shadow-only's alpha writes without a
missing-dependency error.

Refraction opens its conditional in `NI` and closes it in `BC`. The `"z-"` id
places the geometry alpha override or multiplier after that closing brace.
Transmission/refraction write colour, not alpha. The selected opacity slot
runs before output or the geometry gate.

## State machine and lifecycle

| Transition          | Dirtying                                         | Existing uniform writes                       | Buffer lifecycle                     |
| ------------------- | ------------------------------------------------ | --------------------------------------------- | ------------------------------------ |
| 1 → 0.6             | Once per crossing; enqueue in every owning scene | Latest factor to any still-live records       | New lifetime allocates               |
| 0.6 → 0.4 → 0 → 0.3 | None                                             | Four bytes per live binding per changed value | No setter allocation/destruction     |
| 0.3 → 1             | Once per crossing; enqueue in every owning scene | Write 1 to any still-live records             | Old buffers retire with old bindings |
| Equal clamped value | None                                             | None                                          | None                                 |
| Unregistered mesh   | No scene enqueue                                 | No records unless already bound               | First bind reads stored value        |

Dirtying uses `markMeshRenderableDirty` and existing per-scene swap-queue
deduplication; it never bumps the visibility epoch. Boundary enqueueing and
direct writes are independent.

### Explicit render tasks

An `autoMirror: false` render task normally retains the renderables resolved by
`addMeshToTask`. A crossing of 1 changes the opaque/transparent pipeline variant
only when the task opts into `enableRenderTaskMeshRefresh` before recording,
and the entry is a scene-owned mesh added **without** a per-task material
override. As with material swaps, the owning scene first drains its rebuild
queue; the enabled task follows the resulting renderable version on execute.
It rebuilds its own auxiliary renderable and retires the old lifetime disposers
after submitted GPU work drains. See
[Frame Graph — explicit-task mesh refresh](28-frame-graph.md).

```typescript
const task = createRenderTask({ name: "fading", rt, autoMirror: false }, engine, scene);
enableRenderTaskMeshRefresh(task);
addMeshToTask(task, mesh);
```

Once a transparent binding is current, updates below 1 and the 0 skip are live;
they require no task rebuild. A plain explicit task retains its old renderable
across crossings, so callers must deliberately synchronize/re-record it if they
do not enable refresh. Opaque lists do not check the opacity-0 flag: those lists
also serve shadow tasks, where opacity must not remove casters, and opaque
render bundles cache draws. Skipping there would break the shadow gate and
cached-bundle replay contract. The flag is read only on transparent/transmission
colour lists and geometry paths.

### Unregistered meshes and retained bindings

A mesh registered in no scene but drawn through an explicit geometry-task
`meshes` list picks up opacity threshold crossings (`1 ↔ <1`, selecting a
pipeline/blend variant) only at that task's next renderable sync. This is the same
contract as material/topology changes on such meshes; the setter does not
invalidate off-scene geometry tasks. Value updates below 1 and the opacity-0 skip
apply immediately. Returning to 1 also writes 1 to retained binding buffers, so
they do not retain the old opacity while waiting for that sync.

**Rapid double crossing:** for `0.3 → 1 → 0.6` before asynchronous replacement
settles, the retained transparent binding must receive 0.6, even though a rebuild
was enqueued. A replacement binding initializes from the latest stored value.
The intermediate transition to 1 writes 1 to still-live buffers. Zero/fraction
changes require no rebuild because the loops read the synchronously updated skip flag.

For each direct write, require
`record._engine._device === record._device`. Skip stale-device records without
destroying them in the setter. The binding disposer removes its record before
destroying the buffer and is idempotent.

Refraction rebinds reuse the opacity record and buffer associated with the same
renderable lifetime array and device, even when other bind-group entries change.
Each new lifetime or device gets a separate buffer. There is no new signature
cache. Teardown of one scene removes only that scene's records when a mesh belongs
to several scenes.
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
- Off-scene retained geometry bindings receive 1 on reset. Repeated binds on the
  same device and lifetime allocate one buffer/disposer/record and write once per
  update; different lifetime arrays or devices remain independent.
- Atomic unsupported material swaps and both installation orders with the real
  indexed-indirect borrow validator; previous-first feature/context chains.
- PBR bit-23 OPAQUE override with alpha-bearing texture/factor/vertex colours,
  gamma/unlit scope, live OPAQUE/BLEND swaps and coherent forward/geometry keys.
  BLEND/material-alpha multiplication and MASK forward `FA` / geometry `BC`
  remain after the original cutoff. Standard output alpha ignores diffuse-texture
  alpha. Verify shadow-only dependencies, refraction closing braces, geometry
  `> 0.4` gates and composer/bind-index equality.
- Transparent and geometry task loops skip colour draws at zero and resume live
  when the flag clears. Opaque/direct lists ignore it, preserving no-colour/ESM
  casters. Transmission and renderOnTop checks preserve texture-update ordering.
  Raw bindings remain unwrapped. Twin-bundle tests replay the same opaque bundle
  and preserve the visibility epoch while only the faded transparent draw changes.
- Scene-owned non-override explicit entries follow opacity crossings only with
  mesh refresh. Drain the real scene rebuild queue and execute the real task:
  1 → 0.5 selects transparent, 0.5 → 0 skips live, and 0.5 → 1 restores opaque
  and retires auxiliary lifetimes. Plain explicit tasks retain their renderables.
- Flag tests cover zero-to-fraction/one, invalid-call atomicity, clone isolation,
  unchanged public visibility/pickability and accessibility projection.
- Preserve Standard's live material-alpha classification, A2C plus blending,
  mirroring/VAT bindings, PBR generation identity and composed-key consistency.
- Repeated rect-area emission installer calls register one context augmenter;
  that augmenter forwards each bind's current identity and lifetime array.
- Compat raw/clamped values, independent isVisible, atomic glTF fan-out,
  no inheritance, clone/_fromLite and unsupported material assignments.
- Build probes: unused entries contain no feature body markers; opted-in entries
  retain them. Root declaration trimming and root-only exports hold;
  MeshLoDInstance is a compile-time-invalid opacity target.
- Scene354 supplies static Standard/PBR 1/0.5/0 and opaque twins, normalized
  OPAQUE/MASK cases, full-strength shadows and A2C. Its BJS golden is immutable;
  pixel/MAD coverage belongs to the existing scene parity infrastructure.

## File manifest

`src/` below means `packages/babylon-lite/src/`. Listed generic files contain
transport or integration, not feature-owned opacity comparisons.

| Area                        | Files                                                                                                                                                                 |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native API/feature          | `src/mesh/opacity/mesh-opacity.ts`, `mesh-opacity-standard.ts`, `mesh-opacity-pbr.ts`; root exports in `src/index.ts`                                                 |
| Mesh transport              | `src/material/mesh-features.ts`                                                                                                                                       |
| Standard integration        | `src/material/standard/standard-flags.ts`, `standard-renderable.ts`, `standard-geometry-renderable.ts`                                                                |
| PBR integration             | `src/material/pbr/pbr-flags.ts`, `pbr-pipeline.ts`, `pbr-renderable.ts`, `pbr-geometry-renderable.ts`, `pbr-built-variant.ts`                                         |
| Shadow-only predicate       | `src/material/pbr/fragments/shadow-only-fragment.ts`                                                                                                                  |
| Draw filtering / validation | `src/mesh/mesh.ts`, `src/frame-graph/render-task-base.ts`, `transmission.ts`, `geometry-renderer-task.ts`, `src/scene/mesh-scene-registry.ts`                         |
| Rect-area installer guard   | `src/material/pbr/fragments/rect-area-light-emission-fragment.ts`                                                                                                     |
| Compat                      | `packages/babylon-lite-compat/src/meshes/meshes.ts`, `README.md`, `COMPAT-STATUS.md`                                                                                  |
| Architecture index          | `docs/lite/architecture/00-overview.md`                                                                                                                               |
| Native unit tests           | `tests/lite/unit/mesh-opacity.test.ts`, `mesh-opacity-shader.test.ts`, `render-pass-task.test.ts`, `geometry-renderer-task.test.ts`, `pbr-forward-generation.test.ts` |
| Rect-area regression        | `tests/lite/unit/area-light-emission-opt-in.test.ts`                                                                                                                  |
| Build tests                 | `tests/lite/build/mesh-opacity-treeshake.test.ts`, `public-api-types.test.ts`                                                                                         |
| Compat tests                | `packages/babylon-lite-compat/tests/mesh-visibility.test.ts`, `mesh-clone.test.ts`                                                                                    |
| Fixture                     | `lab/lite/scene354.html`, `bundle-scene354.html`, `babylon-ref-scene354.html`, `src/lite/scene354.ts`, `src/bjs/scene354.ts`, `src/shared/scene354-opacity.ts`        |
| Registration                | `scene-config.json`; HTML inputs, gallery and bundle tests auto-discover entries                                                                                      |
| Parity/assets               | `tests/lite/parity/scenes/scene354-mesh-opacity.spec.ts`, `reference/lite/scene354-mesh-opacity/babylon-ref-golden.png`, `lab/public/thumbnails/scene354.jpg`         |
