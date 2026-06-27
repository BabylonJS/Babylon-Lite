/**
 * `@babylonjs/lite-compat` — an opt-in Babylon.js-shaped API implemented on top
 * of the Babylon Lite public API.
 *
 * This package is a migration runway: port a Babylon.js scene with minimal
 * friction, then move to native Babylon Lite APIs incrementally. It covers the
 * common scene subset (engine, scene, cameras, lights, meshes, materials,
 * loaders, math, animation easing). Unsupported Babylon.js APIs throw
 * {@link LiteCompatError} so porting gaps are discoverable rather than silent.
 *
 * See `COMPAT-STATUS.md` for the per-feature support matrix.
 */

// ─── Errors ──────────────────────────────────────────────────────────
export { LiteCompatError, unsupported } from "./error.js";

// ─── Math ────────────────────────────────────────────────────────────
export { Vector2, Vector3, Vector4 } from "./math/vector.js";
export { Color3, Color4 } from "./math/color.js";
export { Quaternion } from "./math/quaternion.js";
export { Matrix, transformCoordinates, transformNormal } from "./math/matrix.js";
export { Scalar, Epsilon, ToRadians, ToDegrees } from "./math/scalar.js";
export { Axis, Space } from "./math/constants.js";
export { Plane } from "./math/plane.js";
export { Ray } from "./math/ray.js";
export { Frustum } from "./math/frustum.js";
export { Size, Viewport } from "./math/size.js";
export { Angle, Curve3, Path3D } from "./math/curve.js";

// ─── Culling ─────────────────────────────────────────────────────────
export { BoundingBox, BoundingSphere, BoundingInfo } from "./culling/bounding.js";

// ─── Engine ──────────────────────────────────────────────────────────
export { AbstractEngine, ThinEngine, WebGPUEngine, Engine, NullEngine } from "./engine/engine.js";

// ─── Scene graph ─────────────────────────────────────────────────────
export { Node } from "./node/node.js";
export { AbstractScene } from "./scene/abstract-scene.js";
export { Scene } from "./scene/scene.js";

// ─── Cameras ─────────────────────────────────────────────────────────
export {
    Camera,
    ArcRotateCamera,
    TargetCamera,
    FreeCamera,
    UniversalCamera,
    TouchCamera,
    GamepadCamera,
    FlyCamera,
    FollowCamera,
    GeospatialCamera,
    DeviceOrientationCamera,
    WebXRCamera,
    AnaglyphArcRotateCamera,
} from "./cameras/cameras.js";

// ─── Lights ──────────────────────────────────────────────────────────
export { Light, HemisphericLight, DirectionalLight, PointLight, SpotLight } from "./lights/lights.js";

// ─── Meshes ──────────────────────────────────────────────────────────
export { Mesh, AbstractMesh, TransformNode, GroundMesh, InstancedMesh, VertexData, VertexBuffer, MeshBuilder } from "./meshes/meshes.js";
export { CreateBox, CreateSphere, CreateGround, CreatePlane, CreateCylinder, CreateTorus, CreateDisc } from "./meshes/meshes.js";
export { CSG, CSG2, InitializeCSG2Async } from "./meshes/csg.js";
export { MeshoptCompression } from "./meshes/compression.js";
export { MorphTarget, MorphTargetManager } from "./morph/morph.js";
export { GaussianSplattingMesh } from "./meshes/gaussian-splatting.js";

// ─── Materials ───────────────────────────────────────────────────────
export {
    Material,
    PushMaterial,
    StandardMaterial,
    PBRMaterial,
    PBRMetallicRoughnessMaterial,
    PBRSpecularGlossinessMaterial,
    PBRClearCoatConfiguration,
    PBRSheenConfiguration,
    PBRAnisotropicConfiguration,
    PBRIridescenceConfiguration,
} from "./materials/materials.js";

// ─── Textures ────────────────────────────────────────────────────────
export { BaseTexture, Texture, RawTexture, DynamicTexture, CubeTexture, HDRCubeTexture, RenderTargetTexture } from "./textures/textures.js";

// ─── Loading ─────────────────────────────────────────────────────────
export { SceneLoader, AssetContainer, ImportMeshAsync, AppendSceneAsync, LoadAssetContainerAsync } from "./loading/scene-loader.js";
export { AssetsManager, AbstractAssetTask, CustomAssetTask } from "./loading/assets-manager.js";
export { KHR_materials_variants } from "./loading/material-variants.js";

// ─── Picking ─────────────────────────────────────────────────────────
export { GPUPicker } from "./picking/gpu-picker.js";
export type { IGPUPickingInfo, IGPUMultiPickingInfo } from "./picking/gpu-picker.js";

// ─── Gizmos ──────────────────────────────────────────────────────────
export {
    UtilityLayerRenderer,
    PositionGizmo,
    RotationGizmo,
    ScaleGizmo,
    BoundingBoxGizmo,
    LightGizmo,
    CameraGizmo,
    GizmoManager,
    AxisDragGizmo,
    PlaneRotationGizmo,
    PlaneDragGizmo,
    AxisScaleGizmo,
} from "./gizmos/gizmos.js";

// ─── Behaviors ───────────────────────────────────────────────────────
export { AutoRotationBehavior, BouncingBehavior, FramingBehavior } from "./behaviors/behaviors.js";
export type { Behavior } from "./behaviors/behaviors.js";

// ─── Sprites ─────────────────────────────────────────────────────────
export { SpriteManager, Sprite, SpriteRenderer, ThinSprite } from "./sprites/sprites.js";

