# Module: Scene

> Package path: `packages/babylon-lite/src/scene/scene.ts`

## Purpose

The Scene module defines `SceneContext` — the central, flat data container for all rendering state. It follows a strict one-way ownership model with no circular references: the scene holds references to the engine, camera, lights, and meshes, but none of those reference the scene back. The scene is material-agnostic — it delegates all pipeline/bind-group creation to material-owned builders via the `_buildGroup` pattern. It also provides `createDefaultCamera()` which computes an ArcRotateCamera auto-framed around loaded meshes' bounding boxes.

## Public API Surface

```typescript
/** Image processing configuration. */
export interface ImageProcessingConfig {
    exposure: number;
    contrast: number;
    toneMappingEnabled: boolean;
}

/** Top-level scene context — flat struct, no deep hierarchy. */
export interface SceneContext {
    readonly engine: Engine;
    clearColor: GPUColorDict;
    camera: ArcRotateCamera | FreeCamera | null;
    lights: LightBase[]; // All light types (HemisphericLight, DirectionalLight, PointLight, SpotLight)
    imageProcessing: ImageProcessingConfig;

    /** All meshes (standard, PBR, or any future material type). */
    meshes: Mesh[];

    /** Animation groups (one per glTF animation clip). */
    animationGroups: AnimationGroup[];

    fog: FogConfig | null;
    shadowGenerators: ShadowGenerator[];

    /** Background material primaryColor (linear RGB). */
    environmentPrimaryColor?: [number, number, number];

    /** Environment cubemap Y rotation in radians. */
    envRotationY?: number;

    /** Fixed timestep for animation ticks (ms, 0 = use real rAF delta). */
    fixedDeltaMs: number;

    /** Internal renderable lists — populated by material builders. */
    _renderables: Renderable[];
    _opaqueRenderables: Renderable[];
    _transparentRenderables: Renderable[];
    _prePasses: PrePassRenderable[];
    _uniformUpdaters: SceneUniformUpdater[];

    /** Fixed timestep alias (internal). */
    _fixedDeltaMs: number;

    /** Per-frame callbacks invoked before rendering. */
    _beforeRender: ((deltaMs: number) => void)[];

    /** Deferred builder functions; may be async. Drained by buildScene() during registerScene(). */
    _deferredBuilders: (() => void | Promise<void>)[];
}

/** Add an entity or asset container to the scene. Auto-routes by type. */
export function addToScene(scene: SceneContext, entity: Mesh | LightBase | Camera | ShadowGenerator | TransformNode | AssetContainer): void;

/** Remove an entity or asset container from the scene, undoing addToScene. Idempotent. */
export function removeFromScene(scene: SceneContext, entity: Mesh | LightBase | Camera | ShadowGenerator | TransformNode | AssetContainer): void;

/** Register a callback to run before each rendered frame. */
export function onBeforeRender(scene: SceneContext, cb: (deltaMs: number) => void): void;

/** Register a callback to run when `disposeScene(scene)` is called. */
export function onSceneDispose(scene: SceneContext, cb: () => void): void;

/** Build deferred GPU resources, build the frame graph, and register the scene for rendering.
 *  Rebuilds the scene first when its light/shadow topology changed since the initial build. */
export function registerScene(scene: SceneContext): Promise<void>;

/** Remove the scene from the engine render list without disposing scene-owned resources. */
export function unregisterScene(scene: SceneContext): void;

/** Re-run every material group builder in place so renderables pick up the current light/shadow
 *  topology. No-op before the initial build. */
export function rebuildSceneRenderables(scene: SceneContext): Promise<void>;

/** Release all GPU resources owned by this scene. */
export function disposeScene(scene: SceneContext): void;

/** Create an empty scene context bound to the given engine. */
export interface SceneContextOptions {
    defaultRenderTask?: boolean;
}

export function createSceneContext(engine: Engine, options?: SceneContextOptions): SceneContext;

/** Create an ArcRotateCamera framed to fit all loaded meshes, assign it to scene. */
export function createDefaultCamera(scene: SceneContext): ArcRotateCamera;
```

## Internal Architecture

### SceneContext — Flat Data Struct

