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

| BJS API                                            | Status     | Module                                                                                           |
| -------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------ |
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

| BJS API                                                                   | Status             | Module                                                                    |
| ------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------- |
| `WebGPUEngine` / `Engine`                                                 | ⚡ Partial         | [engine/engine.ts](src/engine/engine.ts)                                  |
| `engine.runRenderLoop` / `stopRenderLoop`                                 | ⚡ Partial         | engine (async startup; N callbacks)                                       |
| `engine.resize` / `setSize` / `dispose` / `getRenderingCanvas`            | ✅ Full            | engine                                                                    |
| `engine.beginFrame` / `endFrame`                                          | ❌ Not supported   | —                                                                         |
| `Scene`                                                                   | ⚡ Partial         | [scene/scene.ts](src/scene/scene.ts)                                      |
| `scene.clearColor` / `activeCamera` / `imageProcessingConfiguration`      | ✅ Full            | scene                                                                     |
| `scene.fogMode/fogStart/fogEnd/fogDensity/fogColor` + `FOGMODE_*`         | ✅ Full            | scene (over Lite `setFog`)                                                |
| `scene.environmentTexture` / `createDefaultEnvironment`                   | ⚡ Partial         | scene (over Lite `loadEnvironment`; BJS default assets)                   |
| `scene.createDefaultCameraOrLight`                                        | ✅ Full            | scene                                                                     |
| `scene.performancePriority`                                               | ⚡ Partial         | accepted for parity (Lite self-tunes)                                     |
| `scene.onBeforeRenderObservable` / `onDisposeObservable`                  | ✅ Full            | scene + [misc/observable.ts](src/misc/observable.ts)                      |
| `scene.onAfterRenderObservable`                                           | ⚡ Partial         | fires one frame late (Lite has no after-render hook)                      |
| `scene.whenReadyAsync` / `isReady`                                        | ✅ Full            | resolve-immediately (Lite builds synchronously)                           |
| `scene.createDefaultCamera`                                               | ✅ Full            | scene                                                                     |
| `scene.animationGroups` / `scene.animatables`                             | ⚡ Partial         | arrays for iteration/pause (Lite drives playback)                         |
| `ScenePerformancePriority` / `ImageProcessingConfiguration` / `Constants` | ✅ Full            | [misc/engine-constants.ts](src/misc/engine-constants.ts) (numeric values) |
| `scene.render()` (manual single frame)                                    | ❌ Not supported   | no-op under Lite loop                                                     |
| `scene.getMeshByName` / `scene.meshes` enumeration                        | 🔧 Needs Lite core | public scene accessors                                                    |
| `scene.pick` (sync)                                                       | ❌ Not supported   | sync CPU picking; use `GPUPicker` (async) instead                         |
| `GPUPicker` (async GPU picking)                                           | ⚡ Partial         | [picking/gpu-picker.ts](src/picking/gpu-picker.ts)                        |
| `Observable`                                                              | ✅ Full            | [misc/observable.ts](src/misc/observable.ts)                              |
| `Tools` (subset)                                                          | ✅ Full            | [misc/tools.ts](src/misc/tools.ts)                                        |

## Culling & Collisions

| BJS API                                           | Status     | Module                                         |
| ------------------------------------------------- | ---------- | ---------------------------------------------- |
| `BoundingBox` / `BoundingSphere` / `BoundingInfo` | ✅ Full    | [culling/bounding.ts](src/culling/bounding.ts) |
| `PickingInfo` / `IntersectionInfo`                | ⚡ Partial | surfaced via `GPUPicker`                       |

## Cameras

| BJS API                                           | Status           | Module                                       |
| ------------------------------------------------- | ---------------- | -------------------------------------------- |
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

| BJS API                                               | Status             | Module                                   |
| ----------------------------------------------------- | ------------------ | ---------------------------------------- |
| `HemisphericLight`                                    | ✅ Full            | [lights/lights.ts](src/lights/lights.ts) |
| `DirectionalLight`                                    | ✅ Full            | lights                                   |
| `PointLight`                                          | ✅ Full            | lights                                   |
| `SpotLight`                                           | ✅ Full            | lights                                   |
| `light.diffuse/specular/intensity/position/direction` | ✅ Full            | lights                                   |
| `light.setEnabled(false)`                             | 🔧 Needs Lite core | per-light visibility toggle              |
| `RectAreaLight`                                       | ❌ Not supported   | not in Lite                              |

