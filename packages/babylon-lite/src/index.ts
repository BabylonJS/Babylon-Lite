// Babylon Lite — Public API
// Tree-shakable: import only what you use.

// ─── Core ────────────────────────────────────────────────────────────
export {
    createEngine,
    startEngine,
    stopEngine,
    renderFrame,
    resizeEngine,
    setEngineSize,
    disposeEngine,
    setGpuTimingEnabled,
    isGpuTimingSupported,
    VERSION,
} from "./engine/engine.js";
export type { EngineContext, EngineOptions, RenderCanvas } from "./engine/engine.js";
export { setRenderTaskGpuTimingEnabled, isRenderTaskGpuTimingSupported, getRenderTaskGpuTimings } from "./engine/gpu-task-timing.js";
export type { RenderTaskGpuTiming, RenderTaskGpuTimings, RenderTaskGpuTimingStatus } from "./engine/gpu-task-timing.js";
export { createSurface, disposeSurface, resizeSurface, setSurfaceSize } from "./engine/surface.js";
export type { SurfaceContext, SurfaceOptions } from "./engine/surface.js";
export { captureScreenshot } from "./engine/screenshot.js";
export type { Screenshot } from "./engine/screenshot.js";
export {
    createSceneContext,
    createDefaultCamera,
    removeFromScene,
    setMeshVisible,
    onBeforeRender,
    onSceneDispose,
    addToScene,
    disposeScene,
    registerScene,
    registerSceneWithShadowSupport,
    unregisterScene,
} from "./scene/scene.js";
export type { SceneContextOptions } from "./scene/scene.js";
export { setFog, setClipPlane } from "./scene/scene-ubo-extras.js";
export { getFloatingOriginOffset } from "./large-world/floating-origin.js";

// Subtree visibility toggle (used to hide a node before deferring its disposal,
// e.g. streaming voxel chunks). Standalone module — bundled only when used.
export { setSubtreeVisible } from "./scene/visibility.js";

// ─── Frame graph ─────────────────────────────────────────────────────
// Scene-owned ordered list of tasks. The default scene pass is a
// RenderTask, and user tasks can render offscreen RTTs, overlays, etc.
export { getFrameGraph } from "./scene/scene.js";
export type { FrameGraph } from "./frame-graph/frame-graph.js";
export { addRenderPass, addTask, addTaskAtStart, addTaskBefore } from "./frame-graph/frame-graph-actions.js";
export { createFrameGraphContext, registerFrameGraphContext, unregisterFrameGraphContext, disposeFrameGraphContext } from "./frame-graph/frame-graph-context.js";
export type { FrameGraphContext, FrameGraphContextOptions } from "./frame-graph/frame-graph-context.js";
export type { Task } from "./frame-graph/task.js";
export type { Pass, RenderPassExecuteFunc } from "./frame-graph/pass.js";
export { addPassDependencies } from "./frame-graph/pass.js";
export type { RenderPass } from "./frame-graph/render-pass.js";
export type { RenderTask, RenderTaskConfig } from "./frame-graph/render-task.js";
export { createRenderTask, removeMeshFromTask } from "./frame-graph/render-task.js";
export { createImageProcessingTask } from "./frame-graph/image-processing-task.js";
export type { ImageProcessingSource, ImageProcessingTaskConfig } from "./frame-graph/image-processing-task.js";
export type { PostProcessTask, PostProcessTaskSettings, PostProcessAlphaMode, PostProcessSamplingMode } from "./frame-graph/post-process-task.js";
export { createCopyToTextureTask } from "./frame-graph/copy-to-texture-task.js";
export type { CopyToTextureTask, CopyToTextureTaskConfig } from "./frame-graph/copy-to-texture-task.js";
export { createGeometryRendererTask } from "./frame-graph/geometry-renderer-task.js";
export type { GeometryRendererTask, GeometryRendererTaskConfig, GeometryRendererTextureDescription } from "./frame-graph/geometry-renderer-task.js";
export { GeometryTextureType } from "./frame-graph/geometry-types.js";
export { createShadowTask } from "./frame-graph/shadow-task.js";
export type { ShadowTask } from "./frame-graph/shadow-task.js";
export type { RenderTarget, RenderTargetDescriptor } from "./engine/render-target.js";
export { createRenderTarget } from "./engine/render-target.js";
export { createRenderTargetTexture } from "./texture/rtt.js";
// Pooled GPU samplers (same descriptor → same GPUSampler). Public so consumers building their own
// sampled-texture wrappers around managed render targets don't have to reach into `engine._device`.
export { getOrCreateSampler, clearSamplerCache } from "./resource/gpu-pool.js";
// acquireTexture/releaseTexture let a consumer register the lifetime of its OWN GPU texture in Lite's
// ref-count pool, so a texture it creates (e.g. a mipped render texture for a Hi-Z pyramid) survives a
// ShaderMaterial's per-version release/acquire cycle instead of being destroyed at count 0.
export { acquireTexture, releaseTexture } from "./resource/gpu-pool.js";
export { enableSceneTransmission, enableRenderTaskTransmission } from "./frame-graph/transmission.js";
export type { TransmissionOptions, SceneColorGrab } from "./frame-graph/transmission.js";

