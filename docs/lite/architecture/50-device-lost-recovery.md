# Module: Device-Lost Recovery

> Package paths: `packages/babylon-lite/src/engine/device-lost-*-recovery.ts`,
> `packages/babylon-lite/src/loader-env/environment-recovery.ts`,
> `packages/babylon-lite/src/shadow/shadow-recovery.ts`,
> `packages/babylon-lite/src/sprite/sprite-recovery.ts`, and
> `packages/babylon-lite/src/text/text-recovery.ts`

## Purpose

Device-lost recovery is an opt-in, engine-wide replacement-device workflow.
Each public enabler registers exactly one rendering-context kind with the shared
internal coordinator. The coordinator reacquires the `GPUDevice`, reconfigures
all surfaces, and then dispatches only to enabled kind handlers. Context kinds
without an enabled handler are intentionally skipped; no context is cast to
another kind.

## Public API Surface

```typescript
export interface DeviceLostRecoveryCallbacks {
    onLost?: (info: GPUDeviceLostInfo) => void;
    onRecovered?: () => void;
    onRecoveryFailed?: (error: unknown) => void;
}
export interface DeviceLostRecoveryHandle {
    disable(): void;
}

export function enableDeviceLostSceneRecovery(engine: EngineContext, options?: DeviceLostRecoveryCallbacks): DeviceLostRecoveryHandle;
export function enableDeviceLostSpriteRecovery(engine: EngineContext, options?: DeviceLostRecoveryCallbacks): DeviceLostRecoveryHandle;
export function enableDeviceLostTextRecovery(engine: EngineContext, options?: DeviceLostRecoveryCallbacks): DeviceLostRecoveryHandle;
```

An enabler covers every currently or subsequently registered context of its
kind on every surface owned by `engine`; callers never pass renderer instances.
The generic `_enableDeviceLostRecovery` coordinator remains internal and is not
exported from the package root.

## Coordinator Dispatch

`RenderingContext._kind` is the dispatch key. Public adapters use:

| Enabler | `_kind`           | Enumerated contexts |
| ------- | ----------------- | ------------------- |
| Scene   | `scene`           | `SceneContext`      |
| Sprite  | `sprite-renderer` | `SpriteRenderer`    |
| Text    | `text-renderer`   | `TextRenderer`      |

On loss, the coordinator snapshots active registrations and collapses them to
one handler per kind. It stops the engine, requests one replacement device with
the original features and storage limits, rebuilds engine storage buffers,
reconfigures every surface, refreshes swapchain render targets, resizes
contexts, invokes each registered kind handler, and restarts the engine only if
it had been running. Context kinds without a registered recovery handler are
left untouched; this permits applications to intentionally recover only a
subset of independent rendering contexts. Callback order is `onLost` before
replacement, `onRecovered` after rebuild and the first resumed frame, or
`onRecoveryFailed` if any registered recovery step rejects.
Standalone renderer handlers run before Scene rebuilding so a texture or glyph
atlas shared with a scene is current before scene renderables recreate bindings.

Multiple calls for the same kind create independent handles and callbacks.
Kind-level enable work runs on the first registration; kind-level disable work
runs only after the last handle for that kind is disabled. `disable()` is
idempotent. Scene and Sprite registrations share a ref-counted texture/mesh
capture hook, so disabling either kind cannot remove capture while the other
still needs it. Mesh geometry retention is counted separately and is active
only while Scene recovery is enabled; Sprite-only recovery retains textures,
not unrelated mesh arrays.

## Resource Ownership and Rebuild

### Scene

Scene recovery retains mesh CPU geometry, texture recovery sources, and
environment loader sources only while capture is enabled. Its loss-only module
rebuilds textures, geometry, skeletons, morph targets, environment lighting,
shadow generators, renderables, scene/light bind groups, frame-graph tasks, and
render targets.

