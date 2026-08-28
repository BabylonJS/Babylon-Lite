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
export { Polar } from "./math/polar.js";
export { Spherical } from "./math/spherical.js";
export { Angle, Curve3, Path3D } from "./math/curve.js";

// ─── Culling ─────────────────────────────────────────────────────────
export { BoundingBox, BoundingSphere, BoundingInfo } from "./culling/bounding.js";
export { PickingInfo } from "./culling/picking-info.js";

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
export { ClusteredLightContainer } from "./lights/clustered-light-container.js";

// ─── Meshes ──────────────────────────────────────────────────────────
export { Mesh, LinesMesh, AbstractMesh, TransformNode, GroundMesh, InstancedMesh, VertexData, VertexBuffer, MeshBuilder } from "./meshes/meshes.js";
export {
    CreateBox,
    CreateSphere,
    CreateGround,
    CreatePlane,
    CreateCylinder,
    CreateTorus,
    CreateDisc,
    CreateLines,
    CreateLineSystem,
    CreateDashedLines,
    CreateTiledBox,
    CreateTiledPlane,
} from "./meshes/meshes.js";
export { CSG, CSG2, InitializeCSG2Async } from "./meshes/csg.js";
export { MeshoptCompression } from "./meshes/compression.js";
export { MorphTarget, MorphTargetManager } from "./morph/morph.js";
export { GaussianSplattingMesh } from "./meshes/gaussian-splatting.js";
export type { ISafeOrbitCameraLimits } from "./meshes/gaussian-splatting.js";

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
export { BaseTexture, Texture, RawTexture, RawTexture3D, DynamicTexture, CubeTexture, HDRCubeTexture, RenderTargetTexture } from "./textures/textures.js";
export {
    RawTexture2DArray,
    UploadImageToTexture2DArrayLayer,
    LoadImageToTexture2DArrayLayerAsync,
    CreateTexture2DArrayFromImageUrlsAsync,
    CreateTexture2DArrayFromKTX2Async,
} from "./textures/raw-texture-2d-array.js";
export type { IUploadImageToTexture2DArrayLayerOptions, ICreateTexture2DArrayFromImageUrlsOptions, ICreateTexture2DArrayFromKTX2Options } from "./textures/raw-texture-2d-array.js";

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
export { GetSupportedSimultaneousLights } from "./materials/material-helpers.js";

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
export { RandomGUID, GUID } from "./misc/guid.js";
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
    GPUParticleSystem,
    SolidParticleSystem,
    HighlightLayer,
    GlowLayer,
    GreasedLineMesh,
    GreasedLineBaseMesh,
    GreasedLineRibbonMesh,
    GreasedLinePluginMaterial,
    MaterialGreasedLineDefines,
    GreasedLineMaterialDefaults,
    RegisterGreasedLinePluginMaterial,
    GreasedLineSimpleMaterial,
    GreasedLineTools,
    CreateGreasedLine,
    CreateGreasedLineMaterial,
    GetPointsCount,
    CompleteGreasedLineWidthTable,
    CompleteGreasedLineColorTable,
    GreasedLineMeshColorDistribution,
    GreasedLineMeshWidthDistribution,
    GreasedLineRibbonPointsMode,
    GreasedLineRibbonFacesMode,
    GreasedLineRibbonAutoDirectionMode,
    EdgesRenderer,
    OutlineRenderer,
    MirrorTexture,
    HtmlTexture,
    HtmlInteractionManager,
    HtmlRaycastInteractionManager,
    IsHtmlInCanvasUploadSupported,
    UploadHtmlElementToTexture,
    ComputeOverlayCssTransform,
    GetElementPixelFromUv,
    IsHtmlInCanvasSupportedNatively,
    InstallHtmlInCanvasPolyfill,
    UninstallHtmlInCanvasPolyfill,
    GaussianSplattingStream,
    AddGaussianSplattingStreamPart,
    AddGaussianSplattingStreamPartAsync,
    Sound,
    PointerDragBehavior,
    BaseSixDofDragBehavior,
    SixDofDragBehavior,
    MultiPointerScaleBehavior,
    AttachToBoxBehavior,
    FadeInOutBehavior,
    SurfaceMagnetismBehavior,
    FollowBehavior,
    HandConstraintBehavior,
    InterpolatingBehavior,
    GeospatialClippingBehavior,
    SceneSerializer,
} from "./unsupported/unsupported-apis.js";
export type {
    IHtmlTextureOptions,
    IHtmlInteractionManagerOptions,
    IHtmlRaycastInteractionManagerOptions,
    IHtmlInCanvasPolyfillModule,
    IInstallHtmlInCanvasPolyfillOptions,
    GaussianSplattingStreamDebugLodSource,
    IGaussianSplattingStreamOptions,
    ISOGLODMetadata,
    IGaussianSplattingStreamingPart,
} from "./unsupported/unsupported-apis.js";
export {
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
    FSR1RenderingPipeline,
    ThinFSR1UpscalePostProcess,
    ThinFSR1SharpenPostProcess,
    ParticleHelper,
    PointsCloudSystem,
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
export { Skeleton, Bone } from "./bones/skeleton.js";

export {
    HavokPlugin,
    PhysicsEngine,
    PhysicsAggregate,
    PhysicsBody,
    PhysicsShape,
    PhysicsShapeType,
    PhysicsMotionType,
    PhysicsPrestepType,
    PhysicsConstraintType,
    PhysicsCharacterController,
    CharacterSupportedState,
} from "./physics/physics.js";
export type {
    PhysicsAggregateParameters,
    PhysicsMaterial,
    PhysicShapeOptions,
    CharacterShapeOptions,
    CharacterSurfaceInfo,
    ICharacterControllerCollisionEvent,
} from "./physics/physics.js";

// ─── Node Particle Editor (NPE) ──────────────────────────────────────
export { NodeParticleSystemSet, ParticleSystemSet } from "./particles/node-particle-system-set.js";
export { ParticleSystem } from "./particles/particle-system.js";
