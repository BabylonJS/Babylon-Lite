# Babylon Lite Compat — Feature Status

This file tracks the support status of each Babylon.js (BJS) feature area in the
`@babylonjs/lite-compat` package. It is the single source of truth consulted and
updated by the `update-compat-layer` skill.

<!-- The two markers below are machine-read by the update-compat-layer skill.
     Do not rename them. Update the SHA after re-syncing against BJS master. -->

- **Last synced BJS commit:** `5eab981bd5fb8a2b68803a9d25a9affe31327a31`
- **Last sync date:** 2026-06-12
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

## Status legend

| Status            | Meaning                                                                          |
| ----------------- | -------------------------------------------------------------------------------- |
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

| BJS API                                            | Status    | Module                                                                                           |
| -------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------ |
| `Vector2` / `Vector3` / `Vector4`                  | ✅ Full    | [math/vector.ts](src/math/vector.ts)                                                             |
| `Color3` / `Color4`                                | ✅ Full    | [math/color.ts](src/math/color.ts)                                                               |
| `Quaternion`                                       | ✅ Full    | [math/quaternion.ts](src/math/quaternion.ts)                                                     |
| `Matrix`                                           | ✅ Full    | [math/matrix.ts](src/math/matrix.ts)                                                             |
| `Vector3.TransformCoordinates` / `TransformNormal` | ✅ Full    | [math/vector.ts](src/math/vector.ts)                                                             |
| `Vector3.Center` / `CenterToRef`                   | ✅ Full    | [math/vector.ts](src/math/vector.ts)                                                             |
| `Matrix.copyToArray`                               | ✅ Full    | [math/matrix.ts](src/math/matrix.ts)                                                             |
| `Scalar`                                           | ✅ Full    | [math/scalar.ts](src/math/scalar.ts)                                                             |
| `Axis` / `Space` / `Epsilon`                       | ✅ Full    | [math/constants.ts](src/math/constants.ts)                                                       |
| `Plane` / `Ray` / `Frustum`                        | ✅ Full    | [math/plane.ts](src/math/plane.ts), [ray.ts](src/math/ray.ts), [frustum.ts](src/math/frustum.ts) |
| `Size` / `Viewport`                                | ✅ Full    | [math/size.ts](src/math/size.ts)                                                                 |
| `Angle` / `Curve3` / `Path3D`                      | ⚡ Partial | [math/curve.ts](src/math/curve.ts)                                                               |
| `Curve3` / `Path3D` / easing curves on math        | ⚡ Partial | curve + easing                                                                                   |

## Core

