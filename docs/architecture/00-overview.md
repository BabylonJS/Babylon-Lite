# Babylon Lite — Architecture Specification (One-Shot Document)

> **Purpose**: This document is the formal specification of Babylon Lite's architecture.
> It must be so complete that if all source code were deleted, an LLM could perfectly
> regenerate the entire engine from this document alone. Treat this as the ground truth.
>
> **Revision scope**: Scenes 1–112 (BoomBox PBR, Sphere+DirectionalLight, Fog+Boxes+Skybox, Shadows+ESM,
> Alien PBR+Skeleton, PBR Gold Sphere, ChibiRex Animated, HDR Glass Sphere, Sponza, PBR Rough Sphere,
> Shark GLB, PBR Shader Balls, PBR Spheres Grid, Flight Helmet, SpotLights+Ground, Thin Instances,
> PBR+Standard Thin Instances, Spotlight Hard Shadows (PCF), PBR Clearcoat, PBR Emissive Spheres Grid,
> PBR Sheen Cloth, PBR Shadows, PBR Anisotropy, Hill Valley (.babylon), KTX Texture, PBR Subsurface,
> Material Variants (KHR_materials_variants), CSG/CSG2, and FlightHelmetKTX via `KHR_texture_basisu`).
> Detailed per-module specs are in the companion docs listed below.

## Architecture Document Index

| Doc                                                                | Module                  | Scope                                                                                          |
| ------------------------------------------------------------------ | ----------------------- | ---------------------------------------------------------------------------------------------- |
| [00-overview.md](00-overview.md)                                   | Overview                | Repository structure, public API                                                               |
| [01-shadow-generator.md](01-shadow-generator.md)                   | Shadow Generator        | ESM + PCF shadows, depth pass, Gaussian blur                                                   |
| [03-texture-2d.md](03-texture-2d.md)                               | Texture2D               | Image upload, KTX1/KTX2, mipmap gen, invertY                                                   |
| [04-mesh-generators.md](04-mesh-generators.md)                     | Mesh Generators         | Ground/heightmap, torus, sphere, box, cylinder, plane, disc, polyhedron, ribbon, tube, extrude |
| [05-lights.md](05-lights.md)                                       | Lights                  | Hemispheric, directional, point, spot + shared lights UBO for Standard/PBR                     |
| [06-engine.md](06-engine.md)                                       | Engine                  | GPU init, MSAA, render loop, swap chain                                                        |
| [07-scene.md](07-scene.md)                                         | Scene                   | SceneContext, one-way ownership                                                                |
| [08-camera.md](08-camera.md)                                       | Camera                  | ArcRotateCamera + FreeCamera, controls                                                         |
| [09-core-math.md](09-core-math.md)                                 | Core Math               | Vec3, Mat4, Quat, ObservableVec3/Quat                                                          |
| [10-pbr-material.md](10-pbr-material.md)                           | PBR Material            | ShaderFragment composition, GGX/IBL, clearcoat, sheen                                          |
| [11-standard-material.md](11-standard-material.md)                 | Standard Material       | ShaderFragment composition, Blinn-Phong                                                        |
| [12-background-skybox.md](12-background-skybox.md)                 | Background/Skybox       | DDS/HDR/cubemap skybox, ground, background material                                            |
| [13-loaders.md](13-loaders.md)                                     | Loaders                 | glTF 2.0, dynamic glTF features, .env, .hdr, .babylon, skybox                                  |
| [14-render-pipeline.md](14-render-pipeline.md)                     | Renderable Architecture | Renderable interfaces, entity-owned pipelines                                                  |
| [15-morph-targets.md](15-morph-targets.md)                         | Morph Targets           | Vertex extension, GPU texture weights                                                          |
| [16-animation-parity-testing.md](16-animation-parity-testing.md)   | Animation Parity        | Animated scene test methodology                                                                |
| [17-thin-instances.md](17-thin-instances.md)                       | Thin Instances          | Per-instance matrix + color, PBR + Standard                                                    |
| [18-picking.md](18-picking.md)                                     | Picking                 | GPU ID pass, CPU ray/triangle intersection                                                     |
| [19-scene-hierarchy-parenting.md](19-scene-hierarchy-parenting.md) | Scene Hierarchy         | TransformNode, parenting, world matrix propagation                                             |
| [20-animation.md](20-animation.md)                                 | Animation               | AnimationGroup, keyframe evaluation, glTF integration                                          |
| [21-shader-composition.md](21-shader-composition.md)               | Shader Composition      | ShaderFragment system, composer, slot injection                                                |
| [22-skeleton.md](22-skeleton.md)                                   | Skeleton                | Bone textures, 4/8-bone skinning                                                               |
| [23-loader-hdr.md](23-loader-hdr.md)                               | HDR Loader              | RGBE parsing, SH extraction, GPU compute IBL                                                   |
| [24-loader-babylon.md](24-loader-babylon.md)                       | .babylon Loader         | .babylon format parsing                                                                        |
| [25-resource-pool.md](25-resource-pool.md)                         | Resource Pool           | GPU buffer/texture pooling                                                                     |
| [26-sprites.md](26-sprites.md)                                     | Sprites                 | 2D sprites, depth-hosted sprites, sprite renderables                                           |
| [27-frame-graph.md](27-frame-graph.md)                             | Frame Graph             | Task ordering, RenderTask, passes, render targets, RTT texture flow                            |

---

## 1. Repository Structure

