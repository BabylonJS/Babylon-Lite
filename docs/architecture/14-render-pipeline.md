# Module: Renderable Architecture
> Package path: `packages/babylon-lite/src/render/renderable.ts`

## Purpose

The Renderable module defines the universal draw contract that decouples the engine render loop from all material/entity knowledge. The engine iterates blind `Renderable`, `PrePassRenderable`, and `SceneUniformUpdater` interfaces — it never imports materials, shaders, or pipeline-specific code. This is the foundation of Babylon Lite's tree-shakability.

The old `render/pipelines.ts` (centralized `buildRenderPipelines()`) has been **deleted**. Pipeline creation is now owned by each material/entity module.

## Public API Surface

```typescript
/** A drawable entity — the engine calls draw() during the main render pass. */
export interface Renderable {
  /** Sort key. Lower values render first (skybox=0, opaque=100, transparent=200). */
  readonly order: number;
  /** Issue draw calls into the render pass. */
  draw(pass: GPURenderPassEncoder, engine: Engine): void;
}

/** A pre-pass entity — runs before the main render pass (shadows, compute, etc.). */
export interface PrePassRenderable {
  /** Issue commands into the command encoder (shadow depth pass, blur pass, etc.). */
  execute(encoder: GPUCommandEncoder, engine: Engine): void;
}

/** Per-frame uniform updater — writes camera/light/fog data to UBOs. */
export interface SceneUniformUpdater {
  /** Called once per frame before draw calls. */
  update(engine: Engine): void;
}

/** Build result from a mesh group builder. */
export interface MeshGroupBuildResult {
  renderables: Renderable[];
  updater: SceneUniformUpdater;
}

/** A function that builds renderables for a group of meshes sharing the same
 *  material type. Each material module exports one. */
export type MeshGroupBuilder = (scene: any, meshes: any[]) => Promise<MeshGroupBuildResult>;
```

## Design Principles

### Entity-Owned Pipelines — the `_buildGroup` Pattern

Each material module exports a `MeshGroupBuilder` function that knows how to build renderables for its mesh group. Materials carry `_buildGroup: MeshGroupBuilder` on their props, so the scene never needs to know which material type it is dealing with.

```
standard-material.ts  → standardGroupBuilder  (dynamically imports standard-renderable.js + scene-helpers.js)
pbr-material.ts       → pbrGroupBuilder       (dynamically imports pbr-renderable.js)
Skybox                → skybox-cubemap.ts deferred    → Renderable
Background            → buildBackgroundRenderables()  → Renderable[]
Shadows               → shadow-renderable.ts          → PrePassRenderable
```

`standardGroupBuilder` and `pbrGroupBuilder` are `MeshGroupBuilder` functions. They are set on the material props at creation time (e.g. `createStandardMaterial()` sets `_buildGroup: standardGroupBuilder`).

### Registration via `addToScene()`

Entities are registered with the scene via `addToScene()`. The function accepts meshes, lights, or shadow generators — no raw renderables:

```typescript
addToScene(scene, mesh);       // pushes to meshes[], registers _buildGroup once per builder type
addToScene(scene, light);      // pushes to lights[]
addToScene(scene, shadowGen);  // pushes to shadowGenerators[] + _prePasses[]
```

When a mesh is added, `addToScene()` reads `mesh.material._buildGroup` and groups meshes by builder function. A single deferred builder is registered per unique `MeshGroupBuilder`. The old `scene.add(renderables, updater)` signature is gone.

### Deferred Building Pattern

Entities register deferred builders when added to the scene. These builders run once at `startEngine()` before the first frame:

```
mesh added via addToScene(scene, mesh) → material._buildGroup registered once per builder type
startEngine(engine, scene):
  1. Run all deferred builders (materials dynamically import their renderable modules)
  2. Sort renderables by order
  3. Begin render loop
```

### Render Loop (in Engine)

```
each frame:
  1. Pre-passes:   for each _prePasses → execute(encoder, engine)     // shadow depth
  2. Uniform updates: for each _uniformUpdaters → update(engine)       // write UBOs
  3. Begin main render pass (MSAA + depth)
  4. Draw calls:   for each _renderables (sorted by order) → draw(pass, engine)
  5. End pass, submit
```

### Draw Order

| Order | Entity | Depth Write |
|---|---|---|
| 0 | Skybox (env background or cubemap) | true |
| 100 | Opaque meshes (PBR, Standard) | true |
| 200 | Transparent objects (ground plane) | false |

## Babylon.js Equivalence Map

| Babylon Lite | Babylon.js |
|---|---|
| `Renderable` interface | Internal rendering group draw lists |
| `PrePassRenderable` | `scene.onBeforeRenderObservable` + shadow render passes |
| `SceneUniformUpdater` | `scene.sceneUbo` update + material uniform updates |
| `renderable.order` | `scene.setRenderingOrder()` (opaque, alpha test, alpha blend) |
| `scene._renderables` | `scene._renderingManager._renderingGroups` |
| `scene._prePasses` | `scene._activeMeshes` shadow generators |
| Entity-owned pipelines | Material `_getEffect()` internal cache |
| Deferred builder pattern | `scene._prepareFrame()` + material lazy compilation |

## Dependencies

- **Imports**: `Engine` from `../engine/engine.js` (type-only).
- **Depended on by**: Every material module (PBR, Standard, Background, Skybox, Shadow), scene.ts, engine.ts. Both `standard-material.ts` and `pbr-material.ts` import `MeshGroupBuilder` (type-only) to define their builder functions.

## File Manifest

| File | Size | Purpose |
|---|---|---|
| `src/render/renderable.ts` | ~47 lines | Renderable, PrePassRenderable, SceneUniformUpdater interfaces + MeshGroupBuildResult, MeshGroupBuilder types |