| BJS API                                                                     | Status            | Module                                                                                                        |
| --------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------- |
| `WebGPUEngine` / `Engine`                                                   | ⚡ Partial         | [engine/engine.ts](src/engine/engine.ts)                                                                      |
| `engine.useLargeWorldRendering` → floating origin / `useReverseDepthBuffer` | ⚡ Partial         | engine (BJS `useLargeWorldRendering` maps to Lite `useHighPrecisionMatrix` + `useFloatingOrigin`)             |
| `engine.runRenderLoop` / `stopRenderLoop`                                   | ⚡ Partial         | engine (async startup; N callbacks)                                                                           |
| `engine.resize` / `setSize` / `dispose` / `getRenderingCanvas`              | ✅ Full            | engine                                                                                                        |
| `engine.beginFrame` / `endFrame`                                            | ❌ Not supported   | —                                                                                                             |
| `Scene`                                                                     | ⚡ Partial         | [scene/scene.ts](src/scene/scene.ts)                                                                          |
| `scene.clearColor` / `activeCamera` / `imageProcessingConfiguration`        | ✅ Full            | scene                                                                                                         |
| `scene.fogMode/fogStart/fogEnd/fogDensity/fogColor` + `FOGMODE_*`           | ✅ Full            | scene (over Lite `setFog`)                                                                                    |
| `scene.environmentTexture` / `createDefaultEnvironment`                     | ⚡ Partial         | scene (over Lite `loadEnvironment`; BJS default assets)                                                       |
| `scene.createDefaultCameraOrLight`                                          | ✅ Full            | scene                                                                                                         |
| `scene.performancePriority`                                                 | ⚡ Partial         | accepted for parity (Lite self-tunes)                                                                         |
| `scene.onBeforeRenderObservable` / `onDisposeObservable`                    | ✅ Full            | scene + [misc/observable.ts](src/misc/observable.ts)                                                          |
| `scene.onAfterRenderObservable`                                             | ⚡ Partial         | fires one frame late (Lite has no after-render hook)                                                          |
| `scene.whenReadyAsync` / `isReady`                                          | ✅ Full            | resolve-immediately (Lite builds synchronously)                                                               |
| `scene.createDefaultCamera`                                                 | ✅ Full            | scene                                                                                                         |
| `scene.animationGroups` / `scene.animatables`                               | ⚡ Partial         | scene (returns `AnimationGroup[]` over Lite loaded groups — `goToFrame`/`play`/`pause`/`stop` to seek/freeze) |
| `ScenePerformancePriority` / `ImageProcessingConfiguration` / `Constants`   | ✅ Full            | [misc/engine-constants.ts](src/misc/engine-constants.ts) (numeric values)                                     |
| `scene.render()` (manual single frame)                                      | ❌ Not supported   | no-op under Lite loop                                                                                         |
| `scene.getMeshByName` / `scene.meshes` enumeration                          | 🔧 Needs Lite core | public scene accessors                                                                                        |
| `scene.pick` (sync)                                                         | ❌ Not supported   | sync CPU picking; use `GPUPicker` (async) instead                                                             |
| `GPUPicker` (async GPU picking)                                             | ⚡ Partial         | [picking/gpu-picker.ts](src/picking/gpu-picker.ts)                                                            |
| `Observable`                                                                | ✅ Full            | [misc/observable.ts](src/misc/observable.ts)                                                                  |
| `Tools` (subset)                                                            | ✅ Full            | [misc/tools.ts](src/misc/tools.ts)                                                                            |

## Culling & Collisions

| BJS API                                           | Status    | Module                                         |
| ------------------------------------------------- | --------- | ---------------------------------------------- |
| `BoundingBox` / `BoundingSphere` / `BoundingInfo` | ✅ Full    | [culling/bounding.ts](src/culling/bounding.ts) |
| `PickingInfo` / `IntersectionInfo`                | ⚡ Partial | surfaced via `GPUPicker`                       |

## Cameras

| BJS API                                           | Status          | Module                                       |
| ------------------------------------------------- | --------------- | -------------------------------------------- |
| `Camera` (base, extends `Node`)                   | ✅ Full          | [cameras/cameras.ts](src/cameras/cameras.ts) |
| `camera.getViewMatrix` / `getProjectionMatrix`    | ✅ Full          | cameras (over Lite matrix accessors)         |
| `ArcRotateCamera`                                 | ✅ Full          | cameras                                      |
| `TargetCamera` / `FreeCamera` / `UniversalCamera` | ✅ Full          | cameras                                      |
| `TouchCamera` / `GamepadCamera` / `FlyCamera`     | ✅ Full          | cameras (free-camera variants)               |
| `camera.attachControl` / `detachControl`          | ✅ Full          | cameras                                      |
| `FollowCamera`                                    | ⚡ Partial       | cameras (per-frame target tracking)          |
| `DeviceOrientationCamera` / `WebXRCamera`         | ❌ Not supported | throwing stub; no XR/orientation in Lite     |
| `AnaglyphArcRotateCamera` / stereoscopic rigs     | ❌ Not supported | throwing stub                                |

## Lights

