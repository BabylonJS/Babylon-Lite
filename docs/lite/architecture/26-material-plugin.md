# Module: material-plugin

> Package path: `packages/babylon-lite/src/material/plugin/`

## Purpose

Public, **opt-in** material-plugin support — the Babylon-Lite equivalent of BJS
`MaterialPluginBase`. A plugin layers custom WGSL + uniforms + samplers onto an
existing **PBR** or **Standard** material while keeping the full built-in
lighting / IBL / shadow pipeline. Plugins are plain-data objects (GUIDANCE §4b′),
attached per-instance via `material.plugins = [plugin]`.

Plugin support is an **explicit opt-in**: the application imports and calls
`enableMaterialPlugins(scene)` (after creating materials/meshes, before
`registerScene`). That call is the only thing that pulls the plugin bridges and
their WGSL into a scene's module graph. Shared Standard extension calls carry
material and scene context; an optional variant-key hook supplies cache identity.
Plugin flags, identity encoding, and scene-local UBO state belong to the bridge.

PBR plugins that declare custom varyings or vertex-visible uniforms, textures, or
samplers use the separate `enablePbrMaterialPluginVertexData()` entry point instead.
Keeping that bridge separate preserves byte-identical bundles for existing fragment
plugins and for every scene that does not opt in.

## Public API Surface

```ts
// material/plugin/material-plugin.ts (all type-only — erased at build)
export type MaterialPluginPoint =
    | "CUSTOM_FRAGMENT_DEFINITIONS"
    | "CUSTOM_FRAGMENT_MAIN_BEGIN"
    | "CUSTOM_FRAGMENT_UPDATE_ALPHA"
    | "CUSTOM_FRAGMENT_UPDATE_DIFFUSE"
    | "CUSTOM_FRAGMENT_BEFORE_LIGHTS"
    | "CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION"
    | "CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR"
    | "CUSTOM_VERTEX_MAIN_BEGIN"
    | "CUSTOM_VERTEX_UPDATE_WORLDPOS"
    | "CUSTOM_VERTEX_MAIN_END";

export interface PluginUboField {
    readonly name: string;
    readonly type: string;
    readonly visibility?: "vertex" | "fragment" | "vertex-fragment";
} // WGSL type verbatim
export interface PluginVaryingDecl {
    readonly name: string;
    readonly type: "f32" | "vec2f" | "vec3f" | "vec4f" | "vec2<f32>" | "vec3<f32>" | "vec4<f32>";
}
export interface PluginSamplerDecl {
    readonly texture: string;
    readonly sampler: string;
    readonly textureType?: "texture_2d<f32>";
    readonly depthTexture?: boolean; // PBR vertex-resource bridge only
    readonly samplerType?: "sampler" | "sampler_non_filtering";
    readonly visibility?: "vertex" | "fragment" | "vertex-fragment";
}
export interface PluginTextureBinding {
    readonly texture: Texture2D;
} // no GPU handles (§4d)

export interface MaterialPlugin {
    readonly name: string;
    priority?: number; // lower runs first; default 500
    isEnabled?: boolean; // default true when attached
    dynamic?: boolean; // refresh Standard-material UBO values every frame
    defines?: Record<string, boolean | number>;
    getCustomCode?(shaderType: "vertex" | "fragment"): Partial<Record<MaterialPluginPoint, string>> | null;
    getUniforms?(): { ubo?: PluginUboField[] };
    getVaryings?(): PluginVaryingDecl[];
    getSamplers?(): PluginSamplerDecl[];
    writeUbo?(data: Float32Array, offsets: ReadonlyMap<string, number>): void;
    bindTextures?(out: PluginTextureBinding[]): void;
    getActiveTextures?(out: Texture2D[]): void;
}

// material/material.ts
interface Material {
    /* … */ plugins?: MaterialPlugin[];
}
```

