# Getting Started with Babylon Lite

This guide gets you from `npm install` to a rendered 3D scene, and — just as importantly — gives you the **mental model** for how Babylon Lite is designed so the rest of the API feels predictable.

> New here? Read **[Welcome](00-welcome.md)** first for the big picture and the "which engine should I use?" decision tree. This page assumes you've decided to build with Lite.

---

## 1. Install

Babylon Lite ships as a single package:

```bash
npm install @babylonjs/lite
```

That's the whole runtime. There's no plugin registration, no global side effects, and no separate loaders package — every optional feature is a normal `import` that the bundler includes **only if you use it**.

**Requirements:**

- **WebGPU.** Lite is WebGPU-exclusive — Chrome/Edge 113+, and recent Firefox and Safari. There is no WebGL fallback by design.
- **A bundler.** Lite is built on and designed around [Vite](https://vitejs.dev/), which is the smoothest path, but any modern ESM bundler works.

---

## 2. The mental model (read this first)

Babylon Lite looks familiar to Babylon.js, but it is built on a few deliberate rules. Internalize these four ideas and the entire API becomes predictable.

### Plain data, not classes

Cameras, lights, meshes, and materials are **plain state objects** — no methods, no hidden references. You create them with factory functions:

```typescript
const light = createHemisphericLight([0, 1, 0], 1.0); // just returns data
```

Behavior lives in **standalone functions** that take the object as their first argument:

```typescript
addToScene(scene, light);
getViewMatrix(camera);
```

This is what makes Lite **tree-shakable**: a function you never call is stripped from your bundle entirely. There's no class dragging along methods you don't use.

### The scene is the sole owner

A light doesn't know about the scene. A mesh doesn't know about the scene. **Only the scene knows its contents.** You build components as standalone data, then hand them to the scene:

```typescript
const light = createHemisphericLight([0, 1, 0], 1.0);
addToScene(scene, light); // the scene now owns it
```

This one-way ownership means zero circular references, trivial serialization, and predictable lifetimes — if it's not in the scene, it isn't rendered.

### An explicit lifecycle

Every Lite app follows the same four phases, in order:

1. **Create the engine** — `await createEngine(canvas)` (acquires the GPU device).
2. **Build the scene** — create a `SceneContext`, then `addToScene()` your camera, lights, meshes, and loaded assets.
3. **Register** — `await registerScene(scene)` does the deferred GPU work (builds pipelines, partitions renderables). Call this **after** everything is added.
4. **Start** — `await startEngine(engine)` begins the render loop and resolves after the first frame.

If something doesn't appear, it's almost always because it was added **after** `registerScene()`, or never added at all.

### You pay only for what you touch

Every optional feature — a glTF extension, clearcoat, HDR loading, shadows — is an isolated module, dynamically imported the moment a scene actually needs it. A trivial scene ships a few KB; a full PBR + IBL scene only pays for the paths it exercises. You don't manage this; just write the scene you want and the bundler does the rest.

---

## 3. Your first scene

Here is a complete, minimal app: an engine, a camera, a light, and a sphere with a PBR material.

```typescript
import {
    createEngine,
    createSceneContext,
    createArcRotateCamera,
    attachControl,
    createHemisphericLight,
    createSphere,
    createPbrMaterial,
    addToScene,
    registerScene,
    startEngine,
} from "@babylonjs/lite";

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

// 1. Engine
const engine = await createEngine(canvas);

// 2. Scene
const scene = createSceneContext(engine);

// Camera (plain data) — set it on the scene, then attach input handling
const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2.5, 4, { x: 0, y: 0, z: 0 });
scene.camera = camera;
attachControl(camera, canvas, scene);

// Light
addToScene(scene, createHemisphericLight([0, 1, 0], 1.0));

// A sphere with a simple PBR material
const sphere = createSphere(engine, { segments: 16, diameter: 2 });
sphere.material = createPbrMaterial({ baseColorFactor: [0.9, 0.1, 0.1, 1], metallicFactor: 0.1, roughnessFactor: 0.4 });
addToScene(scene, sphere);

// 3. Register (after everything is added)
await registerScene(scene);

// 4. Start the render loop
await startEngine(engine);
```

```html
<canvas id="renderCanvas" style="width: 100%; height: 100%"></canvas>
```

That's a full Lite application. Notice the shape: **create → add → register → start.**

---

## 4. Loading a model and an environment

Most real projects start by loading a glTF/GLB model and lighting it with an image-based environment. `loadGltf()` returns an **asset container** — plain data describing the loaded hierarchy. You hand that container to `addToScene()`, exactly like any other component.

```typescript
import {
    createEngine,
    createSceneContext,
    createDefaultCamera,
    attachControl,
    createHemisphericLight,
    loadGltf,
    loadEnvironment,
    addToScene,
    registerScene,
    startEngine,
} from "@babylonjs/lite";

const engine = await createEngine(canvas);
const scene = createSceneContext(engine);

addToScene(scene, createHemisphericLight([0, 1, 0], 1.0));

// Load a model — returns an AssetContainer; addToScene registers its
// meshes, transform hierarchy, and animation groups for you.
addToScene(scene, await loadGltf(engine, "https://playground.babylonjs.com/scenes/BoomBox.glb"));

// Image-based lighting + skybox + ground. loadEnvironment adds its own
// renderables to the scene internally.
await loadEnvironment(scene, "https://assets.babylonjs.com/core/environments/environmentSpecular.env", {
    skyboxUrl: "https://assets.babylonjs.com/core/environments/backgroundSkybox.dds",
    skyboxSize: 1000,
});

// Frame the loaded model automatically
const camera = createDefaultCamera(scene);
attachControl(camera, canvas, scene);

await registerScene(scene);
await startEngine(engine);
```

This is the BoomBox scene from the **[Welcome](00-welcome.md)** page — the same model, lights, and IBL, in a handful of lines.

---

## 5. How to think about common tasks

A few orientation notes for patterns that differ from Babylon.js. These are pointers, not full references — follow the links for depth.

- **Adding and removing things.** `addToScene(scene, entity)` registers; `removeFromScene(scene, entity)` is the counterpart to BJS's `dispose()`. The scene owns lifetimes — remove an entity and it stops rendering.
- **Reusing geometry across many objects.** Lite does **not** implement the classic `InstancedMesh` API. Instead, draw many copies of one mesh in a single GPU call with **thin instances** — pass a flat `Float32Array` of per-instance matrices via `setThinInstances(mesh, data, count)` (and optional per-instance colors). This is the idiomatic, high-performance way to populate a scene with repeated props. See **[Thin Instances](architecture/12-thin-instances.md)**.
- **Parenting and hierarchies.** Build transform hierarchies with `createTransformNode()` and parent nodes to it; world matrices propagate lazily. `cloneTransformNode()` duplicates a node subtree. See **[Scene Hierarchy & Parenting](architecture/11-scene-hierarchy-parenting.md)**.
- **Hiding things.** Toggle a node and its descendants with `setSubtreeVisible(node, false)` rather than disposing — useful for object pooling and show/hide without paying re-upload costs.
- **Animation.** glTF animation clips arrive on the asset container as **animation groups** that `addToScene()` registers automatically; play, pause, seek, and loop them. See **[Animation](architecture/07-animation.md)**.

---

## 6. Next steps

You now have the mental model and a running scene. From here:

- 🔁 **[Porting Guide](03-porting-guide.md)** — a side-by-side API map for translating a Babylon.js scene to Lite.
- 📊 **[Feature Comparison](02-feature-comparison.md)** — exactly what Lite covers today, what's partial, and what's missing.
- 🧱 **[Architecture docs](architecture/)** — deep dives into every subsystem, ordered from most to least commonly needed.
- 🌐 **[github.com/BabylonJS/Babylon-Lite](https://github.com/BabylonJS/Babylon-Lite)** — browse the source and the scene gallery.

Found something missing or confusing? **[Open an issue](https://github.com/BabylonJS/Babylon-Lite/issues)** — early feedback directly shapes the roadmap. 💙