// ─── Fullscreen Effects ─────────────────────────────────────────────
export { createEffectWrapper, setEffectUniforms, setEffectTexture, createEffectRenderTask, disposeEffectWrapper } from "./effect/effect-renderer.js";
export type { EffectBindingKind, EffectBindingLayout, EffectWrapperOptions, EffectWrapper, EffectRenderTaskConfig, EffectRenderTask } from "./effect/effect-renderer.js";
export { createEffectRenderer, registerEffectRenderer, unregisterEffectRenderer, disposeEffectRenderer } from "./effect/effect-renderer.js";
export type { EffectRendererOptions, EffectRenderer } from "./effect/effect-renderer.js";
export { createUniformEffectWrapper, setUniformEffectUniforms, createUniformEffectRenderTask, disposeUniformEffectWrapper } from "./effect/uniform-effect-renderer.js";
export type { UniformEffectWrapperOptions, UniformEffectWrapper, UniformEffectRenderTaskConfig, UniformEffectRenderTask } from "./effect/uniform-effect-renderer.js";

// ─── Post-processes ─────────────────────────────────────────────────
export { createBlackAndWhitePostProcessTask } from "./post-process/black-and-white.js";
export type { BlackAndWhitePostProcessTask, BlackAndWhitePostProcessTaskConfig } from "./post-process/black-and-white.js";
export { createAnaglyphPostProcessTask } from "./post-process/anaglyph.js";
export type { AnaglyphPostProcessTask, AnaglyphPostProcessTaskConfig } from "./post-process/anaglyph.js";
export { createBlurPostProcessTask } from "./post-process/blur.js";
export type { BlurPostProcessTask, BlurPostProcessTaskConfig } from "./post-process/blur.js";
export { createExtractHighlightsPostProcessTask } from "./post-process/extract-highlights.js";
export type { ExtractHighlightsPostProcessTask, ExtractHighlightsPostProcessTaskConfig } from "./post-process/extract-highlights.js";
export { createChromaticAberrationPostProcessTask } from "./post-process/chromatic-aberration.js";
export type { ChromaticAberrationPostProcessTask, ChromaticAberrationPostProcessTaskConfig } from "./post-process/chromatic-aberration.js";
export { createCircleOfConfusionPostProcessTask } from "./post-process/circle-of-confusion.js";
export type { CircleOfConfusionPostProcessTask, CircleOfConfusionPostProcessTaskConfig } from "./post-process/circle-of-confusion.js";
export { createBloomPostProcessTask } from "./post-process/bloom.js";
export type { BloomPostProcessTask, BloomPostProcessTaskConfig } from "./post-process/bloom.js";
export { createDepthOfFieldPostProcessTask, DepthOfFieldBlurLevel } from "./post-process/depth-of-field.js";
export type { DepthOfFieldPostProcessTask, DepthOfFieldPostProcessTaskConfig } from "./post-process/depth-of-field.js";

// ─── Camera ──────────────────────────────────────────────────────────
export { createArcRotateCamera } from "./camera/arc-rotate.js";
export { attachControl, setCameraLimits } from "./camera/arc-rotate-controls.js";
export type { AttachControlOptions, ArcRotateCameraLimits } from "./camera/arc-rotate-controls.js";
export { createFreeCamera } from "./camera/free-camera.js";
export { attachFreeControl } from "./camera/free-camera-controls.js";

// Geospatial (globe-orbit) camera
export {
    createGeospatialCamera,
    setGeospatialOrientation,
    computeLocalBasis,
    computeLookAtFromYawPitch,
    computeYawPitchFromLookAt,
    clampCenterFromPoles,
    normalizeRadians,
} from "./camera/geospatial-camera.js";
export type { GeospatialCamera, GeospatialCameraOptions, GeospatialOrientation } from "./camera/geospatial-camera.js";
export { createGeospatialLimits, getEffectivePitchMax, clampZoomDistance } from "./camera/geospatial-limits.js";
export type { GeospatialLimits } from "./camera/geospatial-limits.js";
export { attachGeospatialControls } from "./camera/geospatial-camera-controls.js";
export type { GeospatialControlOptions } from "./camera/geospatial-camera-controls.js";
export { flyGeospatialCameraToAsync } from "./camera/geospatial-camera-fly.js";
export type { GeospatialFlyOptions } from "./camera/geospatial-camera-fly.js";