`createSceneContext(engine, options?)` returns a plain object with these defaults. By default it also appends the swapchain render task named `"scene"`; pass `{ defaultRenderTask: false }` when the caller will provide the final swapchain task explicitly, such as a post-process chain.

| Field                     | Default                                                       | Description                                                               |
| ------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `engine`                  | passed in                                                     | Immutable reference to Engine                                             |
| `clearColor`              | `{ r: 0.2, g: 0.2, b: 0.3, a: 1.0 }`                          | Render pass clear color                                                   |
| `camera`                  | `null`                                                        | Set later by `createDefaultCamera`                                        |
| `lights`                  | `[]`                                                          | All light types (LightBase[])                                             |
| `meshes`                  | `[]`                                                          | All meshes (standard, PBR, etc.)                                          |
| `animationGroups`         | `[]`                                                          | Animation groups from glTF clips                                          |
| `fog`                     | `null`                                                        | Fog configuration (null = disabled)                                       |
| `shadowGenerators`        | `[]`                                                          | Shadow generators                                                         |
| `imageProcessing`         | `{ exposure: 1.0, contrast: 1.0, toneMappingEnabled: false }` | Image processing params                                                   |
| `_renderables`            | `[]`                                                          | All renderables (combined list)                                           |
| `_opaqueRenderables`      | `[]`                                                          | Opaque renderables sorted by `order`                                      |
| `_transparentRenderables` | `[]`                                                          | Transparent renderables sorted back-to-front per frame                    |
| `_prePasses`              | `[]`                                                          | Pre-pass entities (shadow depth, compute)                                 |
| `_uniformUpdaters`        | `[]`                                                          | Per-frame UBO updaters                                                    |
| `_fixedDeltaMs`           | `0`                                                           | Fixed timestep for animation (ms)                                         |
| `_beforeRender`           | `[]`                                                          | Pre-render callbacks `(deltaMs) => void`                                  |
| `_deferredBuilders`       | `[]`                                                          | Async-capable builders drained by `buildScene()` during `registerScene()` |

### Design Principle: One-Way Ownership

```
Engine ← SceneContext → Camera
                      → Lights[]
                      → Meshes[]
                      → AnimationGroups[]
                      → ShadowGenerators[]
                      → _renderables[]
                      → _prePasses[]
                      → _uniformUpdaters[]
                      → _beforeRender[]
```

No child objects reference the scene. The engine iterates the renderable arrays as opaque contracts.

### `addToScene()` — Entity Routing

`addToScene(scene, entity)` inspects the entity and routes it to the correct collection:

```typescript
function addToScene(scene: SceneContext, entity: Mesh | LightBase | ShadowGenerator | TransformNode | AssetContainer) {
    // AssetContainer — from loadGltf() or loadBabylon()
    if ("entities" in entity) {
        const result = entity as AssetContainer;
        for (const e of result.entities) addToScene(scene, e); // recurse into individual entities
        if (result.clearColor) ctx.clearColor = result.clearColor;
        if (result.animationGroups?.length) {
            const engine = ctx.engine as EngineContextInternal;
            const groups = result.animationGroups;
            ctx.animationGroups.push(...groups);
            ctx._beforeRender.push((dt) => {
                for (const g of groups) tickAnimation(g, dt, engine);
            });
        }
        return;
    }
    if (isTransformNode(entity)) {
        // TransformNode: collect all meshes from hierarchy and add each
        const meshes = collectMeshes(entity, entity.parent ?? undefined);
        for (const m of meshes) {
            ctx.add(m);
        }
        return;
    }
    if ("_gpu" in entity && "material" in entity) {
        // Mesh → meshes + register material builder (deduped by builder identity)
        this.meshes.push(entity);
        // Subscribe this scene to the mesh. A mesh never references the scene (one-way
        // ownership), so the reverse index lives off the mesh in a lazily-allocated
        // `WeakMap<Mesh, Set<SceneContext>>`. The `mesh.material` setter is installed
        // exactly once (on the mesh's first registration); the captured subscriber set is
        // mutated in place, so a mesh shared across scenes notifies ALL of them on swap.
        // The set's size also ref-counts the mesh's shared GPU buffers: disposeScene /
        // removeFromScene only call disposeMeshGpu on the LAST scene removal.
        registerMeshScene(this, entity);
        const builder = entity.material?._buildGroup;
        if (builder && !_groups.has(builder)) {
            _groups.set(builder, []);
            this._deferredBuilders.push(async () => {
                const result = await builder(this, _groups.get(builder)!);
                this._renderables.push(...result.renderables);
                if (result.updater) this._uniformUpdaters.push(result.updater);
            });
        }
        _groups.get(builder)?.push(entity);
    } else {
        // Light → lights
        this.lights.push(entity as LightBase);
    }
}
```