| BJS API                                               | Status            | Module                                   |
| ----------------------------------------------------- | ----------------- | ---------------------------------------- |
| `HemisphericLight`                                    | ✅ Full            | [lights/lights.ts](src/lights/lights.ts) |
| `DirectionalLight`                                    | ✅ Full            | lights                                   |
| `PointLight`                                          | ✅ Full            | lights                                   |
| `SpotLight`                                           | ✅ Full            | lights                                   |
| `light.diffuse/specular/intensity/position/direction` | ✅ Full            | lights                                   |
| `light.setEnabled(false)`                             | 🔧 Needs Lite core | per-light visibility toggle              |
| `RectAreaLight`                                       | ❌ Not supported   | not in Lite                              |

## Shadows

| BJS API                                           | Status    | Module                                                         |
| ------------------------------------------------- | --------- | -------------------------------------------------------------- |
| `ShadowGenerator` (directional ESM/PCF, spot PCF) | ⚡ Partial | [shadows/shadow-generator.ts](src/shadows/shadow-generator.ts) |
| `addShadowCaster` / `getShadowMap().renderList`   | ✅ Full    | shadows (over Lite shadow factories)                           |
| `mesh.receiveShadows`                             | ✅ Full    | meshes                                                         |
| `CascadedShadowGenerator`                         | ⚡ Partial | shadows (falls back to single-cascade directional)             |

## Meshes & Geometry

