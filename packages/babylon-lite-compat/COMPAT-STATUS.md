# Babylon Lite Compat — Feature Status

This file tracks the support status of each Babylon.js (BJS) feature area in the
`@babylonjs/lite-compat` package. It is the single source of truth consulted and
updated by the `update-compat-layer` skill.

<!-- The two markers below are machine-read by the update-compat-layer skill.
     Do not rename them. Update the SHA after re-syncing against BJS master. -->

- **Last synced BJS commit:** `c729b94f2e36f2d915415620857452f7ad0ff731`
- **Last sync date:** 2026-06-25
- **Lite compat package version:** 0.0.1

> The "Last synced BJS commit" is the `BabylonJS/Babylon.js` `master` HEAD that the
> compat surface was last reconciled against. The skill diffs BJS history since
> this SHA (and Lite history since the last commit that touched this file) to find
> new work, then updates the SHA.

**Scope:** the compat layer (and the `update-compat-layer` skill that maintains it)
covers **only the public API of `@babylonjs/core` and `@babylonjs/loaders`**. The
completeness invariant is: _every public symbol exported by those two packages has a
row here_ (`✅`/`⚡`/`🔧`/`❌`). A handful of out-of-core rows (GUI, audio, XR) are kept
for reader context but are not part of the audited surface.

---

## What this file tracks (the three compat tasks)

The `update-compat-layer` skill advances the compat layer on three fronts; this
file is the live status record for each:

1. **Upstream sync (Task 1 — diffs).** The `Last synced BJS commit` / `Last sync
date` markers above record the `BabylonJS/Babylon.js` `master` HEAD the surface
   was last reconciled against.