// ─── Lights ──────────────────────────────────────────────────────────
export { createHemisphericLight } from "./light/hemispheric.js";
export type { HemisphericLight } from "./light/hemispheric.js";
export { createPointLight } from "./light/point-light.js";
export { createDirectionalLight } from "./light/directional-light.js";
export { createSpotLight } from "./light/spot-light.js";
export type { ClusteredLightContainer, ClusteredLightContainerOptions, ClusteredPointLight, ClusteredPointLightOptions } from "./light/clustered.js";
export { createClusteredLightContainer, createClusteredPointLight, addClusteredLightContainer, markClusteredLightContainerDirty } from "./light/clustered.js";
export type { LightBase } from "./light/types.js";
export { setMaxLights, MAX_LIGHTS } from "./light/types.js";

// ─── Mesh Factories (high-level) ─────────────────────────────────────
export {
    createSphere,
    createBox,
    createTorus,
    createTorusKnot,
    createGround,
    createGroundFromHeightMap,
    createCylinder,
    createCapsule,
    createPlane,
    createDisc,
    createPolyhedron,
    createRibbon,
    createTube,
    createExtrudeShape,
    createMeshFromData,
    updateMeshPositions,
    updateMeshNormals,
    updateMeshColors,
    updateMeshUvs,
    updateMeshUv2,
    updateMeshTangents,
    resizeMeshGeometry,
    invalidateRenderBundles,
} from "./mesh/mesh-factories.js";
export { createSphereData } from "./mesh/create-sphere.js";
export type { SphereMeshData } from "./mesh/create-sphere.js";
export { createCylinderData } from "./mesh/create-cylinder.js";
export { createCapsuleData } from "./mesh/create-capsule.js";
export type { CylinderData } from "./mesh/create-cylinder.js";
export type { CapsuleData } from "./mesh/create-capsule.js";
export { createTorusKnotData } from "./mesh/create-torus-knot.js";
export type { TorusKnotData, TorusKnotOptions } from "./mesh/create-torus-knot.js";
export { createCsgFromMesh, csgSubtract, csgIntersect, csgUnion, createMeshFromCsg } from "./mesh/csg.js";
export type { CsgSolid } from "./mesh/csg.js";
export { initializeCsg2Async, isCsg2Ready, createCsg2FromMesh, csg2Subtract, csg2Intersect, csg2Add, createMeshFromCsg2, createMeshesFromCsg2, disposeCsg2 } from "./mesh/csg2.js";
export type { Csg2Solid } from "./mesh/csg2.js";

// ─── Textures ────────────────────────────────────────────────────────
export { createSolidTexture2D } from "./texture/solid-texture.js";
export { createTexture2DFromPixels, updateTexture2DFromPixels, createRenderTexture2D } from "./texture/pixels-texture.js";
export type { PixelsTexture2DOptions, RenderTexture2DOptions } from "./texture/pixels-texture.js";
export { loadKtxTexture2D } from "./texture/ktx-loader.js";
export { loadBasisTexture2D } from "./texture/basis-loader.js";
export { setKtx2DecoderUrl } from "./texture/ktx2-loader.js";

// ─── Materials ───────────────────────────────────────────────────────
export { createStandardMaterial } from "./material/standard/create-standard-material.js";
export { createStandardNoColorMaterialView } from "./material/standard/no-color-view.js";
export { createPbrMaterial } from "./material/pbr/pbr-material.js";
export {
    createShaderMaterial,
    setShaderUniform,
    setShaderTexture,
    setShaderStorageBuffer,
    setShaderFloat,
    setShaderVector3,
    setShaderMatrix,
} from "./material/shader/shader-material.js";
export { createShaderNoColorMaterialView } from "./material/shader/no-color-view.js";
export { createShaderNormalMaterialView } from "./material/shader/normal-view.js";
export type { ShaderNormalViewConfig } from "./material/shader/normal-view.js";
export { createGridMaterial } from "./material/grid/grid-material.js";
export type { GridMaterialOptions, GridVec3 } from "./material/grid/grid-material.js";
export { createPbrNoColorMaterialView } from "./material/pbr/no-color-view.js";
export { parseNodeMaterialFromSnippet } from "./material/node/node-material.js";
export { loadNodeBlockEmitterWithGeometry } from "./material/node/node-geometry-block-loader.js";
export { createNodeNoColorMaterialView } from "./material/node/no-color-view.js";
export type { NodeMaterial, NodeInputHandle, ParseNodeMaterialOptions } from "./material/node/node-material.js";
export { createMaterialView } from "./material/material-view.js";
export { markMaterialUboDirty } from "./material/material-dirty.js";
export { rebuildMaterial } from "./material/material-rebuild.js";
export type { MaterialPlugin, MaterialPluginPoint, PluginUboField, PluginSamplerDecl, PluginTextureBinding } from "./material/plugin/material-plugin.js";
export { enableMaterialPlugins } from "./material/plugin/enable-material-plugins.js";
export { enableMaterialTracking } from "./material/observable-material.js";

