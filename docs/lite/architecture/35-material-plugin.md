# Module: material-plugin

> Package path: `packages/babylon-lite/src/material/plugin/`

## Purpose

Public, **opt-in** material-plugin support — the Babylon-Lite equivalent of BJS
`MaterialPluginBase`. A plugin layers custom WGSL + uniforms + samplers onto an
existing **PBR** or **Standard** material while keeping the full built-in
lighting / IBL / shadow pipeline. Plugins are plain-data objects (GUIDANCE §4b′),
attached per-instance via `material.plugins = [plugin]`.

**Hard guarantee: plugin-free scenes are BYTE-IDENTICAL to a build without the
plugin system.** No shared/core file (renderables, group builders, flags,
pipelines) carries any plugin-specific code. Plugin support is an **explicit
opt-in**: the application imports and calls `enableMaterialPlugins(scene)` (after
creating materials/meshes, before `registerScene`). That single call is the *only*
thing that pulls the plugin bridges into a scene's module graph. A scene that
never calls it produces the exact same bytes as master — verified by content-hash
equality of every runtime chunk. The plugin's WGSL ships in the user's scene
module, not the engine.

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

export interface PluginUboField { readonly name: string; readonly type: string; } // WGSL type verbatim
export interface PluginSamplerDecl {
  readonly texture: string; readonly sampler: string;
  readonly textureType?: "texture_2d<f32>";
  readonly samplerType?: "sampler" | "sampler_non_filtering";
}
export interface PluginTextureBinding { readonly texture: Texture2D; } // no GPU handles (§4d)

export interface MaterialPlugin {
  readonly name: string;
  priority?: number;            // lower runs first; default 500
  isEnabled?: boolean;          // default true when attached
  defines?: Record<string, boolean | number>;
  getCustomCode?(shaderType: "vertex" | "fragment"): Partial<Record<MaterialPluginPoint, string>> | null;
  getUniforms?(): { ubo?: PluginUboField[] };
  getSamplers?(): PluginSamplerDecl[];
  writeUbo?(data: Float32Array, offsets: ReadonlyMap<string, number>): void;
  bindTextures?(out: PluginTextureBinding[]): void;
  getActiveTextures?(out: Texture2D[]): void;
}

// material/material.ts
interface Material { /* … */ plugins?: MaterialPlugin[]; }
```

Public exports (`index.ts`): `MaterialPlugin`, `MaterialPluginPoint`,
`PluginUboField`, `PluginSamplerDecl`, `PluginTextureBinding` (all `export type`),
plus the runtime function `enableMaterialPlugins(scene)` — the explicit opt-in
entry point.

## Opt-in entry point — `enableMaterialPlugins(scene)`

```ts
const mat = createStandardMaterial();
mat.plugins = [myPlugin];          // attach (any number of materials)
box.material = mat;
addToScene(scene, box);