Environment recovery supports `loadEnvironment` (`.env`) and
`loadHdrEnvironment`. Recovery must be enabled before the environment is
loaded so the URL/settings source is retained. It recreates the specular cube
and BRDF LUT on the replacement device while preserving the public
`EnvironmentTextures` object identity, and installs a single scene disposable
that owns the replacement textures. Loader-owned skybox and ground renderables
are recreated after material groups rebuild, for both loaders: the solid
skybox, the ground plane, the DDS cube skybox, and the HDR skybox that reuses
the lighting cubemap. glTF `EXT_lights_image_based` environments are not yet
recoverable; recovery fails explicitly rather than rendering with stale device
resources.

### Loader capture seam

Loaders never contain recovery semantics. `loadEnvironment` and
`loadHdrEnvironment` each carry exactly one optional-chained `engine._dlr?.e(…)`
/ `engine._dlr?.h(…)` call built from locals the loader already computes. All
meaning — what a recovery source is, which cases are unsupported, and how to
rebuild — lives in `device-lost-recovery-capture.ts` and
`loader-env/environment-recovery.ts`, which are reachable only from
`enableDeviceLostSceneRecovery`. Applications that never enable recovery pull in
none of those chunks.

Backgrounds are discovered, not captured. Each background builder stamps a plain
rebuild thunk onto the `Renderable` it returns — `Renderable._rebuild`, a
`() => Renderable | Promise<Renderable>` closing over the arguments the builder
already received. Recovery snapshots those thunks while traversing
`scene._renderables` and replays them in order, the same way material textures
already recover through `Texture2D._recoverySource`. The always-bundled
`loadEnvironment` / `loadHdr` path therefore carries no per-background recovery
code at all, and the residual cost lands only in `background-*.js`, which a scene
already pays for whenever it builds that background.

The thunk is deliberately opaque. An earlier revision stamped a descriptor tuple
— `[kind, size, rootPosition, url?]` — that recovery interpreted through a
four-arm switch over an `EnvironmentBackgroundKind`. That put a `loader-env`
concept onto `render/`'s lowest-level interface, and the only way to avoid the
import was to write the kind as a magic number at each builder, which hid the
dependency from the compiler rather than removing it. A thunk deletes the enum,
the descriptor type, the switch, and its four `await import()` calls: each
builder is already its own module, so replay needs no dispatch. It is also more
correct — the tuple silently dropped `enableNoise` for the ground and DDS
skybox, which a closure captures for free — and it composes across repeated
losses, because each rebuilt renderable stamps a fresh thunk.

`_rebuild` is only for renderables that no retained structure owns. Mesh-backed
renderables keep recovering through `scene._groups`, and must not also carry a
thunk. That is not inertia: a group build emits several renderables at once (or
merges its meshes into one), and re-running it also restores the group's
`rebuildSingle` closure, its `o` output list, and its uniform updater — none of
which a `Renderable`-returning thunk can express. `scene._groups` is live state
that already regenerates those renderables for material swaps and runtime mesh
adds, so recovery borrows it rather than duplicating it. Setting both mechanisms
on one renderable would rebuild it twice and leave a duplicate in
`scene._renderables`. Backgrounds needed a thunk precisely because they are
orphans — not mesh-backed, pushed straight into `scene._renderables` by a loader
that then discards the locals they were built from.

Two capture-based designs were measured first and rejected. Describing
backgrounds up front — passing the loaders' strategy inputs to one seam and
re-deriving the rules during recovery — cost ~65 B for *every* environment-loading
scene. Per-background capture (`engine._dlr?.g(...)` inside each builder's `if`
block) narrowed that to ~21 B, but still only for scenes that build a background.
Discovery removes the loader seam entirely. Against the pre-feature baseline the
feature now measures +1,707 B across 73 scenes, of which scene164 — the recovery
parity scene, and the only one that enables recovery — carries +1,554 B; 56
scenes are *smaller* than before because the loader capture seam is gone. The 11
background-building scenes pay 16–56 B each for the thunk. The thunk is stamped
unconditionally rather than gated on capture being enabled; one closure per
background is cheaper than the branch that would guard it. Choosing thunks over
descriptors also lowered scene164's ceiling requirement by ~1.6 KB, since the
recovery chunk no longer carries the switch or its dynamic imports.

Property names beginning with `_` are mangled in release builds, so `_rebuild`
costs no more than an abbreviated name would; internal fields are spelled out.

