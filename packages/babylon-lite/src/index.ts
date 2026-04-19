// Babylon Lite — Public API
// Tree-shakable: import only what you use.

// ─── Core ────────────────────────────────────────────────────────────
export { createEngine, startEngine, stopEngine, resizeEngine, disposeEngine, renderOneFrame, VERSION } from "./engine/engine.js";
export { createSceneContext, createDefaultCamera, removeFromScene, onBeforeRender, addToScene, disposeScene } from "./scene/scene.js";

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

// ─── Mesh Factories (high-level) ─────────────────────────────────────
export { createSphere, createBox, createTorus, createGround, createGroundFromHeightMap } from "./mesh/mesh-factories.js";

// ─── Textures ────────────────────────────────────────────────────────
export { createSolidTexture2D } from "./texture/solid-texture.js";
export { loadKtxTexture2D } from "./texture/ktx-loader.js";

// ─── Materials ───────────────────────────────────────────────────────
export { createStandardMaterial } from "./material/standard/standard-material.js";
export { createPbrMaterial } from "./material/pbr/pbr-material.js";
export { markMaterialDirty } from "./material/material-dirty.js";
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

// ─── Shadows ─────────────────────────────────────────────────────────
export { createShadowGenerator } from "./shadow/shadow-generator.js";
export { createPcfShadowGenerator } from "./shadow/pcf-shadow-generator.js";

// ─── Animation ───────────────────────────────────────────────────────
export { createAnimationController } from "./skeleton/skeleton-updater.js";
export { createAnimationGroups, playAnimation, pauseAnimation, stopAnimation, goToFrame } from "./animation/animation-group.js";

// ─── Math ────────────────────────────────────────────────────────────
export { mat4Translation, mat4Identity, mat4Scale, mat4Compose } from "./math/mat4.js";

// ─── Thin Instances ──────────────────────────────────────────────────
export { addThinInstance, removeThinInstance, setThinInstanceMatrix, setThinInstances, flushThinInstances, setThinInstanceColors } from "./mesh/thin-instance.js";
export type { ThinInstanceData } from "./mesh/thin-instance.js";

// ─── Types ───────────────────────────────────────────────────────────
export type { EngineContext } from "./engine/engine.js";
export type { SceneContext, ImageProcessingConfig } from "./scene/scene.js";
export type { ArcRotateCamera } from "./camera/arc-rotate.js";
export type { Camera } from "./camera/camera.js";
export { getViewMatrix, getProjectionMatrix, getViewProjectionMatrix, getCameraPosition } from "./camera/camera.js";
export type { FreeCamera } from "./camera/free-camera.js";
export type { Mesh, MeshGPU } from "./mesh/mesh.js";
export { ObservableVec3 } from "./math/observable-vec3.js";
export { ObservableQuat } from "./math/observable-quat.js";
export type { StandardMaterialProps, FogConfig } from "./material/standard/standard-material.js";
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
export type { ShadowGenerator, ShadowGeneratorConfig } from "./shadow/shadow-generator.js";
export type { PcfShadowGeneratorConfig } from "./shadow/pcf-shadow-generator.js";
export type { AnimationController } from "./skeleton/skeleton-updater.js";
export type { AnimationGroup } from "./animation/animation-group.js";
export type { AnimationClip, GltfAnimationData } from "./animation/types.js";
export type { SphereOptions } from "./mesh/create-sphere.js";
export type { TorusOptions } from "./mesh/create-torus.js";
export type { GroundOptions } from "./mesh/create-ground.js";

// ─── Picking ─────────────────────────────────────────────────────────
export { createGpuPicker, pickAsync, disposePicker } from "./picking/gpu-picker.js";
export type { GpuPicker } from "./picking/gpu-picker.js";
export type { PickingInfo } from "./picking/picking-info.js";
export { enableDetailedPicking } from "./picking/detailed-picking.js";
export { getPickedNormal, getPickedUV } from "./picking/picking-helpers.js";

// ─── 2D Scene ────────────────────────────────────────────────────────
export { createScene2DContext, addToScene2D, removeFromScene2D, disposeScene2D, onBeforeRender2D } from "./scene2d/scene2d.js";
export type { Scene2DContext, Scene2DOptions } from "./scene2d/scene2d.js";
export { startEngine2D, renderSprite2DFrame } from "./scene2d/scene2d-render-loop.js";

// ─── Sprites — Family 1 (Pure 2D) ───────────────────────────────────
export { loadSpriteAtlas, createGridSpriteAtlas, createNamedSpriteAtlas, resolveSpriteFrame } from "./sprite/shared/sprite-atlas.js";
export type {
    SpriteAtlas,
    SpriteFrame,
    SpriteClip,
    SpriteSampling,
    SpriteBlendMode,
    SpriteFrameRef,
    GridAtlasOptions,
    NamedAtlasOptions,
    LoadAtlasOptions,
} from "./sprite/shared/sprite-atlas.js";
export { createSpriteClipState, evaluateSpriteClip, advanceSpriteClip } from "./sprite/shared/sprite-animation.js";
export type { SpriteClipState } from "./sprite/shared/sprite-animation.js";
export { createSprite2DLayer, addSprite2D, updateSprite2D, removeSprite2D, setSprite2DFrame, playSprite2DClip, stopSprite2DClip } from "./sprite/sprite-2d.js";
export type { Sprite2DLayer, Sprite2DLayerOptions, Sprite2DInit, Sprite2DView } from "./sprite/sprite-2d.js";
export { pickSprite2D } from "./sprite/picking/pick-2d.js";
export type { SpritePickInfo } from "./sprite/picking/pick-2d.js";

// ─── Sprites — Family 2 (Anchored, 3D scene with fixed pixel size) ──
export {
    createAnchoredSpriteLayer,
    addAnchoredSprite,
    updateAnchoredSprite,
    removeAnchoredSprite,
    setAnchoredSpriteFrame,
    playAnchoredSpriteClip,
    stopAnchoredSpriteClip,
} from "./sprite/sprite-anchored.js";
export type { AnchoredSpriteLayer, AnchoredSpriteLayerOptions, AnchoredSpriteInit } from "./sprite/sprite-anchored.js";
export { pickAnchoredSprite } from "./sprite/picking/pick-anchored.js";

// ─── Sprites — Family 3 (Billboard, 3D scene with world-unit size) ──
export { createFacingBillboardSystem } from "./sprite/sprite-billboard-facing.js";
export { createYawLockedBillboardSystem } from "./sprite/sprite-billboard-yaw.js";
export { createAxisLockedBillboardSystem } from "./sprite/sprite-billboard-axis.js";
export {
    addBillboardSprite,
    updateBillboardSprite,
    removeBillboardSprite,
    setBillboardSpriteFrame,
    playBillboardSpriteClip,
    stopBillboardSpriteClip,
} from "./sprite/sprite-billboard-shared.js";
export type { BillboardSpriteSystem, BillboardSpriteSystemOptions, BillboardSpriteInit } from "./sprite/sprite-billboard-shared.js";
export { pickBillboardSprite } from "./sprite/picking/pick-billboard.js";

// ─── Low-level (for advanced/custom rendering) ──────────────────────
export type { EnvironmentTextures } from "./loader-env/load-env.js";
export type { Renderable, PrePassRenderable, SceneUniformUpdater } from "./render/renderable.js";