Public exports (`index.ts`): `MaterialPlugin`, `MaterialPluginPoint`,
`PluginUboField`, `PluginVaryingDecl`, `PluginSamplerDecl`, `PluginTextureBinding` (all `export type`),
plus the runtime functions `enableMaterialPlugins(scene)` and
`bakeStdPluginMaterial(material, scene)`, and the PBR-only vertex-resource enabler
`enablePbrMaterialPluginVertexData()`.

## PBR vertex-resource opt-in

```ts
material.plugins = [vertexPlugin];
enablePbrMaterialPluginVertexData();
await registerScene(scene);
```

Use this entry point instead of `enableMaterialPlugins(scene)` when a PBR plugin
uses `getVaryings()`, vertex-visible UBO fields, or vertex-visible samplers. Its
dedicated bridge patches only that composed PBR shader's material-UBO visibility
and vertex declaration. It does not modify the universal shader composer and must
not be enabled alongside the ordinary PBR plugin bridge for the same materials.

## Opt-in entry point — `enableMaterialPlugins(scene)`

```ts
const mat = createStandardMaterial();
mat.plugins = [myPlugin]; // attach (any number of materials)
box.material = mat;
addToScene(scene, box);

enableMaterialPlugins(scene); // ← the ONLY thing that loads plugin code
await registerScene(scene);
```

`enableMaterialPlugins` (`material/plugin/enable-material-plugins.ts`) statically
imports both bridges (legitimate — it is itself only reachable when the app calls
it) and:

1. Registers the **PBR** plugin ext (`registerPbrPlugins`) and **Standard** plugin
   ext (`registerStdPlugins`) into the global `_getPbrExts()` / `_getStdExts()`
   registries. Generic renderable hook loops then invoke their fragment and binding
   callbacks without importing the plugin implementation.
2. For **Standard** plugin materials only (filtered by `_buildGroup ===
standardGroupBuilder`, so PBR materials are never touched), walks `scene.meshes`
   and pre-bakes the per-signature index into `mat._pi`. Standard's plugin extension
   contributes only a per-renderable presence flag (bit 25); the identity never occupies vertex-alpha
   or skeleton feature bits. PBR needs no walk — its `detect` hook assigns `_pi`
   during feature computation.
   Standard materials created after this walk can be registered explicitly with
   `bakeStdPluginMaterial(material, scene)`. Materials without plugins are left
   untouched, so their normal lazy feature detection remains live until build.

The plugin implementation remains outside the always-loaded PBR/Standard graph;
only the generic Standard binding hook carries scene ownership context.

## Injection-point → Lite slot mapping

| BJS `MaterialPluginPoint`                    | Lite slot               | Notes                                |
| -------------------------------------------- | ----------------------- | ------------------------------------ |
| CUSTOM_FRAGMENT_DEFINITIONS                  | `_helperFunctions` (HF) | helper fns / structs                 |
| CUSTOM_FRAGMENT_MAIN_BEGIN                   | SV                      | fragment scope-vars, after prelude   |
| CUSTOM_FRAGMENT_UPDATE_ALPHA                 | AT                      | alpha-test region                    |
| CUSTOM_FRAGMENT_UPDATE_DIFFUSE               | AC                      | Standard diffuse update              |
| CUSTOM_FRAGMENT_BEFORE_LIGHTS                | MF                      | after f0, before lights              |
| CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION | NI                      | after the IBL/non-IBL color tail     |
| CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR             | BC                      | after tonemap+gamma (demo uses this) |
| CUSTOM_VERTEX_MAIN_BEGIN                     | VR                      |                                      |
| CUSTOM_VERTEX_UPDATE_WORLDPOS                | VW                      |                                      |
| CUSTOM_VERTEX_MAIN_END                       | VB                      |                                      |