| BJS API                                                                                                      | Status            | Module                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Node` (base) + `getScene`/`getClassName`/`parent`/`metadata`                                                | ⚡ Partial         | [node/node.ts](src/node/node.ts)                                                                                                                                                                                                           |
| Class chain `Mesh → AbstractMesh → TransformNode → Node`                                                     | ✅ Full            | node + meshes (real inheritance)                                                                                                                                                                                                           |
| `MeshBuilder.CreateBox/Sphere/Ground/Plane/Cylinder`                                                         | ⚡ Partial         | [meshes/meshes.ts](src/meshes/meshes.ts)                                                                                                                                                                                                   |
| `MeshBuilder.CreateTorus/TorusKnot/Disc/Polyhedron`                                                          | ⚡ Partial         | meshes (Lite-backed)                                                                                                                                                                                                                       |
| `Mesh.CreateSphere/Box/Ground/Plane/Cylinder/Torus` (legacy statics)                                         | ✅ Full            | meshes (delegate to `MeshBuilder`)                                                                                                                                                                                                         |
| `MeshBuilder.CreateRibbon/Tube/ExtrudeShape`                                                                 | ⚡ Partial         | meshes (Lite-backed)                                                                                                                                                                                                                       |
| `MeshBuilder.CreateLines` / `CreateDecal` / `CreateText`                                                     | ❌ Not supported   | throwing stub; not in Lite                                                                                                                                                                                                                 |
| `Mesh` / `AbstractMesh` (transform, material, visibility)                                                    | ⚡ Partial         | meshes                                                                                                                                                                                                                                     |
| `GroundMesh`                                                                                                 | ⚡ Partial         | meshes (no CPU height query)                                                                                                                                                                                                               |
| `GaussianSplattingMesh` (`loadFileAsync` / `splatsData` / `updateData` / `bakeCurrentTransformIntoVertices`) | ⚡ Partial         | [meshes/gaussian-splatting.ts](src/meshes/gaussian-splatting.ts) — over Lite `loadSplat`/`loadSOG`/`loadSPZ`; loader routes `.ply`/`.splat`/`.sog`/`.spz` URLs; live transforms + `updateData(flipY)`; pickable via the compat `GPUPicker` |
| `InstancedMesh`                                                                                              | ❌ Not supported   | throwing stub; use thin instances                                                                                                                                                                                                          |
| `VertexData`                                                                                                 | ⚡ Partial         | meshes (CPU data container)                                                                                                                                                                                                                |
| `mesh.position/rotation/scaling` (live mutation)                                                             | ✅ Full            | meshes (write-through `Vector3` proxy → in-place methods like `scaleInPlace`/`addInPlace` mutate the Lite node)                                                                                                                            |
| `mesh.dispose` / `setEnabled` / `isEnabled` / `isDisposed`                                                   | ✅ Full            | meshes + node                                                                                                                                                                                                                              |
| `mesh.thinInstanceSetBuffer`                                                                                 | ⚡ Partial         | meshes (`matrix` + `color` → Lite thin instances)                                                                                                                                                                                          |
| `mesh.clone` / `createInstance`                                                                              | ⚡ Partial         | throwing stub                                                                                                                                                                                                                              |
| `TransformNode`                                                                                              | ✅ Full            | meshes                                                                                                                                                                                                                                     |
| `mesh.getBoundingInfo`                                                                                       | 🔧 Needs Lite core | bounds accessor                                                                                                                                                                                                                            |
| LOD / `EdgesRenderer` / `OutlineRenderer`                                                                    | ❌ Not supported   | throwing stub; not in Lite                                                                                                                                                                                                                 |

## Gizmos

| BJS API                                                               | Status    | Module                                   |
| --------------------------------------------------------------------- | --------- | ---------------------------------------- |
| `UtilityLayerRenderer`                                                | ✅ Full    | [gizmos/gizmos.ts](src/gizmos/gizmos.ts) |
| `PositionGizmo` / `RotationGizmo` / `ScaleGizmo` / `BoundingBoxGizmo` | ⚡ Partial | gizmos (over Lite gizmo suite)           |
| `LightGizmo` / `CameraGizmo`                                          | ⚡ Partial | gizmos                                   |
| `GizmoManager`                                                        | ⚡ Partial | gizmos                                   |

## Behaviors

| BJS API                                      | Status            | Module                                               |
| -------------------------------------------- | ----------------- | ---------------------------------------------------- |
| `Behavior<T>` interface                      | ✅ Full            | [behaviors/behaviors.ts](src/behaviors/behaviors.ts) |
| `AutoRotationBehavior`                       | ✅ Full            | behaviors                                            |
| `BouncingBehavior` / `FramingBehavior`       | ⚡ Partial         | behaviors (no tweened animation)                     |
| `PointerDragBehavior` / `SixDofDragBehavior` | 🔧 Needs Lite core | use native `createPointerDrag`                       |

## Actions

| BJS API                                                          | Status    | Module                                       |
| ---------------------------------------------------------------- | --------- | -------------------------------------------- |
| `ActionManager` (manual `processTrigger`; auto-dispatch pending) | ⚡ Partial | [actions/actions.ts](src/actions/actions.ts) |
| `ExecuteCodeAction` / `SetValueAction` / `IncrementValueAction`  | ✅ Full    | actions                                      |
| `ValueCondition` / `PredicateCondition`                          | ✅ Full    | actions                                      |

## Misc utilities

| BJS API                                    | Status | Module                                       |
| ------------------------------------------ | ------ | -------------------------------------------- |
| `Observable`                               | ✅ Full | [misc/observable.ts](src/misc/observable.ts) |
| `Tools` (subset)                           | ✅ Full | [misc/tools.ts](src/misc/tools.ts)           |
| `SmartArray` / `StringDictionary` / `Tags` | ✅ Full | [misc/misc-utils.ts](src/misc/misc-utils.ts) |
| `PerformanceMonitor`                       | ✅ Full | misc-utils                                   |
| `ColorGradient` / `FactorGradient`         | ✅ Full | misc-utils                                   |

## Materials

| BJS API                                                   | Status          | Module                                                                                            |
| --------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------- |
| `StandardMaterial` (common subset)                        | ⚡ Partial       | [materials/materials.ts](src/materials/materials.ts)                                              |
| `PBRMaterial` (common subset)                             | ⚡ Partial       | materials                                                                                         |
| `Material` / `PushMaterial` (base chain)                  | ⚡ Partial       | materials                                                                                         |
| `PBRMetallicRoughnessMaterial`                            | ⚡ Partial       | materials (çade over PBR)                                                                         |
| `PBRSpecularGlossinessMaterial`                           | ⚡ Partial       | materials (mapped to metallic-roughness)                                                          |
| factor-only PBR (colours, no maps)                        | ✅ Full          | materials (synthesizes 1×1 solid base/ORM textures)                                               |
| `material.environmentTexture` / `reflectionTexture` (PBR) | ⚡ Partial       | materials (routed to `scene.environmentTexture`)                                                  |
| `material` runtime mutation → UBO dirty                   | ✅ Full          | materials                                                                                         |
| `MultiMaterial`                                           | ❌ Not supported | throwing stub; one material per renderable                                                        |
| `ShaderMaterial` (GLSL)                                   | ❌ Not supported | throwing stub; Lite is WGSL-only                                                                  |
| `NodeMaterial` (`Parse` + `getBlockByName().texture`)     | ⚡ Partial       | [materials/node-material.ts](src/materials/node-material.ts) (async NME parse, deferred to build) |
| `BackgroundMaterial`                                      | ❌ Not supported | throwing stub; use native `loadEnvironment`                                                       |

## Textures

| BJS API                                                                    | Status          | Module                                                                         |
| -------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------ |
| `Texture` (2D, URL)                                                        | ✅ Full          | [textures/textures.ts](src/textures/textures.ts) (async load awaited at build) |
| `RawTexture`                                                               | ✅ Full          | textures (Lite pixel texture)                                                  |
| `DynamicTexture` (canvas-backed)                                           | ✅ Full          | textures                                                                       |
| `CubeTexture` (`CreateFromPrefilteredData`, `isReady`, `onLoadObservable`) | ⚡ Partial       | textures (URL handle → Lite `loadEnvironment` at engine start)                 |
| `HDRCubeTexture`                                                           | ❌ Not supported | throwing stub; use native `loadHdrEnvironment`                                 |
| `RenderTargetTexture`                                                      | ❌ Not supported | throwing stub; use native frame-graph RTT                                      |
| `MirrorTexture`                                                            | ❌ Not supported | throwing stub                                                                  |

## Loaders

| BJS API                                                                   | Status          | Module                                                            |
| ------------------------------------------------------------------------- | --------------- | ----------------------------------------------------------------- |
| `SceneLoader.ImportMeshAsync` / `AppendAsync` / `LoadAssetContainerAsync` | ⚡ Partial       | [loading/scene-loader.ts](src/loading/scene-loader.ts)            |
| glTF 2.0 + extensions                                                     | ✅ Full          | via Lite `loadGltf`                                               |
| `.babylon`                                                                | ✅ Full          | via Lite `loadBabylon`                                            |
| `AssetContainer`                                                          | ⚡ Partial       | loading (`.meshes` returns `LoadedMesh[]` with `getBoundingInfo`) |
| `AssetsManager`                                                           | ✅ Full          | [loading/assets-manager.ts](src/loading/assets-manager.ts)        |
| `OBJ` / `STL` / `FBX` / `BVH` loaders                                     | ❌ Not supported | throwing stub; not in Lite (convert to glTF)                      |

## Animation

| BJS API                                                     | Status    | Module                                                                                                                                                                                  |
| ----------------------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Easing functions (`SineEase`, `CubicEase`, `BounceEase`, …) | ✅ Full    | [animations/easing.ts](src/animations/easing.ts)                                                                                                                                        |
| `Animation` (keyframe model + CPU `evaluate`)               | ✅ Full    | [animations/animation.ts](src/animations/animation.ts)                                                                                                                                  |
| `Animatable` / `scene.beginDirectAnimation`                 | ⚡ Partial | animation (CPU per-frame evaluation; no weight blending)                                                                                                                                |
| `AnimationGroup` (single BJS type; structural + loaded)     | ⚡ Partial | animation (loaded groups seek/freeze + weighted/additive blend via a scene-owned Lite `AnimationManager`; structural groups step + weight-blend on the CPU)                             |
| Animation weights / cross-fade / additive                   | ✅ Full    | structural CPU weighted + cross-fade blending (manual `AnimationGroup`s) and loaded glTF skeletal weighted + additive (`MakeAnimationAdditive`) blending over Lite's `AnimationManager` |

## Bones / Skeletons / Morph

| BJS API                              | Status          | Notes                                                   |
| ------------------------------------ | --------------- | ------------------------------------------------------- |
| `Skeleton` / `Bone`                  | ❌ Not supported | throwing stub; produced by glTF loader, not constructed |
| `MorphTarget` / `MorphTargetManager` | ❌ Not supported | throwing stub; use native `createMorphTargets`          |

## Sprites

| BJS API                             | Status          | Notes                                                                                                                         |
| ----------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `SpriteManager` / `Sprite`          | ⚡ Partial       | [sprites/sprites.ts](src/sprites/sprites.ts) — world-space camera-facing billboards over Lite's `createFacingBillboardSystem` |
| `SpriteMap` / `SpritePackedManager` | ❌ Not supported | throwing stub; tile-map / packed-atlas variants not wrapped                                                                   |

## Particles

| BJS API                                                        | Status          | Notes                      |
| -------------------------------------------------------------- | --------------- | -------------------------- |
| `ParticleSystem` / `GPUParticleSystem` / `SolidParticleSystem` | ❌ Not supported | throwing stub; not in Lite |
| `ParticleHelper` / `ParticleSystemSet` / `PointsCloudSystem`   | ❌ Not supported | throwing stub              |

## Post-processes

| BJS API                                                            | Status          | Notes                                                |
| ------------------------------------------------------------------ | --------------- | ---------------------------------------------------- |
| `PostProcess` (base) + `DefaultRenderingPipeline`                  | ❌ Not supported | throwing stub; use native frame-graph tasks          |
| `Bloom` / `Blur` / `BlackAndWhite` / `ChromaticAberration` / `DoF` | ❌ Not supported | throwing stub; effects exist as native `create*Task` |
| `FxaaPostProcess` / `SSAO2RenderingPipeline`                       | ❌ Not supported | throwing stub; not in Lite                           |

## Probes / Layers / Rendering

| BJS API                                                            | Status          | Notes                                          |
| ------------------------------------------------------------------ | --------------- | ---------------------------------------------- |
| `ReflectionProbe`                                                  | ❌ Not supported | throwing stub                                  |
| `Layer` / `EffectLayer` / `HighlightLayer` / `GlowLayer`           | ❌ Not supported | throwing stub; not in Lite                     |
| `DepthRenderer` / `GeometryBufferRenderer` / `BoundingBoxRenderer` | ❌ Not supported | throwing stub; use native geometry/depth tasks |

## Physics

| BJS API                                                             | Status          | Notes                                        |
| ------------------------------------------------------------------- | --------------- | -------------------------------------------- |
| `HavokPlugin` / `PhysicsAggregate` / `PhysicsBody` / `PhysicsShape` | ❌ Not supported | throwing stub; use native Havok-V2 functions |
| `CannonJSPlugin` / `AmmoJSPlugin`                                   | ❌ Not supported | throwing stub; Lite is Havok-V2 only         |

## Navigation

| BJS API          | Status          | Notes                                              |
| ---------------- | --------------- | -------------------------------------------------- |
| `RecastJSPlugin` | ❌ Not supported | throwing stub; use native Recast-V2 navigation API |

## Audio

| BJS API                                   | Status          | Notes                                 |
| ----------------------------------------- | --------------- | ------------------------------------- |
| `Sound` / `AudioEngine` / `WeightedSound` | ❌ Not supported | throwing stub; use Web Audio directly |

## Not yet wrapped (Lite supports — wrappers planned)

Geospatial camera, `VertexData.applyToMesh` (build a mesh from CPU vertex data),
weighted / additive `AnimationGroup` blending, and an auto-dispatching
`ActionManager` (needs a unified Lite pointer pipe). These exist in Lite and are
candidate rows for the next audit passes — until wrapped they either carry a
`🔧`/`⚡` row or none, which the skill's completeness gate flags.

## Out of scope

| BJS API                                        | Status                                    |
| ---------------------------------------------- | ----------------------------------------- |
| `BABYLON.*` global namespace                   | ⛔ Out of scope (no `globalThis` mutation) |
| `SceneLoader.RegisterPlugin` / `RegisterClass` | ⛔ Out of scope (side-effectful)           |
| `Inspector` / `NodeMaterialEditor`             | ⛔ Out of scope                            |
| `ParticleSystem` / `GPUParticleSystem`         | ❌ Not supported (not in Lite)             |
| `@babylonjs/gui`                               | ❌ Not supported (not in Lite)             |
| `Sound` / `AudioEngine`                        | ❌ Not supported (no audio in Lite)        |
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

> Snapshot date: 2026-06-14. Method: in-browser MAD diff of `/compat/sceneN`
> vs `/lite/sceneN`. "Working" = renders with MAD ≈ 0 (matches the Lite port).
> Scenes opted into the Compat tab carry `"compatParity": true` in
> [scene-config.json](../../scene-config.json).
>
> **Lite-only scenes are excluded.** Four scenes — `180`, `181`, `227`, `228`
> (text rendering / multi-canvas) — have no Babylon.js oracle source, so there is
> nothing to run through the compat layer; `/compat/sceneN.html` reports them as
> skipped. The counts below are out of the **164** scenes that have a BJS oracle.

### ✅ Working (79 scenes, MAD ≈ 0)

`1`, `2`, `5`, `6`, `9`, `10`, `11`, `13`, `14`, `15`, `16`, `18`, `19`, `28`,
`29`, `30`, `31`, `32`, `33`, `34`, `35`, `37`, `38`, `50`, `51`, `52`, `53`,
`54`, `55`, `58`, `59`, `60`, `61`, `62`, `63`, `77`, `78`, `79`, `80`, `82`,
`83`, `85`, `87`, `88`, `89`, `92`, `93`, `94`, `95`, `96`, `120`, `121`, `122`,
`123`, `124`, `125`, `129`, `150`, `151`, `152`, `155`, `156`, `157`, `158`,
`200`, `201`, `202`, `203`, `204`, `205`, `207`, `210`, `216`, `218`, `219`,
`221`, `222`, `223`, `224`

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

| Blocker                                                     | Scenes                                                                                                | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Additive-blend billboards (`ALPHA_ONEONE` premultiplied)    | 98, 205                                                                                               | 98's BJS oracle premultiplies color for `(one,one)` but Lite additive is `(src-alpha,one)`; 205 layers LWR on top                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `NodeMaterial` shadow/PBR layers (renders, diverges)        | 65, 66, 67, 68, 69, 70, 71, 72, 73, 84                                                                | Render at MAD ≈ 0.4–1.5; advanced NME-PBR (clearcoat/sheen/SSS/env) not exact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `PostProcess` / rendering pipelines                         | 142, 143, 144, 145, 146                                                                               | Oracle scenes drive BJS engine/frame-graph internals (`postProcessManager.directRender`, `RenderTargetTexture`, `PostProcessRenderPipeline`/`BloomEffect`, raw `FrameGraph*` tasks + `_applyViewport` patches), not a public facade surface. Lite renders these via its own `create*PostProcessTask` frame-graph API; a compat path would mean re-emulating BJS's post-process + frame-graph subsystems, so they stay deferred.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| GLSL `ShaderMaterial` / `EffectWrapper` (Lite is WGSL-only) | 74, 75, 76, 159, 160, 161, 162, 163                                                                   | BJS oracle authors shaders in GLSL (`Effect.ShadersStore`, `EffectWrapper.fragmentShader`, `ShaderMaterial`). Lite is WGSL-only with **no GLSL→WGSL translation** (the `ShaderMaterial` compat stub throws by design). Enabling these means rewriting each oracle to `ShaderLanguage.WGSL` so the compat `ShaderMaterial`/`EffectWrapper` can forward WGSL straight to Lite's `createShaderMaterial`/`createEffectWrapper`. Output stays pixel-identical, so committed goldens remain valid.                                                                                                                                                                                                                                                                                                                                                         |
| GLSL depth `ShaderMaterial` + `RenderTargetTexture`         | 116                                                                                                   | Same WGSL-only blocker as above, **plus** needs a `RenderTargetTexture` + `createDepthStencilTexture` facade over Lite's frame-graph RTT before the depth-preview pass can run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Missing `VertexBuffer` export / custom geometry             | 56, 64, 86, 114, 170, 213                                                                             | Manual vertex-buffer authoring not wrapped                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| glTF model framing (`result.meshes` + `getBoundingInfo`)    | 172, 173                                                                                              | 🔧 Recast nav scenes also gated on navigation mesh support                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Floating-origin / large-world rendering (LWR)               | 201, 206                                                                                              | 201/206 add sprite/billboard + `VertexData` on top of LWR; the procedural LWR scenes (202–204, 207) now pass                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `.dds` environment / advanced reflection                    | 17, 21, 23, 176, 177, 178, 212                                                                        | `.dds` IBL works (scene 19 passes); these add sheen/anisotropy textures or skybox-reflection PBR that still diverge                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Heightmap ground (`CreateGroundFromHeightMap`)              | 4, 22                                                                                                 | Async heightmap mesh builder not wrapped                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `VertexData.applyToMesh` (build mesh from CPU data)         | 57                                                                                                    | Needs an empty-`Mesh(name, scene)` + apply path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Gaussian Splatting — remaining (material-plugin / depth)    | 126, 127, 128                                                                                         | Core GS now works (120–125, 129 — load `.ply`/`.splat`/`.sog`/`.spz` + SH, `updateData(flipY)`, `bakeCurrentTransformIntoVertices`, GPU picking). All three remaining have a working Lite port (Lite backs the feature), but each needs a substantial multi-part compat surface: **126** needs `GaussianSplattingMaterial` + `MaterialPluginBase` + `ShaderLanguage` wrappers, a `gs.material` getter, and **post-load** fragment application (the BJS oracle attaches the plugin after `ImportMeshAsync`, whereas Lite splices `GsShaderFragment`s into the pipeline at load — so this also needs a tree-shakeable Lite renderable-rebuild export); **127/128** are blocked by their oracle's GLSL `Effect.ShadersStore` + `PostProcess` + `scene.enableDepthRenderer` — the same WGSL-only/PostProcess bucket as 74–76/142–146/159–163, not by GS. |
| Navigation meshes (Recast)                                  | 171, 174, 175                                                                                         | Recast nav not wrapped                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Basis Universal textures                                    | 36                                                                                                    | `.basis` transcode not wrapped                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| CSG / CSG2                                                  | 90, 91                                                                                                | Constructive solid geometry not wrapped                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Physics (Havok)                                             | 40                                                                                                    | `PhysicsAggregate`/`PhysicsShapeType` not wrapped                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `CascadedShadowGenerator` (true CSM)                        | 214, 215                                                                                              | Falls back to single-cascade directional; cascades diverge                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Misc single-API gaps                                        | 8, 12, 20, 25, 26, 27, 113, 140, 147, 148, 149, 153, 154, 165, 179, 211, 217, 221, 222, 223, 224, 225 | e.g. `HDRCubeTexture`, `engine.getCaps`, `NullEngine`, `MaterialPluginBase`, `GeospatialCamera`, gizmo internals                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Loaded-camera surfacing / KTX2 textures                     | 24, 112                                                                                               | Investigated (14 was mislabeled here — it renders at parity and is now enabled). **24** throws `scene.activeCamera` is null: the `.babylon` loader's own camera is applied to the Lite scene but not surfaced as a compat `Camera` (needs a `Camera._fromLite` wrapper for loaded cameras + `attachControl` wiring). **112** throws `scene.materials is not iterable` (needs a `scene.materials` accessor) and underneath requires KTX2 / `KHR_texture_basisu` transcode — the same basis blocker as scene 36.                                                                                                                                                                                                                                                                                                                                       |
| Sync `scene.pick`                                           | 113                                                                                                   | ❌ by design — use async `GPUPicker`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

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