Capture arguments must stay primitive. Rollup tracks the property values of
object literals and uses them to prove branches dead. Passing an object whose
properties gate tree-shakeable code — such as `bgOptions`, whose `skipSkybox` /
`skipGround` guard the loader's `await import()` of the background modules —
forces Rollup to deoptimize it, because the unknown callee could mutate it. It
then loses the known property values and retains `background-ground.js`
(+4,968 B) and `background-solid-skybox.js` (+1,882 B) in scenes that had
tree-shaken them. This is why the remaining seams (`_dlr.e` / `_dlr.h`) pass
already-computed scalars.

Shadow generators are recovered in place before material groups are rebuilt.
Recovery deduplicates generators referenced by `scene.lights` and
`scene.shadowGenerators`, disposes their nested render-task state, recreates
their device-owned textures, samplers, uniform buffers, pipelines, and bind
groups, and preserves the public `ShadowGenerator` identity. This currently
supports directional ESM generators, the shadow type used by Babylon Lite
Viewer; recovery fails explicitly for PCF or CSM instead of resuming with stale
device resources. ESM retains only the two blur scalars it cannot reconstruct —
`_blurKernel` and `_blurScale`, held as internal fields on the generator's
`EsmShadowTaskResources` — and `shadow-recovery.ts` reads them from that object
during the loss-only rebuild. `_blurScale` is retained rather than re-derived as
`mapSize / _blurTexH.width` because `blurSize` is not integral for every scale,
so the round trip through a texture dimension cannot recover the caller's
original value. Every remaining option is derived from steady-state runtime
fields: `mapSize`, `bias`, `orthoMinZ`, `orthoMaxZ`, and `forceRefreshEveryFrame`
from the generator's `_config`, and `darkness`, `depthScale`, and
`frustumEdgeFalloff` from its `_shadowsInfo` array.
Rebuilding material groups afterward binds receivers and casters only to
replacement-device resources.

The shared 1x1 PBR fallback texture is cleared once per recovery, before any
scene is rebuilt, because it is engine-scoped and the PBR fallback resolver
recreates it lazily — clearing it per scene would orphan the texture created by
each earlier scene. Factor-only and shadow-only PBR materials therefore recreate
the fallback lazily on the replacement device. The environment and shadows are
restored before PBR groups rebuild so their captured shader builders see the
correct light and shadow state.

### SpriteRenderer

Sprite recovery enumerates only registered `sprite-renderer` contexts. Before
renderer state is rebuilt, it deduplicates and rebuilds every texture used by
the renderer:

- each layer's atlas `Texture2D`;
- custom-fragment extra `Texture2D`s;
- the optional offscreen render target.

The renderer then recreates its shared index buffer and every existing
per-layer instance buffer, layer UBO, custom-shader FX UBO, bind group,
pipeline reference, and render bundle. CPU instance arrays, layer membership
and ordering, visibility, transforms, dirty/version state, animation hooks,
clear settings, and target selection remain intact. Custom-shader FX elapsed
time restarts at zero because preserving that closure-only accumulator would
add recovery state to the normal custom-shader bundle. Device-keyed
shader/pipeline caches naturally select new-device entries.

URL, solid, bitmap, dynamic, raw-pixel, and empty render-target textures carry
pure recovery data only when Scene or Sprite recovery capture is enabled.
Raw-pixel updates and runtime atlas appends update the retained CPU copy.
Applications must enable recovery before creating/loading recoverable sprite
textures. Disabling the last capture-using handle stops retaining sources for
new resources; existing source records remain on their owning textures.

### TextRenderer

Text recovery enumerates only registered `text-renderer` contexts. It recreates
every existing layer UBO and instance buffer, invalidates bind groups,
pipelines, upload markers, and render bundles, and uploads the retained
`TextData` instance bytes. Every referenced Slug curve/band atlas is recreated
from `GlyphStorage`'s existing CPU arrays. Device-keyed text pipeline caches
produce the replacement pipeline and shared quad buffer. Layer membership,
ordering, placement, opacity, coverage gamma, visibility, `TextData` slot
layout, and glyph storage remain unchanged. Text recovery needs no additional
capture because those CPU arrays are already the authoritative text state.