Only **existing** template slots are reused — no new `/*XX*/` markers are added
(that would grow every PBR/Standard scene's template). At the `BC` slot the color
variable is named `color` in both PBR (`vec3<f32>`) and Standard (`vec4<f32>`),
so per-component writes (`color.r = …`) work for both families.

The `RegisterMaterialPlugin` global auto-attach from BJS is intentionally **not**
implemented — it would require module-level side effects (forbidden, GUIDANCE §4).
Use per-instance `material.plugins = [...]`.

## Internal Architecture (bridge data flow)

```
material.plugins ──► enableMaterialPlugins(scene) ──► {pbr,std}-plugin-bridge ──► PbrExt / StdExt
                                                        │
                                  plugin-bridge-shared.ts
                                  ├─ pluginSignature(plugins)  → stable cache key string
                                  ├─ buildPluginFragment(plugins, idx, forStandard) → { _fragment, _stdUboSpec }
                                  │     getCustomCode → _fragmentSlots / _vertexSlots / _helperFunctions
                                  │     getUniforms.ubo → _uboFields (PBR) | self-managed fragment `pluginUbo` binding (Standard)
                                  │     getSamplers → fragment texture+sampler bindings
                                  ├─ writePluginUbo  → plugin.writeUbo(data, offsets)
                                  └─ bindPluginTextures → plugin.bindTextures → GPU entries

material.plugins ──► enablePbrMaterialPluginVertexData()
                  └─► pbr-plugin-vertex-bridge.ts
                      └─► pbr-plugin-vertex-data.ts
                          ├─ custom varyings and vertex-visible resources
                          └─ `_pc` patch for the opted-in PBR material UBO only
```

Each material caches its enabled plugins in stable priority order when its plugin signature is
baked. Per-frame UBO writes iterate that prepared list directly; filtering and sorting remain build
work rather than animated-material hot-path work.

A single bridge extension handles all plugins on a material. Each distinct plugin
**signature** (name + priority + isEnabled + defines + custom code + uniforms +
samplers of every attached plugin) is assigned a small **index**. PBR stores that
index separately on `Material._pi`, as does Standard, so neither identity can collide
with native material or mesh feature bits. Both families include the
index in their compose/pipeline cache keys, so any plugin change — including
enabling/disabling — produces a distinct shader variant. The signature registries
are append-only: enabling another scene, rebuilding, or replacing a device never
reassigns an identity still referenced by a live material. Registry entries retain
compiled fragment data, not material instances or per-instance UBO callbacks.

### PBR (`pbr-plugin-bridge.ts`)

A `PbrExt { id: "plugin", phase: "fragment" }` registered via `_registerPbrExt`:

- `detect(mat)` lazily assigns `mat._pi` and contributes no native feature bits.
- `frag(ctx)` resolves the fragment for `ctx._pi`.
- `writeUbo(data, mat, offsets)` → plugin UBO slices into the **material UBO**
  (PBR template has `_baseMaterialUboFields`, so fragment `_uboFields` target it;
  WGSL access is `material.<field>`).
- `bind` / `textures` → samplers + acquire/release.
  All five hooks are already iterated over the global `_getPbrExts()` registry by
  the core (detect in `_computePbrMaterialFeatures`, frag in `pbr-compose`, writeUbo
  in `writeMaterialData`, bind in `createPbrMeshBindGroup`, textures in
  `collectPbrBoundTextures`), so **no core PBR file is modified at all** —
  `enableMaterialPlugins` simply registers the ext before the build runs.

### Standard (`std-plugin-bridge.ts`)

A `StdExt { _id: "plugin", _phase: "mesh", _feature: 1 << 25 }` registered via
`_registerStdExt`. Standard has a fixed-layout material UBO, so the bridge:

- pre-bakes the signature index into each plugin material's `_pi`, done in
  `registerStdPlugins` for Standard materials only. `_meshFeatures` derives the
  presence bit from the current identity, rather than caching it on material views.
  `_frag` receives the material separately from the feature mask.
  Both normal/shadow shader keys and geometry-view variant keys include `_pi`,
- delivers plugin uniforms through a **self-managed uniform buffer**, _not_ the
  mesh UBO. `buildPluginFragment(plugins, idx, /*forStandard*/ true)` emits a
  dedicated `var<uniform> pluginUbo : pluginUboUniforms;` fragment binding (struct
  declared in `_helperFunctions`) instead of appending `_uboFields` to the mesh
  UBO. The bridge builds one `GPUBuffer` per material, so materials with the same
  shader signature can retain different uniform values, and pushes its bind entry
  from `StdExt._bind` — **before** the texture entries, matching the binding
  declaration order — followed by `bindPluginTextures`.

Standard plugins marked `dynamic: true` have their per-material UBO values
rewritten before every frame. Dynamic tracking and UBO ownership are scoped to
the enabling scene, so enabling a second scene does not replace the first
scene's refresh state. The Standard bind builders pass the owning scene into the
plugin extension, so one material shared by multiple scenes resolves each
scene's distinct UBO; disposing either scene cannot invalidate the other's
binding. Static plugins retain the registration-time upload. Re-baking a
material queues every affected mesh for a material-swap rebuild. The old UBO's
release is attached to those renderables' existing disposer packets. Async
per-mesh and full-group rebuilds expose the packets they temporarily remove from
`scene._meshDisposables`, so a re-bake during either window can attach to the
same pending teardown. The old buffer therefore remains valid while the swap
queue or an async group build is blocked. Only after every affected replacement
bind group has been committed is the old buffer retired behind a subsequent GPU
fence. Disposing the scene
destroys all of its remaining plugin UBOs and releases the material references
held by the bridge.

Scene membership and material-setter events maintain per-material mesh users in the
opt-in bridge. Removing or replacing the final user stops dynamic uploads immediately;
no frame-time mesh scan is used. Binding owners additionally retain their exact UBO
generation through disposer callbacks, including explicit overrides and geometry views.
An override remains live when the mesh's main material changes. Once both scene users
and auxiliary binding owners disappear, the material leaves the active map; GPU release
waits for outstanding binding disposers and the submission retirement fence.

Baking an unattached material prepares its signature without allocating an unowned UBO.
The first scene user or owned binding allocates the buffer. Re-adding a previously retired
material creates a fresh allocation, while multiple meshes in one scene share it.

Re-baking is failure-atomic. The proposed enabled-plugin list, signature, native feature
bits, uniform contents, and replacement GPU state are prepared locally first. A throwing
plugin callback or allocation/upload failure leaves the previous material identity,
prepared list, feature cache, scene state, and binding owners untouched. Failed temporary
uploads destroy their new buffer. Only successful preparation publishes the new generation
and schedules retirement of the previous one; caller-authored `material.plugins` is not reverted.

The decisive benefit: this route adds no `_writeUbo` hook or plugin UBO loop to
the Standard renderable. The pre-existing `StdExt._bind` / `_textures` loops in
`standard-pipeline.ts` / `collect-std-bound-textures.ts` and the `_frag` loop in
`standard-renderable.ts` carry the plugin; the bind hook receives the owning
scene so scene-local UBO state can be selected. WGSL access to a Standard plugin
uniform is `pluginUbo.<field>` (PBR access is `material.<field>`).

## Pipeline Configuration / Cache Keying

- PBR compose, binding, and geometry-output cache keys include `Material._pi`,
  which differentiates plugin variants without consuming native feature bits.
- PBR pipeline + bindings also include `_fragmentKey` (sorted fragment ids); the
  plugin fragment id is `plugin-<index>`, matched back to the ext in
  `createPbrMeshBindGroup` via `fid.startsWith("plugin-")`.
- Standard main/shadow and geometry keys include `_pi` through the opt-in
  `_stdMaterialVariantKey` resolver. The plugin bridge owns the signature encoding;
  when it is absent, the null resolver and its keying branch tree-shake away.

## Shader Logic (demo: BlackAndWhite grayscale)

Injected at `CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR` → `BC` (after tonemap + gamma):

```wgsl
let bwLuma = dot(color.rgb, vec3<f32>(0.3, 0.59, 0.11));
color.r = bwLuma; color.g = bwLuma; color.b = bwLuma;
```

The BJS reference plugin injects the equivalent at the same point on `finalColor`
(PBR) / `color` (Standard). Since the pre-grayscale color is already parity-matched
and grayscale is a linear reduction, the result stays pixel-identical.

## State Machine / Lifecycle

1. User sets `material.plugins = [plugin]`, calls `enableMaterialPlugins(scene)`,
   then `registerScene`.
2. `enableMaterialPlugins` registers the PBR + Standard plugin exts into the global
   registries (Standard additionally pre-bakes separate shader identities for its materials and
   builds any self-managed plugin UBOs).
3. Per mesh: detect (PBR) / pre-baked `_pi` (Standard) supplies the signature index
   → compose builds WGSL with the plugin fragment → pipeline/bind groups created →
   UBO + textures bound.
4. **Toggle/re-bake:** set `plugin.isEnabled`, then call
   `bakeStdPluginMaterial(material, scene)`. The new signature index yields a
   fresh pipeline; affected bindings are rebuilt through the scene's material
   swap queue, and the replaced plugin UBO is retired safely. Removing the last
   plugin clears the cached Standard features only when that scene actually had
   an existing plugin state; plugin-free materials are never eagerly cached by
   `enableMaterialPlugins`.
5. **Dispose:** `disposeScene(scene)` destroys every remaining Standard plugin
   UBO owned by that scene and drops its per-material refresh state.

## Babylon.js Equivalence Map

| BJS                                   | Lite                                            |
| ------------------------------------- | ----------------------------------------------- |
| `MaterialPluginBase` (class)          | `MaterialPlugin` (plain object)                 |
| `getCustomCode(type, lang)`           | `getCustomCode(type)` (WGSL only)               |
| `prepareDefinesBeforeAttributes` etc. | `defines` (folded into cache key)               |
| `getUniforms()` / `bindForSubMesh`    | `getUniforms()` / `writeUbo()` / `bindTextures` |
| `RegisterMaterialPlugin` (global)     | (omitted — per-instance attach only)            |

## Dependencies

- `shader/fragment-types.ts` (ShaderFragment, slots, UboField, BindingDecl)
- `material/pbr/pbr-flags.ts` (PbrExt), `material/standard/standard-flags.ts` (StdExt)
- `texture/texture-2d.ts` (Texture2D)

## Test Specification

- Scene 217 (`scene217-material-plugin`): a PBR sphere **and** a Standard box, each
  with the BlackAndWhite plugin enabled, validated against a BJS golden using an
  equivalent `MaterialPluginBase` BlackAndWhite plugin. MAD ≤ `scene-config.maxMad`.
- Unit coverage verifies independent dynamic refresh state across two scenes,
  scene-disposal cleanup, shared-material scene isolation, lazy plugin-free
  feature detection, and replacement-UBO rebinding/retirement when a Standard
  material is baked again while the material-swap queue is blocked, including
  per-mesh and full-group async-build windows where `_meshDisposables`
  temporarily has no packet.
- Identity regression coverage includes more than 127 Standard signatures,
  vertex alpha, four/eight-bone skinning, shadow/geometry views, plugin removal,
  and simultaneous PBR scenes on shared or separate devices followed by rebuild/recovery.
- Bundle-size: `bundle-size.spec.ts` guards the generic scene-context propagation
  and verifies the plugin implementation remains absent from plugin-free scene
  graphs.

## File Manifest

- `material/plugin/material-plugin.ts` — public types.
- `material/plugin/plugin-bridge-shared.ts` — signature + fragment builder
  (`forStandard` chooses mesh-UBO `_uboFields` vs self-managed `pluginUbo` binding)
    - UBO/texture helpers.
- `material/plugin/pbr-plugin-bridge.ts` — PBR `PbrExt`.
- `material/plugin/std-plugin-bridge.ts` — Standard `StdExt` + self-managed UBO.
- `material/plugin/enable-material-plugins.ts` — the opt-in entry point.
- Shared Standard hooks: `standard-flags.ts`, `standard-pipeline.ts`,
  `standard-renderable.ts`, and `standard-geometry-renderable.ts` propagate material
  context to fragment selection and `SceneContext` to binding. The optional
  variant-key resolver contributes cache identity; no plugin-specific binding loop
  or signature registry lives in the core.
