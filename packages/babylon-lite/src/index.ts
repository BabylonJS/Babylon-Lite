// Babylon Lite — Public API
// Tree-shakable: import only what you use.

// ─── Core ────────────────────────────────────────────────────────────
export { createEngine, startEngine, stopEngine, resizeEngine, disposeEngine, VERSION } from "./engine/engine.js";
export type { EngineContext, EngineOptions } from "./engine/engine.js";
export {
    createSceneContext,
    createDefaultCamera,
    removeFromScene,
    onBeforeRender,
    onSceneDispose,
    addToScene,
    disposeScene,
    registerScene,
    registerSceneWithShadowSupport,
    unregisterScene,
} from "./scene/scene.js";

// ─── Frame graph ─────────────────────────────────────────────────────
// Scene-owned ordered list of tasks. The default scene pass is a
// RenderTask, and user tasks can render offscreen RTTs, overlays, etc.
export { getFrameGraph } from "./scene/scene.js";
export type { FrameGraph } from "./frame-graph/frame-graph.js";
export { addRenderPass, addTask, addTaskAtStart, addTaskBefore } from "./frame-graph/frame-graph-actions.js";
export type { Task } from "./frame-graph/task.js";
export type { Pass, RenderPassExecuteFunc } from "./frame-graph/pass.js";
export { addPassDependencies } from "./frame-graph/pass.js";
export type { RenderPass } from "./frame-graph/render-pass.js";
export type { RenderTask, RenderTaskConfig } from "./frame-graph/render-task.js";
export { createRenderTask, removeMeshFromTask } from "./frame-graph/render-task.js";
export { createImageProcessingTask } from "./frame-graph/image-processing-task.js";
export type { ImageProcessingSource, ImageProcessingTaskConfig } from "./frame-graph/image-processing-task.js";
export { createShadowTask } from "./frame-graph/shadow-task.js";
export type { ShadowTask } from "./frame-graph/shadow-task.js";
export type { RenderTarget, RenderTargetDescriptor } from "./engine/render-target.js";
export { createRenderTarget } from "./engine/render-target.js";
export { createRenderTargetTexture } from "./texture/rtt.js";

// ─── Fullscreen Effects ─────────────────────────────────────────────
export { createEffectWrapper, setEffectUniforms, setEffectTexture, createEffectRenderTask, disposeEffectWrapper } from "./effect/effect-renderer.js";
export type { EffectBindingKind, EffectBindingLayout, EffectWrapperOptions, EffectWrapper, EffectRenderTaskConfig, EffectRenderTask } from "./effect/effect-renderer.js";
export { createEffectRenderer, registerEffectRenderer, unregisterEffectRenderer, disposeEffectRenderer } from "./effect/effect-renderer.js";
export type { EffectRendererOptions, EffectRenderer } from "./effect/effect-renderer.js";

// ─── Camera ──────────────────────────────────────────────────────────
export { createArcRotateCamera } from "./camera/arc-rotate.js";
export { attachControl } from "./camera/arc-rotate-controls.js";
export { createFreeCamera } from "./camera/free-camera.js";
export { attachFreeControl } from "./camera/free-camera-controls.js";

// ─── Lights ──────────────────────────────────────────────────────────
export { createHemisphericLight } from "./light/hemispheric.js";
export type { HemisphericLight } from "./light/hemispheric.js";
export { createPointLight } from "./light/point-light.js";
export { createDirectionalLight } from "./light/directional-light.js";
export { createSpotLight } from "./light/spot-light.js";
export type { LightBase } from "./light/types.js";
export { setMaxLights, MAX_LIGHTS } from "./light/types.js";

// ─── Mesh Factories (high-level) ─────────────────────────────────────
export {
    createSphere,
    createBox,
    createTorus,
    createGround,
    createGroundFromHeightMap,
    createCylinder,
    createPlane,
    createDisc,
    createPolyhedron,
    createRibbon,
    createTube,
    createExtrudeShape,
    createMeshFromData,
} from "./mesh/mesh-factories.js";
export { createSphereData } from "./mesh/create-sphere.js";
export type { SphereMeshData } from "./mesh/create-sphere.js";
export { createCsgFromMesh, csgSubtract, csgIntersect, csgUnion, createMeshFromCsg } from "./mesh/csg.js";
export type { CsgSolid } from "./mesh/csg.js";
export { initializeCsg2Async, isCsg2Ready, createCsg2FromMesh, csg2Subtract, csg2Intersect, csg2Add, createMeshFromCsg2, createMeshesFromCsg2, disposeCsg2 } from "./mesh/csg2.js";
export type { Csg2Solid } from "./mesh/csg2.js";

// ─── Textures ────────────────────────────────────────────────────────
export { createSolidTexture2D } from "./texture/solid-texture.js";
export { loadKtxTexture2D } from "./texture/ktx-loader.js";
export { loadBasisTexture2D } from "./texture/basis-loader.js";