```
babylon-lite/
├── GUIDANCE.md                    # Immutable core pillars & workflow (anti-amnesia)
├── package.json                   # pnpm workspace root
├── pnpm-workspace.yaml            # packages: [packages/*, apps/*]
├── tsconfig.base.json             # Shared TS config
├── vitest.config.ts               # Root test config
│
├── packages/babylon-lite/         # The engine library
│   ├── package.json               # name: "babylon-lite", type: "module"
│   ├── tsconfig.json              # extends ../../tsconfig.base.json
│   ├── vite.config.ts             # lib mode build
│   ├── src/
│   │   ├── index.ts               # Public API barrel (tree-shakable)
│   │   ├── vite-env.d.ts          # Declares ?raw WGSL imports
│   │   ├── math/                   # Math primitives
│   │   │   ├── types.ts           # Vec3, Vec4, Color3, Color4, Mat4, Quat
│   │   │   ├── vec3.ts            # Pure Vec3 functions
│   │   │   ├── mat4.ts            # Pure Mat4 functions (LH, column-major)
│   │   │   ├── observable-vec3.ts # ObservableVec3 (reactive position/target)
│   │   │   ├── observable-quat.ts # ObservableQuat (reactive rotation)
│   │   │   └── index.ts           # Math barrel
│   │   ├── engine/
│   │   │   └── engine.ts          # createEngine(), GPUDevice, swapchain, render loop
│   │   ├── scene/
│   │   │   ├── scene.ts           # createSceneContext(), flat data struct, add()
│   │   │   ├── scene-core.ts      # Core scene logic
│   │   │   ├── scene-camera.ts    # Camera management
│   │   │   ├── scene-remove.ts    # removeFromScene()
│   │   │   ├── set-parent.ts      # setParent() — parent/child transforms
│   │   │   ├── parentable.ts      # IWorldMatrixProvider, IParentable interfaces
│   │   │   ├── transform-node.ts  # TransformNode — hierarchy node without mesh
│   │   │   └── world-matrix-state.ts # Version-based world matrix propagation
│   │   ├── camera/
│   │   │   ├── camera.ts          # Camera interface
│   │   │   ├── arc-rotate.ts      # createArcRotateCamera(), ArcRotateCamera
│   │   │   ├── arc-rotate-controls.ts  # attachControl() for orbit
│   │   │   ├── free-camera.ts     # createFreeCamera(), FreeCamera
│   │   │   └── free-camera-controls.ts # attachFreeControl() for WASD/arrow
│   │   ├── light/
│   │   │   ├── light-base.ts      # Shared light base
│   │   │   ├── types.ts           # LightBase type, LightBaseInternal, MAX_LIGHTS
│   │   │   ├── light-matrix.ts    # Light view-projection for shadows
│   │   │   ├── hemispheric.ts     # createHemisphericLight()
│   │   │   ├── point-light.ts     # createPointLight()
│   │   │   ├── directional-light.ts # createDirectionalLight()
│   │   │   └── spot-light.ts      # createSpotLight()
│   │   ├── material/
│   │   │   ├── pbr/               # PBR metallic-roughness material
│   │   │   │   ├── pbr-material.ts      # PbrMaterialProps + createPbrMaterial()
│   │   │   │   ├── pbr-template.ts      # PBR shader template (WGSL generation)
│   │   │   │   ├── pbr-flags.ts         # PBR feature flag bitmask
│   │   │   │   ├── pbr-pipeline.ts      # Pipeline cache + feature flags
│   │   │   │   ├── pbr-renderable.ts    # buildPbrRenderables()
│   │   │   │   ├── pbr-single-rebuild.ts     # Single-mesh pipeline rebuild
│   │   │   │   ├── fragments/singlelight-wgsl.ts # Non-looping one-light WGSL
│   │   │   │   ├── fragments/multilight-wgsl.ts  # Generic multi-light WGSL
│   │   │   │   ├── background-material.ts    # Skybox + Ground material factories
│   │   │   │   ├── background-renderable.ts  # Skybox + Ground → Renderables
│   │   │   │   ├── background-dds-skybox.ts  # DDS environment skybox
│   │   │   │   ├── background-hdr-skybox.ts  # HDR environment skybox
│   │   │   │   ├── background-ground.ts      # Background ground plane
│   │   │   │   └── fragments/          # PBR ShaderFragment modules
│   │   │   │       ├── clearcoat-fragment.ts
│   │   │   │       ├── emissive-fragment.ts
│   │   │   │       ├── ibl-fragment.ts
│   │   │   │       ├── morph-fragment.ts
│   │   │   │       ├── pbr-shadow-fragment.ts
│   │   │   │       ├── reflectance-fragment.ts
│   │   │   │       ├── sheen-fragment.ts
│   │   │   │       └── skeleton-fragment.ts
│   │   │   └── standard/          # Standard Blinn-Phong material
│   │   │       ├── standard-material.ts    # Types, factory, texture collection
│   │   │       ├── standard-template.ts    # Standard shader template (WGSL generation)
│   │   │       ├── standard-pipeline.ts    # Pipeline cache + feature flags
│   │   │       ├── standard-renderable.ts  # buildStandardMeshRenderables()
│   │   │       ├── standard-single-rebuild.ts # Single-mesh pipeline rebuild
│   │   │       ├── skybox-cubemap.ts       # CubeMap skybox for StandardMaterial scenes
│   │   │       └── fragments/             # Standard ShaderFragment modules
│   │   │           ├── normal-map-fragment.ts
│   │   │           ├── std-ambient-fragment.ts
│   │   │           ├── std-emissive-fragment.ts
│   │   │           ├── std-lightmap-fragment.ts
│   │   │           ├── std-opacity-fragment.ts
│   │   │           ├── std-reflection-fragment.ts
│   │   │           ├── std-shadow-fragment.ts
│   │   │           └── std-specular-fragment.ts
│   │   ├── shader/                # Shader composition system
│   │   │   ├── shader-composer.ts # ShaderFragment composer engine
│   │   │   ├── fragment-types.ts  # ShaderFragment interface definitions
│   │   │   ├── ubo-layout.ts     # UBO layout helpers
│   │   │   ├── wgsl-helpers.ts   # WGSL code-gen utilities
│   │   │   └── fragments/        # Shared shader fragments
│   │   │       └── thin-instance-fragment.ts
│   │   ├── render/
│   │   │   ├── renderable.ts      # Renderable, PrePassRenderable, SceneUniformUpdater
│   │   │   ├── scene-helpers.ts   # Shared helper utilities
│   │   │   └── lights-ubo.ts     # Multi-light UBO packing
│   │   ├── effect/
│   │   │   └── effect-renderer.ts # EffectWrapper fullscreen passes + RenderTarget output
│   │   ├── mesh/
│   │   │   ├── mesh.ts            # Mesh type and GPU upload
│   │   │   ├── mesh-factories.ts  # High-level createSphere/Box/Torus/Ground/Cylinder/Plane/Disc/Polyhedron/Ribbon/Tube/Extrude
│   │   │   ├── path3d.ts          # Path3D parallel-transport frames (used by tube/extrude)
│   │   │   ├── thin-instance.ts   # Thin instance CPU data model + public API
│   │   │   ├── thin-instance-gpu.ts # GPU buffer sync (lazy-loaded by renderable)
│   │   │   ├── create-sphere.ts   # Sphere geometry generator
│   │   │   ├── create-box.ts      # Box geometry generator
│   │   │   ├── create-torus.ts    # Torus geometry generator
│   │   │   └── create-ground.ts   # Ground/heightmap geometry generator
│   │   ├── skeleton/
│   │   │   ├── create-skeleton.ts   # Skeleton data creation from glTF
│   │   │   └── skeleton-updater.ts  # Joint matrix computation for skinned meshes
│   │   ├── animation/
│   │   │   ├── animation-group.ts    # AnimationGroup creation from glTF data
│   │   │   ├── evaluate.ts           # Keyframe interpolation (step, linear, cubic)
│   │   │   └── types.ts              # Animation type definitions
│   │   ├── morph/
│   │   │   └── create-morph-targets.ts # Morph target data + GPU texture
│   │   ├── picking/
│   │   │   ├── gpu-picker.ts        # createGpuPicker() — GPU ID-pass picking
│   │   │   ├── picking-pipeline.ts  # Picking render pipeline
│   │   │   ├── picking-shader.ts    # Picking WGSL shaders
│   │   │   ├── picking-helpers.ts   # getPickedNormal(), getPickedUV()
│   │   │   ├── picking-info.ts      # PickingInfo type
│   │   │   ├── detailed-picking.ts  # enableDetailedPicking() — CPU ray/triangle
│   │   │   └── ray.ts              # Ray intersection math
│   │   ├── resource/
│   │   │   └── gpu-pool.ts         # GPU buffer/texture pooling
│   │   ├── shadow/
│   │   │   ├── shadow-base.ts       # Shared shadow logic
│   │   │   ├── shadow-generator.ts  # ESM shadow generator
│   │   │   ├── pcf-shadow-generator.ts # PCF shadow generator
│   │   │   └── shadow-renderable.ts # Shadow → PrePassRenderable
│   │   ├── frame-graph/
│   │   │   ├── task.ts              # Frame-graph task interface
│   │   │   ├── frame-graph.ts       # Ordered task list
│   │   │   ├── frame-graph-actions.ts # addTask helpers
│   │   │   └── render-task.ts  # Render-pass task + per-pass scene UBO
│   │   ├── texture/
│   │   │   ├── texture-2d.ts      # 2D texture loader
│   │   │   ├── solid-texture.ts   # 1×1 solid-color texture factory
│   │   │   ├── cube-texture.ts    # 6-face cube texture loader
│   │   │   ├── rtt.ts             # Eager render-target texture helper
│   │   │   ├── ktx2-loader.ts      # KTX2/BasisU upload for KHR_texture_basisu
│   │   │   ├── rtt-mip.ts          # Mipmapped render-target texture helper
│   │   │   ├── record-mipmaps.ts   # Encoder-local mipmap recording
│   │   │   └── generate-mipmaps.ts # GPU mipmap generation
│   │   ├── loader-gltf/
│   │   │   ├── load-gltf.ts       # GLB parser, GPU upload
│   │   │   ├── gltf-parser.ts     # glTF JSON parsing helpers
│   │   │   ├── gltf-material.ts   # glTF material → PbrMaterialProps
│   │   │   ├── gltf-ext-basisu.ts # KHR_texture_basisu dynamic feature
│   │   │   └── gltf-animation.ts  # glTF animation extraction
│   │   ├── loader-env/
│   │   │   ├── load-env.ts        # .env parser, RGBD decode, cubemap upload
│   │   │   ├── load-dds-env.ts    # DDS environment loading
│   │   │   ├── env-helpers.ts     # Environment helper utilities
│   │   │   └── rgbd-decode.ts     # RGBD decode helpers
│   │   ├── loader-hdr/
│   │   │   ├── load-hdr.ts        # loadHdrEnvironment() — HDR environment pipeline
│   │   │   ├── hdr-parser.ts      # RGBE file parser
│   │   │   └── hdr-ibl-pipeline.ts # GPU compute IBL from HDR
│   │   ├── loader-babylon/
│   │   │   └── load-babylon.ts    # loadBabylon() — .babylon format parser
│   │   └── loader-skybox/
│   │       ├── load-skybox.ts     # High-level skybox loader
│   │       └── skybox-renderable.ts # Skybox → deferred Renderable builder
│
├── lab/               # Dev sandbox (Scenes 1–112)
│   ├── index.html
│   ├── src/lite/scene1.ts          # Scene 1: BoomBox PBR
│   ├── src/lite/scene2.ts          # Scene 2: Sphere + DirectionalLight
│   ├── ...                         # Scenes 3–111
│   ├── src/lite/scene74.ts         # Scene 74: EffectRenderer fullscreen pass
│   ├── src/lite/scene75.ts         # Scene 75: EffectWrapper render-to-texture sphere
│   ├── src/lite/scene76.ts         # Scene 76: EffectWrapper texture binding
│   ├── src/lite/scene112.ts        # Scene 112: FlightHelmetKTX / KHR_texture_basisu
│   ├── package.json
│   ├── tsconfig.json
│   └── vite.config.ts
│
├── reference/                     # Per-scene reference data
│   ├── scene1-boombox/            # Scene 1 reference data
│   ├── scene2-sphere/             # Scene 2 reference data
│   ├── ...                        # Scenes 3–111
│   ├── scene74-effect-renderer/   # EffectRenderer fullscreen golden
│   ├── scene75-effect-rtt-sphere/ # EffectWrapper RTT golden
│   ├── scene76-effect-texture/    # EffectWrapper texture-binding golden
│   ├── scene112-khr-texture-basisu/ # KHR_texture_basisu golden
│   └── (each contains golden screenshots for parity tests)
│
└── docs/architecture/
    └── 00-overview.md             # THIS FILE
```

---

## 2. Public API Surface

All exports from `packages/babylon-lite/src/index.ts`. The API must feel like Babylon.js
but is composed of pure functions and plain data types.