2. **Lab-scene coverage (Task 2).** The [Lab scene coverage](#lab-scene-coverage)
   section records which Babylon.js oracle scenes render at parity through the
   compat layer, and the blocker for the rest.
3. **API parity (Task 3).** The per-area status matrix (every section from
   **Math** onward) carries a `✅`/`⚡`/`🔧`/`❌` row for every `@babylonjs/core` +
   `@babylonjs/loaders` public symbol — the completeness invariant above.

---

## Status legend

| Status             | Meaning                                                                          |
| ------------------ | -------------------------------------------------------------------------------- |
| ✅ Full            | Common surface implemented and tested where possible                             |
| ⚡ Partial         | A practical subset is implemented; some properties/overloads throw or are absent |
| 🔧 Needs Lite core | Implementable only with a small additive Babylon Lite core change                |
| ❌ Not supported   | Not implementable on the current Lite API                                        |
| ⛔ Out of scope    | Intentionally excluded (legacy / inspector / global namespace)                   |

> **Known but unsupported APIs throw `LiteCompatError`.** Where Babylon.js exposes a
> named symbol that Babylon Lite cannot back (`❌`) or that is intentionally excluded
> (`⛔`), the compat layer ships a stub that throws on use via the `unsupported()`
> helper — so a port fails loudly with a pointer instead of a missing-export error or
> a silently-wrong render. Stubs live in
> [src/unsupported/unsupported-apis.ts](src/unsupported/unsupported-apis.ts) (standalone
> classes/namespaces) or as throwing methods on the relevant wrapper (e.g. `Scene.pick`,
> `Engine.beginFrame`, `Mesh.clone`, `MeshBuilder.CreateLines`, `SceneLoader.RegisterPlugin`).

---

## Math

| BJS API                                            | Status     | Module                                                                                                                                                          |
| -------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Vector2` / `Vector3` / `Vector4`                  | ✅ Full    | [math/vector.ts](src/math/vector.ts)                                                                                                                            |
| `Color3` / `Color4`                                | ✅ Full    | [math/color.ts](src/math/color.ts)                                                                                                                              |
| `Quaternion`                                       | ✅ Full    | [math/quaternion.ts](src/math/quaternion.ts) (incl. `FromRotationMatrix` / `FromRotationMatrixToRef` / `fromRotationMatrix` over Lite `quatFromRotationMatrix`) |
| `Matrix`                                           | ✅ Full    | [math/matrix.ts](src/math/matrix.ts) (incl. `decompose` — BJS-accurate scale/negative-determinant handling, rotation via Lite `quatFromRotationMatrix`)         |
| `Vector3.TransformCoordinates` / `TransformNormal` | ✅ Full    | [math/vector.ts](src/math/vector.ts)                                                                                                                            |
| `Vector3.Center` / `CenterToRef`                   | ✅ Full    | [math/vector.ts](src/math/vector.ts)                                                                                                                            |
| `Matrix.copyToArray`                               | ✅ Full    | [math/matrix.ts](src/math/matrix.ts)                                                                                                                            |
| `Scalar`                                           | ✅ Full    | [math/scalar.ts](src/math/scalar.ts)                                                                                                                            |
| `Axis` / `Space` / `Epsilon`                       | ✅ Full    | [math/constants.ts](src/math/constants.ts)                                                                                                                      |
| `Plane` / `Ray` / `Frustum`                        | ✅ Full    | [math/plane.ts](src/math/plane.ts), [ray.ts](src/math/ray.ts), [frustum.ts](src/math/frustum.ts)                                                                |
| `Size` / `Viewport`                                | ✅ Full    | [math/size.ts](src/math/size.ts)                                                                                                                                |
| `Angle` / `Curve3` / `Path3D`                      | ⚡ Partial | [math/curve.ts](src/math/curve.ts)                                                                                                                              |
| `Curve3` / `Path3D` / easing curves on math        | ⚡ Partial | curve + easing                                                                                                                                                  |

## Core

| BJS API                                                                                                                                                                               | Status           | Module                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AbstractEngine` / `ThinEngine` / `Engine` / `WebGPUEngine`                                                                                                                           | ⚡ Partial       | [engine/engine.ts](src/engine/engine.ts) (full BJS hierarchy: `Engine`→`ThinEngine`→`AbstractEngine`, `WebGPUEngine`→`AbstractEngine`)                                        |
| `engine.useLargeWorldRendering` → floating origin / `useReverseDepthBuffer`                                                                                                           | ⚡ Partial       | engine (BJS `useLargeWorldRendering` maps to Lite `useHighPrecisionMatrix` + `useFloatingOrigin`)                                                                             |
| `engine.runRenderLoop` / `stopRenderLoop`                                                                                                                                             | ⚡ Partial       | engine (async startup; N callbacks)                                                                                                                                           |
| `engine.resize` / `setSize` / `dispose` / `getRenderingCanvas`                                                                                                                        | ✅ Full          | engine                                                                                                                                                                        |
| `engine.getCaps()` (compressed-format flags `astc` / `s3tc` / `etc2`)                                                                                                                 | ✅ Full          | engine (derived from the Lite WebGPU device's enabled features)                                                                                                               |
| `engine.beginFrame` / `endFrame`                                                                                                                                                      | ❌ Not supported | —                                                                                                                                                                             |
| `NullEngine`                                                                                                                                                                          | ✅ Full          | [engine/engine.ts](src/engine/engine.ts) (real deviceless engine: no GPU, drives a pure-JS tick loop for CPU animations + render observables; `Scene` skips its Lite context) |
| `AbstractScene` / `Scene`                                                                                                                                                             | ⚡ Partial       | [scene/scene.ts](src/scene/scene.ts) over [scene/abstract-scene.ts](src/scene/abstract-scene.ts) (entity collections on `AbstractScene`, as in BJS)                           |
| `scene.clearColor` / `activeCamera` / `imageProcessingConfiguration`                                                                                                                  | ✅ Full          | scene                                                                                                                                                                         |
| `scene.fogMode/fogStart/fogEnd/fogDensity/fogColor` + `FOGMODE_*`                                                                                                                     | ✅ Full          | scene (over Lite `setFog`)                                                                                                                                                    |
| `scene.environmentTexture` / `createDefaultEnvironment`                                                                                                                               | ⚡ Partial       | scene (over Lite `loadEnvironment`; `createDefaultEnvironment` applies BJS EnvironmentHelper image processing, plain `environmentTexture` does not)                           |
| `scene.createDefaultCameraOrLight`                                                                                                                                                    | ✅ Full          | scene                                                                                                                                                                         |
| `scene.performancePriority`                                                                                                                                                           | ⚡ Partial       | accepted for parity (Lite self-tunes)                                                                                                                                         |
| `scene.onBeforeRenderObservable` / `onDisposeObservable`                                                                                                                              | ✅ Full          | scene + [misc/observable.ts](src/misc/observable.ts)                                                                                                                          |
| `scene.onAfterRenderObservable`                                                                                                                                                       | ⚡ Partial       | fires one frame late (Lite has no after-render hook)                                                                                                                          |
| `scene.whenReadyAsync` / `isReady`                                                                                                                                                    | ✅ Full          | resolve-immediately (Lite builds synchronously)                                                                                                                               |
| `scene.createDefaultCamera`                                                                                                                                                           | ✅ Full          | scene                                                                                                                                                                         |
| `scene.animationGroups` / `scene.animatables`                                                                                                                                         | ⚡ Partial       | scene (returns `AnimationGroup[]` over Lite loaded groups — `goToFrame`/`play`/`pause`/`stop` to seek/freeze)                                                                 |
| `ScenePerformancePriority` / `ImageProcessingConfiguration` / `Constants`                                                                                                             | ✅ Full          | [misc/engine-constants.ts](src/misc/engine-constants.ts) (numeric values)                                                                                                     |
| `scene.render()` (manual single frame)                                                                                                                                                | ❌ Not supported | no-op under Lite loop                                                                                                                                                         |
| `scene.getMeshByName` / `getMeshById` / `getMeshByID` / `getCameraBy{Name,Id}` / `getLightBy{Name,Id}` / `getMaterialBy{Name,Id}` / `getNodeBy{Name,Id}` / `scene.meshes` enumeration | ⚡ Partial       | scene query over the compat-tracked entity lists (loader-surfaced + wrapper-created); full scene-mesh enumeration still needs Lite core                                       |
| `scene.pick` (sync)                                                                                                                                                                   | ❌ Not supported | sync CPU picking; use `GPUPicker` (async) instead                                                                                                                             |
| `GPUPicker` (async GPU picking)                                                                                                                                                       | ⚡ Partial       | [picking/gpu-picker.ts](src/picking/gpu-picker.ts)                                                                                                                            |
| `Observable`                                                                                                                                                                          | ✅ Full          | [misc/observable.ts](src/misc/observable.ts)                                                                                                                                  |
| `Tools` (subset)                                                                                                                                                                      | ✅ Full          | [misc/tools.ts](src/misc/tools.ts)                                                                                                                                            |

## Culling & Collisions

| BJS API                                           | Status     | Module                                         |
| ------------------------------------------------- | ---------- | ---------------------------------------------- |
| `BoundingBox` / `BoundingSphere` / `BoundingInfo` | ✅ Full    | [culling/bounding.ts](src/culling/bounding.ts) |
| `PickingInfo` / `IntersectionInfo`                | ⚡ Partial | surfaced via `GPUPicker`                       |

## Cameras

| BJS API                                           | Status           | Module                                                                                                 |
| ------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------ |
| `Camera` (base, extends `Node`)                   | ✅ Full          | [cameras/cameras.ts](src/cameras/cameras.ts)                                                           |
| `camera.getViewMatrix` / `getProjectionMatrix`    | ✅ Full          | cameras (over Lite matrix accessors)                                                                   |
| `ArcRotateCamera`                                 | ✅ Full          | cameras                                                                                                |
| `TargetCamera` / `FreeCamera` / `UniversalCamera` | ✅ Full          | cameras (incl. `_adopt` for loaded `.babylon` cameras)                                                 |
| `TouchCamera` / `GamepadCamera` / `FlyCamera`     | ✅ Full          | cameras (free-camera variants)                                                                         |
| `camera.attachControl` / `detachControl`          | ✅ Full          | cameras                                                                                                |
| `FollowCamera`                                    | ⚡ Partial       | cameras (per-frame target tracking)                                                                    |
| `GeospatialCamera`                                | ✅ Full          | cameras (over Lite `createGeospatialCamera` / `setGeospatialOrientation` / `attachGeospatialControls`) |
| `DeviceOrientationCamera` / `WebXRCamera`         | ❌ Not supported | throwing stub; no XR/orientation in Lite                                                               |
| `AnaglyphArcRotateCamera` / stereoscopic rigs     | ❌ Not supported | throwing stub                                                                                          |

## Lights

| BJS API                                               | Status             | Module                                   |
| ----------------------------------------------------- | ------------------ | ---------------------------------------- |
| `HemisphericLight`                                    | ✅ Full            | [lights/lights.ts](src/lights/lights.ts) |
| `DirectionalLight`                                    | ✅ Full            | lights                                   |
| `PointLight`                                          | ✅ Full            | lights                                   |
| `SpotLight`                                           | ✅ Full            | lights                                   |
| `light.diffuse/specular/intensity/position/direction` | ✅ Full            | lights                                   |
| `light.setEnabled(false)`                             | 🔧 Needs Lite core | per-light visibility toggle              |
| `RectAreaLight`                                       | ❌ Not supported   | not in Lite                              |
| `ClusteredLightContainer`                             | ❌ Not supported   | throwing stub; not in Lite's public API  |

## Shadows

| BJS API                                           | Status     | Module                                                         |
| ------------------------------------------------- | ---------- | -------------------------------------------------------------- |
| `ShadowGenerator` (directional ESM/PCF, spot PCF) | ⚡ Partial | [shadows/shadow-generator.ts](src/shadows/shadow-generator.ts) |
| `addShadowCaster` / `getShadowMap().renderList`   | ✅ Full    | shadows (over Lite shadow factories)                           |
| `mesh.receiveShadows`                             | ✅ Full    | meshes                                                         |
| `CascadedShadowGenerator`                         | ⚡ Partial | shadows (falls back to single-cascade directional)             |

## Meshes & Geometry

| BJS API                                                                                                         | Status             | Module                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Node` (base) + `getScene`/`getClassName`/`parent`/`metadata` + `getDescendants`/`getChildren`/`getChildMeshes` | ⚡ Partial         | [node/node.ts](src/node/node.ts) (scene-graph traversal over a child registry maintained by the `parent` setter / `setParent`)                                                                                                             |
| Class chain `Mesh → AbstractMesh → TransformNode → Node`                                                        | ✅ Full            | node + meshes (real inheritance)                                                                                                                                                                                                           |
| `MeshBuilder.CreateBox/Sphere/Ground/Plane/Cylinder`                                                            | ⚡ Partial         | [meshes/meshes.ts](src/meshes/meshes.ts)                                                                                                                                                                                                   |
| `MeshBuilder.CreateTorus/TorusKnot/Disc/Polyhedron`                                                             | ⚡ Partial         | meshes (Lite-backed)                                                                                                                                                                                                                       |
| `Mesh.CreateSphere/Box/Ground/Plane/Cylinder/Torus` (legacy statics)                                            | ✅ Full            | meshes (delegate to `MeshBuilder`)                                                                                                                                                                                                         |
| `MeshBuilder.CreateRibbon/Tube/ExtrudeShape`                                                                    | ⚡ Partial         | meshes (Lite-backed)                                                                                                                                                                                                                       |
| `MeshBuilder.CreateLines` / `CreateDecal` / `CreateText`                                                        | ❌ Not supported   | throwing stub; not in Lite                                                                                                                                                                                                                 |
| `Mesh` / `AbstractMesh` (transform, material, visibility)                                                       | ⚡ Partial         | meshes                                                                                                                                                                                                                                     |
| `GroundMesh`                                                                                                    | ⚡ Partial         | meshes (no CPU height query)                                                                                                                                                                                                               |
| `GaussianSplattingMesh` (`loadFileAsync` / `splatsData` / `updateData` / `bakeCurrentTransformIntoVertices`)    | ⚡ Partial         | [meshes/gaussian-splatting.ts](src/meshes/gaussian-splatting.ts) — over Lite `loadSplat`/`loadSOG`/`loadSPZ`; loader routes `.ply`/`.splat`/`.sog`/`.spz` URLs; live transforms + `updateData(flipY)`; pickable via the compat `GPUPicker` |
| `GaussianSplattingStream` / `GaussianSplattingWorkBuffer` (`setSplatIndexRanges` / `renderedSplatCount`)        | ❌ Not supported   | new in BJS `efdee76` (GS LOD streaming PR #18563); SOG-octree LOD streaming + GPU work-buffer decode + per-splat interval rendering are not in Lite's GS path                                                                              |
| `InstancedMesh`                                                                                                 | ❌ Not supported   | throwing stub; use thin instances                                                                                                                                                                                                          |
| `VertexData`                                                                                                    | ⚡ Partial         | meshes (CPU data container)                                                                                                                                                                                                                |
| `mesh.position/rotation/scaling` (live mutation)                                                                | ✅ Full            | meshes (write-through `Vector3` proxy → in-place methods like `scaleInPlace`/`addInPlace` mutate the Lite node)                                                                                                                            |
| `mesh.dispose` / `setEnabled` / `isEnabled` / `isDisposed`                                                      | ✅ Full            | meshes + node                                                                                                                                                                                                                              |
| `mesh.thinInstanceSetBuffer`                                                                                    | ⚡ Partial         | meshes (`matrix` + `color` → Lite thin instances)                                                                                                                                                                                          |
| `mesh.clone` / `createInstance`                                                                                 | ⚡ Partial         | throwing stub                                                                                                                                                                                                                              |
| `TransformNode`                                                                                                 | ✅ Full            | meshes                                                                                                                                                                                                                                     |
| `mesh.getBoundingInfo`                                                                                          | 🔧 Needs Lite core | bounds accessor                                                                                                                                                                                                                            |
| LOD / `EdgesRenderer` / `OutlineRenderer`                                                                       | ❌ Not supported   | throwing stub; not in Lite                                                                                                                                                                                                                 |
| `CSG` / `CSG2` (+ `InitializeCSG2Async`)                                                                        | ✅ Full            | [meshes/csg.ts](src/meshes/csg.ts) over Lite `createCsgFromMesh`/`createMeshFromCsg` and `createCsg2FromMesh`/`createMeshesFromCsg2` (CSG2 preserves per-source materials)                                                                 |

## Gizmos

| BJS API                                                               | Status     | Module                                   |
| --------------------------------------------------------------------- | ---------- | ---------------------------------------- |
| `UtilityLayerRenderer`                                                | ✅ Full    | [gizmos/gizmos.ts](src/gizmos/gizmos.ts) |
| `PositionGizmo` / `RotationGizmo` / `ScaleGizmo` / `BoundingBoxGizmo` | ⚡ Partial | gizmos (over Lite gizmo suite)           |
| `LightGizmo` / `CameraGizmo`                                          | ⚡ Partial | gizmos                                   |
| `GizmoManager`                                                        | ⚡ Partial | gizmos                                   |

## Behaviors

| BJS API                                      | Status             | Module                                               |
| -------------------------------------------- | ------------------ | ---------------------------------------------------- |
| `Behavior<T>` interface                      | ✅ Full            | [behaviors/behaviors.ts](src/behaviors/behaviors.ts) |
| `AutoRotationBehavior`                       | ✅ Full            | behaviors                                            |
| `BouncingBehavior` / `FramingBehavior`       | ⚡ Partial         | behaviors (no tweened animation)                     |
| `PointerDragBehavior` / `SixDofDragBehavior` | 🔧 Needs Lite core | use native `createPointerDrag`                       |

## Actions

| BJS API                                                          | Status     | Module                                       |
| ---------------------------------------------------------------- | ---------- | -------------------------------------------- |
| `ActionManager` (manual `processTrigger`; auto-dispatch pending) | ⚡ Partial | [actions/actions.ts](src/actions/actions.ts) |
| `ExecuteCodeAction` / `SetValueAction` / `IncrementValueAction`  | ✅ Full    | actions                                      |
| `ValueCondition` / `PredicateCondition`                          | ✅ Full    | actions                                      |

## Misc utilities

| BJS API                                    | Status  | Module                                       |
| ------------------------------------------ | ------- | -------------------------------------------- |
| `Observable`                               | ✅ Full | [misc/observable.ts](src/misc/observable.ts) |
| `Tools` (subset)                           | ✅ Full | [misc/tools.ts](src/misc/tools.ts)           |
| `SmartArray` / `StringDictionary` / `Tags` | ✅ Full | [misc/misc-utils.ts](src/misc/misc-utils.ts) |
| `PerformanceMonitor`                       | ✅ Full | misc-utils                                   |
| `ColorGradient` / `FactorGradient`         | ✅ Full | misc-utils                                   |

## Materials

| BJS API                                                                                                                                                                                        | Status           | Module                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `StandardMaterial` (common subset: diffuse/specular/emissive/ambient colors, `diffuseTexture` / `emissiveTexture` / `bumpTexture`, alpha, `alphaCutOff`, `backFaceCulling`, `disableLighting`) | ⚡ Partial       | [materials/materials.ts](src/materials/materials.ts)                                                                                                                                           |
| `PBRMaterial` (common subset)                                                                                                                                                                  | ⚡ Partial       | materials                                                                                                                                                                                      |
| `Material` / `PushMaterial` (base chain)                                                                                                                                                       | ⚡ Partial       | materials                                                                                                                                                                                      |
| `PBRMetallicRoughnessMaterial`                                                                                                                                                                 | ⚡ Partial       | materials (çade over PBR)                                                                                                                                                                      |
| `PBRSpecularGlossinessMaterial`                                                                                                                                                                | ⚡ Partial       | materials (mapped to metallic-roughness)                                                                                                                                                       |
| factor-only PBR (colours, no maps)                                                                                                                                                             | ✅ Full          | materials (synthesizes 1×1 solid base/ORM textures)                                                                                                                                            |
| `material.environmentTexture` / `reflectionTexture` (PBR)                                                                                                                                      | ⚡ Partial       | materials (routed to `scene.environmentTexture`)                                                                                                                                               |
| `material` runtime mutation → UBO dirty                                                                                                                                                        | ✅ Full          | materials                                                                                                                                                                                      |
| `MultiMaterial`                                                                                                                                                                                | ❌ Not supported | throwing stub; one material per renderable                                                                                                                                                     |
| `ShaderMaterial` (GLSL)                                                                                                                                                                        | ❌ Not supported | throwing stub; Lite is WGSL-only                                                                                                                                                               |
| `ShaderLanguage` (enum)                                                                                                                                                                        | ✅ Full          | [misc/engine-constants.ts](src/misc/engine-constants.ts) (BJS numeric values; `GLSL` still throws at `ShaderMaterial` construction)                                                            |
| `NodeMaterial` (`Parse` + `getBlockByName().texture`)                                                                                                                                          | ⚡ Partial       | [materials/node-material.ts](src/materials/node-material.ts) (async NME parse, deferred to engine start after shadow build so NME shadow-receiver blocks sample the scene's shadow generators) |
| `BackgroundMaterial`                                                                                                                                                                           | ❌ Not supported | throwing stub; use native `loadEnvironment`                                                                                                                                                    |

## Textures

| BJS API                                                                    | Status           | Module                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Texture` (2D, URL)                                                        | ✅ Full          | [textures/textures.ts](src/textures/textures.ts) (async load awaited at build; honours `invertY` / `noMipmap` / `samplingMode` on the material path; `.basis` URLs route through Lite `loadBasisTexture2D`, compressed `.ktx` URLs through `loadKtxTexture2D`) |
| `RawTexture`                                                               | ✅ Full          | textures (Lite pixel texture)                                                                                                                                                                                                                                  |
| `DynamicTexture` (canvas-backed)                                           | ✅ Full          | textures                                                                                                                                                                                                                                                       |
| `CubeTexture` (`CreateFromPrefilteredData`, `isReady`, `onLoadObservable`) | ⚡ Partial       | textures (URL handle → Lite `loadEnvironment` at engine start)                                                                                                                                                                                                 |
| `HDRCubeTexture`                                                           | ❌ Not supported | throwing stub; use native `loadHdrEnvironment`                                                                                                                                                                                                                 |
| `RenderTargetTexture`                                                      | ❌ Not supported | throwing stub; use native frame-graph RTT                                                                                                                                                                                                                      |
| `MirrorTexture`                                                            | ❌ Not supported | throwing stub                                                                                                                                                                                                                                                  |

## Loaders

| BJS API                                                                       | Status           | Module                                                                                                                                                   |
| ----------------------------------------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SceneLoader.ImportMeshAsync` / `AppendAsync` / `LoadAssetContainerAsync`     | ⚡ Partial       | [loading/scene-loader.ts](src/loading/scene-loader.ts)                                                                                                   |
| glTF 2.0 + extensions                                                         | ✅ Full          | via Lite `loadGltf`                                                                                                                                      |
| `MeshoptCompression` (`EXT_meshopt_compression`)                              | ✅ Full          | [meshes/compression.ts](src/meshes/compression.ts) (no-op `Configuration` shim; Lite decodes meshopt in its glTF loader)                                 |
| `KHR_materials_variants` (`SelectVariant` / `GetAvailableVariants` / `Reset`) | ✅ Full          | [loading/material-variants.ts](src/loading/material-variants.ts) (over Lite `selectVariant` / `getVariantNames` / `resetVariant`; root mesh → container) |
| `.babylon`                                                                    | ✅ Full          | via Lite `loadBabylon`                                                                                                                                   |
| `AssetContainer`                                                              | ⚡ Partial       | loading (`.meshes` returns `LoadedMesh[]` with `getBoundingInfo`)                                                                                        |
| `AssetsManager`                                                               | ✅ Full          | [loading/assets-manager.ts](src/loading/assets-manager.ts)                                                                                               |
| `OBJ` / `STL` / `FBX` / `BVH` loaders                                         | ❌ Not supported | throwing stub; not in Lite (convert to glTF)                                                                                                             |

## Animation

| BJS API                                                     | Status     | Module                                                                                                                                                                                  |
| ----------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Easing functions (`SineEase`, `CubicEase`, `BounceEase`, …) | ✅ Full    | [animations/easing.ts](src/animations/easing.ts)                                                                                                                                        |
| `Animation` (keyframe model + CPU `evaluate`)               | ✅ Full    | [animations/animation.ts](src/animations/animation.ts) (linear + `AnimationKeyInterpolation.STEP` keys)                                                                                 |
| `Animatable` / `scene.beginDirectAnimation`                 | ⚡ Partial | animation (CPU per-frame evaluation; no weight blending)                                                                                                                                |
| `AnimationGroup` (single BJS type; structural + loaded)     | ⚡ Partial | animation (loaded groups seek/freeze + weighted/additive blend via a scene-owned Lite `AnimationManager`; structural groups step + weight-blend on the CPU)                             |
| Animation weights / cross-fade / additive                   | ✅ Full    | structural CPU weighted + cross-fade blending (manual `AnimationGroup`s) and loaded glTF skeletal weighted + additive (`MakeAnimationAdditive`) blending over Lite's `AnimationManager` |

## Bones / Skeletons / Morph

| BJS API                              | Status           | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Skeleton` / `Bone`                  | ❌ Not supported | throwing stub; produced by glTF loader, not constructed. Re-checked 2026-06-24: Lite's new opt-in bone-control API (`enableBoneControl` / `getBoneByName` / `setBone*` / `Skeleton` / `Bone`, #268) can read & pose a **loader-built** skeleton, but BJS `new Skeleton()/new Bone()` manual construction and sync skinned `scene.pick` (`applySkeleton`) are still absent, so scene 114 stays blocked and no compat wrapper is shippable yet |
| `MorphTarget` / `MorphTargetManager` | ✅ Full          | morph ([morph/morph.ts](src/morph/morph.ts)) over Lite `createMorphTargets` / `setMorphTargetWeights` (absolute target positions → deltas, built at engine start)                                                                                                                                                                                                                                                                            |

## Sprites

| BJS API                             | Status           | Notes                                                                                                                         |
| ----------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `SpriteManager` / `Sprite`          | ⚡ Partial       | [sprites/sprites.ts](src/sprites/sprites.ts) — world-space camera-facing billboards over Lite's `createFacingBillboardSystem` |
| `SpriteMap` / `SpritePackedManager` | ❌ Not supported | throwing stub; tile-map / packed-atlas variants not wrapped                                                                   |

## Particles

| BJS API                                                        | Status           | Notes                      |
| -------------------------------------------------------------- | ---------------- | -------------------------- |
| `ParticleSystem` / `GPUParticleSystem` / `SolidParticleSystem` | ❌ Not supported | throwing stub; not in Lite |
| `ParticleHelper` / `ParticleSystemSet` / `PointsCloudSystem`   | ❌ Not supported | throwing stub              |

## Post-processes

| BJS API                                                            | Status           | Notes                                                |
| ------------------------------------------------------------------ | ---------------- | ---------------------------------------------------- |
| `PostProcess` (base) + `DefaultRenderingPipeline`                  | ❌ Not supported | throwing stub; use native frame-graph tasks          |
| `Bloom` / `Blur` / `BlackAndWhite` / `ChromaticAberration` / `DoF` | ❌ Not supported | throwing stub; effects exist as native `create*Task` |
| `FxaaPostProcess` / `SSAO2RenderingPipeline`                       | ❌ Not supported | throwing stub; not in Lite                           |

## Probes / Layers / Rendering

| BJS API                                                            | Status           | Notes                                          |
| ------------------------------------------------------------------ | ---------------- | ---------------------------------------------- |
| `ReflectionProbe`                                                  | ❌ Not supported | throwing stub                                  |
| `Layer` / `EffectLayer` / `HighlightLayer` / `GlowLayer`           | ❌ Not supported | throwing stub; not in Lite                     |
| `DepthRenderer` / `GeometryBufferRenderer` / `BoundingBoxRenderer` | ❌ Not supported | throwing stub; use native geometry/depth tasks |

## Physics

| BJS API                                                             | Status           | Notes                                        |
| ------------------------------------------------------------------- | ---------------- | -------------------------------------------- |
| `HavokPlugin` / `PhysicsAggregate` / `PhysicsBody` / `PhysicsShape` | ❌ Not supported | throwing stub; use native Havok-V2 functions |
| `CannonJSPlugin` / `AmmoJSPlugin`                                   | ❌ Not supported | throwing stub; Lite is Havok-V2 only         |

## Navigation

| BJS API          | Status  | Notes                                                                                                                                                                                                                                                                                                                                      |
| ---------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `RecastJSPlugin` | ✅ Full | compat `@babylonjs/addons/navigation` wrapper ([navigation/navigation.ts](src/navigation/navigation.ts)) over Babylon Lite's native Recast-V2 API (navmesh + debug mesh + crowd + path + raycast + off-mesh connections + tile-cache obstacles via `addBoxObstacle`/`addCylinderObstacle`/`removeObstacle` + `WaitForFullTileCacheUpdate`) |

## Audio (AudioV2)

Babylon Lite ships a full AudioV2 port (offline-capable Web Audio graph). The compat
layer mirrors the Babylon.js `AudioV2` public surface 1:1 (exact class names,
inheritance chain, factory functions, enums) on top of it — see
[audio/audio.ts](src/audio/audio.ts) and [audio/audio-enums.ts](src/audio/audio-enums.ts).
Added for issue #296.

| BJS API                                                                               | Status           | Notes                                                                                                                                                                  |
| ------------------------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CreateAudioEngineAsync` / `AudioEngineV2`                                            | ✅ Full          | over Lite `createAudioEngineAsync`; volume, state, `unlockAsync`, `pause`/`resume`/`dispose`, `listener`, `defaultMainBus`                                             |
| `LastCreatedAudioEngine` / `OnAudioEngineV2CreatedObservable`                         | ✅ Full          | module-level tracking, matches BJS                                                                                                                                     |
| `CreateSoundAsync` / `StaticSound`                                                    | ✅ Full          | over Lite `createSoundAsync`; play/pause/resume/stop, `loop`/`startOffset`/`maxInstances`/`duration`/`loopStart`/`loopEnd`/`pitch`/`playbackRate`, `onEndedObservable` |
| `CreateSoundBufferAsync` / `StaticSoundBuffer`                                        | ✅ Full          | over Lite `createSoundBufferAsync`                                                                                                                                     |
| `CreateStreamingSoundAsync` / `StreamingSound`                                        | ✅ Full          | over Lite streaming-sound fns; preload counts, transport                                                                                                               |
| `CreateAudioBusAsync` / `AudioBus`                                                    | ✅ Full          | over Lite `createAudioBusAsync`; volume, spatial/stereo/analyzer, `outBus`                                                                                             |
| `MainAudioBus`                                                                        | ⚡ Partial       | `engine.defaultMainBus`; Lite main bus is not a spatial-graph host, so `spatial`/`stereo`/`analyzer` throw a discoverable error                                        |
| `CreateMainAudioBusAsync`                                                             | ⚡ Partial       | Lite exposes only the default main bus; resolves to `engine.defaultMainBus` rather than constructing a second one                                                      |
| `CreateSoundSourceAsync` / `CreateMicrophoneSoundSourceAsync` / `SoundSource`         | ✅ Full          | over Lite `createSoundSourceAsync` / `createMicrophoneSoundSourceAsync`                                                                                                |
| `AbstractSound` / `AbstractSoundSource` / `AbstractAudioBus` / `AbstractAudioOutNode` | ✅ Full          | abstract base classes in the hierarchy                                                                                                                                 |
| `AbstractAudioNode` / `AbstractNamedAudioNode`                                        | ✅ Full          | `onNameChangedObservable`, engine `onNodeAddedObservable`/`onNodeRemovedObservable`                                                                                    |
| `AbstractSpatialAudio` / `AbstractSpatialAudioListener`                               | ⚡ Partial       | over Lite spatial feature fns; node attachment tracked by world position, not a live transform binding                                                                 |
| `AbstractStereoAudio`                                                                 | ✅ Full          | over Lite stereo feature fns                                                                                                                                           |
| `AbstractAudioAnalyzer`                                                               | ✅ Full          | over Lite analyzer feature fns; `getByteFrequencyData`/`getFloatFrequencyData`                                                                                         |
| `SoundState` / `AudioParameterRampShape` / `SpatialAudioAttachmentType`               | ✅ Full          | enums mirror BJS string/number values exactly                                                                                                                          |
| `Sound` / `AudioEngine` / `WeightedSound` (legacy v1)                                 | ❌ Not supported | throwing stub; superseded by the AudioV2 surface above                                                                                                                 |

## Not yet wrapped (Lite supports — wrappers planned)

Geospatial camera, `VertexData.applyToMesh` (build a mesh from CPU vertex data),
weighted / additive `AnimationGroup` blending, and an auto-dispatching
`ActionManager` (needs a unified Lite pointer pipe). These exist in Lite and are
candidate rows for the next audit passes — until wrapped they either carry a
`🔧`/`⚡` row or none, which the skill's completeness gate flags.

## Out of scope

| BJS API                                        | Status                                     |
| ---------------------------------------------- | ------------------------------------------ |
| `BABYLON.*` global namespace                   | ⛔ Out of scope (no `globalThis` mutation) |
| `SceneLoader.RegisterPlugin` / `RegisterClass` | ⛔ Out of scope (side-effectful)           |
| `Inspector` / `NodeMaterialEditor`             | ⛔ Out of scope                            |
| `ParticleSystem` / `GPUParticleSystem`         | ❌ Not supported (not in Lite)             |
| `@babylonjs/gui`                               | ❌ Not supported (not in Lite)             |
| `Sound` / `AudioEngine` (legacy v1)            | ❌ Not supported (use AudioV2 — see Audio) |
| WebXR                                          | ❌ Not supported (no XR in Lite)           |
| `HighlightLayer` / `GlowLayer` / `Decal`       | ❌ Not supported (not in Lite)             |
| `SceneSerializer`                              | ❌ Not supported                           |

---

## Lab scene coverage

The repo's lab renders the Babylon.js oracle scenes (`lab/lite/src/bjs/sceneN.ts`)
through the compat layer at `/compat/sceneN.html` (see the **Compat** tab). This
section records which of those scenes currently render at pixel parity with the
native Babylon Lite port, and the blocker for the ones that don't. It is a
behavioural cross-check of the API surface above, not a separate contract.

> Snapshot date: 2026-06-18. Method: in-browser MAD diff of `/compat/sceneN`
> vs `/lite/sceneN`. "Working" = renders with MAD ≈ 0 (matches the Lite port).
> Scenes opted into the Compat tab carry `"compatParity": true` in
> [scene-config.json](../../scene-config.json).
>
> **Lite-only scenes are excluded.** Four scenes — `180`, `181`, `227`, `228`
> (text rendering / multi-canvas) — have no Babylon.js oracle source, so there is
> nothing to run through the compat layer; `/compat/sceneN.html` reports them as
> skipped. The counts below are out of the **164** scenes that have a BJS oracle.

### ✅ Working (109 scenes, MAD ≈ 0)

`1`, `2`, `4`, `5`, `6`, `9`, `10`, `11`, `13`, `14`, `15`, `16`, `18`, `19`, `22`, `24`, `25`, `27`, `28`,
`29`, `30`, `31`, `32`, `33`, `34`, `35`, `36`, `37`, `38`, `50`, `51`, `52`, `53`,
`54`, `55`, `56`, `57`, `58`, `59`, `60`, `61`, `62`, `63`, `64`, `65`, `67`, `68`, `69`, `70`,
`71`, `77`, `78`, `79`, `80`,
`82`, `83`, `85`, `86`, `87`, `88`, `89`, `90`, `91`, `92`, `93`, `94`, `95`, `96`, `112`, `120`, `121`,
`122`, `123`, `124`, `125`, `129`, `150`, `151`, `152`, `153`, `154`, `155`, `156`, `157`,
`158`, `170`, `171`, `172`, `173`, `174`, `175`, `200`, `201`, `202`, `203`, `204`, `205`, `207`, `210`, `211`, `213`, `216`, `218`,
`219`, `221`, `222`, `223`, `224`, `225`

Covers: StandardMaterial + PBR (factor + IBL, clearcoat, `.dds` environment),
glTF / `.babylon` model loading (+ loaded animation groups with `goToFrame`
freeze), default-environment IBL, fog, spot/directional PCF + ESM shadows, thin
instances, NME node materials (incl. iridescence + image processing), world-space
camera-facing billboard sprites (`SpriteManager`/`Sprite`), pixel-space
`SpriteRenderer`/`ThinSprite` 2D sprites (grids, animation, palette/param shaders,
uvOffset parallax) plus depth-hosted 2D sprites, gizmos (single-axis +
composite position/rotation/scale, bounding-box, camera + light) over a utility
layer, procedural builders (ribbon/tube/extrude), `VertexData.applyToMesh`
(CPU-authored geometry),
floating-origin / large-world rendering (point/spot light, thin instances,
directional shadows), CPU keyframe animation, manual weighted / cross-fade
`AnimationGroup` blending (structural groups sharing a property), loaded
glTF skeletal weighted + additive `AnimationGroup` blending (Xbot walk/run mix,
idle + additive sad-pose) via a scene-owned Lite `AnimationManager`, and
Gaussian Splatting (`.ply` / `.splat` / `.sog` / `.spz` clouds with worker-sorted
back-to-front rendering + view-dependent SH) through a `GaussianSplattingMesh`
wrapper over Lite's `loadSplat` / `loadSOG` / `loadSPZ` (incl. `updateData` with
`flipY` parity, `bakeCurrentTransformIntoVertices`, and GPU picking).

### ❌ Not working — grouped by blocker

| Blocker                                                     | Scenes                                                | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | --- |
| Additive-blend billboards (`ALPHA_ONEONE` premultiplied)    | 98, 205                                               | 98's BJS oracle premultiplies color for `(one,one)` but Lite additive is `(src-alpha,one)`; 205 layers LWR on top                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `NodeMaterial` PBR/IP layers (renders, diverges)            | 66, 72, 73, 84                                        | NME shadow receive works (65 — `NodeMaterial.Parse` wires the scene's shadow generators into the Lite NME parse, MAD ≈ 0.01). NME-PBR-with-env scenes **67–71** (clearcoat/sheen/anisotropy/SSS) now work (MAD ≈ 0) after fixing environment image-processing semantics: plain `scene.environmentTexture = …` no longer inherits Lite `loadEnvironment`'s tone-mapping side effect (snapshot/restore around the env load), while `scene.createDefaultEnvironment` explicitly applies the BJS `EnvironmentHelper` image processing (tone mapping on, exposure 0.8 / contrast 1.2). This keeps `createDefaultEnvironment` scenes (1/13/19/28) tone-mapped and scene 87 (explicit image processing) correct. Remaining have distinct blockers, each verified against the Lite port: **66** now builds its `MorphTargetManager` (compat morph is implemented) but then needs an NME `Reflection_map` texture binding wired into the parsed node material (provide via `material.inputs[...]`/parse options). **72, 73** need a scene-specific `blockLoader` for advanced PBR NME blocks (sheen/anisotropy/clearcoat/SSS) not in the default registry. **84** (NME fragment/screen) diverges most (MAD ≈ 3.0). |
| `PostProcess` / rendering pipelines                         | 142, 143, 144, 145, 146                               | Oracle scenes drive BJS engine/frame-graph internals (`postProcessManager.directRender`, `RenderTargetTexture`, `PostProcessRenderPipeline`/`BloomEffect`, raw `FrameGraph*` tasks + `_applyViewport` patches), not a public facade surface. Lite renders these via its own `create*PostProcessTask` frame-graph API; a compat path would mean re-emulating BJS's post-process + frame-graph subsystems, so they stay deferred.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| GLSL `ShaderMaterial` / `EffectWrapper` (Lite is WGSL-only) | 74, 75, 76, 159, 160, 161, 162, 163                   | BJS oracle authors shaders in GLSL (`Effect.ShadersStore`, `EffectWrapper.fragmentShader`, `ShaderMaterial`). Lite is WGSL-only with **no GLSL→WGSL translation** (the `ShaderMaterial` compat stub throws by design). Enabling these means rewriting each oracle to `ShaderLanguage.WGSL` so the compat `ShaderMaterial`/`EffectWrapper` can forward WGSL straight to Lite's `createShaderMaterial`/`createEffectWrapper`. Output stays pixel-identical, so committed goldens remain valid.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| GLSL depth `ShaderMaterial` + `RenderTargetTexture`         | 116                                                   | Same WGSL-only blocker as above, **plus** needs a `RenderTargetTexture` + `createDepthStencilTexture` facade over Lite's frame-graph RTT before the depth-preview pass can run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Custom-geometry / morph / skeleton meshes                   | 114                                                   | Custom-geometry scenes **56** (axis-locked billboards), **64** (NME `MorphTargetsBlock`), and **86** (NME clip-plane + per-mesh UV/color/tangent) now work (MAD ≈ 0). Fixes: `VertexData.applyToMesh` + empty `new Mesh(name, scene)` already existed; added `mesh.setVerticesData(tangent)` with retained tangent/color buffers, `scene.clipPlane` (over Lite `setClipPlane`), `MorphTarget`/`MorphTargetManager` over Lite `createMorphTargets`/`setMorphTargetWeights` (BJS absolute target positions → Lite deltas, built at engine start), `Material.backFaceCulling` wired to the Lite material, and `Texture` honouring `invertY`/`noMipmap` on the material path. Scene **170** (Recast navmesh) and **213** (`GridMaterial`) are now also wrapped and working (see the Navigation and `@babylonjs/materials` rows). Remaining: **114** (morph/skeleton picking) requires a **manual `Skeleton`/`Bone` construction API** (Lite builds skeletons only via the glTF loader) **and sync `scene.pick` with `applySkeleton`/`applyMorph`** (Lite is async-`GPUPicker`-only, no sync CPU pick with deformation) — both are Lite-core additions.                                                        |
| Navigation tile-cache obstacles (Recast)                    | —                                                     | Wrapped & working (**172**, **173** at MAD ≈ 0). The compat navigation wrapper has the full tile-cache obstacle surface — `plugin.addCylinderObstacle` / `addBoxObstacle` / `removeObstacle` over Lite's `addCylinderObstacle`/`addBoxObstacle`/`removeObstacle`, `createNavMesh` returns `{ navMesh, tileCache }`, and a standalone `WaitForFullTileCacheUpdate` delegates to Lite's `updateNavMeshObstacles`. (173's parity frame is the frozen state with both obstacles present; its live `removeObstacle`/rebuild path runs only when not frozen.)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Floating-origin / large-world rendering (LWR)               | 201, 206                                              | 201/206 add sprite/billboard + `VertexData` on top of LWR; the procedural LWR scenes (202–204, 207) now pass                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `.dds` environment / advanced reflection                    | 17, 21, 23, 176, 177, 178, 212                        | `.dds` IBL works (scene 19 passes); these add sheen/anisotropy textures or skybox-reflection PBR that still diverge. **23** (anisotropy) now renders (a `Color3` assigned to `scene.clearColor` no longer reaches WebGPU with `a: undefined` — alpha defaults to 1) but its anisotropic highlight still diverges from the Lite port (MAD ≈ 0.016, under the scene's 0.12 ceiling but not yet ≈ 0).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Gaussian Splatting — remaining (material-plugin / depth)    | 126, 127, 128                                         | Core GS now works (120–125, 129 — load `.ply`/`.splat`/`.sog`/`.spz` + SH, `updateData(flipY)`, `bakeCurrentTransformIntoVertices`, GPU picking). All three remaining have a working Lite port (Lite backs the feature), but each needs a substantial multi-part compat surface: **126** needs `GaussianSplattingMaterial` + `MaterialPluginBase` + `ShaderLanguage` wrappers, a `gs.material` getter, and **post-load** fragment application (the BJS oracle attaches the plugin after `ImportMeshAsync`, whereas Lite splices `GsShaderFragment`s into the pipeline at load — so this also needs a tree-shakeable Lite renderable-rebuild export); **127/128** are blocked by their oracle's GLSL `Effect.ShadersStore` + `PostProcess` + `scene.enableDepthRenderer` — the same WGSL-only/PostProcess bucket as 74–76/142–146/159–163, not by GS.                                                                                                                                                                                                                                                                                                                                                      |
| Navigation meshes (Recast)                                  | —                                                     | Recast nav is fully wrapped: scenes **170, 171, 172, 173, 174, 175** work (MAD ≈ 0) via a compat `@babylonjs/addons/navigation` wrapper (`navigation/navigation.ts`) over Babylon Lite's native Recast API — navmesh build, debug-mesh visualization, crowd + `addAgent`/`agentGoto`/`timeFactor`, `computePath`, `raycast`, off-mesh connections (174), and tile-cache obstacles (172, 173). The `@recast-navigation/*` packages the oracle imports are shimmed to no-ops since Lite loads its own Recast wasm. Also: glTF `result.meshes` now includes the BJS `__root__` at index 0 (so `result.meshes[1]` resolves), and `mesh.bakeCurrentTransformIntoVertices()` folds a node's transform into its CPU geometry.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |     |     |
| Basis Universal textures                                    | —                                                     | Wrapped & working (**36** = `.basis` diffuse+emissive box, MAD ≈ 0). The compat `Texture` routes `.basis` URLs through Lite's `loadBasisTexture2D` (GPU-format transcode) instead of the raster `loadTexture2D`, and `StandardMaterial.emissiveTexture` is now wired to the Lite material (with deferred-load rebinding, like `diffuseTexture`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| CSG / CSG2                                                  | —                                                     | Wrapped & working (90 = legacy `CSG`, 91 = Manifold `CSG2`, both MAD ≈ 0). Compat `CSG`/`CSG2`/`InitializeCSG2Async` ([meshes/csg.ts](src/meshes/csg.ts)) adapt Babylon.js's method-chaining (`FromMesh` / `subtract` / `intersect` / `union` or `add` / `toMesh`) onto Lite's `createCsgFromMesh`/`createMeshFromCsg` and `createCsg2FromMesh`/`createMeshesFromCsg2`. CSG2 preserves per-source materials (each `FromMesh` records its mesh's material against a unique slot; `toMesh` triangulates one Lite mesh per slot and parents them under one returned mesh). Also wired `StandardMaterial.alphaCutOff` (the texture-label alpha test).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Physics (Havok)                                             | 40                                                    | `PhysicsAggregate`/`PhysicsShapeType` not wrapped                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `CascadedShadowGenerator` (true CSM)                        | 214, 215                                              | Falls back to single-cascade directional; cascades diverge                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Misc single-API gaps                                        | 8, 12, 20, 26, 113, 140, 147, 148, 149, 165, 179, 217 | e.g. `HDRCubeTexture`, `MaterialPluginBase`, gizmo internals                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Loaded-camera surfacing / KTX2 textures                     | —                                                     | Both resolved. **24** surfaces a `.babylon` camera as the compat `scene.activeCamera` (`FreeCamera._adopt`). **112** (FlightHelmet, KTX2 / `KHR_texture_basisu`) renders at MAD ≈ 0: Babylon Lite decodes KTX2/basisu inside its glTF loader, and `scene.materials` is iterable (the BJS oracle's `enableNoise` loop is a no-op over the compat material list).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Sync `scene.pick`                                           | 113                                                   | ❌ by design — use async `GPUPicker`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

Adding a missing export usually only advances a scene to its _next_ blocker
rather than fixing it outright (e.g. several NME-PBR scenes resolve `NodeMaterial`
but then diverge on clearcoat/sheen lighting). The `PostProcess` / frame-graph
scenes (142–146) are deferred **by design** — Lite renders effects through its
own `create*PostProcessTask` frame-graph API, so the Babylon.js camera-attached
`PostProcess` / `PostProcessRenderPipeline` / raw `FrameGraph*` model is left as a
throwing stub rather than re-emulated. Manual structural weighted / cross-fade
`AnimationGroup` blending (155, 156) and loaded glTF skeletal weighted + additive
blending (157, 158) now work; the remaining tractable work is the assorted
single-API gaps. The glTF model-framing cluster and the procedural
large-world-rendering scenes are now resolved.

> **Task 2 re-check (2026-06-24):** the new Lite capabilities landed since the last
> sync — opt-in bone control (#268), `AnimationGroupMask` (#269), the AudioV2 port
> (#273), physics collision/trigger events + raycast + character controller, the
> standalone `loadKtx2Texture2D` (#263), per-material stencil (#257), and the
> `mat4Decompose` / `quatFromRotationMatrix` / vec3-ref math helpers — were
> cross-referenced against the blocker table above. **None clears a
> previously-skipped scene's blocker:** scene 114 still needs _manual_
> `Skeleton`/`Bone` construction plus sync skinned `scene.pick` (the new bone-control
> API only poses loader-built skeletons); scene 40 is a compat-wrapper gap
> (`PhysicsAggregate` not yet wrapped), not a Lite-core unblock; and audio scenes
> have no pixel oracle. So no scene moved into the working list this run — Task 2 is
> dormant, as expected when no Lite change unblocks a scene.
