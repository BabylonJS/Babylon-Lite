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
- **Not** a full Babylon.js reimplementation. Classic imperative particle systems,
  GUI, WebXR, decals, and other features absent from Babylon Lite are out of scope
  (Node Particle Editor graphs are partially supported).

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

| Feature area                                                                                                                              | Status | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------- | :----: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Math (`Vector*`, `Color*`, `Quaternion`, `Matrix`, `Plane`, `Ray`, `Frustum`, `Scalar`, `Axis`/`Space`, color temperature/white balance)  |   ✅   | Includes handedness-correct `LookDirection` matrices/quaternions; `Angle` / `Curve3` / `Path3D` partial                                                                                                                                                                                                                                                                                                                                                                                         |
| Engine (`WebGPUEngine`, `Engine`, `ThinEngine`, `NullEngine`)                                                                             |   ⚡   | async startup + render loop; `currentSampleCount` reports the active surface's MSAA count; `beginFrame`/`endFrame`, occlusion queries, engine-wide alpha-to-coverage, and manual `scene.render()` unsupported                                                                                                                                                                                                                                                                                  |
| Compute + GPU buffers (`ComputeShader`, `StorageBuffer`, `UniformBuffer`)                                                                 |   ⚡   | WGSL compute, direct/indirect dispatch, storage buffers, and compute-oriented std140 uniform buffers forward to Lite; shader registries/preprocessing, texture bindings, in-frame immediate dispatch, and Effect-oriented UBO methods remain unsupported                                                                                                                                                                                                                                       |
| Scene (clear color, cameras/lights, fog, environment, observables, ready state)                                                           |   ⚡   | `Node.accessibilityTag` forwards description, role, and ARIA metadata to Lite (DOM event handlers remain unsupported); sync `scene.pick` forwards to Lite's CPU triangle picker with thin-instance, predicate, normal, and UV detail; `scene.meshes` + `getMeshBy*`/`getNodeBy*` enumerate every mesh via a canonical wrapper registry; exposure/contrast/tone mapping are forwarded, while white balance and fluid rendering throw because Lite lacks their cross-cutting shader/render-pass subsystems |
| Cameras (`ArcRotateCamera`, `FreeCamera`/`Universal`/`Target`, `FollowCamera`, `GeospatialCamera`)                                        |   ✅   | arc controls include pointer, wheel, touch, and BJS-default Arrow-key input; orthographic bounds and projection-mode switching forward to Lite; fully unconfigured orthographic extents use Lite's `halfHeight` + aspect-ratio derivation rather than Babylon.js render dimensions; XR / device-orientation / stereoscopic rigs unsupported                                                                                                                                                    |
| Lights (`Hemispheric`, `Directional`, `Point`, `Spot`)                                                                                    |   ✅   | `ClusteredLightContainer` clusters unshadowed point lights before engine start (⚡ partial); clustered spot lights and `RectAreaLight` unsupported                                                                                                                                                                                                                                                                                                                                              |
| Shadows (`ShadowGenerator` directional ESM/PCF, spot PCF)                                                                                 |   ⚡   | `CascadedShadowGenerator` uses Lite's native 2–4 cascade CSM                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Meshes & geometry (class chain, `MeshBuilder` primitives, transforms, thin instances, `clone`, `VertexData`, `Mesh.MergeMeshes`)          |   ⚡   | `CreateLines`/`CreateLineSystem` support fixed-topology line lists and RGBA point colors; `CreateDashedLines` supports uniform-color dashed line lists; mesh-blending tag helpers and validated mesh metadata forward to native Lite; `MergeMeshes` bakes positions/normals/UVs and rejects unsupported attributes/animation; polygon/extruded-polygon, decal/text/tiled builders, `GreasedLine*` (thick lines), `InstancedMesh`, LOD/edges/outline, and hardware instances unsupported |
| CSG / CSG2                                                                                                                                |   ✅   | over Lite boolean ops                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Gizmos (position/rotation/scale/bounding-box/light/camera + `GizmoManager`)                                                               |   ⚡   | over Lite gizmo suite; `isEnabled` toggles per-axis interactivity (display-only when disabled)                                                                                                                                                                                                                                                                                                                                                                                                 |
| Materials (`StandardMaterial`, `PBRMaterial`, metallic-rough / spec-gloss, `NodeMaterial`)                                                |   ⚡   | `clone(name)` shares textures with its own renderable; fixed-slot custom WGSL `MaterialPluginBase` injection is supported (`#include`, regex replacement, and custom UBO/sampler hooks are not), while Gaussian-splat visualization plugins, `DitheredTileFadeMaterialPlugin`, BJS-preprocessed `ShaderMaterial`, `MultiMaterial`, `BackgroundMaterial`, and `OpenPBRMaterial` remain unsupported                                                                                                  |
| Textures (`Texture`, `RawTexture`, `RawTexture2DArray`, `RawTexture3D`, `DynamicTexture`, `HtmlTexture`, `ExternalTexture`, cube textures) |   ⚡   | `ExternalTexture` wraps Lite's native external-video texture; `HDRCubeTexture` routes to native `loadHdrEnvironment`; `RawTexture2DArray` supports raw bytes, image sources/URLs, and single-file KTX2 arrays; `RawTexture3D` supports base-level RGBA8 volumes but not mip generation; `HtmlTexture` forwards native Lite DOM capture/update; `RenderTargetTexture` / `MirrorTexture` unsupported                                                                                                      |
| Animation (keyframe `Animation`, easing, `Animatable`, `AnimationGroup` incl. weighted/additive blend)                                    |   ⚡   | All standard easing classes, including `PowerEase` / `BezierCurveEase`, reuse Lite's native functional curves; `beginAnimation` / `beginDirectAnimation` delegate supported float/vector/quaternion tracks to Lite property animation; unsupported tracks use an explicit compat evaluator; structural groups remain compat-owned; loaded glTF skeletal blending supported; root-motion analysis/controller APIs throw                                                                         |
| Morph targets (`MorphTarget` / `MorphTargetManager`)                                                                                      |   ✅   | over Lite morph targets                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Sprites (`SpriteManager` / `Sprite`)                                                                                                      |   ⚡   | camera-facing billboards; `SpriteMap` / packed atlas unsupported                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Behaviors / Actions (`AutoRotation`, `Framing`, `ActionManager`, conditions)                                                              |   ⚡   | `ActionManager` is manual-dispatch; drag / six-DoF / XR-oriented mesh behaviors throw                                                                                                                                                                                                                                                                                                                                                                                                          |
| Misc (`Observable`, `Tools`, `SmartArray`, `Tags`, gradients, `PerformanceMonitor`)                                                       |   ✅   |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Audio V2 (`AudioEngineV2`, `StaticSound`, `StreamingSound`, `AudioBus`, buses/sources/analyzer)                                           |   ⚡   | over Lite's AudioV2 port; `MainAudioBus` spatial/analyzer and a second main bus unsupported                                                                                                                                                                                                                                                                                                                                                                                                    |
| Physics (`HavokPlugin`, `scene.enablePhysics`/`getPhysicsEngine`, `PhysicsAggregate`/`PhysicsBody`/`PhysicsShape`)                        |   ⚡   | Native Havok V2 forwarding for common body/shape operations, thin-instance bodies, and filtered raycasts with instance indices; unrecognized enum values throw at the compat boundary                                                                                                                                                                                                                                                                                                          |
| Particles (`NodeParticleSystemSet` / `ParticleSystemSet` — Node Particle Editor)                                                          |   ⚡   | NPE snippet/JSON graphs: `Parse`/`ParseFromSnippetAsync` → `buildAsync` → `start`, incl. per-system `set.systems[i]` runtime (`start`/`animate`/`updateSpeed`/`particleTexture`). Imperative classic/GPU/solid `ParticleSystem` construction + programmatic block authoring unsupported                                                                                                                                                                                                        |
| Post-processes, layers (glow/highlight), probes, WebXR                                                                                    |   ❌   | Babylon.js wrapper classes are not implemented — use native Lite `create*Task` functions, including `createMeshBlendingPostProcessTask` with geometry-renderer tag/depth/albedo outputs                                                                                                                                                                                                                                                                                                        |