enableMaterialPlugins(scene);      // ← the ONLY thing that loads plugin code
await registerScene(scene);
```

`enableMaterialPlugins` (`material/plugin/enable-material-plugins.ts`) statically
imports both bridges (legitimate — it is itself only reachable when the app calls
it) and:

1. Registers the **PBR** plugin ext (`registerPbrPlugins`) and **Standard** plugin
   ext (`registerStdPlugins`) into the global `_getPbrExts()` / `_getStdExts()`
   registries. The pre-existing renderable hook loops then invoke them with **zero
   shared-code changes**.
2. For **Standard** plugin materials only (filtered by `_buildGroup ===
   standardGroupBuilder`, so PBR materials are never touched), walks `scene.meshes`
   and pre-bakes the per-signature index into
   `mat._renderFeatures = { features: _computeStandardMaterialFeatures(mat) | (idx<<24) }`.
   This is required because Standard's `_computeStandardMaterialFeatures` is not
   ext-extensible, so the index must be baked in before the build reads it. PBR
   needs no walk — its `detect` hook encodes the index during feature computation.

Because none of this lives in a shared module, removing the call (or never adding
it) leaves every byte of the PBR/Standard core untouched.

## Injection-point → Lite slot mapping

| BJS `MaterialPluginPoint`                       | Lite slot      | Notes                                  |
| ----------------------------------------------- | -------------- | -------------------------------------- |
| CUSTOM_FRAGMENT_DEFINITIONS                      | `_helperFunctions` (HF) | helper fns / structs          |
| CUSTOM_FRAGMENT_MAIN_BEGIN                       | SV             | fragment scope-vars, after prelude     |
| CUSTOM_FRAGMENT_UPDATE_ALPHA                     | AT             | alpha-test region                      |
| CUSTOM_FRAGMENT_UPDATE_DIFFUSE                   | AC             | Standard diffuse update                |
| CUSTOM_FRAGMENT_BEFORE_LIGHTS                    | MF             | after f0, before lights                |
| CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION     | AI **and** NI  | ibl + non-ibl color tails              |
| CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR                 | BC             | after tonemap+gamma (demo uses this)   |
| CUSTOM_VERTEX_MAIN_BEGIN                         | VR             |                                        |
| CUSTOM_VERTEX_UPDATE_WORLDPOS                    | VW             |                                        |
| CUSTOM_VERTEX_MAIN_END                           | VB             |                                        |

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
                                  │     getUniforms.ubo → _uboFields (PBR) | self-managed `pluginUbo` binding (Standard)
                                  │     getSamplers → _bindings (texture+sampler pairs)
                                  ├─ writePluginUbo  → plugin.writeUbo(data, offsets)
                                  └─ bindPluginTextures → plugin.bindTextures → GPU entries
```

A single bridge extension handles all plugins on a material. Each distinct plugin
**signature** (name + priority + isEnabled + defines + custom code + uniforms +
samplers of every attached plugin) is assigned a small **index** (1..127). That
index is encoded into the host material's feature bits (PBR: `features2` bits
24..31; Standard: `features` bits 24..30, which are unused by the native flag
sets). Because both families' compose / pipeline caches key on the feature
integers, encoding the signature index there is what makes the cache rebuild on
any plugin change — including enabling/disabling (a disabled plugin contributes
no shader code but still produces a distinct index, hence a distinct key).

### PBR (`pbr-plugin-bridge.ts`)
A `PbrExt { id: "plugin", phase: "fragment" }` registered via `_registerPbrExt`:
- `detect(mat)` → `{ f: 0, f2: index(mat.plugins) << 24 }` (lazy index assignment).
- `frag(ctx)` → fragment for `(ctx._features2 >>> 24) & 0xff`.
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
A `StdExt { _id: "plugin", _phase: "mesh", _feature: 0x7f << 24 }` registered via
`_registerStdExt`. Standard has no per-ext `detect` hook and a fixed-layout
material UBO, so the bridge:
- pre-bakes the signature index into each plugin material's cached
  `_renderFeatures.features` (`_computeStandardMaterialFeatures(mat) | (idx<<24)`),
  done in `registerStdPlugins` for Standard materials only,
- delivers plugin uniforms through a **self-managed uniform buffer**, *not* the
  mesh UBO. `buildPluginFragment(plugins, idx, /*forStandard*/ true)` emits a
  dedicated `var<uniform> pluginUbo : pluginUboUniforms;` fragment binding (struct
  declared in `_helperFunctions`) instead of appending `_uboFields` to the mesh
  UBO. The bridge builds that `GPUBuffer` once per signature at registration time
  (uniform values are constant for a given signature) and pushes its bind entry
  from `StdExt._bind` — **before** the texture entries, matching the binding
  declaration order — followed by `bindPluginTextures`.