// ─── Loaders ─────────────────────────────────────────────────────────
export { loadGltf } from "./loader-gltf/load-gltf.js";
export type { AssetContainer } from "./asset-container.js";
export { getContainerMeshes } from "./asset-container.js";
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
export { loadDdsEnvironment } from "./loader-env/load-dds-env.js";
export { loadHdrEnvironment } from "./loader-hdr/load-hdr.js";
export { loadTexture2D, cloneTexture2D } from "./texture/texture-2d.js";
export { loadSkybox } from "./loader-skybox/load-skybox.js";
export { loadSplat } from "./loader-splat/load-splat.js";
export { loadSOG } from "./loader-splat/load-sog.js";
export { loadSPZ } from "./loader-splat/load-spz.js";
export type { GaussianSplattingMesh } from "./mesh/GaussianSplatting/gaussian-splatting-mesh.js";
export { bakeCurrentTransformIntoVertices, bakeTransformIntoVertices } from "./mesh/GaussianSplatting/gaussian-splatting-bake.js";
export type { GsShaderFragment, GsFragmentSlot } from "./mesh/GaussianSplatting/gaussian-splatting-mesh.js";
export { createProceduralGaussianSplattingMesh } from "./mesh/GaussianSplatting/create-gaussian-splatting-mesh.js";
export { gsLinearDepthFragment, gsAlphaBlendedDepthFragment } from "./mesh/GaussianSplatting/gs-depth-fragments.js";
export { gsGpuPickingFragment, encodeIdToColor } from "./mesh/GaussianSplatting/gs-gpu-picking-fragment.js";

// ─── Linear-depth material (matches BJS DepthRenderer's linear depth output) ──
export { createLinearDepthMaterial } from "./render/linear-depth-material.js";
export type { LinearDepthMaterialOptions } from "./render/linear-depth-material.js";

// ─── Shadows ─────────────────────────────────────────────────────────
export { createEsmDirectionalShadowGenerator } from "./shadow/esm-directional-shadow-generator.js";
export { createPcfSpotlightShadowGenerator } from "./shadow/pcf-spotlight-shadow-generator.js";
export { createPcfDirectionalShadowGenerator } from "./shadow/pcf-directional-shadow-generator.js";
export { createCsmDirectionalShadowGenerator } from "./shadow/csm-directional-shadow-generator.js";
export { onCsmReceiverUpdate } from "./shadow/csm-directional-shadow-generator.js";
export { setShadowTaskCasterMeshes } from "./frame-graph/shadow-inputs.js";

// ─── Animation ───────────────────────────────────────────────────────
export { createAnimationController } from "./skeleton/skeleton-updater.js";
export { createAnimationGroups, playAnimation, pauseAnimation, stopAnimation, goToFrame } from "./animation/animation-group.js";
export { setAnimationWeight } from "./animation/animation-weight.js";
export { crossFadeAnimationGroups, enablePropertyAnimationBlending, fadeAnimationWeight } from "./animation/weighted-pointer-mixer.js";
export { enableAnimationBlending, setAnimationAdditive } from "./animation/weighted-gltf-mixer.js";
export type { CrossFadeAnimationGroupsOptions, FadeAnimationWeightOptions } from "./animation/weighted-pointer-mixer.js";
export type { AnimationAdditiveOptions } from "./animation/weighted-gltf-mixer.js";
export {
    addAnimationTask,
    clearAnimationManager,
    createAnimationManager,
    createAnimationTask,
    removeAnimationTask,
    setAnimationTaskCategoryHandler,
    startAnimationManager,
    stopAnimationManager,
    updateAnimationManager,
} from "./animation/animation-manager.js";
export { addAnimationGroup, addAnimationGroups, getAnimationGroups, removeAnimationGroup } from "./animation/animation-group-task.js";
export { createPropertyAnimationClip, createPropertyAnimationGroup } from "./animation/property-animation.js";
export type { AnimationTask, AnimationTaskCategoryHandler, AnimationTaskOptions, AnimationTaskUpdate } from "./animation/animation-manager.js";
export { createMorphTargets, setMorphTargetWeights } from "./morph/create-morph-targets.js";
export type { MorphTargetData } from "./animation/types.js";
export { bakeVat, attachVat } from "./vat/vat-baker.js";
export type { VatBakeResult, VatClip, VatHandle } from "./vat/vat-baker.js";