## Shadows

| BJS API                                           | Status     | Module                                                         |
| ------------------------------------------------- | ---------- | -------------------------------------------------------------- |
| `ShadowGenerator` (directional ESM/PCF, spot PCF) | ⚡ Partial | [shadows/shadow-generator.ts](src/shadows/shadow-generator.ts) |
| `addShadowCaster` / `getShadowMap().renderList`   | ✅ Full    | shadows (over Lite shadow factories)                           |
| `mesh.receiveShadows`                             | ✅ Full    | meshes                                                         |
| `CascadedShadowGenerator`                         | ⚡ Partial | shadows (falls back to single-cascade directional)             |

## Meshes & Geometry

| BJS API                                                              | Status             | Module                                     |
| -------------------------------------------------------------------- | ------------------ | ------------------------------------------ |
| `Node` (base) + `getScene`/`getClassName`/`parent`/`metadata`        | ⚡ Partial         | [node/node.ts](src/node/node.ts)           |
| Class chain `Mesh → AbstractMesh → TransformNode → Node`             | ✅ Full            | node + meshes (real inheritance)           |
| `MeshBuilder.CreateBox/Sphere/Ground/Plane/Cylinder`                 | ⚡ Partial         | [meshes/meshes.ts](src/meshes/meshes.ts)   |
| `MeshBuilder.CreateTorus/TorusKnot/Disc/Polyhedron`                  | ⚡ Partial         | meshes (Lite-backed)                       |
| `Mesh.CreateSphere/Box/Ground/Plane/Cylinder/Torus` (legacy statics) | ✅ Full            | meshes (delegate to `MeshBuilder`)         |
| `MeshBuilder.CreateRibbon/Tube/ExtrudeShape`                         | ⚡ Partial         | — (Lite factories exist; wrappers planned) |
| `MeshBuilder.CreateLines` / `CreateDecal` / `CreateText`             | ❌ Not supported   | throwing stub; not in Lite                 |
| `Mesh` / `AbstractMesh` (transform, material, visibility)            | ⚡ Partial         | meshes                                     |
| `GroundMesh`                                                         | ⚡ Partial         | meshes (no CPU height query)               |
| `InstancedMesh`                                                      | ❌ Not supported   | throwing stub; use thin instances          |
| `VertexData`                                                         | ⚡ Partial         | meshes (CPU data container)                |
| `mesh.position/rotation/scaling` (live mutation)                     | ✅ Full            | meshes                                     |
| `mesh.dispose` / `setEnabled` / `isEnabled` / `isDisposed`           | ✅ Full            | meshes + node                              |
| `mesh.thinInstanceSetBuffer`                                         | ⚡ Partial         | — (planned wrapper)                        |
| `mesh.clone` / `createInstance`                                      | ⚡ Partial         | throwing stub                              |
| `TransformNode`                                                      | ✅ Full            | meshes                                     |
| `mesh.getBoundingInfo`                                               | 🔧 Needs Lite core | bounds accessor                            |
| LOD / `EdgesRenderer` / `OutlineRenderer`                            | ❌ Not supported   | throwing stub; not in Lite                 |

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

| BJS API                                                   | Status           | Module                                                                                            |
| --------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------- |
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

| BJS API                                                                    | Status           | Module                                                                         |
| -------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------ |
| `Texture` (2D, URL)                                                        | ✅ Full          | [textures/textures.ts](src/textures/textures.ts) (async load awaited at build) |
| `RawTexture`                                                               | ✅ Full          | textures (Lite pixel texture)                                                  |
| `DynamicTexture` (canvas-backed)                                           | ✅ Full          | textures                                                                       |
| `CubeTexture` (`CreateFromPrefilteredData`, `isReady`, `onLoadObservable`) | ⚡ Partial       | textures (URL handle → Lite `loadEnvironment` at engine start)                 |
| `HDRCubeTexture`                                                           | ❌ Not supported | throwing stub; use native `loadHdrEnvironment`                                 |
| `RenderTargetTexture`                                                      | ❌ Not supported | throwing stub; use native frame-graph RTT                                      |
| `MirrorTexture`                                                            | ❌ Not supported | throwing stub                                                                  |