The `AssetContainer` branch is checked first (via `'entities' in entity`). For `glTF` results, `entities` contains a single root `TransformNode` — the TransformNode branch then calls `collectMeshes` to pull all child meshes into the scene. For `.babylon` results, `entities` is flat `[...meshes, ...lights]`, dispatched directly.

The scene never branches on material type (PBR vs standard). Materials self-describe their builder via `material._buildGroup`, and the scene groups meshes by builder identity using an internal `Map<MeshGroupBuilder, Mesh[]>`. Each unique builder is registered as a deferred builder exactly once.

### Deferred Building & `_buildGroup` Pattern

Materials carry a `_buildGroup: MeshGroupBuilder` function that knows how to create GPU pipelines, bind groups, and renderables for a batch of meshes sharing that material type. The flow:

1. `addToScene(scene, mesh)` groups the mesh by its `material._buildGroup` identity.
2. If this is the first mesh for a given builder, a deferred builder is registered.
3. At `buildScene(scene)` time (called by `registerScene()` before the frame graph is built), each deferred builder runs once with the full batch of meshes for that group.
4. Builders return `MeshGroupBuildResult`; `renderables` are pushed onto `_renderables`, and an optional `updater` is pushed onto `_uniformUpdaters` only when present.

`buildScene(scene)` is async — deferred builders may return `Promise<void>` for GPU resource creation.

This decouples scene setup from GPU resource creation, ensures all assets are loaded before pipelines are built, and keeps scene.ts entirely material-agnostic.

### Runtime Adds & Removals (after `registerScene`)

