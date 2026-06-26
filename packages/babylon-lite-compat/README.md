# @babylonjs/lite-compat

An **opt-in Babylon.js-shaped compatibility layer** implemented on top of the
[Babylon Lite](../babylon-lite/) public API. It exists to give Babylon.js apps a
low-friction migration runway to Babylon Lite's WebGPU renderer.

```ts
import { WebGPUEngine, Scene, ArcRotateCamera, HemisphericLight, MeshBuilder, StandardMaterial, Vector3, Color3 } from "@babylonjs/lite-compat";

const engine = new WebGPUEngine(canvas);
await engine.initAsync();

const scene = new Scene(engine);
const camera = new ArcRotateCamera("cam", -Math.PI / 2, Math.PI / 2.5, 5, new Vector3(0, 0, 0), scene);
camera.attachControl(canvas, true);
new HemisphericLight("light", new Vector3(0, 1, 0), scene);

const box = MeshBuilder.CreateBox("box", { size: 1 }, scene);
const mat = new StandardMaterial("mat", scene);
mat.diffuseColor = new Color3(1, 0, 0);
box.material = mat;

engine.runRenderLoop(() => scene.render());
```

## Drop-in migration: keep your Babylon.js imports

If you have an existing Babylon.js app, you don't have to rewrite a single import.
This package ships a bundler plugin that **rewrites `@babylonjs/*` imports onto the
compat layer at build time**, so your `@babylonjs/core`, `@babylonjs/loaders`,
`@babylonjs/addons`, `@babylonjs/materials`, and `@recast-navigation/*` imports
resolve to `@babylonjs/lite-compat` instead.

```ts
// Your code stays exactly as it was — no edits needed:
import { Scene, ArcRotateCamera, MeshBuilder } from "@babylonjs/core";
```

Add the plugin for your bundler:

**Vite**

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { liteCompat } from "@babylonjs/lite-compat/vite";

export default defineConfig({
    plugins: [liteCompat()],
});
```

**Rollup** (also works with Rolldown)

```js
// rollup.config.js
import { liteCompat } from "@babylonjs/lite-compat/rollup";

export default {
    plugins: [liteCompat()],
};
```

**Webpack** (also works with Rspack)

```js
// webpack.config.js
const { LiteCompatPlugin } = require("@babylonjs/lite-compat/webpack");

module.exports = {
    plugins: [new LiteCompatPlugin()],
};
```

**esbuild**

```js
import { build } from "esbuild";
import { liteCompat } from "@babylonjs/lite-compat/esbuild";