## Loaders

| BJS API                                                                   | Status           | Module                                                     |
| ------------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------- |
| `SceneLoader.ImportMeshAsync` / `AppendAsync` / `LoadAssetContainerAsync` | ⚡ Partial       | [loading/scene-loader.ts](src/loading/scene-loader.ts)     |
| glTF 2.0 + extensions                                                     | ✅ Full          | via Lite `loadGltf`                                        |
| `.babylon`                                                                | ✅ Full          | via Lite `loadBabylon`                                     |
| `AssetContainer`                                                          | ⚡ Partial       | loading (no flat mesh list yet)                            |
| `AssetsManager`                                                           | ✅ Full          | [loading/assets-manager.ts](src/loading/assets-manager.ts) |
| `OBJ` / `STL` / `FBX` / `BVH` loaders                                     | ❌ Not supported | throwing stub; not in Lite (convert to glTF)               |

## Animation

| BJS API                                                     | Status     | Module                                                   |
| ----------------------------------------------------------- | ---------- | -------------------------------------------------------- |
| Easing functions (`SineEase`, `CubicEase`, `BounceEase`, …) | ✅ Full    | [animations/easing.ts](src/animations/easing.ts)         |
| `Animation` (keyframe model + CPU `evaluate`)               | ✅ Full    | [animations/animation.ts](src/animations/animation.ts)   |
| `Animatable` / `scene.beginDirectAnimation`                 | ⚡ Partial | animation (CPU per-frame evaluation; no weight blending) |
| `AnimationGroup`                                            | ⚡ Partial | animation (structural; native manager drives playback)   |
| Animation weights / cross-fade / additive                   | ⚡ Partial | native APIs                                              |

## Bones / Skeletons / Morph

| BJS API                              | Status           | Notes                                                   |
| ------------------------------------ | ---------------- | ------------------------------------------------------- |
| `Skeleton` / `Bone`                  | ❌ Not supported | throwing stub; produced by glTF loader, not constructed |
| `MorphTarget` / `MorphTargetManager` | ❌ Not supported | throwing stub; use native `createMorphTargets`          |

## Sprites

| BJS API                                                          | Status           | Notes                                      |
| ---------------------------------------------------------------- | ---------------- | ------------------------------------------ |
| `Sprite` / `SpriteManager` / `SpriteMap` / `SpritePackedManager` | ❌ Not supported | throwing stub; use native Lite sprite APIs |

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

| BJS API          | Status           | Notes                                              |
| ---------------- | ---------------- | -------------------------------------------------- |
| `RecastJSPlugin` | ❌ Not supported | throwing stub; use native Recast-V2 navigation API |

## Audio

| BJS API                                   | Status           | Notes                                 |
| ----------------------------------------- | ---------------- | ------------------------------------- |
| `Sound` / `AudioEngine` / `WeightedSound` | ❌ Not supported | throwing stub; use Web Audio directly |

## Not yet wrapped (Lite supports — wrappers planned)

Thin instances, geospatial camera, the ribbon/tube/extrude `MeshBuilder`
primitives, `VertexData.applyToMesh` (build a mesh from CPU vertex data),
loader-populated `result.meshes` + per-mesh `getBoundingInfo` (for model-framing
scenes), weighted `AnimationGroup` blending, and an auto-dispatching
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
| `Sound` / `AudioEngine`                        | ❌ Not supported (no audio in Lite)        |
| WebXR                                          | ❌ Not supported (no XR in Lite)           |
| `HighlightLayer` / `GlowLayer` / `Decal`       | ❌ Not supported (not in Lite)             |
| `SceneSerializer`                              | ❌ Not supported                           |