Deferred builders only run at boot, inside `buildScene()`. Anything added afterwards goes through the
per-frame material-swap queue (`processMaterialSwaps`, drained from the scene's `_update` hook), which
covers two distinct cases:

- **The material's group already exists and has been built** (`group.r` is set) — the mesh's renderable
  is rebuilt synchronously in that same frame, so there is no missing-mesh flash.
- **The material's group has never been built** — either the mesh is the FIRST of its material family in
  this scene, or `mesh.material` was reassigned to a family with no group at all (the material setter only
  enqueues; it never creates a group). These are handed to the runtime build path
  (`scene-runtime-mesh-build.ts`, dynamically imported so static scenes do not bundle it), which
  materializes the group: PBR rebuilds the whole group via `rebuildScenePbrPipelines`, other families
  build the single mesh and install the group's rebuild function.

> **Introducing a material family at runtime is ASYNCHRONOUS.** It requires a dynamic module import plus
> shader compilation and a full group build, so the mesh becomes visible some frames after `addToScene`
> returns — `addToScene` itself returns `void` and offers no readiness signal. Adding at least one mesh of
> each material family before `registerScene` keeps everything synchronous. Build failures surface through
> the scene's before-render error hook rather than being swallowed.

`removeFromScene` mirrors this asymmetry on the teardown side: scene bookkeeping (list splices, group and
frame-graph eviction, renderable-version bump) is synchronous, but **GPU teardown is deferred** —
per-mesh/material UBOs, texture releases and shared geometry buffers are retired via `retireGpuResources`
and only destroyed after the next `queue.submit` has drained. This makes `removeFromScene` legal from
inside `onBeforeRender` (destroying mid-frame hits "Destroyed texture / Buffer used in a submit") and
preserves make-before-break for resources shared with another mesh: a rebuild re-acquires the texture
before the deferred release lands, so its ref count never dips to zero. Because the free is deferred, the
right to release a mesh's shared buffers is taken as a one-shot, revocable claim
(`claimMeshGpuDisposal` / `consumeMeshGpuDisposal`), so a repeat removal, a re-add, or a `disposeScene`
in between cannot free the same buffers twice.

### Hidden State (accessed via `(scene as any)`)

| Property       | Set by              | Type                  | Purpose                                   |
| -------------- | ------------------- | --------------------- | ----------------------------------------- |
| `_envTextures` | `loadEnvironment()` | `EnvironmentTextures` | IBL cubemap + BRDF LUT                    |
| `_pbrSceneBGL` | PBR builder         | `GPUBindGroupLayout`  | PBR scene BGL for background reuse        |
| `_pbrSceneBG`  | PBR builder         | `GPUBindGroup`        | PBR scene bind group for background reuse |

> **Removed**: `_gpuMeshes` and the `GpuMesh` type no longer exist. Meshes carry their GPU data in `mesh._gpu` and their bounding boxes in `mesh.boundMin`/`mesh.boundMax` directly.

### Auto-Framing Camera (`createDefaultCamera`)

Algorithm:

1. Read `scene.meshes` (may be empty).
2. Compute world-space AABB across all meshes by iterating `boundMin`/`boundMax` on each `Mesh`.
3. Compute diagonal: `diag = √(sx² + sy² + sz²)` where `sx = maxX - minX`, etc.
4. Radius = `diag * 1.5` (Babylon formula).
5. Center = midpoint of AABB.
6. If radius is 0 or non-finite: radius = 1, center = (0,0,0).
7. Create camera: `alpha = -π/2`, `beta = π/2`, `radius`, `target = center`.
8. Set `minZ = radius * 0.01`, `maxZ = radius * 1000`.
9. Assign `scene.camera = cam`.

## Lifecycle: What Is Baked At Build Time

`registerScene` / `registerSceneWithShadowSupport` run the deferred group builders **once**
(`_built`); `unregisterScene` only detaches the scene from its surface's render list, so a
re-registration re-attaches rather than re-builds. What each category costs:

| Change after the initial build            | Takes effect                                                                             |
| ----------------------------------------- | ---------------------------------------------------------------------------------------- |
| Light position / direction / colour / intensity | Immediately — the lights UBO is refreshed from `_lightVersion` every frame           |
| **Removing** or swapping a light          | Data: next frame (`_lightListVersion` invalidates the UBO). Baked state: rebuilt automatically on the next registration |
| Removing a shadow generator               | Rebuilt automatically on the next registration                                           |
| **Adding** a light, or attaching a generator to an existing light | Data: next frame (the light count changes). Baked state: only via an explicit `rebuildSceneRenderables(scene)` |
| `mesh.material = …`                       | Next frame, via the material-swap drain                                                  |

Baked per renderable at build time: the per-mesh light **index** list, the single- vs multi-light
shader permutation, whether the mesh receives shadows, and the shadow bind group of the generator
attached to each light. `rebuildSceneRenderables(scene)` re-runs the group builders so all of it is
recomputed. `removeFromScene` installs a rebuild hook that `buildScene` runs, so a **removal** is
picked up automatically on the scene's next registration and the natural flow works:

```ts
unregisterScene(scene);
removeFromScene(scene, oldLight); // its shadow generator goes with it — arms the rebuild
addToScene(scene, newLight); // with its own generator
await registerSceneWithShadowSupport(scene); // rebuilds, then re-attaches
```

A scene that only **adds** a light to an already-built scene installs no hook (keeping `addToScene`
free of rebuild bytes for every scene that never mutates topology) — call `rebuildSceneRenderables`
explicitly in that case.

Removing a shadow generator does **not** free its GPU resources inline: receiver renderables built
before the removal still bind them, so the teardown is queued on `_pendingTopologyRetirements` and
drained by an all-family rebuild (after the replacement bind groups exist) or by `disposeScene`. A
family-scoped rebuild (image processing → PBR only) deliberately never drains it.

Only group-owned renderables are replaced. Feature-owned entries in `_renderables` (skybox, ground,
HDR backdrop, Gaussian splats) are preserved: each `SceneMeshGroup` records its last build's output
in `group.o` — a group's meshes can be merged into one combined renderable with no `mesh`
back-reference, so ownership cannot be recovered by mesh identity. Node materials that captured
`shadowGenerators` at parse time keep their own references and are out of scope for a topology swap.

## Babylon.js Equivalence Map

| Babylon Lite                    | Babylon.js                                                        |
| ------------------------------- | ----------------------------------------------------------------- |
| `createSceneContext(engine)`    | `new BABYLON.Scene(engine)`                                       |
| `scene.clearColor`              | `scene.clearColor`                                                |
| `scene.camera`                  | `scene.activeCamera`                                              |
| `scene.lights`                  | `scene.lights`                                                    |
| `scene.meshes`                  | `scene.meshes`                                                    |
| `scene.animationGroups`         | `scene.animationGroups`                                           |
| `addToScene(scene, entity)`     | `scene.addMesh()` / `scene.addLight()` (depending on entity type) |
| `scene._renderables`            | `scene._renderingManager._renderingGroups`                        |
| `scene._prePasses`              | `scene.onBeforeRenderObservable` handlers                         |
| `scene._beforeRender`           | `scene.onBeforeRenderObservable`                                  |
| `scene._uniformUpdaters`        | Internal UBO update during `scene.render()`                       |
| `scene._deferredBuilders`       | `scene._prepareFrame()` lazy compilation                          |
| `scene.imageProcessing`         | `scene.imageProcessingConfiguration`                              |
| `createDefaultCamera(scene)`    | `scene.createDefaultCameraOrLight(true, true, true)`              |
| `scene.environmentPrimaryColor` | `env.groundMaterial.primaryColor`                                 |

## Dependencies

- **Imports**: `Engine` from `../engine/engine.js`, `ArcRotateCamera` + `createArcRotateCamera` from `../camera/arc-rotate.js`, `vec3` from `../math/vec3.js`, `Renderable`/`PrePassRenderable`/`SceneUniformUpdater`/`MeshGroupBuilder` from `../render/renderable.js`, `Mesh` from `../mesh/mesh.js` (type-only), `AnimationGroup` and `tickAnimation` from `../animation/animation-group.js`.
- **Depended on by**: `engine.ts`, all material renderables, all loaders.

## Test Specification

| Test                                        | Description                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------- |
| `createSceneContext returns valid defaults` | Verify all fields match documented defaults                               |
| `addToScene routes mesh`                    | Add Mesh → appears in `meshes`, builder registered in `_deferredBuilders` |
| `addToScene routes light`                   | Add light → appears in `lights`                                           |
| `addToScene routes shadow generator`        | Add ShadowGenerator → appears in `shadowGenerators` + `_prePasses`        |
| `addToScene deduplicates builders`          | Two meshes with same `_buildGroup` → one deferred builder                 |
| `createDefaultCamera with meshes`           | Provide meshes with known bounds, verify radius = diag\*1.5               |
| `createDefaultCamera with no meshes`        | radius=1, center=(0,0,0)                                                  |
| `deferred builders run at buildScene()`     | Register builder → verify called by `buildScene()`                        |
| `buildScene() awaits async builders`        | Register async builder → verify awaited                                   |
| `rebuildSceneRenderables no-op pre-build`   | `_built === false` → builders not re-run                                  |
| `rebuildSceneRenderables preserves features`| Skybox/ground renderables survive; group output replaced                   |
| `rebuildSceneRenderables regroups meshes`   | Material-swapped mesh rebuilt by its CURRENT family builder               |
| `rebuild retires old disposers after build` | Make-before-break ordering; `_meshAuxDisposables` untouched               |
| `light removal marks topology dirty`        | `_lightListVersion` bumped, rebuild hook installed, teardown deferred     |
| `scene272-runtime-mesh-swap`                | Remove a textured mesh + add a clone sharing its material from `onBeforeRender` → no destroyed-resource submit, matches BJS |
| `scene273-runtime-material-family`          | Add the first PBR mesh to a built StandardMaterial-only scene → the mesh renders instead of being silently dropped |

## File Manifest

| File                 | Size       | Purpose                                                              |
| -------------------- | ---------- | -------------------------------------------------------------------- |
| `src/scene/scene.ts` | ~150 lines | SceneContext interface, factory, entity routing, auto-framing camera |