// ─── Materials ───────────────────────────────────────────────────────
export { createStandardMaterial } from "./material/standard/create-standard-material.js";
export { createStandardNoColorMaterialView } from "./material/standard/no-color-view.js";
export { createPbrMaterial } from "./material/pbr/pbr-material.js";
export { createShaderMaterial, setShaderUniform, setShaderTexture, setShaderFloat, setShaderVector3, setShaderMatrix } from "./material/shader/shader-material.js";
export { createPbrNoColorMaterialView } from "./material/pbr/no-color-view.js";
export { parseNodeMaterialFromSnippet } from "./material/node/node-material.js";
export { createNodeNoColorMaterialView } from "./material/node/no-color-view.js";
export type { NodeMaterial, NodeInputHandle, ParseNodeMaterialOptions } from "./material/node/node-material.js";
export { createMaterialView } from "./material/material-view.js";
export { markMaterialUboDirty } from "./material/material-dirty.js";
export { rebuildMaterial } from "./material/material-rebuild.js";
export { enableMaterialTracking } from "./material/observable-material.js";

// ─── Loaders ─────────────────────────────────────────────────────────
export { loadGltf } from "./loader-gltf/load-gltf.js";
export type { AssetContainer } from "./asset-container.js";
export { selectVariant, getVariantNames, resetVariant } from "./loader-gltf/material-variants.js";
export type { MaterialVariantData } from "./loader-gltf/material-variants.js";
// ─── Hierarchy ───────────────────────────────────────────────────────
export type { IWorldMatrixProvider, IParentable } from "./scene/parentable.js";
export { setParent } from "./scene/set-parent.js";
export { createTransformNode, cloneTransformNode } from "./scene/transform-node.js";
export type { TransformNode } from "./scene/transform-node.js";
export type { SceneNode } from "./scene/scene-node.js";
export { loadBabylon } from "./loader-babylon/load-babylon.js";
export { loadEnvironment } from "./loader-env/load-env.js";
export { loadHdrEnvironment } from "./loader-hdr/load-hdr.js";
export { loadTexture2D } from "./texture/texture-2d.js";
export { loadSkybox } from "./loader-skybox/load-skybox.js";
export { loadSplat } from "./loader-splat/load-splat.js";
export { loadSOG } from "./loader-splat/load-sog.js";
export { loadSPZ } from "./loader-splat/load-spz.js";
export type { GaussianSplattingMesh } from "./mesh/GaussianSplatting/gaussian-splatting-mesh.js";
export { bakeCurrentTransformIntoVertices, bakeTransformIntoVertices } from "./mesh/GaussianSplatting/gaussian-splatting-bake.js";
export type { GsShaderFragment, GsFragmentSlot } from "./mesh/GaussianSplatting/gaussian-splatting-mesh.js";
export { createProceduralGaussianSplattingMesh } from "./mesh/GaussianSplatting/create-gaussian-splatting-mesh.js";

// ─── Shadows ─────────────────────────────────────────────────────────
export { createEsmDirectionalShadowGenerator } from "./shadow/esm-directional-shadow-generator.js";
export { createPcfSpotlightShadowGenerator } from "./shadow/pcf-spotlight-shadow-generator.js";
export { createPcfDirectionalShadowGenerator } from "./shadow/pcf-directional-shadow-generator.js";
export { setShadowTaskCasterMeshes } from "./frame-graph/shadow-inputs.js";

// ─── Animation ───────────────────────────────────────────────────────
export { createAnimationController } from "./skeleton/skeleton-updater.js";
export { createAnimationGroups, playAnimation, pauseAnimation, stopAnimation, goToFrame } from "./animation/animation-group.js";
export { crossFadeAnimationGroups, fadeAnimationWeight, setAnimationWeight } from "./animation/animation-weight.js";
export { enableAnimationBlending, setAnimationAdditive } from "./animation/weighted-gltf-mixer.js";
export type { CrossFadeAnimationGroupsOptions, FadeAnimationWeightOptions } from "./animation/animation-weight.js";
export type { AnimationAdditiveOptions } from "./animation/weighted-gltf-mixer.js";
export {
    addAnimationGroup,
    addAnimationGroups,
    clearAnimationManager,
    createAnimationManager,
    createPropertyAnimationClip,
    createPropertyAnimationGroup,
    removeAnimationGroup,
    startAnimationManager,
    stopAnimationManager,
    updateAnimationManager,
} from "./animation/animation-manager.js";
export { createMorphTargets } from "./morph/create-morph-targets.js";
export type { MorphTargetData } from "./animation/types.js";