await build({
    plugins: [liteCompat()],
    // …
});
```

Every adapter shares one redirect table, so they map imports identically. Specifiers
outside the supported surface (e.g. `@babylonjs/gui`) are left untouched and resolve
to the real Babylon.js package — so unsupported APIs fail loudly instead of silently
mismapping. Once migration is complete you can drop the plugin and import from
`@babylonjs/lite-compat` (or native `@babylonjs/lite`) directly.

## What it is (and isn't)

- A **class-based, Babylon.js-shaped** surface over Lite's plain-data + factory API.
- **Opt-in:** import it explicitly. It installs no `BABYLON` global and has no
  module-level side effects, so it never bloats consumers that don't use it.
- **Honest:** unsupported Babylon.js APIs throw `LiteCompatError` rather than
  rendering something subtly wrong.
- **Not** a full Babylon.js reimplementation. Particles, GUI, WebXR, decals,
  and other features absent from Babylon Lite are out of scope.

## Supported APIs at a glance

A high-level view of which Babylon.js packages and feature areas the compat layer
covers. This is a summary of the common surface; individual properties and
overloads within a supported area may still be absent.

| Status | Meaning                                                                 |
| ------ | ----------------------------------------------------------------------- |
| ✅     | Common surface implemented and tested where possible                    |
| ⚡     | A practical subset works; some properties/overloads are absent or throw |
| ❌     | Not supported on the current Lite API (throws `LiteCompatError`)        |

### `@babylonjs/core`

| Feature area                                                                                            | Status | Notes                                                                                                    |
| ------------------------------------------------------------------------------------------------------- | :----: | -------------------------------------------------------------------------------------------------------- |
| Math (`Vector*`, `Color*`, `Quaternion`, `Matrix`, `Plane`, `Ray`, `Frustum`, `Scalar`, `Axis`/`Space`) |   ✅   | `Angle` / `Curve3` / `Path3D` partial                                                                    |
| Engine (`WebGPUEngine`, `Engine`, `ThinEngine`, `NullEngine`)                                           |   ⚡   | async startup + render loop; `beginFrame`/`endFrame` and manual `scene.render()` unsupported             |
| Scene (clear color, cameras/lights, fog, environment, observables, ready state)                         |   ⚡   | sync `scene.pick` unsupported (use async `GPUPicker`); some scene enumeration needs Lite core            |
| Cameras (`ArcRotateCamera`, `FreeCamera`/`Universal`/`Target`, `FollowCamera`, `GeospatialCamera`)      |   ✅   | XR / device-orientation / stereoscopic rigs unsupported                                                  |
| Lights (`Hemispheric`, `Directional`, `Point`, `Spot`)                                                  |   ✅   | `RectAreaLight` / clustered lights unsupported                                                           |
| Shadows (`ShadowGenerator` directional ESM/PCF, spot PCF)                                               |   ⚡   | `CascadedShadowGenerator` falls back to single cascade                                                   |
| Meshes & geometry (class chain, `MeshBuilder` primitives, transforms, thin instances, `VertexData`)     |   ⚡   | `CreateLines`/`CreateDecal`/`CreateText`, `InstancedMesh`, LOD/edges/outline, clone/instance unsupported |
| CSG / CSG2                                                                                              |   ✅   | over Lite boolean ops                                                                                    |
| Gizmos (position/rotation/scale/bounding-box/light/camera + `GizmoManager`)                             |   ⚡   | over Lite gizmo suite                                                                                    |
| Materials (`StandardMaterial`, `PBRMaterial`, metallic-rough / spec-gloss, `NodeMaterial`)              |   ⚡   | `ShaderMaterial` (GLSL), `MultiMaterial`, `BackgroundMaterial` unsupported                               |
| Textures (`Texture`, `RawTexture`, `DynamicTexture`, `CubeTexture`)                                     |   ⚡   | `HDRCubeTexture` / `RenderTargetTexture` / `MirrorTexture` unsupported                                   |
| Animation (keyframe `Animation`, easing, `Animatable`, `AnimationGroup` incl. weighted/additive blend)  |   ⚡   | CPU evaluation; loaded glTF skeletal blending supported                                                  |
| Morph targets (`MorphTarget` / `MorphTargetManager`)                                                    |   ✅   | over Lite morph targets                                                                                  |
| Sprites (`SpriteManager` / `Sprite`)                                                                    |   ⚡   | camera-facing billboards; `SpriteMap` / packed atlas unsupported                                         |
| Behaviors / Actions (`AutoRotation`, `Framing`, `ActionManager`, conditions)                            |   ⚡   | `ActionManager` is manual-dispatch; drag behaviors need Lite core                                        |
| Misc (`Observable`, `Tools`, `SmartArray`, `Tags`, gradients, `PerformanceMonitor`)                     |   ✅   |                                                                                                          |
| Audio V2 (`AudioEngineV2`, `StaticSound`, `StreamingSound`, `AudioBus`, buses/sources/analyzer)         |   ⚡   | over Lite's AudioV2 port; `MainAudioBus` spatial/analyzer and a second main bus unsupported              |
| Particles, post-processes, layers (glow/highlight), probes, physics, WebXR                              |   ❌   | not in Babylon Lite — use native Lite `create*Task` / Havok-V2 functions                                 |

### `@babylonjs/loaders`

| Feature area                                                                                   | Status | Notes                                                           |
| ---------------------------------------------------------------------------------------------- | :----: | --------------------------------------------------------------- |
| glTF 2.0 (+ extensions), `.babylon`                                                            |   ✅   | via Lite `loadGltf` / `loadBabylon`                             |
| `SceneLoader` (`ImportMeshAsync` / `AppendAsync` / `LoadAssetContainerAsync`), `AssetsManager` |   ⚡   | `AssetContainer` partial                                        |
| Gaussian Splatting (`.ply` / `.splat` / `.sog` / `.spz`)                                       |   ⚡   | via `GaussianSplattingMesh`; LOD-streaming variants unsupported |
| `OBJ` / `STL` / `FBX` / `BVH`                                                                  |   ❌   | not in Lite — convert to glTF                                   |

### `@babylonjs/addons` · `@recast-navigation/*`

| Feature area                                                                           | Status | Notes                            |
| -------------------------------------------------------------------------------------- | :----: | -------------------------------- |
| `RecastJSPlugin` (navmesh, crowd, path, raycast, off-mesh links, tile-cache obstacles) |   ✅   | over Lite's native Recast-V2 API |

### `@babylonjs/materials`

| Feature area      | Status | Notes                                                                                          |
| ----------------- | :----: | ---------------------------------------------------------------------------------------------- |
| Library materials |   ⚡   | mapped onto the compat material surface where a Lite equivalent exists; unsupported ones throw |

> Specifiers outside the supported surface (e.g. `@babylonjs/gui`,
> `@babylonjs/inspector`) are left untouched by the bundler plugins and resolve to
> real Babylon.js, so unsupported APIs fail loudly instead of mis-mapping.

The intended migration path is:

```
@babylonjs/core  →  @babylonjs/lite-compat  →  babylon-lite (native)
```

## Missing an API you need?

The compat surface grows in response to real-world migration needs. If you hit a
Babylon.js API that isn't wrapped yet (or one that throws `LiteCompatError`),
[open an issue in the Babylon Lite repo](https://github.com/BabylonJS/Babylon-Lite/issues/new?template=compat-api-request.yml)
and add the **`compat`** label. Describe the API and your use case — issues with
the `compat` label feed directly into the layer's maintenance workflow.