### `@babylonjs/loaders`

| Feature area                                                                                   | Status | Notes                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------- | :----: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| glTF 2.0 (+ extensions), `.babylon`                                                            |   ✅   | via Lite `loadGltf` / `loadBabylon`; KHR_interactivity assets run through Lite's native flow-graph runtime                                                                                                                        |
| `GLTF2.KHR_interactivity` public helpers                                                       |   ⚡   | pure operation/data normalization and exporter data types are implemented; BJS FlowGraph registry/parser/export planning throws with named structural blockers                                                                    |
| glTF 1.0 loader and extensions                                                                 |   ❌   | named `GLTF1` stubs throw; Lite has no legacy parser, extension registry, or material-conversion subsystem                                                                                                                        |
| OpenPBR glTF material adapter                                                                  |   ❌   | exported at root and under `GLTF2`; throws because Lite has no OpenPBR material subsystem                                                                                                                                         |
| OpenUSD (`USDFileLoader`)                                                                      |   ⚡   | delegates binary import, virtual files, callbacks, diagnostics, asset containers, and disposal to Lite; all four custom runtime assets must share one directory                                                                   |
| `SceneLoader` (`ImportMeshAsync` / `AppendAsync` / `LoadAssetContainerAsync`), `AssetsManager` |   ⚡   | `AssetContainer` partial                                                                                                                                                                                                          |
| Gaussian Splatting (`.ply` / `.splat` / `.sog` / `.spz`)                                       |   ⚡   | `GaussianSplattingMesh` wraps eager Lite loaders; BJS streaming and the separate stochastic WebGPU point-splatting compute path resolve to named stubs because their budget, pass-lifecycle, and rendering models do not map to Lite's sorted-splat renderer |
| `OBJ` / `STL` / `FBX` / `BVH`                                                                  |   ❌   | parser/materializer subsystems are not in Lite — convert to glTF                                                                                                                                                                  |