// ─── Math ────────────────────────────────────────────────────────────
export { normalizeVec3 } from "./math/normalize-vec3.js";
export { mat4Translation } from "./math/mat4-translation.js";
export { mat4Identity } from "./math/mat4-identity.js";
export { mat4Scale } from "./math/mat4-scale.js";
export { mat4Compose } from "./math/mat4-compose.js";
export type { Vec3, Vec3Tuple } from "./math/types.js";

// ─── Thin Instances ──────────────────────────────────────────────────
export { addThinInstance, removeThinInstance, setThinInstanceMatrix, setThinInstances, flushThinInstances, setThinInstanceColors } from "./mesh/thin-instance.js";
export type { ThinInstanceData } from "./mesh/thin-instance.js";

// ─── Types ───────────────────────────────────────────────────────────
export type { SceneContext, ImageProcessingConfig, ClipPlane } from "./scene/scene.js";
export type { ArcRotateCamera } from "./camera/arc-rotate.js";
export type { Camera, NormalizedViewport } from "./camera/camera.js";
export { getViewMatrix, getProjectionMatrix, getViewProjectionMatrix, getCameraPosition } from "./camera/camera.js";
export { getEffectiveAspectRatio } from "./camera/camera.js";
export { resolveCameraViewport } from "./camera/viewport.js";
export type { PixelViewport } from "./camera/viewport.js";
export type { FreeCamera } from "./camera/free-camera.js";
export type { Mesh, MeshGPU } from "./mesh/mesh.js";
export { ObservableVec3 } from "./math/observable-vec3.js";
export { ObservableQuat } from "./math/observable-quat.js";
export type { StandardMaterialProps, FogConfig } from "./material/standard/standard-material.js";
export type { Material, MaterialRenderFeatures, MaterialView } from "./material/material.js";
export type {
    ShaderMaterial,
    ShaderMaterialOptions,
    ShaderAttributeName,
    ShaderUniformType,
    ShaderSystemUniformName,
    ShaderUniformOption,
    ShaderUniformDecl,
    ShaderUniformValue,
    ShaderSamplerOption,
    ShaderSamplerDecl,
    ShaderDefineValue,
    ShaderDefineMap,
    ShaderDefine,
} from "./material/shader/shader-material.js";
export type {
    PbrMaterialProps,
    ClearCoatProps,
    AnisotropyProps,
    SubSurfaceProps,
    TranslucencyProps,
    ThicknessProps,
    TintProps,
    RefractionProps,
} from "./material/pbr/pbr-material.js";
export type { PointLight } from "./light/point-light.js";
export type { DirectionalLight } from "./light/directional-light.js";
export type { SpotLight } from "./light/spot-light.js";
export type { Texture2D, Texture2DOptions } from "./texture/texture-2d.js";
export type { ShadowGenerator } from "./shadow/shadow-generator.js";
export type { EsmDirectionalShadowGeneratorConfig } from "./shadow/esm-directional-shadow-generator.js";
export type { PcfSpotlightShadowGeneratorConfig } from "./shadow/pcf-spotlight-shadow-generator.js";
export type { PcfDirectionalShadowGeneratorConfig } from "./shadow/pcf-directional-shadow-generator.js";
export type { AnimationController } from "./skeleton/skeleton-updater.js";
export type { AnimationGroup } from "./animation/animation-group.js";
export type {
    AnimationKeyframe,
    AnimationKeyframeValue,
    AnimationManager,
    AnimationManagerOptions,
    CreatePropertyAnimationGroupOptions,
    PropertyAnimationClip,
    PropertyAnimationClipOptions,
    PropertyAnimationInterpolation,
    PropertyAnimationTrack,
    PropertyAnimationTrackOptions,
} from "./animation/animation-manager.js";
export type { AnimationClip, GltfAnimationData } from "./animation/types.js";
export type { SphereOptions } from "./mesh/create-sphere.js";
export type { TorusOptions } from "./mesh/create-torus.js";
export type { GroundOptions } from "./mesh/create-ground.js";
export type { CylinderOptions } from "./mesh/create-cylinder.js";
export type { PlaneOptions } from "./mesh/create-plane.js";
export type { DiscOptions } from "./mesh/create-disc.js";
export type { PolyhedronOptions } from "./mesh/create-polyhedron.js";
export type { RibbonOptions } from "./mesh/create-ribbon.js";
export type { TubeOptions } from "./mesh/create-tube.js";
export type { ExtrudeShapeOptions } from "./mesh/create-extrude.js";
export { CAP_NONE, CAP_START, CAP_END, CAP_ALL } from "./mesh/create-tube.js";

// ─── Picking ─────────────────────────────────────────────────────────
export { createGpuPicker, pickAsync, disposePicker } from "./picking/gpu-picker.js";
export type { GpuPicker } from "./picking/gpu-picker.js";
export type { PickingInfo } from "./picking/picking-info.js";
export { enableDetailedPicking } from "./picking/detailed-picking.js";
export { getPickedNormal, getPickedUV } from "./picking/picking-helpers.js";