### Functions

```typescript
// Engine lifecycle
createEngine(canvas: HTMLCanvasElement): Promise<Engine>

// Scene
createSceneContext(engine: Engine): SceneContext
createDefaultCamera(scene: SceneContext): ArcRotateCamera
removeFromScene(scene: SceneContext, entity: Mesh | ...): void

// Camera — pure data, no scene param
createArcRotateCamera(alpha: number, beta: number, radius: number, target: Vec3): ArcRotateCamera
attachControl(camera: ArcRotateCamera, canvas: HTMLCanvasElement): void
createFreeCamera(position: Vec3, target: Vec3): FreeCamera
attachFreeControl(camera: FreeCamera, canvas: HTMLCanvasElement): void

// Loaders — note: loadGltf and loadBabylon take Engine, not SceneContext
loadGltf(engine: Engine, url: string): Promise<AssetContainer>
loadEnvironment(scene: SceneContext, url: string, options: {
    brdfUrl: string;
    groundTextureUrl?: string;
    skipSkybox?: boolean;
    skipGround?: boolean;
    skyboxUrl?: string;
    skyboxSize?: number;
}): Promise<EnvironmentTextures>
loadHdrEnvironment(scene: SceneContext, url: string, options?: HdrLoadOptions): Promise<EnvironmentTextures>
loadBabylon(engine: Engine, url: string, opts?: LoadBabylonOptions): Promise<AssetContainer>
loadTexture2D(engine: Engine, url: string, options?: Texture2DOptions): Promise<Texture2D>
loadSkybox(scene: SceneContext, baseUrl: string, ext: string, size?: number): Promise<void>

// Texture factories
createSolidTexture2D(engine: Engine, r: number, g: number, b: number, a?: number): Texture2D

// EffectRenderer-style fullscreen passes
createEffectWrapper(engine: Engine, options: EffectWrapperOptions): EffectWrapper
setEffectUniforms(wrapper: EffectWrapper, data: ArrayBuffer | ArrayBufferView | Record<string | number, ArrayBuffer | ArrayBufferView>): void
setEffectTexture(wrapper: EffectWrapper, bindingNameOrIndex: string | number, texture: Texture2D): void
createEffectRenderer(engine: Engine, effect: EffectWrapper, options?: EffectRendererOptions): EffectRenderer
registerEffectRenderer(renderer: EffectRenderer): void
unregisterEffectRenderer(renderer: EffectRenderer): void
disposeEffectRenderer(renderer: EffectRenderer): void
createEffectRenderTask(config: EffectRenderTaskConfig, engine: Engine, scene: SceneContext): EffectRenderTask
disposeEffectWrapper(wrapper: EffectWrapper): void

// Lights
createHemisphericLight(direction?: [number,number,number], intensity?: number): HemisphericLight
createPointLight(position: [number,number,number], intensity?: number): PointLight
createDirectionalLight(direction: [number,number,number], intensity?: number): DirectionalLight
createSpotLight(
    position: [number,number,number],
    direction: [number,number,number],
    angle: number,
    exponent: number,
    intensity?: number,
): SpotLight

// Mesh factories
createSphere(engine: Engine, options?: SphereOptions): Mesh
createBox(engine: Engine, size?: number): Mesh
createTorus(engine: Engine, options?: TorusOptions): Mesh
createCylinder(engine: Engine, options?: CylinderOptions): Mesh
createPlane(engine: Engine, options?: PlaneOptions): Mesh
createDisc(engine: Engine, options?: DiscOptions): Mesh
createPolyhedron(engine: Engine, options?: PolyhedronOptions): Mesh
createRibbon(engine: Engine, options: RibbonOptions): Mesh
createTube(engine: Engine, options: TubeOptions): Mesh
createExtrudeShape(engine: Engine, options: ExtrudeShapeOptions): Mesh
createGround(engine: Engine, options?: GroundOptions): Mesh
createGroundFromHeightMap(engine: Engine, url: string, options: GroundOptions): Promise<Mesh>

// Materials
createStandardMaterial(): StandardMaterialProps
createPbrMaterial(props?: Partial<PbrMaterialProps>): PbrMaterialProps

// Shadows — note: takes engine + casterMeshes[], not scene
createShadowGenerator(engine: Engine, light: DirectionalLight, casterMeshes: Mesh[], config?: ShadowGeneratorConfig): ShadowGenerator
createPcfShadowGenerator(engine: Engine, light: SpotLight, casterMeshes: Mesh[], config?: PcfShadowGeneratorConfig): ShadowGenerator

// Animation
createAnimationController(skeleton, scene): AnimationController
createAnimationGroups(gltfData, meshes, scene): AnimationGroup[]

// Hierarchy
setParent(child: IParentable, parent: IWorldMatrixProvider | null, scene: SceneContext): void
createTransformNode(name: string, scene: SceneContext): TransformNode
cloneTransformNode(node: TransformNode, scene: SceneContext): TransformNode
collectMeshes(node: TransformNode): Mesh[]

// Math
mat4Translation(x: number, y: number, z: number): Mat4
mat4Identity(): Mat4
mat4Scale(sx: number, sy: number, sz: number): Mat4
mat4Compose(tx,ty,tz, qx,qy,qz,qw, sx,sy,sz): Mat4

// Thin Instances
addThinInstance(mesh: Mesh, matrix: Mat4): number
removeThinInstance(mesh: Mesh, index: number): void
setThinInstanceMatrix(mesh: Mesh, index: number, matrix: Mat4): void
setThinInstances(mesh: Mesh, matrices: Mat4[]): void
flushThinInstances(mesh: Mesh): void
setThinInstanceColors(mesh: Mesh, colors: Float32Array): void

// Picking
createGpuPicker(engine: Engine, scene: SceneContext): GpuPicker
enableDetailedPicking(mesh: Mesh): void
getPickedNormal(info: PickingInfo): Vec3
getPickedUV(info: PickingInfo): [number, number]
```

### Types