// ─── Math ────────────────────────────────────────────────────────────
export { normalizeVec3 } from "./math/normalize-vec3.js";
export { normalizeVec3 as normalizeVec3Object } from "./math/normalize-vec3-object.js";
export { vec3 } from "./math/vec3-ctor.js";
export { Vec3Up } from "./math/vec3-up.js";
export { addVec3 } from "./math/add-vec3.js";
export { subVec3 } from "./math/sub-vec3.js";
export { scaleVec3 } from "./math/scale-vec3.js";
export { dotVec3 } from "./math/dot-vec3.js";
export { crossVec3 } from "./math/cross-vec3.js";
export { lengthVec3 } from "./math/length-vec3.js";
export { negateVec3 } from "./math/negate-vec3.js";
export { lerpVec3 } from "./math/lerp-vec3.js";
export { writeVec3 } from "./math/write-vec3.js";
export { mat4Translation } from "./math/mat4-translation.js";
export { mat4Identity } from "./math/mat4-identity.js";
export { mat4Scale } from "./math/mat4-scale.js";
export { mat4Compose } from "./math/mat4-compose.js";
export { mat4Invert } from "./math/mat4-invert.js";
export { mat4Multiply } from "./math/mat4-multiply.js";
export { mat4LookAtLH } from "./math/mat4-look-at-lh.js";
export { mat4PerspectiveLH } from "./math/mat4-perspective-lh.js";
export { mat4FromQuat } from "./math/mat4-from-quat.js";
export type { Vec3, Vec3Tuple, Vec4, Color3, Color4, Mat4, Quat } from "./math/types.js";
export type { Aabb } from "./math/aabb.js";
export { computeAabb } from "./math/aabb.js";

// ─── Color ───────────────────────────────────────────────────────────
export { linearToSrgbByte, srgbByteToLinear, packedSrgbToLinearRgba } from "./math/color.js";

// ─── Thin Instances ──────────────────────────────────────────────────
export {
    addThinInstance,
    removeThinInstance,
    setThinInstanceMatrix,
    setThinInstances,
    setThinInstanceCount,
    flushThinInstances,
    setThinInstanceColors,
    setThinInstanceColor,
    enableThinInstanceGpuCulling,
} from "./mesh/thin-instance.js";
export {
    addHierarchyInstance,
    createHierarchyInstancePool,
    removeHierarchyInstance,
    setHierarchyInstanceCount,
    setHierarchyInstanceMatrix,
} from "./mesh/hierarchy-instance-pool.js";
export type { HierarchyInstancePool } from "./mesh/hierarchy-instance-pool.js";
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
    SheenProps,
    IridescenceProps,
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
export type { CsmDirectionalShadowGeneratorConfig } from "./shadow/csm-directional-shadow-generator.js";
export type { AnimationController } from "./skeleton/skeleton-updater.js";
export type { AnimationGroup } from "./animation/animation-group.js";
export type { AnimationManager, AnimationManagerOptions } from "./animation/animation-manager.js";
export type {
    AnimationKeyframe,
    AnimationKeyframeValue,
    CreatePropertyAnimationGroupOptions,
    PropertyAnimationClip,
    PropertyAnimationClipOptions,
    PropertyAnimationInterpolation,
    PropertyAnimationTrack,
    PropertyAnimationTrackOptions,
} from "./animation/property-animation.js";
export type { AnimationClip, GltfAnimationData } from "./animation/types.js";
export type { SphereOptions } from "./mesh/create-sphere.js";
export type { TorusOptions } from "./mesh/create-torus.js";
export type { GroundOptions } from "./mesh/create-ground.js";
export type { CylinderOptions } from "./mesh/create-cylinder.js";
export type { CapsuleOptions } from "./mesh/create-capsule.js";
export type { PlaneOptions } from "./mesh/create-plane.js";
export type { DiscOptions } from "./mesh/create-disc.js";
export type { PolyhedronOptions } from "./mesh/create-polyhedron.js";
export type { RibbonOptions } from "./mesh/create-ribbon.js";
export type { TubeOptions } from "./mesh/create-tube.js";
export type { ExtrudeShapeOptions } from "./mesh/create-extrude.js";
export { CAP_NONE, CAP_START, CAP_END, CAP_ALL } from "./mesh/create-tube.js";