> **glTF hierarchy:** `result.meshes` is a flattened view of the glTF node hierarchy (transform nodes plus the
> primitive meshes beneath them), not one mesh per node as in Babylon.js. Reparent with `setParent()`, not `.parent =`,
> when you flatten it — see [glTF import hierarchy and reparenting](#gltf-import-hierarchy-and-reparenting).

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

## glTF import hierarchy and reparenting

Babylon Lite keeps the glTF node hierarchy: every glTF node becomes a transform node, and every primitive of its mesh
becomes a mesh **under** that node. For a node with a single primitive, Babylon.js instead returns one `Mesh` that
carries both the node transform and the geometry. The compat layer rebuilds Lite's hierarchy as canonical wrappers and
returns it flattened, in hierarchy order, from `SceneLoader.ImportMeshAsync(...).meshes` and `AssetContainer.meshes`:

- The list is a flattened view of a retained hierarchy, not a list of independent renderable meshes. A parent always
  comes before its children.
- It contains the synthetic `__root__` at index 0, the source glTF transform nodes, and the primitive meshes beneath
  them.
- Transform-only entries are wrapped as `Mesh` too, but carry no geometry: `getTotalVertices() === 0`. Do not treat an
  entry as geometry just because it is a `Mesh`.

### Why per-entry `.parent` breaks

`mesh.parent = node` keeps the mesh's **local** transform and lets its world transform change under the new parent.
`mesh.setParent(node)` keeps its **world** transform. Both behave as in Babylon.js, but a loop written for Babylon.js
often assigns `.parent` to every returned entry:

```ts
// Fine in Babylon.js. Under compat it detaches each primitive from the glTF node that carries its transform.
for (const mesh of result.meshes) {
    mesh.parent = applicationRoot;
}
```

Under compat every primitive mesh is then moved off the glTF node above it and keeps only its own local transform, so
any scale, rotation or translation that came from an ancestor node is lost. A typical case is a hardware asset modelled
in millimetres whose glTF node scales it by `0.001`: after the loop its primitives render 1000 times too large, so a
40 mm connector becomes 40 m, often far outside the camera range.

Baking in list order fails the same way. `bakeCurrentTransformIntoVertices()` bakes only the mesh's **local**
transform: on a primitive that still sits under its glTF node it leaves the node's scale out, and resetting a node's
transform first (it comes earlier in the list) changes what its children inherit before they are processed.

### Safe patterns

Keep the hierarchy and move the whole import:

```ts
import { Mesh, SceneLoader } from "@babylonjs/lite-compat";

const result = await SceneLoader.ImportMeshAsync("", rootUrl, "model.glb", scene);
result.meshes[0]!.setParent(applicationRoot);
```

Flatten only the renderable meshes, keeping their current world transforms. `result.meshes` is typed as
`TransformNode[]`, so narrow the entries to `Mesh` before calling mesh-only methods:

```ts
const renderableMeshes = result.meshes.filter((mesh): mesh is Mesh => mesh instanceof Mesh && mesh.getTotalVertices() > 0);
for (const mesh of renderableMeshes) {
    mesh.setParent(applicationRoot);
}
```

Baking the composed transform into the geometry works only for a narrow set of imported meshes. For those, call
`setParent()` first, so the full hierarchy-composed world transform becomes the mesh's new local transform, then bake:

```ts
// bakeableMeshes: the entries of renderableMeshes that meet every condition listed below.
for (const mesh of bakeableMeshes) {
    mesh.setParent(applicationRoot);
    mesh.bakeCurrentTransformIntoVertices();
}
```

Bake a mesh only if all of the following hold. Otherwise flatten it with `setParent()` alone, or keep the hierarchy and
move the whole import:

- **Shear-free composed transform.** `setParent()` keeps the exact affine local matrix, but
  `bakeCurrentTransformIntoVertices()` rebuilds the transform from position, rotation and scaling, and that cannot
  express shear. Shear appears when an ancestor has a non-uniform scale and a descendant below it is rotated: for
  example, a node scaled `(2, 1, 1)` above a primitive rotated 45 degrees around Z. Baking such a primitive drops the
  shear and changes the geometry.
- **Tightly packed vertex data.** Baking replaces the vertex buffers through `resizeMeshGeometry()`, which throws for
  interleaved geometry. A glTF primitive whose attributes come from a bufferView with `byteStride` loads as interleaved
  geometry.
- **Undeformed geometry.** The baker transforms the base positions, normals and tangents only. It does not transform
  morph target deltas, so after baking a delta contributes in the baked space: under an inherited uniform scale of
  `0.001`, a delta of 1 contributes `0.001` before baking and `1` after. Skinned meshes are not covered either, and
  flattening already detaches a primitive from any animated glTF node above it. Keep the hierarchy for assets whose
  morph targets, skinning or node animation must keep working.
- **Only positions, normals and the first UV set.** Baking can only re-upload the vertex attributes whose CPU arrays are
  retained. The glTF loader uploads `COLOR_0` and `TEXCOORD_1` without keeping CPU copies, so baking drops vertex colors
  and the second UV set, and it retains tangents only after `enableGltfCpuTangents()` from `@babylonjs/lite` is called before loading.

`setParent()` also preserves mirrored transforms, including the synthetic handedness root of glTF imports (#456).

## Missing an API you need?

The compat surface grows in response to real-world migration needs. If you hit a
Babylon.js API that isn't wrapped yet (or one that throws `LiteCompatError`),
[open an issue in the Babylon Lite repo](https://github.com/BabylonJS/Babylon-Lite/issues/new?template=compat-api-request.yml)
and add the **`compat`** label. Describe the API and your use case — issues with
the `compat` label feed directly into the layer's maintenance workflow.