```typescript
// ─── Engine ──────────────────────────────────────────────────────────
// Note: GPU internals (device, context, format) are @internal and not exposed.
interface EngineContext {
    readonly canvas: HTMLCanvasElement;
    readonly msaaSamples: number; // always 4
    drawCallCount: number; // GPU draw calls in last rendered frame
}

// ─── Scene ───────────────────────────────────────────────────────────
interface SceneContext {
    readonly engine: Engine;
    clearColor: GPUColorDict;
    camera: ArcRotateCamera | FreeCamera | null;
    lights: LightBase[]; // All light types (HemisphericLight, PointLight, etc.)
    meshes: Mesh[];
    animationGroups: AnimationGroup[];
    fog: FogConfig | null;
    shadowGenerators: ShadowGenerator[];
    imageProcessing: ImageProcessingConfig;
    environmentPrimaryColor?: [number, number, number];
    envRotationY?: number; // Environment cubemap Y rotation in radians
    fixedDeltaMs: number; // Fixed delta for deterministic animation (0 = real time)

    // Internal renderable lists
    _renderables: Renderable[];
    _opaqueRenderables: Renderable[];
    _transparentRenderables: Renderable[];
    _prePasses: PrePassRenderable[];
    _uniformUpdaters: SceneUniformUpdater[];
    _fixedDeltaMs: number;
    _beforeRender: ((deltaMs: number) => void)[];
    _deferredBuilders: (() => void | Promise<void>)[];
}

// ─── Cameras ─────────────────────────────────────────────────────────
interface ArcRotateCamera {
    alpha: number; // Horizontal rotation (azimuth)
    beta: number; // Vertical angle from top pole (0=top, π=bottom)
    radius: number; // Distance from target
    target: Vec3; // Look-at point (ObservableVec3 at runtime)
    fov: number; // Vertical FOV in radians
    nearPlane: number; // Near clip plane
    farPlane: number; // Far clip plane
    inertia: number; // Rotation + zoom inertia (0=instant, 0.9=default)
    panningInertia: number; // Panning inertia
    inertialAlphaOffset: number;
    inertialBetaOffset: number;
    inertialRadiusOffset: number;
    inertialPanningX: number;
    inertialPanningY: number;
    getViewMatrix(): Mat4;
    getProjectionMatrix(aspectRatio: number): Mat4;
    getViewProjectionMatrix(aspectRatio: number): Mat4;
    getPosition(): Vec3;
}

interface FreeCamera {
    position: ObservableVec3; // Camera world position
    target: ObservableVec3; // Look-at target
    speed: number; // Movement speed (default 2.0, matches BJS)
    angularSensitivity: number; // Mouse rotation sensitivity (default 2000)
    inertia: number; // Damping factor (0=instant, 0.9=default)
    fov: number;
    nearPlane: number;
    farPlane: number;
    getViewMatrix(): Mat4;
    getProjectionMatrix(aspectRatio: number): Mat4;
    getViewProjectionMatrix(aspectRatio: number): Mat4;
    getPosition(): Vec3;
}

interface Camera {
    /* Union: ArcRotateCamera | FreeCamera */
}

// ─── Lights ──────────────────────────────────────────────────────────
interface LightBase {
    readonly lightType: string;
    intensity: number;
    excludedMeshIds?: ReadonlySet<string>;
    includedOnlyMeshIds?: ReadonlySet<string>;
    shadowGenerator?: ShadowGenerator;
    parent: IWorldMatrixProvider | null;
    readonly worldMatrix: Mat4;
    readonly worldMatrixVersion: number;
}

interface HemisphericLight extends LightBase {
    readonly lightType: "hemispheric";
    direction: ObservableVec3;
    intensity: number;
    diffuseColor: [number, number, number];
    specularColor: [number, number, number];
    groundColor: [number, number, number];
}

interface PointLight extends LightBase {
    readonly lightType: "point";
    position: ObservableVec3;
    diffuse: [number, number, number];
    specular: [number, number, number];
    intensity: number;
    range: number;
}

interface DirectionalLight extends LightBase {
    readonly lightType: "directional";
    direction: ObservableVec3;
    position: ObservableVec3;
    diffuse: [number, number, number];
    specular: [number, number, number];
    intensity: number;
}

interface SpotLight extends LightBase {
    readonly lightType: "spot";
    position: ObservableVec3;
    direction: ObservableVec3;
    angle: number;
    exponent: number;
    diffuse: [number, number, number];
    specular: [number, number, number];
    intensity: number;
    range: number;
}

// ─── Materials ───────────────────────────────────────────────────────
interface PbrMaterialProps {
    baseColorTexture?: Texture2D;
    normalTexture?: Texture2D;
    ormTexture?: Texture2D; // R=occ, G=rough, B=metal
    emissiveTexture?: Texture2D;
    emissiveColor?: [number, number, number]; // Linear RGB emissive (no texture)
    specGlossTexture?: Texture2D; // KHR_materials_pbrSpecularGlossiness
    doubleSided?: boolean;
    alpha?: number; // Overall material alpha (default 1.0)
    alphaBlend?: boolean; // Enable alpha blending (glTF BLEND)
    environmentIntensity?: number; // IBL contribution scale (default 1.0)
    directIntensity?: number; // Direct light contribution scale (default 1.0)
    usePhysicalLightFalloff?: boolean; // Direct point/spot inverse-square falloff (default true)
    reflectance?: number; // Dielectric F0 (default 0.04)
    occlusionStrength?: number; // AO strength from ORM R channel (default 1.0)
    metallicF0Factor?: number; // Dielectric F0 scale (default 1.0)
    metallicReflectanceColor?: [number, number, number]; // Tints dielectric reflectance (default [1,1,1])
    metallicReflectanceTexture?: Texture2D; // RGB=reflectance tint, A=F0 scalar
    reflectanceTexture?: Texture2D; // RGB=reflectance tint only
    useOnlyMetallicFromMetallicReflectanceTexture?: boolean;
    enableSpecularAA?: boolean; // Specular anti-aliasing on IBL alphaG
    gammaAlbedo?: boolean; // Apply pow(2.2) sRGB→linear in shader
    clearCoat?: ClearCoatProps;
    sheen?: SheenProps;
}

interface ClearCoatProps {
    isEnabled?: boolean;
    intensity?: number;
    roughness?: number;
    indexOfRefraction?: number; // Default 1.5
}

interface SheenProps {
    isEnabled: boolean;
    color?: [number, number, number];
    roughness?: number;
    intensity?: number;
    texture?: Texture2D; // Sheen tint texture (modulates color)
}

interface StandardMaterialProps {
    diffuseColor: [number, number, number];
    alpha: number;
    specularColor: [number, number, number];
    specularPower: number;
    emissiveColor: [number, number, number];
    ambientColor: [number, number, number];
    diffuseTexture: Texture2D | null;
    diffuseCoordIndex: 0 | 1;
    emissiveTexture: Texture2D | null;
    bumpTexture: Texture2D | null;
    bumpLevel: number;
    specularTexture: Texture2D | null;
    specularCoordIndex: 0 | 1;
    ambientTexture: Texture2D | null;
    ambientTexLevel: number;
    ambientCoordIndex: 0 | 1;
    lightmapTexture: Texture2D | null;
    lightmapLevel: number;
    lightmapCoordIndex: 0 | 1;
    opacityTexture: Texture2D | null;
    opacityLevel: number;
    opacityFromRGB: boolean;
    alphaCutOff: number;
    reflectionTexture: Texture2D | null;
    reflectionLevel: number;
    reflectionCoordMode: 1 | 2;
    uvScale: [number, number];
    backFaceCulling: boolean;
    disableLighting: boolean;
}

interface FogConfig {
    mode: 0 | 1 | 2 | 3; // 0=off, 1=exp, 2=exp2, 3=linear (matches BJS Scene.FOGMODE_*)
    density: number;
    start: number;
    end: number;
    color: [number, number, number];
}

interface ImageProcessingConfig {
    exposure: number;
    contrast: number;
    toneMappingEnabled: boolean;
}

// ─── Mesh ────────────────────────────────────────────────────────────
interface Mesh {
    boundMin?: Vec3;
    boundMax?: Vec3;
    name?: string;
    material: StandardMaterialProps | PbrMaterialProps | null;
    receiveShadows: boolean;
}
interface MeshGPU {
    /* internal GPU state */
}

// ─── Textures ────────────────────────────────────────────────────────
interface Texture2D {
    texture: GPUTexture;
    view: GPUTextureView;
    sampler: GPUSampler;
    width: number;
    height: number;
}
interface Texture2DOptions {
    mipMaps?: boolean; // Generate mipmaps (default true)
    addressModeU?: GPUAddressMode; // Default 'repeat'
    addressModeV?: GPUAddressMode; // Default 'repeat'
    minFilter?: GPUFilterMode; // Default 'linear'
    magFilter?: GPUFilterMode; // Default 'linear'
    invertY?: boolean; // Flip Y axis (default true, matches BJS)
    srgb?: boolean; // Use rgba8unorm-srgb format (default false)
}

// ─── Shadows ─────────────────────────────────────────────────────────
interface ShadowGenerator {
    shadowType: "esm" | "pcf";
    light: LightBase;
    config: Required<ShadowGeneratorConfig>;
}
interface ShadowGeneratorConfig {
    mapSize?: number; // Shadow map size (default 1024)
    depthScale?: number; // ESM depth exponent scale (default 50)
    bias?: number; // Shadow bias (default 0.00005)
    blurScale?: number; // Gaussian blur downscale factor (default 2)
    darkness?: number; // Shadow darkness 0–1 (default 0 = full black)
    frustumEdgeFalloff?: number;
    orthoMinZ?: number; // Ortho projection near Z (default 1)
    orthoMaxZ?: number; // Ortho projection far Z (default 10000)
}
interface PcfShadowGeneratorConfig {
    mapSize?: number; // Shadow map size (default 512)
    bias?: number;
    darkness?: number;
    normalBias?: number;
    near?: number; // Near plane for shadow projection
    far?: number; // Far plane for shadow projection
}

// ─── Loaders ─────────────────────────────────────────────────────────
// Unified result returned by both loadGltf() and loadBabylon()
interface AssetContainer {
    // glTF: [root TransformNode]. .babylon: flat [...meshes, ...lights]
    entities: Array<Mesh | TransformNode | LightBase>;
    animationGroups?: AnimationGroup[]; // auto-ticked by addToScene()
    clearColor?: GPUColorDict; // applied to scene.clearColor by addToScene()
}

interface EnvironmentTextures {
    specularCube: GPUTexture;
    specularCubeView: GPUTextureView;
    brdfLut: GPUTexture;
    brdfLutView: GPUTextureView;
    cubeSampler: GPUSampler;
    brdfSampler: GPUSampler;
    irradianceSH: Float32Array; // 27 floats (9 vec3 SH coefficients)
    sphericalHarmonics: {
        // Pre-scaled SH bands for shader (L00…L22)
        l00: Float32Array;
        l1_1: Float32Array;
        l10: Float32Array;
        l11: Float32Array;
        l2_2: Float32Array;
        l2_1: Float32Array;
        l20: Float32Array;
        l21: Float32Array;
        l22: Float32Array;
    };
    lodGenerationScale: number; // LOD scale for specular IBL sampling (default 0.8)
}

interface HdrLoadOptions {
    faceSize?: number; // Cubemap face size in pixels (default 256)
    useCubemapSkybox?: boolean; // Render HDR cubemap as skybox background
    skipGround?: boolean; // Skip the background ground plane
    skyboxSize?: number; // Skybox mesh size (matches BJS skyboxSize)
}

// ─── Animation ───────────────────────────────────────────────────────
interface AnimationController {
    update(deltaMs: number): void;
}
interface AnimationGroup {
    name: string;
    play(loop?: boolean): void;
    stop(): void;
}
interface AnimationClip {
    /* keyframe data */
}
interface GltfAnimationData {
    /* parsed glTF animation channels */
}

// ─── Hierarchy ───────────────────────────────────────────────────────
interface TransformNode {
    name: string;
    position: ObservableVec3;
    rotation: ObservableQuat;
    scaling: ObservableVec3;
}
interface IWorldMatrixProvider {
    getWorldMatrix(): Mat4;
}
interface IParentable extends IWorldMatrixProvider {
    parent: IWorldMatrixProvider | null;
}

// ─── Thin Instances ──────────────────────────────────────────────────
interface ThinInstanceData {
    matrices: Mat4[];
    colors?: Float32Array;
}

// ─── Math ────────────────────────────────────────────────────────────
class ObservableVec3 {
    x: number;
    y: number;
    z: number;
}
class ObservableQuat {
    x: number;
    y: number;
    z: number;
    w: number;
}

// ─── Picking ─────────────────────────────────────────────────────────
interface GpuPicker {
    pick(x: number, y: number): Promise<PickingInfo | null>;
}
interface PickingInfo {
    mesh: Mesh;
    faceId: number;
    worldPosition: Vec3;
}

// ─── Low-level (advanced/custom rendering) ───────────────────────────
interface DrawUpdateContext {
    targetWidth: number;
    targetHeight: number;
}
interface Renderable {
    order: number;
    bind(engine: Engine, target: RenderTargetSignature): DrawBinding;
}
interface DrawBinding {
    pipeline: GPURenderPipeline;
    update?(context: DrawUpdateContext): void;
    draw(pass: GPURenderPassEncoder | GPURenderBundleEncoder, engine: Engine): number;
}
interface PrePassRenderable {
    execute(encoder: GPUCommandEncoder, engine: Engine): number;
}
interface SceneUniformUpdater {
    update(engine: Engine): void;
}

// ─── Mesh factory options ────────────────────────────────────────────
interface SphereOptions {
    diameter?: number;
    segments?: number;
}
interface TorusOptions {
    diameter?: number;
    thickness?: number;
    tessellation?: number;
}
interface GroundOptions {
    width?: number;
    height?: number;
    subdivisions?: number;
}
```