// ─── Picking ─────────────────────────────────────────────────────────
export { createGpuPicker, pickAsync, disposePicker } from "./picking/gpu-picker.js";
export type { GpuPicker, PickDiscardRule, PickOptions } from "./picking/gpu-picker.js";
export type { PickingInfo } from "./picking/picking-info.js";
export { enableDetailedPicking } from "./picking/detailed-picking.js";
export { getPickedNormal, getPickedUV } from "./picking/picking-helpers.js";

// ─── Gizmos ──────────────────────────────────────────────────────────
export { createUtilityLayer, registerUtilityLayer, disposeUtilityLayer } from "./gizmo/utility-layer.js";
export type { UtilityLayer, UtilityLayerOptions } from "./gizmo/utility-layer.js";
export { createPointerDrag, registerPointerDrag, isGizmoInteracting, isGizmoDragging, isGizmoPickPending } from "./gizmo/pointer-drag.js";
export type { PointerDrag, PointerDragOptions, PointerDragStartEvent, PointerDragMoveEvent, PointerDragEndEvent } from "./gizmo/pointer-drag.js";
export { createAxisDragGizmo, attachAxisDragGizmoToNode, disposeAxisDragGizmo } from "./gizmo/axis-drag-gizmo.js";
export type { AxisDragGizmo, AxisDragGizmoOptions } from "./gizmo/axis-drag-gizmo.js";
export { createPlaneDragGizmo, attachPlaneDragGizmoToNode, disposePlaneDragGizmo } from "./gizmo/plane-drag-gizmo.js";
export type { PlaneDragGizmo, PlaneDragGizmoOptions } from "./gizmo/plane-drag-gizmo.js";
export { createPlaneRotationGizmo, attachPlaneRotationGizmoToNode, disposePlaneRotationGizmo } from "./gizmo/plane-rotation-gizmo.js";
export type { PlaneRotationGizmo, PlaneRotationGizmoOptions } from "./gizmo/plane-rotation-gizmo.js";
export { createAxisScaleGizmo, attachAxisScaleGizmoToNode, disposeAxisScaleGizmo } from "./gizmo/axis-scale-gizmo.js";
export type { AxisScaleGizmo, AxisScaleGizmoOptions } from "./gizmo/axis-scale-gizmo.js";
export { createPositionGizmo, attachPositionGizmoToNode, setPositionGizmoLocalCoordinates, disposePositionGizmo } from "./gizmo/composite-gizmos.js";
export type { PositionGizmo, PositionGizmoOptions } from "./gizmo/composite-gizmos.js";
export { createRotationGizmo, attachRotationGizmoToNode, setRotationGizmoLocalCoordinates, disposeRotationGizmo } from "./gizmo/composite-gizmos.js";
export type { RotationGizmo, RotationGizmoOptions } from "./gizmo/composite-gizmos.js";
export { createScaleGizmo, attachScaleGizmoToNode, setScaleGizmoLocalCoordinates, disposeScaleGizmo } from "./gizmo/composite-gizmos.js";
export type { ScaleGizmo, ScaleGizmoOptions } from "./gizmo/composite-gizmos.js";
export { createCameraGizmo, attachCameraGizmoToCamera, disposeCameraGizmo } from "./gizmo/camera-gizmo.js";
export type { CameraGizmo, CameraGizmoOptions } from "./gizmo/camera-gizmo.js";
export { createLightGizmo, attachLightGizmoToLight, disposeLightGizmo } from "./gizmo/light-gizmo.js";
export type { LightGizmo, LightGizmoOptions } from "./gizmo/light-gizmo.js";
export { createBoundingBoxGizmo, attachBoundingBoxGizmoToNode, disposeBoundingBoxGizmo } from "./gizmo/bounding-box-gizmo.js";
export type { BoundingBoxGizmo, BoundingBoxGizmoOptions } from "./gizmo/bounding-box-gizmo.js";

// ─── Low-level (for advanced/custom rendering) ──────────────────────
export type { EnvironmentTextures } from "./loader-env/load-env.js";
export type { Renderable, PrePassRenderable, SceneUniformUpdater, DrawBinding, DrawUpdateContext } from "./render/renderable.js";
export type { RenderTargetSignature } from "./engine/render-target.js";