The decisive benefit: this route touches **zero shared standard code**. The
pre-existing `StdExt._bind` / `_textures` loops in `standard-pipeline.ts` /
`collect-std-bound-textures.ts` and the `_frag` loop in `standard-renderable.ts`
carry the plugin for free. `standard-renderable.ts`, `standard-group-builder.ts`,
and `standard-flags.ts` are byte-identical to master (no `_writeUbo` hook, no UBO
write loop, no gated import). WGSL access to a Standard plugin uniform is
`pluginUbo.<field>` (PBR access is `material.<field>`).

## Pipeline Configuration / Cache Keying

- PBR compose cache key: `features:features2:meshFeatures:sceneFeatures:lightMode:…`
  → plugin index in `features2` differentiates variants.
- PBR pipeline + bindings also include `_fragmentKey` (sorted fragment ids); the
  plugin fragment id is `plugin-<index>`, matched back to the ext in
  `createPbrMeshBindGroup` via `fid.startsWith("plugin-")`.
- Standard feature key: `_standardFeatureKey(features, …)` → plugin index in
  `features` differentiates variants.

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
   registries (Standard additionally pre-bakes feature bits for its materials and
   builds any self-managed plugin UBOs).
3. Per mesh: detect (PBR) / pre-baked features (Standard) carry the signature index
   → compose builds WGSL with the plugin fragment → pipeline/bind groups created →
   UBO + textures bound.
4. **Toggle:** set `plugin.isEnabled`, then (because `_renderFeatures` is cached)
   set `material._renderFeatures = undefined`, call `enableMaterialPlugins(scene)`
   again to re-bake, and `rebuildMaterial(scene, material)`. The new signature
   index yields a fresh pipeline.

## Babylon.js Equivalence Map

| BJS                                  | Lite                                            |
| ------------------------------------ | ----------------------------------------------- |
| `MaterialPluginBase` (class)         | `MaterialPlugin` (plain object)                 |
| `getCustomCode(type, lang)`          | `getCustomCode(type)` (WGSL only)               |
| `prepareDefinesBeforeAttributes` etc.| `defines` (folded into cache key)               |
| `getUniforms()` / `bindForSubMesh`   | `getUniforms()` / `writeUbo()` / `bindTextures` |
| `RegisterMaterialPlugin` (global)    | (omitted — per-instance attach only)            |

## Dependencies

- `shader/fragment-types.ts` (ShaderFragment, slots, UboField, BindingDecl)
- `material/pbr/pbr-flags.ts` (PbrExt), `material/standard/standard-flags.ts` (StdExt)
- `texture/texture-2d.ts` (Texture2D)

## Test Specification

- Scene 217 (`scene217-material-plugin`): a PBR sphere **and** a Standard box, each
  with the BlackAndWhite plugin enabled, validated against a BJS golden using an
  equivalent `MaterialPluginBase` BlackAndWhite plugin. MAD ≤ `scene-config.maxMad`.
- Bundle-size: every pre-existing (plugin-free) scene stays **byte-identical** to
  master — `bundle-size.spec.ts` reports no "increased vs master" for any scene
  except (newly added) scene217. Because plugin code is only reachable through
  `enableMaterialPlugins`, the shared PBR/Standard chunks keep identical content
  hashes.

## File Manifest

- `material/plugin/material-plugin.ts` — public types.
- `material/plugin/plugin-bridge-shared.ts` — signature + fragment builder
  (`forStandard` chooses mesh-UBO `_uboFields` vs self-managed `pluginUbo` binding)
  + UBO/texture helpers.
- `material/plugin/pbr-plugin-bridge.ts` — PBR `PbrExt`.
- `material/plugin/std-plugin-bridge.ts` — Standard `StdExt` + self-managed UBO.
- `material/plugin/enable-material-plugins.ts` — the opt-in entry point.
- Edits (all plugin-graph-only or type-only): `material/material.ts` (`plugins?`
  type-only field, erased from JS), `index.ts` (exports). **No shared/core
  PBR/Standard runtime file is modified** — `standard-renderable.ts`,
  `standard-group-builder.ts`, `standard-flags.ts`, and `pbr-renderable.ts` are
  diff-free vs master.