---

## 3. Module Specifications

### 3.1 Core Math (`math/`)

**Coordinate system**: Left-handed (LH), matching Babylon.js and WebGPU.

**Mat4 memory layout**: Column-major, 16 contiguous `f32` values.
Indices `[col*4+row]` — matches WGSL `mat4x4<f32>` storage.

```
[0]  [4]  [8]  [12]     col0  col1  col2  col3
[1]  [5]  [9]  [13]  =  (X)   (Y)   (Z)   (Translation)
[2]  [6]  [10] [14]
[3]  [7]  [11] [15]
```

**Key functions**:

| Function                                       | Signature        | Notes                                         |
| ---------------------------------------------- | ---------------- | --------------------------------------------- |
| `mat4Identity()`                               | `→ Mat4`         | 16-float identity                             |
| `mat4Multiply(a, b)`                           | `→ Mat4`         | Column-major `a * b`                          |
| `mat4LookAtLH(eye, target, up)`                | `→ Mat4`         | LH look-at, `zAxis = normalize(target - eye)` |
| `mat4PerspectiveLH(fov, aspect, near, far)`    | `→ Mat4`         | Zero-to-one depth, `tan = 1/tan(fov/2)`       |
| `mat4Invert(m)`                                | `→ Mat4 \| null` | Full 4x4 inverse via cofactors                |
| `mat4Compose(tx,ty,tz, qx,qy,qz,qw, sx,sy,sz)` | `→ Mat4`         | TRS composition                               |
| `mat4FromQuat(qx,qy,qz,qw)`                    | `→ Mat4`         | Quaternion to rotation matrix                 |

**LookAtLH formula** (matches Babylon.js `Matrix.LookAtLHToRef`):

```
zAxis = normalize(target - eye)          // forward
xAxis = normalize(cross(up, zAxis))      // right
yAxis = cross(zAxis, xAxis)              // up
M = | xAxis.x  yAxis.x  zAxis.x  0 |    (stored column-major)
    | xAxis.y  yAxis.y  zAxis.y  0 |
    | xAxis.z  yAxis.z  zAxis.z  0 |
    | -dot(x,eye)  -dot(y,eye)  -dot(z,eye)  1 |
```

**PerspectiveLH formula** (zero-to-one depth, matches `Matrix.PerspectiveFovLHToRef`):

```
f = 1 / tan(fov / 2)
M = | f/aspect  0  0              0 |
    | 0         f  0              0 |
    | 0         0  far/(far-near) 1 |
    | 0         0  -far*near/(far-near) 0 |
```

### 3.2 Engine (`engine/engine.ts`)

**Responsibilities**: Acquire GPUDevice, configure swapchain, manage MSAA render targets,
drive the render loop.

**Init sequence**:

1. `navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })`
2. `adapter.requestDevice({ requiredFeatures })` — optionally enables `float32-filterable` if supported
3. `canvas.getContext('webgpu')` → configure with `options?.alphaMode ?? 'opaque'`
4. Store engine render state (`msaaSamples`, registered contexts, transient encoder/swapchain view)

**MSAA configuration**:

- Color target: `format = navigator.gpu.getPreferredCanvasFormat()` (typically `bgra8unorm`), `sampleCount = 4`
- Depth target: `depth24plus-stencil8`, `sampleCount = 4`
- Canvas render targets are owned by frame-graph `RenderTask`s. If `sampleCount > 1`, the task owns an MSAA color texture and resolves to the swapchain texture each frame.

**Render loop** (`startEngine(engine)` after `registerScene(engine, scene)` — async, returns `Promise<void>`):

```
registerScene runs deferred builders → requestAnimationFrame → resize() → renderFrame() → requestAnimationFrame ...
```

**`renderFrame()`**:

1. Create command encoder and expose it as `engine._currentEncoder`
2. For each registered rendering context, run `_update()`:
    - before-render callbacks, material swaps, shadow generators, legacy pre-passes, shared uniform updaters
3. For each registered rendering context, run `_record()`:
    - `scene._frameGraph.execute()` drains its ordered tasks

- each `RenderTask` acquires/patches the swapchain or RTT views, writes its per-pass scene UBO, calls `DrawBinding.update({ targetWidth, targetHeight, _camera })`, and draws bucketed `DrawBinding`s

4. Submit the command buffer

**Resize**: checks `canvas.clientWidth * devicePixelRatio`, updates the canvas backing store if changed, then asks registered contexts to rebuild frame-graph targets that depend on canvas size.

### 3.3 Scene (`scene/scene.ts`)

A flat data struct with renderable arrays. No hierarchy. No callbacks.

```typescript
{
  engine,                        // readonly ref to Engine
  clearColor: {r:0.2, g:0.2, b:0.3, a:1.0},
  camera: null,                  // set by caller
  lights: [],                    // LightBase[] — all light types
  meshes: [],                    // Mesh[] — all meshes (standard + PBR)
  animationGroups: [],           // AnimationGroup[] — glTF animation groups
  fog: null,                     // FogConfig | null
  shadowGenerators: [],          // ShadowGenerator[]
  imageProcessing: { exposure: 1.0, contrast: 1.0, toneMappingEnabled: false },
  _renderables: [],              // Renderable[] — all renderables (combined)
  _opaqueRenderables: [],        // Renderable[] — sorted by order
  _transparentRenderables: [],   // Renderable[] — sorted back-to-front each frame
  _prePasses: [],                // PrePassRenderable[] — shadow passes etc.
  _uniformUpdaters: [],          // SceneUniformUpdater[] — per-frame UBO updates
  _deferredBuilders: [],         // (() => void | Promise<void>)[] — drained by buildScene() during registerScene()
  _fixedDeltaMs: 0,              // fixed delta for animation (0 = use real time)
  _beforeRender: [],             // ((deltaMs: number) => void)[] — per-frame callbacks
}
```

**Registration**: `addToScene(scene, entity)` routes by type — `Mesh`, `LightBase`, `ShadowGenerator`, or `TransformNode` (which recursively adds all contained meshes).
**Deferred builders**: run once at `startEngine()` to create pipelines/bind groups.

### 3.4 Camera (`camera/arc-rotate.ts`)

**ArcRotateCamera** — orbits around a target using spherical coordinates.

**Position formula** (matches Babylon.js `ArcRotateCamera._getViewMatrix`):

```
position = target + Vector3(
  radius * cos(alpha) * sin(beta),
  radius * cos(beta),
  radius * sin(alpha) * sin(beta)
)
```

**`createDefaultCamera(scene)`** auto-frames loaded meshes:

1. Compute world AABB from all `scene.meshes[].boundMin/boundMax`
2. `target = center of AABB`
3. `worldSize = max - min`
4. `radius = length(worldSize) * 1.5`
5. `alpha = -π/2`, `beta = π/2` (matching Babylon's `createDefaultCameraOrLight`)
6. `fov = 0.8` (Babylon default)
7. `nearPlane = 0.1`, `farPlane = 1000`

The playground then overrides: `camera.alpha = 1.77538207638442`

### 3.5 Light (`light/hemispheric.ts`)

Plain data factory. Returns `HemisphericLight` with:

- `direction: ObservableVec3(0, 1, 0)` (up)
- `intensity: 1.0`
- `diffuseColor: [1, 1, 1]` (sky/top)
- `specularColor: [1, 1, 1]` (highlight color)
- `groundColor: [0, 0, 0]` (bottom)

The hemispheric light model in the shader:

```
hemiNdotL = dot(N, lightDir) * 0.5 + 0.5    // remap [-1,1] → [0,1]
hemiColor = mix(groundColor, diffuseColor, hemiNdotL)
contribution = hemiColor * intensity
```

### 3.6 Materials (`material/pbr/`, `material/standard/`)

**Design principle**: Materials own shaders. The engine never imports WGSL or material code — it iterates blind `Renderable` interfaces.

**Dynamic shader composition**: Both PBR and Standard materials use a composer pattern — TypeScript functions build WGSL strings from feature flags. Only the blocks needed for a given mesh's features are emitted. No uber shader, no raw `.wgsl` files for PBR/Standard.

**PBR feature flags**: `PBR_HAS_NORMAL_MAP` (1<<0), `PBR_HAS_EMISSIVE` (1<<1), `PBR_HAS_ENV` (1<<2).

**Standard feature flags**: `HAS_DIFFUSE_TEXTURE` (1<<0), `HAS_EMISSIVE_TEXTURE` (1<<1), `RECEIVE_SHADOWS` (1<<2).

**Pipeline caching**: Both materials cache pipelines per `(features, format, msaaSamples)` tuple. Meshes with the same features share a pipeline.

**Bind group layout (scene group 0)**: binding 0 is the per-pass `SceneUniforms` UBO owned by `RenderTask`; binding 1 is the scene-owned `LightsUniforms` UBO.

**Bind group layout (PBR group 1)**: Bindings assigned sequentially — mesh UBO (world + per-mesh light indices), baseColor, [normal], ORM, [emissive], [BRDF LUT, IBL cube]. Binding count varies by features.

**Bind group layout (Standard group 1)**: mesh UBO (world + per-mesh light indices), material UBO, [diffuse texture], [shadow/UV UBO], [emissive texture]. Group 2 = shadow map (if shadows).

### 3.7 Renderable Architecture (`render/renderable.ts`)

**Entity-owned pipelines**: Each material/entity creates its own pipeline and returns `Renderable` objects. Scene-owned `RenderTask`s call `renderable.bind(engine, target)` to create target-specific `DrawBinding`s; the engine/frame graph never imports material code.

```typescript
interface DrawUpdateContext {
    targetWidth: number;
    targetHeight: number;
}
interface Renderable {
    order: number;
    bind(engine, target): DrawBinding;
}
interface DrawBinding {
    pipeline: GPURenderPipeline;
    update?(context: DrawUpdateContext): void;
    draw(pass, engine): number;
}
interface PrePassRenderable {
    execute(encoder, engine): number;
}
interface SceneUniformUpdater {
    update(engine): void;
}
```

**Draw order**: skybox/background (0) → opaque bundle (100) → direct non-transparent draws (dynamic depth-write batches and true transmissive surfaces) → transparent (200, distance-sorted).

**Deferred building**: Entities register builders on `scene._deferredBuilders`. `registerScene()` calls `buildScene()` to drain them before the scene is registered, then builds the scene frame graph.

### 3.8 glTF Loader (`loader-gltf/load-gltf.ts`)

Parses GLB/glTF containers (glTF 2.0). Not a general-purpose loader — optimized for
the meshes we encounter in reference scenes. Returns an asset container whose root can be passed to `addToScene()`.

Optional glTF capabilities are dynamic feature modules (`gltf-ext-*.ts` / `gltf-feature-*.ts`). `load-gltf.ts` inspects `extensionsUsed`, materials, and primitives, then imports only the modules needed by the current asset. `KHR_texture_basisu` is handled by `gltf-ext-basisu.ts`, which strips KTX2 textureInfos before core image parsing and uploads them through `texture/ktx2-loader.ts`; scenes without that extension fetch none of those chunks.

**Texture caching**: Textures are cached per bitmap identity + sRGB flag to avoid duplicate GPU uploads. The hot path uses a numeric key (`bitmapId * 2 + +srgb`); feature modules can keep their own extension-source caches.

**Animation extraction**: Creates `AnimationGroup[]` from glTF animations via `createAnimationGroups()`, registers `_beforeRender` callbacks on the scene for playback.

**GLB container format**:

```
[Header: 12B]  magic=0x46546c67, version=2, totalLength
[JSON chunk]   type=0x4E4F534A, length, UTF-8 JSON payload
[BIN chunk]    type=0x004E4942, length, binary blob
```

**Accessor resolution**:

```
byteOffset = bufferView.byteOffset + accessor.byteOffset
TypedArray = new T(binChunk.buffer, binChunk.byteOffset + byteOffset, count * componentCount)
```

**Component types**: FLOAT=5126, UNSIGNED_SHORT=5123, UNSIGNED_INT=5125, UNSIGNED_BYTE=5121

**Mesh extraction flow**:

1. Discover dynamic feature modules (`KHR_texture_basisu`, Draco, variants, skins, morphs, etc.)
2. Run feature `preMesh` hooks to decode feature-owned primitive data (for example strided FLOAT accessors used by FlightHelmetKTX)
3. Walk nodes → find nodes with `mesh` property
4. Compute world matrix via node TRS + parent chain
5. Resolve accessors: POSITION, NORMAL, TANGENT, TEXCOORD_0, indices
6. Resolve material: pbrMetallicRoughness textures → ImageBitmap (with `colorSpaceConversion: 'none'`) plus extension-owned overrides

**GPU upload**:

- Vertex/index buffers: `mappedAtCreation`, copy bytes, unmap
- Textures: `copyExternalImageToTexture` with `premultipliedAlpha: false`, `rgba8unorm` or `rgba8unorm-srgb`
- KTX2 textures: decoder-provided mip chain uploaded by `uploadKtx2Texture2D()` for `KHR_texture_basisu`
- Mipmaps: generated for image textures via GPU blit; preserved from KTX2 decoder output for KTX2 textures
- Null textures → 1×1 opaque white fallback
- Bounding box: computed from positions × world matrix during upload

**BoomBox.glb specifics (Scene 1)**:

- 1 mesh primitive: 18,108 indices, 3,575 vertices
- 4 vertex attributes: position (f32x3), normal (f32x3), tangent (f32x4), uv (f32x2)
- 4 textures: baseColor (2048²), normal (2048²), metallicRoughness (2048²), emissive (2048²)
- World matrix from glTF node: `[-1,0,0,0, 0,1,0,0, 0,0,-1,0, 0,0,0,1]` (180° Y rotation)
- ORM packing: metallicRoughness texture has R=occlusion, G=roughness, B=metallic

### 3.9 Environment Loader (`loader-env/load-env.ts`)

**Babylon.js `.env` format**:

```
[Magic: 8B]  0x86 0x16 0x87 0x96 0xF6 0xD6 0x96 0x36
[JSON manifest: variable]  UTF-8, null-terminated
[Binary image data: rest]  Concatenated PNG/WebP face images
```

**Manifest structure** (relevant fields):

```json
{
  "width": 256,
  "imageType": "image/png",
  "irradiance": { "x": [...], "y": [...], ... "xy": [...] },
  "specular": {
    "lodGenerationScale": 0.8,
    "mipmaps": [ { "position": 0, "length": 12345 }, ... ]
  }
}
```

**Face images**: `mipmaps` array is flat: `[mip0_face0, mip0_face1, ..., mip0_face5, mip1_face0, ...]`.
Each entry has `position` (offset from binary start) and `length` (bytes).

**RGBD encoding**: Faces are RGBD-encoded (HDR in 8-bit). Decode: `hdr.rgb = rgbd.rgb / max(rgbd.a, ε)`.
Decoded in the fragment shader, not during upload.

**Cubemap upload**: `rgba8unorm`, full mip chain. All faces via `copyExternalImageToTexture`
with `premultiplyAlpha: false`, `colorSpaceConversion: 'none'`.

**BRDF LUT generation**: CPU-computed at init (no CDN dependency).

- 256×256 `rgba8unorm` texture
- Split-sum BRDF integration: Hammersley quasi-random sampling + importance-sampled GGX
- 64 samples per texel
- Smith-GGX geometry (IBL variant: `k = a²/2` where `a = roughness²`)
- Output: `R = scale`, `G = bias` (used as `specular = F0 * scale + bias`)

**Irradiance SH**: 9 Vec3 coefficients extracted from manifest, stored as Float32Array(27).

### 3.10 Shaders

PBR and Standard material shaders are **dynamically composed** from feature flags via the ShaderFragment composition system in `pbr-template.ts` and `standard-template.ts`. No raw `.wgsl` files exist for these materials.

Raw `.wgsl` shader files are still used for:

- Background materials (skybox, ground)
- Shadow passes (depth, blur)
- CubeMap skybox

All shaders are WGSL. Raw files are imported via Vite `?raw` by their respective material modules.

#### Scene Uniforms (shared struct)

```wgsl
struct SceneUniforms {
  viewProjection: mat4x4<f32>,
  view: mat4x4<f32>,
  vEyePosition: vec4<f32>,
  envRotationY: f32,
  /* SH irradiance + image processing + fog fields */
};                                // Total: 352B
```

Direct-light data is stored in the separate lights UBO, not in `SceneUniforms`.

#### PBR Vertex Shader (composed by `composePbrVertex`)

**Inputs**: position (loc 0, f32x3), normal (loc 1, f32x3), tangent (loc 2, f32x4, if HAS_NORMAL_MAP), uv (loc 2 or 3, f32x2)
**Outputs**: clipPos (builtin), worldPos, worldNormal, [worldTangent, worldBitangent], uv

**Logic**:

```
worldPos = mesh.world * vec4(position, 1.0)
clipPos = scene.viewProjection * worldPos
normalW = normalize((mesh.world * vec4(normal, 0)).xyz)
tangentW = normalize((mesh.world * vec4(tangent.xyz, 0)).xyz)
bitangentW = cross(normalW, tangentW) * tangent.w
```

#### PBR Fragment Shader (composed by `composePbrFragment`)

**BRDF functions** (all matching standard microfacet model):

1. **GGX/Trowbridge-Reitz NDF**:

    ```
    D(NdotH, α) = α⁴ / (π · (NdotH² · (α⁴ - 1) + 1)²)
    where α = roughness²
    ```

2. **Smith-GGX Height-Correlated Geometry**:

    ```
    G(NdotL, NdotV, α) = 0.5 / (NdotL·√(NdotV²·(1-α⁴)+α⁴) + NdotV·√(NdotL²·(1-α⁴)+α⁴))
    ```

3. **Schlick Fresnel**:

    ```
    F(cosθ, F0) = F0 + (1 - F0) · (1 - cosθ)⁵
    ```

4. **sRGB → Linear**: `pow(c, 2.2)` (applied to baseColor and emissive textures)

**Fragment logic**:

```
1. Sample textures (baseColor, ORM, normal, emissive)
2. Linearize sRGB (baseColor, emissive)
3. Normal mapping: TBN * (normalMap * 2 - 1)
4. Compute vectors: V, L, H, NdotL, NdotV, NdotH, VdotH
5. Material: F0 = mix(0.04, baseColor, metallic), diffuseColor = baseColor * (1 - metallic)
6. Direct lighting:
   - Cook-Torrance specular: D * G * F
   - Hemispheric diffuse: mix(groundColor, diffuseColor, dot(N,L)*0.5+0.5) / π
   - Combined: (diffuse * hemiColor + specular * lightColor * NdotL) * intensity
7. IBL:
   - Diffuse: textureSampleLevel(cubemap, N, maxMip) — RGBD decoded
   - Specular: textureSampleLevel(cubemap, reflect(-V,N), roughness*maxMip) — RGBD decoded
   - BRDF LUT: textureSample(brdfLUT, vec2(NdotV, roughness)).rg
   - Combined: (iblDiffuse * diffuseColor + iblSpecular * (F0 * brdf.x + brdf.y)) * occlusion
8. Final: direct + indirect + emissive
```

---

## 4. Scene 1 Rendering Spec (from Spector.GPU Capture)

**Source**: `playground.babylonjs.com/full.html?webgpu=1#QCU8DJ#800`

### Render Pass Configuration

- 1 render pass, 3 draw calls
- Color: `bgra8unorm`, 4x MSAA → resolve to swapchain
- Depth: `depth24plus-stencil8`, 4x MSAA
- Clear color: `{r:0.2, g:0.2, b:0.3, a:1.0}`
- Viewport: 1280×720 (depends on window)

### Draw Call 1: BoomBox

- 18,108 indices (uint16), 3,575 vertices
- 4 vertex buffers: position (42900B), normal (42900B), tangent (57200B), uv (28600B)
- PBR pipeline, back-face culling, depth write enabled

### Draw Call 2: Ground Plane

- 36 indices, 24 vertices
- 2 vertex buffers: position, normal
- Background material shader

### Draw Call 3: Skybox

- 6 indices, 4 vertices
- 3 vertex buffers: position, normal, uv
- Skybox material, depth write DISABLED

### Textures (10 total)

- 4× BoomBox PBR (2048×2048): baseColor, normal, metallicRoughness, emissive
- 1× BRDF LUT (256×256 or 128×128)
- 1× Ground texture (1024×1024)
- 2× Cubemap (specular prefiltered, with mips)
- 2× Render targets (MSAA + depth)

### Camera

- ArcRotateCamera, alpha = 1.77538207638442
- Beta, radius, target: auto-computed from mesh bounds by `createDefaultCameraOrLight(true,true,true)`

### Light

- Hemispheric, direction = [0, 1, 0], intensity = 0.7

---

## 5. Data Flow Diagram

```
main.ts (e.g. scene1.ts)
  │
  ├─→ createEngine(canvas)           → Engine { device, context, format, msaaSamples }
  ├─→ createSceneContext(engine)      → SceneContext { engine, clearColor, camera:null, ... }
  │
  ├─→ loadGltf(engine, url)          → Fetches glTF/GLB, parses, uploads to GPU
  │     Returns AssetContainer          addToScene(scene, container) registers deferred builders
  │
  ├─→ loadEnvironment(scene, url)    → Fetches .env, generates BRDF LUT, uploads cubemap
  │     Sets scene._envTextures         Registers deferred builder → buildBackgroundRenderables()
  │
  ├─→ createDefaultCamera(scene)     → Reads mesh bounds → auto-frames
  │     scene.camera = camera
  │
  ├─→ createHemisphericLight()       → Returns plain HemisphericLight data
  │     scene.lights.push(light)
  │
  └─→ registerScene(engine, scene); startEngine(engine)
        Runs deferred builders (creates pipelines + renderables)
        Builds scene._frameGraph       → begins requestAnimationFrame loop
        Each frame:
          _update(): callbacks, swaps, shadows, pre-passes, uniform updaters
          _record(): scene._frameGraph.execute()
            RenderTask writes pass scene UBO and draws bound buckets
          submit
```

---

## 6. Babylon.js Equivalence Map

| Babylon.js                           | Babylon Lite                                              | Notes                                     |
| ------------------------------------ | --------------------------------------------------------- | ----------------------------------------- |
| `new Engine(canvas)`                 | `createEngine(canvas)`                                    | Async, returns Promise                    |
| `new Scene(engine)`                  | `createSceneContext(engine)`                              | Flat struct, no observables               |
| `SceneLoader.Append(url)`            | `addToScene(scene, await loadGltf(engine, url))`          | glTF/GLB with scoped extension modules    |
| `scene.createDefaultEnvironment()`   | `loadEnvironment(scene, url)`                             | Explicit URL                              |
| `scene.createDefaultCameraOrLight()` | `createDefaultCamera(scene)` + `createHemisphericLight()` | Separate functions                        |
| `new HemisphericLight(...)`          | `createHemisphericLight(dir, intensity)`                  | Returns plain data                        |
| `new ArcRotateCamera(...)`           | `createDefaultCamera(scene)`                              | Auto-frames, returns data                 |
| `PBRMaterial`                        | `getOrCreatePbrPipeline()` + composer                     | Feature-flag pipelines                    |
| `StandardMaterial`                   | `getOrCreatePipeline()` + composer                        | Feature-flag pipelines                    |
| `scene._prepareFrame()`              | `startEngine()` runs deferred builders                    | Lazy pipeline creation                    |
| `engine.runRenderLoop(...)`          | `registerScene(engine, scene)` + `startEngine(engine)`    | One or more registered rendering contexts |

---

## 7. Build & Dev Configuration

### TypeScript (`tsconfig.base.json`)

```json
{
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "types": ["@webgpu/types"]
}
```

### Vite (engine lib build)

```typescript
// packages/babylon-lite/vite.config.ts
export default defineConfig({
    build: {
        lib: { entry: "src/index.ts", formats: ["es"] },
        rollupOptions: { external: [] },
    },
});
```

### Package resolution

During dev, `package.json` exports point to source: `"main": "./src/index.ts"`.
For production builds, switch to `"./dist/index.js"`.

---

## 8. Test Specification

### Unit Tests (per module)

- **core/mat4**: Identity, multiply, lookAtLH, perspectiveLH, invert — compare with Babylon.js `Matrix` class output
- **core/vec3**: All operations — dot, cross, normalize, length
- **camera**: Position from alpha/beta/radius matches Babylon's formula
- **loader-gltf**: Parse known GLB → verify vertex counts, index counts, bounding box
- **loader-env**: Parse known .env → verify SH coefficients, face count, mip count
- **BRDF LUT**: Generated values within tolerance of reference

### Integration Tests (Playwright + pixel diff)

- Render Scene 1 → screenshot → RMSE against reference capture < threshold
- Automated via CI with headed Chrome (WebGPU requires GPU)

### Regression

- Every new scene must pass all previous scene tests
- Pixel diff threshold: RMSE < 1.0 (out of 255)

---

## 9. Known Limitations

- **No post-processing** — Image processing applied in-shader, no separate post-process pass
- **No LOD** — Meshes rendered at full resolution regardless of distance

---

## 10. File Manifest

| File                                               | Purpose                                            | Lines (approx) |
| -------------------------------------------------- | -------------------------------------------------- | -------------- |
| `src/index.ts`                                     | Public API barrel                                  | 95             |
| `src/math/types.ts`                                | Math type definitions                              | 45             |
| `src/math/vec3.ts`                                 | Vec3 pure functions                                | 68             |
| `src/math/mat4.ts`                                 | Mat4 pure functions                                | 185            |
| `src/math/observable-vec3.ts`                      | Reactive Vec3 (position/target)                    | —              |
| `src/math/observable-quat.ts`                      | Reactive Quat (rotation)                           | —              |
| `src/engine/engine.ts`                             | WebGPU device + render loop                        | 150            |
| `src/scene/scene.ts`                               | Scene context struct + add()                       | 130            |
| `src/scene/scene-core.ts`                          | Core scene logic                                   | —              |
| `src/scene/scene-camera.ts`                        | Camera management                                  | —              |
| `src/scene/scene-remove.ts`                        | removeFromScene()                                  | —              |
| `src/scene/set-parent.ts`                          | setParent() — parent/child transforms              | —              |
| `src/scene/parentable.ts`                          | IWorldMatrixProvider, IParentable                  | —              |
| `src/scene/transform-node.ts`                      | TransformNode factory + collectMeshes              | —              |
| `src/scene/world-matrix-state.ts`                  | Version-based world matrix propagation             | —              |
| `src/camera/camera.ts`                             | Camera interface                                   | —              |
| `src/camera/arc-rotate.ts`                         | ArcRotateCamera                                    | 85             |
| `src/camera/arc-rotate-controls.ts`                | Orbit controls                                     | 70             |
| `src/camera/free-camera.ts`                        | FreeCamera                                         | —              |
| `src/camera/free-camera-controls.ts`               | WASD/arrow controls                                | —              |
| `src/light/light-base.ts`                          | Shared light base                                  | —              |
| `src/light/types.ts`                               | LightBase type, LightBaseInternal, MAX_LIGHTS      | —              |
| `src/light/light-matrix.ts`                        | Light view-projection for shadows                  | —              |
| `src/light/hemispheric.ts`                         | Hemispheric light factory                          | 16             |
| `src/light/point-light.ts`                         | Point light factory                                | 20             |
| `src/light/directional-light.ts`                   | Directional light factory                          | 20             |
| `src/light/spot-light.ts`                          | Spot light factory                                 | —              |
| `src/material/pbr/pbr-material.ts`                 | PBR material props + factory                       | 25             |
| `src/material/pbr/pbr-template.ts`                 | PBR shader template (WGSL gen)                     | 230            |
| `src/material/pbr/pbr-flags.ts`                    | PBR feature flag bitmask                           | —              |
| `src/material/pbr/pbr-pipeline.ts`                 | PBR pipeline cache                                 | 170            |
| `src/material/pbr/pbr-renderable.ts`               | PBR renderable builder                             | 140            |
| `src/material/pbr/pbr-single-rebuild.ts`           | Single-mesh PBR rebuild                            | —              |
| `src/material/pbr/fragments/singlelight-wgsl.ts`   | Non-looping single-light PBR WGSL                  | —              |
| `src/material/pbr/fragments/multilight-wgsl.ts`    | Generic multi-light PBR WGSL                       | —              |
| `src/material/pbr/background-material.ts`          | Skybox + Ground material factories                 | 217            |
| `src/material/pbr/background-renderable.ts`        | Background renderable builder                      | 96             |
| `src/material/pbr/background-dds-skybox.ts`        | DDS environment skybox                             | —              |
| `src/material/pbr/background-hdr-skybox.ts`        | HDR environment skybox                             | —              |
| `src/material/pbr/background-ground.ts`            | Background ground plane                            | —              |
| `src/material/pbr/fragments/`                      | PBR ShaderFragment modules                         | —              |
| `src/material/standard/standard-material.ts`       | Standard types + factory                           | 93             |
| `src/material/standard/standard-template.ts`       | Standard shader template (WGSL gen)                | 230            |
| `src/material/standard/standard-pipeline.ts`       | Standard pipeline cache                            | 280            |
| `src/material/standard/standard-renderable.ts`     | Standard renderable builder                        | 115            |
| `src/material/standard/standard-single-rebuild.ts` | Single-mesh Standard rebuild                       | —              |
| `src/material/standard/skybox-cubemap.ts`          | CubeMap skybox pipeline                            | 104            |
| `src/material/standard/fragments/`                 | Standard ShaderFragment modules                    | —              |
| `src/shader/shader-composer.ts`                    | ShaderFragment composer engine                     | —              |
| `src/shader/fragment-types.ts`                     | ShaderFragment interface definitions               | —              |
| `src/shader/ubo-layout.ts`                         | UBO layout helpers                                 | —              |
| `src/shader/wgsl-helpers.ts`                       | WGSL code-gen utilities                            | —              |
| `src/render/renderable.ts`                         | Renderable/PrePass/Updater interfaces              | 20             |
| `src/render/scene-helpers.ts`                      | Shared helper utilities                            | —              |
| `src/render/lights-ubo.ts`                         | Multi-light UBO packing                            | —              |
| `src/mesh/mesh.ts`                                 | Mesh type and GPU upload                           | 80             |
| `src/mesh/mesh-factories.ts`                       | High-level mesh factories                          | 50             |
| `src/mesh/thin-instance.ts`                        | Thin instance CPU data + public API                | —              |
| `src/mesh/thin-instance-gpu.ts`                    | Thin instance GPU sync                             | —              |
| `src/skeleton/create-skeleton.ts`                  | Skeleton data creation from glTF                   | —              |
| `src/skeleton/skeleton-updater.ts`                 | Joint matrix computation                           | —              |
| `src/animation/animation-group.ts`                 | AnimationGroup creation                            | —              |
| `src/animation/evaluate.ts`                        | Keyframe interpolation                             | —              |
| `src/animation/types.ts`                           | Animation type definitions                         | —              |
| `src/morph/create-morph-targets.ts`                | Morph target data + GPU texture                    | —              |
| `src/picking/gpu-picker.ts`                        | GPU ID-pass picking                                | —              |
| `src/picking/picking-pipeline.ts`                  | Picking render pipeline                            | —              |
| `src/picking/picking-shader.ts`                    | Picking WGSL shaders                               | —              |
| `src/picking/picking-helpers.ts`                   | getPickedNormal(), getPickedUV()                   | —              |
| `src/picking/picking-info.ts`                      | PickingInfo type                                   | —              |
| `src/picking/detailed-picking.ts`                  | CPU ray/triangle intersection                      | —              |
| `src/picking/ray.ts`                               | Ray intersection math                              | —              |
| `src/resource/gpu-pool.ts`                         | GPU buffer/texture pooling                         | —              |
| `src/shadow/shadow-base.ts`                        | Shared shadow logic                                | —              |
| `src/shadow/shadow-generator.ts`                   | ESM shadow generator                               | 150            |
| `src/shadow/pcf-shadow-generator.ts`               | PCF shadow generator                               | —              |
| `src/shadow/shadow-renderable.ts`                  | Shadow PrePassRenderable                           | 80             |
| `src/frame-graph/task.ts`                          | Frame-graph task interface                         | —              |
| `src/frame-graph/frame-graph.ts`                   | Ordered frame-graph task list                      | —              |
| `src/frame-graph/frame-graph-actions.ts`           | Task insertion helpers                             | —              |
| `src/frame-graph/render-pass-task.ts`              | Render-pass task, per-pass scene UBO, draw buckets | —              |
| `src/texture/texture-2d.ts`                        | 2D texture loader                                  | 60             |
| `src/texture/solid-texture.ts`                     | 1×1 solid-color factory                            | —              |
| `src/texture/cube-texture.ts`                      | 6-face cube texture loader                         | 141            |
| `src/texture/rtt.ts`                               | Render-target texture helper                       | —              |
| `src/texture/ktx2-loader.ts`                       | KTX2/BasisU upload for `KHR_texture_basisu`        | —              |
| `src/texture/rtt-mip.ts`                           | Mipmapped render-target texture helper             | —              |
| `src/texture/record-mipmaps.ts`                    | Encoder-local mipmap recording                     | —              |
| `src/texture/generate-mipmaps.ts`                  | GPU mipmap generation                              | —              |
| `src/loader-gltf/load-gltf.ts`                     | GLB parser + GPU upload                            | 390            |
| `src/loader-gltf/gltf-parser.ts`                   | glTF JSON parsing helpers                          | —              |
| `src/loader-gltf/gltf-material.ts`                 | glTF material → PbrMaterialProps                   | —              |
| `src/loader-gltf/gltf-ext-basisu.ts`               | `KHR_texture_basisu` dynamic feature               | —              |
| `src/loader-gltf/gltf-animation.ts`                | glTF animation extraction                          | —              |
| `src/loader-env/load-env.ts`                       | .env parser + RGBD decode                          | 240            |
| `src/loader-env/load-dds-env.ts`                   | DDS environment loading                            | —              |
| `src/loader-env/env-helpers.ts`                    | Environment helper utilities                       | —              |
| `src/loader-env/rgbd-decode.ts`                    | Shared RGBD decode helpers                         | —              |
| `src/loader-hdr/load-hdr.ts`                       | HDR environment pipeline                           | —              |
| `src/loader-hdr/hdr-parser.ts`                     | RGBE file parser                                   | —              |
| `src/loader-hdr/hdr-ibl-pipeline.ts`               | GPU compute IBL from HDR                           | —              |
| `src/loader-babylon/load-babylon.ts`               | .babylon format parser                             | —              |
| `src/loader-skybox/load-skybox.ts`                 | High-level skybox loader                           | —              |
| `src/loader-skybox/skybox-renderable.ts`           | Skybox → Renderable builder                        | —              |
| `lab/src/lite/scene1.ts`                           | Scene 1: BoomBox PBR                               | 44             |
| `lab/src/lite/scene*.ts`                           | Scenes 1–112 (dev sandbox)                         | —              |