// ─── Low-level (for advanced/custom rendering) ──────────────────────
export type { EnvironmentTextures } from "./loader-env/load-env.js";
export type { Renderable, PrePassRenderable, SceneUniformUpdater, DrawBinding, DrawUpdateContext } from "./render/renderable.js";
export type { RenderTargetSignature } from "./engine/render-target.js";

// ─── Sprites (2D) ────────────────────────────────────────────────────
export type { SpriteAtlas, SpriteFrame, SpriteSampling, GridAtlasOptions, LoadAtlasOptions } from "./sprite/shared/sprite-atlas.js";
export { createGridSpriteAtlas, loadSpriteAtlas } from "./sprite/shared/sprite-atlas.js";
export type { Sprite2DLayer, Sprite2DLayerOptions, Sprite2DProps, Sprite2DView, Sprite2DDepthMode, SpriteBlendMode } from "./sprite/sprite-2d.js";
export { createSprite2DLayer, addSprite2DIndex, updateSprite2DIndex, removeSprite2DIndex, clearSprite2DLayer, setSprite2DFrameIndex } from "./sprite/sprite-2d.js";
export type { Sprite2DHandle } from "./sprite/sprite-2d-handle.js";
export { addSprite2D, updateSprite2D, removeSprite2D, setSprite2DFrame, getSprite2DHandleIndex, isSprite2DHandleAlive } from "./sprite/sprite-2d-handle.js";
export { addDepthHostedSpriteLayer } from "./sprite/sprite-scene.js";
// ─── World-space billboards ────────────────────────────────────────
export type {
    FacingBillboardSpriteSystem,
    AxisLockedBillboardSpriteSystem,
    BillboardSpriteSystemOptions,
    BillboardSpriteInit,
    BillboardOrientation,
    BillboardDepthMode,
    BillboardBlendMode,
} from "./sprite/billboard-sprite.js";
export {
    createFacingBillboardSystem,
    createAxisLockedBillboardSystem,
    addBillboardSpriteIndex,
    updateBillboardSpriteIndex,
    removeBillboardSpriteIndex,
    clearBillboardSprites,
    setBillboardSpriteFrameIndex,
} from "./sprite/billboard-sprite.js";
export type { BillboardSpriteHandle } from "./sprite/billboard-sprite-handle.js";
export {
    addBillboardSprite,
    updateBillboardSprite,
    removeBillboardSprite,
    setBillboardSpriteFrame,
    getBillboardSpriteHandleIndex,
    isBillboardSpriteHandleAlive,
} from "./sprite/billboard-sprite-handle.js";
export { addFacingBillboardSystem, addAxisLockedBillboardSystem } from "./sprite/billboard-scene.js";
export type { SpriteRenderer, SpriteRendererOptions } from "./sprite/sprite-renderer.js";
export {
    createSpriteRenderer,
    addSpriteRendererLayer,
    removeSpriteRendererLayer,
    registerSpriteRenderer,
    unregisterSpriteRenderer,
    disposeSpriteRenderer,
} from "./sprite/sprite-renderer.js";

// ─── Physics ─────────────────────────────────────────────────────────
export {
    createHavokWorld,
    createPhysicsBody,
    createPhysicsShape,
    createPhysicsAggregate,
    setPhysicsGravity,
    getPhysicsGravity,
    setPhysicsTimestep,
    getPhysicsTimestep,
    setPhysicsVelocityLimits,
    getPhysicsVelocityLimits,
    setPhysicsBodyShape,
    setPhysicsShapeMaterial,
    setPhysicsBodyMass,
    disposePhysics,
    PhysicsShapeType,
    PhysicsMotionType,
} from "./physics/havok.js";
export type { PhysicsWorld, PhysicsBody, PhysicsShape, PhysicsAggregate, PhysicsShapeOptions, PhysicsShapeParameters, PhysicsAggregateOptions } from "./physics/havok.js";

// ─── Navigation (Recast V2) ──────────────────────────────────────────
export {
    createNavigationPluginAsync,
    createNavMesh,
    createDebugNavMeshGeometry,
    getClosestPoint,
    computePath,
    createNavCrowd,
    addAgent,
    getAgentPosition,
    getAgentVelocity,
    agentGoto,
    updateNavCrowd,
    findRandomPointAroundCircle,
    findRandomPoint,
    setNavigationRandomSeed,
    getNavigationRandomSeed,
    raycast,
    addBoxObstacle,
    addCylinderObstacle,
    removeObstacle,
    updateNavMeshObstacles,
} from "./navigation/navigation.js";
export type { NavigationPlugin, NavCrowd, NavMeshParameters, AgentParameters, OffMeshConnection, ObstacleHandle } from "./navigation/navigation.js";