Resources that belong to callers remain caller-owned after recovery:
SpriteRenderer does not dispose atlases, custom textures, or render targets;
TextRenderer does not dispose `TextData` or `GlyphStorage`.

## Lazy Rebuild Boundaries

The coordinator keeps only registration, required-feature capture, and the
`device.lost` listener in the steady-state bundle. A loss dynamically imports
`engine/device-lost-recovery-run`, which acquires and configures the replacement
device, dispatches recovery handlers, and restarts rendering. Public enabler
modules contain only callback wiring, kind registration, and small capture
coordination. Their `_recover` callbacks use further dynamic imports:

- Scene imports `engine/recovery-rebuild`;
- Sprite imports `sprite/sprite-recovery`, which may import texture recovery;
- Text imports `text/text-recovery`.

The package root may export all three enablers without statically retaining
SpriteRenderer, TextRenderer, their shaders, pipelines, texture rebuilders, or
glyph-atlas upload code in unrelated bundles. All modules have zero
module-level side effects; mutable caches remain null until an explicit call.

## State Machine / Lifecycle

1. Enable each context kind the application wants to recover.
2. For Scene/Sprite, enable before creating resources that require retained
   CPU/source data.
3. Register contexts and render normally.
4. On non-deliberate loss (or the internal testing marker), callbacks fire and
   the single coordinator performs replacement and per-kind rebuild.
5. Rendering resumes with the same public renderer/data objects.
6. Disable handles independently. Existing renderers continue rendering but
   their kind is no longer recoverable after its final handle is disabled.

## Test Specification

- Coordinator unit tests cover mixed Scene/Sprite/Text registration, skipped
  unregistered kinds, repeated registrations, safe idempotent disable, and
  shared capture lifetime.
- Scene recovery unit tests replace the device under an ESM shadow generator
  and assert that its textures, sampler, UBOs, hidden blur resources, and nested
  render task are recreated while the generator identity remains stable and the
  PBR fallback is cleared before material groups rebuild.
- A real-loss browser scene covers environment-lit PBR, a directional ESM
  caster, and a shadow-only receiver. It asserts replacement-device
  environment/fallback/shadow resources, preserved environment identity, no
  uncaptured WebGPU errors, credible non-flat output, and at least 50 rendered
  frames after recovery.
- Sprite unit tests replace a fake device and assert new index, instance,
  uniform, FX, pipeline/bind-group/bundle state, recovered atlas/custom/target
  textures, preserved CPU/layer state, and exact-kind enumeration.
- Text unit tests replace a fake device and assert new layer buffers and Slug
  atlas textures, invalidated/rebuilt bindings and bundles, preserved
  `TextData`/layer state, and exact-kind enumeration.
- Existing Sprite/Text renderer unit suites remain green.
- A focused browser recovery scene is preferred when it can exercise an
  existing deterministic Sprite/Text scene without changing golden images or
  MAD/bundle ceilings. Full parity and bundle-manifest regeneration remain a
  PR-preparation guardrail when explicitly requested.

## File Manifest

- `engine/device-lost-recovery.ts` — internal engine coordinator.
- `engine/device-lost-recovery-run.ts` — loss-only device replacement and handler dispatch.
- `engine/device-lost-recovery-capture.ts` — ref-counted opt-in capture.
- `engine/device-lost-scene-recovery.ts` — public Scene adapter.
- `engine/device-lost-sprite-recovery.ts` — public Sprite adapter.
- `engine/device-lost-text-recovery.ts` — public Text adapter.
- `engine/recovery-rebuild.ts` — loss-only Scene rebuild tree.
- `loader-env/environment-recovery.ts` — loss-only environment and background rebuild.
- `shadow/shadow-recovery.ts` — loss-only shadow-generator rebuild.
- `sprite/sprite-recovery.ts` — loss-only Sprite enumeration and texture rebuild.
- `text/text-recovery.ts` — loss-only Text enumeration and atlas rebuild.
- `texture/texture-recovery.ts` — loss-only `Texture2D` reconstruction.
