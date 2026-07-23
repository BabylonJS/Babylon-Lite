# Module: Device-Lost Recovery

> Package paths: `packages/babylon-lite/src/engine/device-lost-*-recovery.ts`,
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

Scene recovery retains mesh CPU geometry and texture recovery sources only
while capture is enabled. Its loss-only module rebuilds textures, geometry,
skeletons, morph targets, renderables, scene/light bind groups, frame-graph
tasks, and render targets.

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
- `sprite/sprite-recovery.ts` — loss-only Sprite enumeration and texture rebuild.
- `text/text-recovery.ts` — loss-only Text enumeration and atlas rebuild.
- `texture/texture-recovery.ts` — loss-only `Texture2D` reconstruction.