// ─── Sprites (2D) ────────────────────────────────────────────────────
export type { SpriteAtlas, SpriteFrame, SpriteSampling, GridAtlasOptions, LoadAtlasOptions } from "./sprite/shared/sprite-atlas.js";
export { createGridSpriteAtlas, loadSpriteAtlas } from "./sprite/shared/sprite-atlas.js";
export type { SpriteAtlasFrameSource, SpriteAtlasPackOptions } from "./sprite/shared/sprite-atlas-packer.js";
export { appendSpriteAtlasFrames, createSpriteAtlasFromFrames } from "./sprite/shared/sprite-atlas-packer.js";
export type { Sprite2DLayer, Sprite2DLayerOptions, Sprite2DProps, Sprite2DView, Sprite2DDepthMode, SpriteBlendMode } from "./sprite/sprite-2d.js";
export type { SpriteBlendDescriptor } from "./sprite/sprite-blend.js";
export { spriteBlendAlpha, spriteBlendPremultiplied, spriteBlendAdditive, spriteBlendMultiply } from "./sprite/sprite-blend.js";
export {
    createSprite2DLayer,
    addSprite2DIndex,
    updateSprite2DIndex,
    removeSprite2DIndex,
    clearSprite2DLayer,
    setSprite2DFrameIndex,
    setSprite2DShaderParams,
    setSprite2DUvOffset,
} from "./sprite/sprite-2d.js";
export type { CustomShaderTexture } from "./sprite/custom-shader-core.js";
export type { Sprite2DCustomShader, Sprite2DCustomShaderOptions, Sprite2DCustomTexture } from "./sprite/sprite-custom-shader.js";
export { createSprite2DCustomShader } from "./sprite/sprite-custom-shader.js";
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
export type { BillboardBlendDescriptor } from "./sprite/billboard-blend.js";
export { billboardBlendAlpha, billboardBlendPremultiplied, billboardBlendCutout, billboardBlendAdditive } from "./sprite/billboard-blend.js";
export {
    createFacingBillboardSystem,
    createAxisLockedBillboardSystem,
    addBillboardSpriteIndex,
    updateBillboardSpriteIndex,
    removeBillboardSpriteIndex,
    clearBillboardSprites,
    setBillboardSpriteFrameIndex,
    setBillboardShaderParams,
} from "./sprite/billboard-sprite.js";
export type { BillboardCustomShader, BillboardCustomShaderOptions, BillboardCustomTexture } from "./sprite/billboard-custom-shader.js";
export { createBillboardCustomShader } from "./sprite/billboard-custom-shader.js";
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
// ─── Sprite Animation (Optional) ─────────────────────────────────────
export type {
    SpriteAnimationBinding,
    SpriteAnimationManager,
    SpriteAnimationManagerOptions,
    SpriteAnimationTarget,
    SpriteFrameAnimation,
    PlaySpriteAnimationOptions,
} from "./sprite/sprite-animation.js";
export {
    createSpriteAnimationManager,
    createSpriteFrameAnimation,
    addSpriteAnimation,
    removeSpriteAnimation,
    clearSpriteAnimations,
    updateSpriteAnimationManager,
    playSpriteFrameAnimation,
    stopSpriteAnimation,
    attachSpriteAnimationsToScene,
    attachSpriteAnimationsToRenderer,
    disposeSpriteAnimationBinding,
} from "./sprite/sprite-animation.js";
export { addSpriteAnimationManager, removeSpriteAnimationManager, startSpriteAnimationManager, stopSpriteAnimationManager } from "./sprite/sprite-animation-task.js";
export { playSprite2DIndexAnimation } from "./sprite/sprite-2d-index-animation.js";
export { playSprite2DAnimation } from "./sprite/sprite-2d-handle-animation.js";
export { playBillboardSpriteIndexAnimation } from "./sprite/billboard-sprite-index-animation.js";
export { playBillboardSpriteAnimation } from "./sprite/billboard-sprite-handle-animation.js";
export type { SpriteRenderer, SpriteRendererOptions } from "./sprite/sprite-renderer.js";
export {
    createSpriteRenderer,
    addSpriteRendererLayer,
    removeSpriteRendererLayer,
    registerSpriteRenderer,
    unregisterSpriteRenderer,
    setSpriteRendererTarget,
    disposeSpriteRenderer,
} from "./sprite/sprite-renderer.js";