// ─── Shadows ─────────────────────────────────────────────────────────
export { ShadowGenerator, CascadedShadowGenerator } from "./shadows/shadow-generator.js";
export { NodeMaterial } from "./materials/node-material.js";
export { GridMaterial } from "./materials/grid-material.js";

// ─── Animation ───────────────────────────────────────────────────────
export { Animation, AnimationGroup, AnimationTypes, AnimationLoopModes, AnimationKeyInterpolation, Animatable } from "./animations/animation.js";
export type { IAnimationKey, AnimationGroupState } from "./animations/animation.js";
export {
    EasingFunction,
    CircleEase,
    QuadraticEase,
    CubicEase,
    QuarticEase,
    QuinticEase,
    SineEase,
    ExponentialEase,
    BackEase,
    ElasticEase,
    BounceEase,
    EASINGMODE_EASEIN,
    EASINGMODE_EASEOUT,
    EASINGMODE_EASEINOUT,
} from "./animations/easing.js";

// ─── Misc ────────────────────────────────────────────────────────────
export { Observable } from "./misc/observable.js";
export { Tools } from "./misc/tools.js";
export { SmartArray, StringDictionary, Tags, PerformanceMonitor, FactorGradient, ColorGradient, Logger, PrecisionDate } from "./misc/misc-utils.js";
export { ScenePerformancePriority, ShaderLanguage, ImageProcessingConfiguration, Constants } from "./misc/engine-constants.js";

// ─── Actions ─────────────────────────────────────────────────────────
export {
    ActionManager,
    Action,
    ExecuteCodeAction,
    SetValueAction,
    IncrementValueAction,
    Condition,
    ValueCondition,
    PredicateCondition,
    ValueConditionOperators,
    ActionManagerTriggers,
} from "./actions/actions.js";

// ─── Audio (AudioV2) ─────────────────────────────────────────────────
export { SoundState, AudioParameterRampShape, SpatialAudioAttachmentType } from "./audio/audio-enums.js";
export type { AudioAnalyzerFFTSizeType, AudioEngineV2State, IAudioParameterRampOptions } from "./audio/audio-enums.js";
export {
    AbstractAudioNode,
    AbstractNamedAudioNode,
    AbstractAudioOutNode,
    AbstractAudioBus,
    AudioBus,
    MainAudioBus,
    AbstractSoundSource,
    SoundSource,
    AbstractSound,
    StaticSound,
    StreamingSound,
    StaticSoundBuffer,
    AudioEngineV2,
    AbstractSpatialAudio,
    AbstractSpatialAudioListener,
    AbstractStereoAudio,
    AbstractAudioAnalyzer,
    CreateAudioEngineAsync,
    CreateSoundAsync,
    CreateSoundBufferAsync,
    CreateStreamingSoundAsync,
    CreateAudioBusAsync,
    CreateMainAudioBusAsync,
    CreateSoundSourceAsync,
    CreateMicrophoneSoundSourceAsync,
    LastCreatedAudioEngine,
    OnAudioEngineV2CreatedObservable,
} from "./audio/audio.js";
export type {
    PrimaryAudioBus,
    StaticSoundSource,
    SpatialNodeLike,
    IAudioNodeNameChange,
    IAudioEngineV2Options,
    IWebAudioEngineOptions,
    IVolumeAudioOptions,
    IAudioAnalyzerOptions,
    IStereoAudioOptions,
    ISpatialAudioOptions,
    IStaticSoundBufferOptions,
    IAbstractSoundOptions,
    IStaticSoundOptions,
    IStaticSoundPlayOptions,
    IStaticSoundStopOptions,
    IStaticSoundCloneOptions,
    IStreamingSoundOptions,
    IStreamingSoundPlayOptions,
    IAudioBusOptions,
    IMainAudioBusOptions,
    ISoundSourceOptions,
} from "./audio/audio.js";

// ─── Known but unsupported (throw LiteCompatError on use) ─────────────
export {
    MultiMaterial,
    ShaderMaterial,
    BackgroundMaterial,
    RectAreaLight,
    ClusteredLightContainer,
    ParticleSystem,
    GPUParticleSystem,
    SolidParticleSystem,
    HighlightLayer,
    GlowLayer,
    LinesMesh,
    GreasedLineMesh,
    EdgesRenderer,
    OutlineRenderer,
    MirrorTexture,
    Sound,
    SceneSerializer,
} from "./unsupported/unsupported-apis.js";
export {
    Skeleton,
    Bone,
    ReflectionProbe,
    Layer,
    EffectLayer,
    DepthRenderer,
    GeometryBufferRenderer,
    BoundingBoxRenderer,
    PostProcess,
    BlackAndWhitePostProcess,
    BlurPostProcess,
    BloomEffect,
    ChromaticAberrationPostProcess,
    DepthOfFieldEffect,
    DefaultRenderingPipeline,
    FxaaPostProcess,
    SSAO2RenderingPipeline,
    ParticleHelper,
    ParticleSystemSet,
    PointsCloudSystem,
    HavokPlugin,
    PhysicsAggregate,
    PhysicsBody,
    PhysicsShape,
    CannonJSPlugin,
    AmmoJSPlugin,
    RecastJSPlugin,
    AudioEngine,
    WeightedSound,
    OBJFileLoader,
    STLFileLoader,
    FBXFileLoader,
    BVHFileLoader,
    SpriteMap,
    SpritePackedManager,
    VirtualJoystick,
    SceneOptimizer,
} from "./unsupported/unsupported-extended.js";