// ─── Text ────────────────────────────────────────────────────────────
export type { Font } from "./text/font.js";
export { loadFont, createFontFromBuffer } from "./text/font.js";
export { extractGlyphCurves, cubicToQuadratics } from "./text/glyph-extraction.js";
export type { TextLayoutOptions } from "./text/layout.js";
export type { GlyphStorage, CurveSetId, QuadCurve, GlyphBounds, GlyphCurves } from "./text/glyph-storage.js";
export { createGlyphStorage, updateGlyphStorage, disposeGlyphStorage } from "./text/glyph-storage.js";
export type { TextData, PlacedGlyph, GlyphRun, TextDataUpdate } from "./text/text-data.js";
export { createTextData, updateTextData, disposeTextData } from "./text/text-data.js";
export type { DefaultTextData } from "./text/default-text-data.js";
export { createDefaultTextData, updateDefaultTextData, disposeDefaultTextData } from "./text/default-text-data.js";
export type { TextRenderableOptions, TextRenderable } from "./text/text-renderable.js";
export { createTextRenderable, disposeTextRenderable, addTextRenderable } from "./text/text-renderable.js";
export type { TextLayer, TextLayerOptions, TextRenderer, TextRendererOptions } from "./text/text-renderer.js";
export {
    createTextLayer,
    setTextLayerPosition,
    createTextRenderer,
    addTextRendererLayer,
    removeTextRendererLayer,
    registerTextRenderer,
    unregisterTextRenderer,
    disposeTextRenderer,
} from "./text/text-renderer.js";

// ─── Physics ─────────────────────────────────────────────────────────
export {
    createHavokWorld,
    enableHavokFloatingOrigin,
    createPhysicsBody,
    createPhysicsShape,
    createPhysicsAggregate,
    createPhysicsConstraint,
    setPhysicsGravity,
    getPhysicsGravity,
    setPhysicsTimestep,
    getPhysicsTimestep,
    onPhysicsAfterStep,
    setPhysicsVelocityLimits,
    getPhysicsVelocityLimits,
    setPhysicsBodyShape,
    setPhysicsBodyPreStep,
    setPhysicsBodyPrestepType,
    applyPhysicsBodyImpulse,
    applyPhysicsBodyForce,
    addPhysicsShapeChild,
    addPhysicsShapeChildFromParent,
    setPhysicsShapeFilterMembershipMask,
    setPhysicsShapeFilterCollideMask,
    setPhysicsShapeMaterial,
    setPhysicsBodyMass,
    setPhysicsBodyMassProperties,
    applyPhysicsImpulse,
    setPhysicsBodyLinearVelocity,
    getPhysicsBodyLinearVelocity,
    setPhysicsBodyAngularVelocity,
    setPhysicsBodyMotionType,
    setPhysicsBodyTransform,
    removePhysicsBody,
    releasePhysicsShape,
    disposePhysics,
    PhysicsShapeType,
    PhysicsMotionType,
    PhysicsPrestepType,
    PhysicsConstraintType,
    PhysicsConstraintAxis,
} from "./physics/havok.js";
export type {
    PhysicsWorld,
    PhysicsBody,
    PhysicsShape,
    PhysicsAggregate,
    PhysicsConstraint,
    PhysicsShapeOptions,
    PhysicsShapeParameters,
    PhysicsAggregateOptions,
    PhysicsMassProperties,
    PhysicsConstraintOptions,
    PhysicsConstraintLimit,
} from "./physics/havok.js";
export { createHeightFieldShape } from "./physics/havok-heightfield.js";
export type { HeightFieldShapeOptions } from "./physics/havok-heightfield.js";
export { shapeProximity, shapeCast, physicsRaycast } from "./physics/havok-queries.js";
export type { ShapeProximityQuery, ShapeCastQuery, ShapeProximityResult, ShapeCastResult, RaycastQuery, RaycastResult } from "./physics/havok-queries.js";
export { setPhysicsBodyCollisionEventsEnabled, onPhysicsCollision } from "./physics/havok-collision.js";
export type { PhysicsCollisionInfo } from "./physics/havok-collision.js";
export { setPhysicsShapeIsTrigger, onPhysicsTrigger } from "./physics/havok-trigger.js";
export type { PhysicsTriggerInfo } from "./physics/havok-trigger.js";
export { createPhysicsViewer, showPhysicsBody, showPhysicsConstraint, hidePhysicsBody, disposePhysicsViewer } from "./physics/physics-viewer.js";
export type { PhysicsViewer, PhysicsViewerOptions, PhysicsConstraintDebug } from "./physics/physics-viewer.js";
export { createPhysicsCharacterController, PhysicsCharacterController, CharacterSupportedState, CharacterCollisionObservable } from "./physics/character-controller.js";
export type { PhysicsCharacterControllerOptions, CharacterSurfaceInfo, CharacterCollisionEvent } from "./physics/character-controller.js";

// ─── Navigation (Recast V2) ──────────────────────────────────────────
export {
    createNavigationPluginAsync,
    createNavMesh,
    createNavMeshFromSources,
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
export type { NavigationPlugin, NavCrowd, NavMeshParameters, NavMeshSource, AgentParameters, OffMeshConnection, ObstacleHandle } from "./navigation/navigation.js";
