# Module: Node Particles (NPE)

> Package path: `packages/babylon-lite/src/particle/`
>
> This document specifies the complete node-particle feature. It is sufficient to recreate the parser, graph builder, CPU simulation, feature storage, sprite-sheet support, billboard and Sprite2D synchronization, and live registration paths.

## 1. Scope and goals

The feature executes serialized Node Particle Editor graphs on the CPU. Its compatibility boundary is the set of NPE blocks and serialized values listed here, not the full classic `ParticleSystem` surface.

The design requirements are:

- CPU NPE graphs only. There is no GPU particle simulation path.
- `ParticleSystem` is mutable pure state. Behavior is supplied by standalone functions. The public surface is imperative through functions such as `startParticleSystem`, `stopParticleSystem`, and `animateParticleSystem`; it does not expose a Babylon-style particle constructor or attached particle-system methods.
- Particle attributes use Struct-of-Arrays storage. A particle is an integer slot, not an allocated particle value.
- Simulation order, random-number consumption, numeric storage, and lifecycle boundaries follow the Babylon.js compatibility contract and are verified against Babylon.js as the equivalence oracle.
- Rendering supports two explicit targets: camera-facing world-space billboards and a pure-2D Sprite2D bridge over NPE world XY. The Sprite2D path does not project XZ or YZ planes.
- Code and optional storage are pay-for-use. Reachable block evaluators are dynamically imported, and optional feature columns are allocated only by features that need them. Every buffer contains the base simulation and standard NPE render/lifecycle columns described in section 4.
- The indexed simulation path does not allocate per particle or per update. Graph getters return scalars or reused scratch values. Billboard synchronization allocates transient values for each live particle; Sprite2D synchronization writes packed buffers directly without per-particle allocations.

## 2. Package-root API

`packages/babylon-lite/src/index.ts` exports exactly twenty-seven node-particle functions and twelve node-particle types.

### 2.1 Functions

```ts
function parseNodeParticleSource(source: unknown): ParticleGraph;
function normalizeNodeParticleGraph(graph: ParticleGraph): Promise<ParticleGraph>;

function buildNodeParticleSet(engine: EngineContext, scene: SceneContext, graph: ParticleGraph, options?: BuildNodeParticleOptions): Promise<NodeParticleSet>;
function buildNodeParticleSetWithBlendModes(engine: EngineContext, scene: SceneContext, graph: ParticleGraph, options?: BuildNodeParticleOptions): Promise<NodeParticleSet>;
function buildNodeParticleSetWithFlowMaps(engine: EngineContext, scene: SceneContext, graph: ParticleGraph, options?: BuildNodeParticleOptions): Promise<NodeParticleSet>;
function buildNodeParticleSetWithNoiseTextures(engine: EngineContext, scene: SceneContext, graph: ParticleGraph, options?: BuildNodeParticleOptions): Promise<NodeParticleSet>;
function buildNodeParticleSetWithTextureUpdates(engine: EngineContext, scene: SceneContext, graph: ParticleGraph, options?: BuildNodeParticleOptions): Promise<NodeParticleSet>;
function buildNodeParticleSetWithEmitterProvider(
    engine: EngineContext,
    scene: SceneContext,
    graph: ParticleGraph,
    provider: NodeParticleEmitterProvider,
    options?: BuildNodeParticleOptions
): Promise<NodeParticleSet>;
function withNodeParticleEmitterProvider<T extends object = BuildNodeParticleOptions>(
    provider: NodeParticleEmitterProvider,
    options?: T & BuildNodeParticleOptions
): T & BuildNodeParticleOptions;
function enableNodeParticleBlendModes(set: NodeParticleSet): NodeParticleSet;

function parseNodeParticleSetFromSnippet(engine: EngineContext, scene: SceneContext, snippetId: string, options?: ParseNodeParticleOptions): Promise<NodeParticleSet>;

function startParticleSystem(system: ParticleSystem): void;
function stopParticleSystem(system: ParticleSystem): void;
function isParticleSystemStarted(system: ParticleSystem): boolean;
function animateParticleSystem(system: ParticleSystem, scaledRatio: number): void;

function createParticleBillboard(system: ParticleSystem): FacingBillboardSpriteSystem;
function syncParticleBillboard(system: ParticleSystem, billboard: FacingBillboardSpriteSystem): void;

function registerNodeParticleSet(scene: SceneContext, set: NodeParticleSet, options?: RegisterNodeParticleOptions): void;
function getParticleSystems(scene: SceneContext): readonly ParticleSystem[];

function createParticleSprite2DBridge(system: ParticleSystem, options?: ParticleSprite2DBridgeOptions): ParticleSprite2DBridge;
function syncParticleSprite2DBridge(bridge: ParticleSprite2DBridge): void;
function registerNodeParticleSet2D(renderer: SpriteRenderer, set: NodeParticleSet, options?: RegisterNodeParticleSet2DOptions): NodeParticleSet2DBinding;
function disposeNodeParticleSet2DBinding(binding: NodeParticleSet2DBinding): void;

function createParticleSprite2DBridgeWithBlendModes(system: ParticleSystem, options?: ParticleSprite2DBridgeOptions): ParticleSprite2DBlendModesBridge;
function syncParticleSprite2DBridgeWithBlendModes(bridge: ParticleSprite2DBlendModesBridge): void;
function registerNodeParticleSet2DWithBlendModes(renderer: SpriteRenderer, set: NodeParticleSet, options?: RegisterNodeParticleSet2DOptions): NodeParticleSet2DBlendModesBinding;
function disposeNodeParticleSet2DBlendModesBinding(binding: NodeParticleSet2DBlendModesBinding): void;
```

`buildNodeParticleSetWithFlowMaps`, `buildNodeParticleSetWithNoiseTextures`, and `buildNodeParticleSetWithTextureUpdates` are `@deprecated` functions that forward their arguments unchanged to `buildNodeParticleSet`. They were explicit opt-in builders before the block manifest (section 7.4). `UpdateFlowMapBlock` and `UpdateNoiseBlock` now load through the manifest like every other class, so every builder supports them. The wrappers remain exported as function declarations with their original signatures, so the public API is unchanged, and they carry no separate implementation.

All twenty-seven functions listed above, including the graph normalizer, build-options helper, and blend-mode enabler, are public package-root exports. `ParticleGraph` is returned by `parseNodeParticleSource` and accepted and returned by `normalizeNodeParticleGraph`, but it is not a named node-particle type export from the package root. TypeScript infers the graph type through the parser/normalizer chain, and the rolled-up declaration represents it the same way as the existing parser API without adding a casual named export.

### Scene discovery

`ParticleSystem.name?: string` retains a non-empty NPE `SystemBlock` name for both inline JSON and snippet builds. Unnamed systems omit the property. `isParticleSystemStarted(system)` returns `_started && !_stopped`: stopped systems can still contain draining particles in `buffer.alive`. Capacity remains available through `buffer.capacity`; start/stop use the existing standalone functions.

`getParticleSystems(scene)` enumerates only systems registered through the 3D `registerNodeParticleSet`, in first-registration order, deduped by identity. It returns the live readonly array; copy it for a snapshot. `SceneContext` declares an optional `@internal _particleSystems?: ParticleSystem[]` with a type-only import; this adds no emitted code, and the field is stripped from published declarations. The particle module owns allocation and cleanup. In the existing per-system registration loop, the first system lazily allocates the list and installs exactly one scene disposer that clears it with `length = 0`; each system is appended only when not already included. The list is add-only until scene disposal, and existing references observe the clear. Without a list, the getter returns a fresh `[]`.

Enumeration dedupe does **not** dedupe rendering: each registration still builds its billboard and pushes its own frame callback. Existing callback order, mid-frame registration, pick registration, and `autoStart` behavior are unchanged. There is no unregister or scheduler consolidation. 2D bindings are not enumerated, and all listed systems are CPU systems. Costs are a lazy array and cleanup closure per particle scene, an identity `includes` check per registration, and a name reference per named system; non-particle scenes create no such storage.

Focused tests cover ordered membership, duplicates with duplicate rendering preserved, `autoStart: false`, callback ordering and mid-frame registration, scene isolation, disposal, retained names, and started/stopped state with draining particles.

### 2.2 Types

```ts
interface BuildNodeParticleOptions {
    emitter?: Vec3;
    emitterWorldMatrix?: Mat4;
    textureBaseUrl?: string;
}

interface ParseNodeParticleOptions extends BuildNodeParticleOptions {
    json?: string | object;
    snippetServer?: string;
}

type NodeParticleEmitterProvider = () => Mat4;

interface NodeParticleSet {
    readonly systems: ParticleSystem[];
    /** @internal */
    _graph: ParticleGraph;
}

interface RegisterNodeParticleOptions {
    autoStart?: boolean;
}

interface ParticleSprite2DBridgeOptions {
    pixelsPerUnit?: number;
    originPx?: readonly [number, number];
    invertY?: boolean;
    layer?: Pick<Sprite2DLayerOptions, "opacity" | "visible" | "order" | "view">;
}

interface ParticleSprite2DBridge {
    readonly system: ParticleSystem;
    readonly layer: Sprite2DLayer;
    pixelsPerUnit: number;
    originPx: [number, number];
    invertY: boolean;
}

interface RegisterNodeParticleSet2DOptions extends ParticleSprite2DBridgeOptions {
    autoStart?: boolean;
}

interface NodeParticleSet2DBinding {
    /** @internal */
    readonly _entityType: "node-particle-set-2d-binding";
    readonly bridges: readonly ParticleSprite2DBridge[];
    active: boolean;
    /** @internal */
    _dispose: () => void;
}

interface ParticleSprite2DBlendModesBridge {
    readonly system: ParticleSystem;
    /** Primary presentation layer: the only layer for modes 0-3/default, or the Multiply layer for mode 4. */
    readonly layer: Sprite2DLayer;
    /** All ordered render-pass layers. Mode 4 contains `[Multiply, Add]`; every other mode contains `[layer]`. */
    readonly layers: readonly Sprite2DLayer[];
    pixelsPerUnit: number;
    originPx: [number, number];
    invertY: boolean;
    /** @internal */
    readonly _passes: readonly ParticleSprite2DBridge[];
}

interface NodeParticleSet2DBlendModesBinding {
    /** @internal */
    readonly _entityType: "node-particle-set-2d-blend-modes-binding";
    readonly bridges: readonly ParticleSprite2DBlendModesBridge[];
    active: boolean;
    /** @internal */
    _dispose: () => void;
}
```

`ParticleSystem` is the tenth exported type and is specified in section 5. `ParticleSprite2DBlendModesBridge` and `NodeParticleSet2DBlendModesBinding` are the eleventh and twelfth exported types. `NodeParticleEmitterProvider` is a pure state source: it accepts no runtime objects and returns only a matrix value. `NodeParticleSet.systems` is a mutable array behind a readonly property, and each system and its typed arrays are mutable. Both bridge families expose readonly system/layer references while keeping `pixelsPerUnit`, `originPx`, and `invertY` mutable. Both binding families expose a readonly bridge list and mutable `active` state. Every public type is pure state; behavior remains in standalone functions.

### 2.3 Breaking migration

The post-build `enableNodeParticleEmitterProvider` API is removed with no deprecated compatibility shim. Move provider selection into the builder options:

```ts
// Removed
await enableNodeParticleEmitterProvider(await builder(engine, scene, graph, options), provider);

// Replacement for every node-particle builder, including snippet parsing
await builder(engine, scene, graph, withNodeParticleEmitterProvider(provider, options));
```

The default-builder convenience remains `buildNodeParticleSetWithEmitterProvider(engine, scene, graph, provider, options)`. The options helper returns a shallow copy, preserves extension-specific fields such as `ParseNodeParticleOptions.json` and `snippetServer`, and gives the provider precedence over static `emitterWorldMatrix` and `emitter` values.

### 2.4 Phase 3 graph migration

Direct `parseNodeParticleSource` users opt in to Teleport, LocalVariable, Elbow, and Debug support explicitly before invoking any builder. One normalized graph composes with the default, blend-mode, and provider-backed builders, including the deprecated texture-update aliases of the default builder:

```ts
const graph = await normalizeNodeParticleGraph(parseNodeParticleSource(source));
const set = await buildNodeParticleSet(engine, scene, graph);
```

Calling a builder directly with an unnormalized graph whose reachable edge targets `ParticleTeleportOutBlock` preserves the existing unsupported-value-block error. This omission behavior is intentional: the parser can represent Teleport records, but direct builders support their routing semantics only after the caller normalizes the graph.

Elbow and Debug likewise remain unsupported when direct normalization is omitted. LocalVariable owns an evaluator, so a structurally simple unnormalized graph can reach that optional evaluator, but doing so bypasses mandatory connection-role and domain-mask validation and is unsupported. Every direct graph containing any Phase 3C class must be normalized first.

`parseNodeParticleSetFromSnippet` is already an asynchronous arbitrary-content boundary, so it always calls `normalizeNodeParticleGraph` after parsing and before its default build. Inline JSON and fetched snippets therefore gain Teleport support automatically. A non-Teleport snippet pays only the thin graph scan, receives the exact parsed graph reference from the helper, and does not fetch the heavy runtime.

### 2.5 Internal APIs

The following symbols are implementation APIs and are not node-particle package-root exports:

- Graph types: `ParticleGraph`, `ParsedParticleBlock`, and `ParsedParticleInput`.
- Build types: `NpeBuildState`, `NpeBuildContext`, and `NpeBlockEvaluator`.
- Value types: `NpeValue`, `NpeTextureValue`, `NpeTextureContent`, `NpeGetter`, `ScalarGetter`, `Vec3Getter`, `Color4Getter`, and `ParticleStep`.
- Storage types and functions: `ParticleColumn`, `ParticleBuffer`, `createParticleBuffer`, `column`, `spawnParticle`, and `killParticle`.
- Runtime construction: `ParticleSpriteHandle` and `createParticleSystem`.
- Sprite features: `SpriteSheetConfig`, `SpriteSheet`, `useSpriteSheet`, and `useRandomSpriteSheet`.
- Snippet transport: `fetchNodeParticleSnippet`.
- Graph-plumbing runtime: `normalizeNodeParticleGraphRuntime` and the internal `_isGraphPlumbingNormalized` marker.
- Contextual factories, local-position helpers, evaluator values, and the block manifest loader `loadNpeBlock`.

## 3. Modules, ownership, and data flow

The direct data flow is:

```text
serialized value
    -> parseNodeParticleSource
    -> ParticleGraph
    -> for a Teleport graph: explicit normalizeNodeParticleGraph
     -> buildNodeParticleSet
         or buildNodeParticleSetWithBlendModes for exact billboard Multiply/MultiplyAdd rendering
         with options from withNodeParticleEmitterProvider for a live emitter matrix on any builder
         or buildNodeParticleSetWithEmitterProvider as the default-builder convenience form
     -> optional enableNodeParticleBlendModes for exact billboard blending on a set from any builder
    -> NodeParticleSet { systems }
    -> startParticleSystem / stopParticleSystem / animateParticleSystem
        -> billboard target:
                 createParticleBillboard + syncParticleBillboard
                 -> addBillboardSystemToScene or registerNodeParticleSet
             or pure-2D target:
                 createParticleSprite2DBridge + syncParticleSprite2DBridge
                 -> addSpriteRendererLayer or registerNodeParticleSet2D
             or exact-blend pure-2D target:
                 createParticleSprite2DBridgeWithBlendModes + syncParticleSprite2DBridgeWithBlendModes
                 -> registerNodeParticleSet2DWithBlendModes
```

The snippet convenience flow is:

```text
inline JSON or fetched snippet response
    -> parseNodeParticleSource
    -> normalizeNodeParticleGraph automatically
        no TeleportOut -> exact graph, heavy runtime not fetched
        TeleportOut    -> lazy runtime normalization
    -> buildNodeParticleSet
```

The runtime layers are:

```text
particle-buffer.ts       dense typed-array storage and slot lifecycle
particle-system.ts       mutable system state and CPU simulation
sprite-columns*.ts       optional sprite cell state and animation
particle-billboard.ts    conversion of live columns to billboard instances
particle-blend.ts        exact Babylon.js particle blend descriptors
particle-billboard-scene.ts
                         ordinary/advanced scene registration boundary
particle-billboard-renderable.ts
                         lazy Multiply shader and MultiplyAdd second pass
particle-scene.ts        scene registration and per-frame callback wiring
particle-sprite-2d.ts    packed Sprite2D bridge and renderer binding lifecycle
particle-sprite-2d-blend-modes.ts
                         optional exact Sprite2D descriptors, Multiply shader, and mode-4 pass/lifecycle composition

node/npe-parser.ts       serialized source normalization
node/npe-types.ts        readonly TypeScript graph shapes
node/npe-build.ts        root-reachable DFS and system construction
node/npe-blend-modes.ts  explicit Multiply/MultiplyAdd rendering enabler
node/npe-emitter-provider.ts
                         build-options helper, provider validation/copy/inverse refresh, and convenience builder
node/npe-value.ts        indexed getter and step contracts
node/npe-texture-content.ts
                         pay-for-use CPU RGBA texture decoding
node/npe-flow-map.ts, node/npe-noise.ts, node/npe-texture-updates.ts
                         deprecated aliases of buildNodeParticleSet
node/npe-contextual*.ts  contextual source getters and optional columns
node/npe-local-position.ts
                         local birth seeding and world-position conversion
node/npe-manifest.ts     base class-name to lazy block-module table and loadNpeBlock
node/npe-manifest-extra.ts
                         extension class table, fetched on a base-table miss
node/blocks/*.ts         supported block classes, block-local optional paths, and helpers
```

`particle-billboard.ts` produces a `FacingBillboardSpriteSystem`; the billboard subsystem owns atlas interpretation, normal pipeline selection, GPU instance data, and base renderable construction. The particle package owns only the lazy Multiply fragment body and the MultiplyAdd wrapper around that base renderable. It does not duplicate billboard geometry or instance-buffer implementations.

The private Multiply shader keeps its vertex WGSL local while reusing `makeBillboardBasisWgsl`. A shared runtime vertex helper was measured and rejected because its cross-chunk edge grew ordinary billboard bundles that do not use particle blending.

`particle-sprite-2d.ts` creates and exclusively bulk-writes a `Sprite2DLayer`; the sprite subsystem continues to own that layer's packed layout, dirty tracking, upload, pipeline, and `SpriteRenderer` draw path. `particle-sprite-2d-blend-modes.ts` is a separate particle-owned opt-in consumer of that baseline bridge. It reuses the exact descriptor factory, adds only the Sprite2D Multiply fragment and mode-4 layer composition, and imports no billboard renderable or scene-registration module. The ordinary bridge never imports the exact module. The particle package owns particle-to-render-target mapping and live-registration policy rather than generic material, pipeline, bind-group, or GPU instance-buffer implementations.

### 3.1 Direct dependencies outside `particle/`

- Camera: `camera/camera.ts`.
- Engine type: `engine/engine.ts`.
- Math: `math/types.ts`, `math/random-range.ts`, `math/create-identity-mat4.ts`, `math/invert-mat4.ts`, `math/invert-mat4-to-ref-or-identity.ts`, `math/mat4-transform.ts`, and `math/create-translation-mat4.ts`.
- Scene: `scene/scene.ts` and `scene/scene-core.ts`.
- Texture: `texture/texture-2d.ts`.
- Sprite: `sprite/shared/sprite-atlas.ts`, `sprite/billboard-sprite.ts`, `sprite/billboard-blend.ts`, `sprite/billboard-scene.ts`, `sprite/billboard-custom-shader.ts`, `sprite/billboard-pipeline.ts`, `sprite/billboard-renderable.ts`, `sprite/sprite-2d.ts`, `sprite/sprite-blend.ts`, `sprite/sprite-custom-shader.ts`, and `sprite/sprite-renderer.ts`.

`billboard-scene.ts` registers the billboard as a scene-owned deferred renderable and pick source. It dynamically imports `sprite/billboard-renderable.ts` when scene renderables are built and `picking/billboard-pick-pipeline.ts` when picking first needs that source.

The Sprite2D dependency is one-way: the opt-in particle bridges import sprite modules, while static Sprite2D code never imports particle code. The baseline bridge does not import the advanced bridge. Consequently, scenes that do not import either bridge pay no particle-bridge bytes, and scenes that import only the baseline bridge pay no exact descriptor, custom-shader, or two-pass bytes.

## 4. Particle storage

### 4.1 Built-in columns

`createParticleBuffer(capacity)` creates 21 columns, each with exactly `capacity` elements:

| Field                                                  | Typed array    | Meaning                        |
| ------------------------------------------------------ | -------------- | ------------------------------ |
| `posX`, `posY`, `posZ`                                 | `Float32Array` | world render position          |
| `dirX`, `dirY`, `dirZ`                                 | `Float32Array` | movement direction or velocity |
| `age`                                                  | `Float64Array` | elapsed particle lifetime      |
| `lifeTime`                                             | `Float64Array` | death threshold                |
| `id`                                                   | `Uint32Array`  | spawn identity                 |
| `size`                                                 | `Float32Array` | uniform particle size          |
| `angle`                                                | `Float32Array` | render rotation                |
| `scaleX`, `scaleY`                                     | `Float32Array` | per-axis size multipliers      |
| `colorR`, `colorG`, `colorB`, `colorA`                 | `Float32Array` | current render color           |
| `colorStepR`, `colorStepG`, `colorStepB`, `colorStepA` | `Float32Array` | color change per lifetime unit |

`ParticleColumn` is the union `Float64Array | Float32Array | Uint32Array | Uint16Array | Uint8Array | Int32Array`.

`ParticleBuffer` is:

```ts
interface ParticleBuffer {
    readonly capacity: number;
    alive: number;
    readonly posX: Float32Array;
    readonly posY: Float32Array;
    readonly posZ: Float32Array;
    readonly dirX: Float32Array;
    readonly dirY: Float32Array;
    readonly dirZ: Float32Array;
    readonly age: Float64Array;
    readonly lifeTime: Float64Array;
    readonly id: Uint32Array;
    readonly size: Float32Array;
    readonly angle: Float32Array;
    readonly scaleX: Float32Array;
    readonly scaleY: Float32Array;
    readonly colorR: Float32Array;
    readonly colorG: Float32Array;
    readonly colorB: Float32Array;
    readonly colorA: Float32Array;
    readonly colorStepR: Float32Array;
    readonly colorStepG: Float32Array;
    readonly colorStepB: Float32Array;
    readonly colorStepA: Float32Array;
    readonly _columns: Map<string, ParticleColumn>;
    readonly _all: ParticleColumn[];
    _nextId: number;
}
```

Live particles occupy the dense interval `[0, buffer.alive)`. `_all` starts with all 21 built-in arrays and receives every optional feature array.

`spawnParticle` returns `-1` when `alive >= capacity`. On success it reserves `i = alive`, increments `alive`, writes `id[i] = _nextId++`, writes `age[i] = 0`, and returns `i`. It does not clear any other base or feature slot; creation steps must write every field they own.

`killParticle(buffer, i)` decrements `alive`, copies the last live slot into `i` across every array in `_all` when `i` is not the last slot, and leaves values beyond the live range unspecified. This swap-remove rule applies equally to base, standard, and feature-only columns.

`column(buffer, name, ctor)` returns the existing `_columns` entry when the string key exists. Otherwise it constructs `new ctor(capacity)`, stores it by name, and appends it to `_all`. Callers using the same string share the same array. The function does not verify that a later constructor matches the constructor used for the first allocation.

### 4.2 Standard render/lifecycle fields

Twelve of the built-in `Float32Array` fields provide the standard NPE creation and rendering state:

| State      | Direct fields                                          |
| ---------- | ------------------------------------------------------ |
| Size       | `size`                                                 |
| Angle      | `angle`                                                |
| Scale      | `scaleX`, `scaleY`                                     |
| Color      | `colorR`, `colorG`, `colorB`, `colorA`                 |
| Color step | `colorStepR`, `colorStepG`, `colorStepB`, `colorStepA` |

`CreateParticleBlock` initializes these fields for each birth, contextual and update blocks read or modify them, and both `syncParticleBillboard` and `syncParticleSprite2DBridge` read the render subset directly. The Sprite2D synchronizer consumes XY position only and ignores `posZ`. They are part of every buffer because the primary runtime contract is a renderable NPE particle system.

### 4.3 Feature-only columns

Only these columns are allocated in addition to the base and standard columns:

- `InitialColor` source `0x13`: `initialColor.r`, `initialColor.g`, `initialColor.b`, and `initialColor.a`, all `Float32Array`.
- `ColorDead` source `0x14`: `colorDead.r`, `colorDead.g`, `colorDead.b`, and `colorDead.a`, all `Float32Array`.
- `InitialDirection` source `0x15`: `initialDir.x`, `initialDir.y`, and `initialDir.z`, all `Float32Array`, unless mesh-normal emission selects the constant zero source without allocating them.
- `LocalPositionUpdated` source `0x18`: `localPosition.x`, `.y`, and `.z` as `Float32Array`, `localPosition.id` as `Uint32Array`, and `localPosition.valid` as `Uint8Array`.
- Scalar OncePerParticle random cache for block `B`: `random.B.id` as `Uint32Array`, `random.B.valid` as `Uint8Array`, and `random.B.value0` as `Float64Array`.
- Vector or color OncePerParticle cache for block `B`: the same id and valid arrays plus `random.B.value0...N` as `Float64Array`. The component count is two for Vector2 and other non-Vector3/non-Color4 tags, three for Vector3, and four for Color4. The block id is part of the column key; the current particle id stored in the id column invalidates a recycled slot. Cache memory is bounded by particle capacity.
- Sprite animation: `sprite.cellIndex` as `Uint16Array`.
- Random-start sprite animation: `sprite.randomOffset` as `Float32Array` in addition to `sprite.cellIndex`.

## 5. ParticleSystem and simulation

### 5.1 State and defaults

```ts
interface ParticleSpriteHandle {
    readonly cellWidth: number;
    readonly cellHeight: number;
    readonly cellIndex: Uint16Array;
    readonly update: (i: number) => void;
}

interface ParticleSystem {
    readonly buffer: ParticleBuffer;
    emitRate: number;
    updateSpeed: number;
    targetStopDuration: number;
    blendMode: number;
    texture: Texture2D | null;

    createLifeTime: ParticleStep | null;
    createPosition: ParticleStep | null;
    createDirection: ParticleStep | null;
    createEmitPower: ParticleStep | null;
    createSize: ParticleStep | null;
    createAngle: ParticleStep | null;
    createColor: ParticleStep | null;
    createColorDead: ParticleStep | null;
    updateSteps: ParticleStep[];

    _scaledStep: number;
    _emitPower: number;
    _scaledUpdateSpeed: number;
    _newPartsExcess: number;
    _started: boolean;
    _stopped: boolean;
    _actualFrame: number;
    _emitRateGetter?: () => number;
    _prepareFrame?: () => void;
    _spriteSheet?: ParticleSpriteHandle;
    _writeColorDead?: (i: number, color: Color4) => void;
    _suppressInitialDirectionCapture?: boolean;
    _seedLocalPosition?: ParticleStep;
    _registerBillboard?: (scene: SceneContext, billboard: FacingBillboardSpriteSystem) => void;
}
```

`createParticleSystem(capacity)` is internal. It creates a fresh buffer and sets:

| Field                     | Default          |
| ------------------------- | ---------------- |
| `emitRate`                | `10`             |
| `updateSpeed`             | `0.0167`         |
| `targetStopDuration`      | `0`              |
| `blendMode`               | `2`              |
| `texture`                 | `null`           |
| all eight `create*` slots | `null`           |
| `updateSteps`             | `[]`             |
| `_scaledStep`             | `0`              |
| `_emitPower`              | `1`              |
| `_scaledUpdateSpeed`      | `0`              |
| `_newPartsExcess`         | `0`              |
| `_started`, `_stopped`    | `false`, `false` |
| `_actualFrame`            | `0`              |

Optional internal fields are absent until a feature installs them.

### 5.2 Start and stop

`startParticleSystem(system)` sets `_started = true`, `_stopped = false`, and `_actualFrame = 0`. It does not clear live particles, ids, columns, creation/update steps, `_newPartsExcess`, texture, or feature handles.

`stopParticleSystem(system)` sets `_stopped = true`. It does not set `_started = false` and does not clear live particles. Calls to `animateParticleSystem` continue to update and expire live particles while suppressing creation.

Starting a stopped system resets simulated time and permits emission while retaining all live particles and fractional emission carry.

### 5.3 Feature-owned frame preparation

`_prepareFrame` is one optional zero-argument callback. A normal static system leaves it absent. `animateParticleSystem` invokes it after the `_started` guard and before scaled-speed, dynamic emit-rate, existing-particle, or birth work. The public animation signature remains exactly `(system, scaledRatio)`; camera and target dimensions are not simulation inputs.

The base particle system has no camera or target-size preparation API. Camera-dependent optional features own their preparation behind their enabler. Once its flow map decodes, UpdateFlowMap composes a callback into `_prepareFrame`, with the same previous-then-new ordering, and that callback snapshots the current view-projection matrix at the start of every simulation call. Because the system owns the callback, a failed decode or a discarded or rejected build leaves no frame work behind, and manual `animateParticleSystem` calls re-snapshot after the camera or target size changes. The callback reaches the scene only through a per-scene projection source that scene disposal detaches, so a system stepped after its scene is disposed keeps its last snapshot and retains no scene.

`withNodeParticleEmitterProvider(provider, options)` is the build-time opt-in. It samples and validates the provider immediately, returns a shallow copy of the supplied options with one internal `_setupEmitter` callback, and preserves extension-specific option fields through its generic intersection return type. The result can be passed to every node-particle builder or to `parseNodeParticleSetFromSnippet`. Each builder calls the callback with its temporary `NpeBuildState` immediately after constructing that state and before evaluator traversal. The callback replaces any caller-owned static matrix reference with a fresh provider-owned stable matrix, copies the initial matrix and translation into stable evaluator references, assigns a fresh provider-owned inverse list, and installs frame preparation on that system. Provider setup does not mutate the original options or their `emitterWorldMatrix`.

Provider setup installs `_prepareFrame` before evaluator traversal using its Phase 2 closure. The first reachable Loop LocalVariable wraps that existing callback with the same previous-then-new ordering inside its lazy evaluator during traversal. Keeping composition feature-local prevents never-fetched LocalVariable code from changing provider-only or ordinary particle bundles. Provider preparation remains first, later callback failures cannot run after an earlier failure, and no shared helper or root file is added.

Setup copies the stable emitter vector, emitter matrix, and inverse-list references into local variables immediately. The provider callback retains only those references, the provider, one private next-matrix scratch, one lazily allocated inverse scratch, and any prior frame callback. It does not retain `NpeBuildState`, `SceneContext`, `ParticleSystem`, its buffer, the options object, or graph-build data, and it does not point back to the owning system. The Loop composition wrapper, when needed, retains only the previous provider callback and its feature-owned epoch increment. The wrapped options object retains only the provider, validated initial matrix, and setup callback; it never accumulates references to systems or builds. Static systems allocate no provider array, inverse-list collection, object, closure, scratch matrix, or provider field.

The provider result must be a finite 16-element matrix. Validation copies into private scratch storage before touching builder-owned references. Initial implicit-cylinder inverses are computed during traversal from the already-copied provider matrix. On a started frame, that system's refresh checks its own inverse list, lazily allocates one private inverse scratch when needed, and computes the sampled inverse with identity fallback for singular matrices. Only after the complete sample succeeds does refresh commit that system's stable emitter matrix, translation vector, and collected inverse matrices. Provider exceptions propagate unchanged; structural or finite-value errors use the explicit provider error. Either failure leaves stable references and particle simulation state unchanged.

The initial helper sample establishes provider precedence over any static `emitterWorldMatrix` or `emitter` supplied in the wrapped options. A provider may return a new matrix object on every sample or mutate and return the same object; every accepted sample is copied into stable builder-owned references. There is no post-build provider replacement path and no provider handle on a system.

One wrapped options object may be reused across builds without coupling them. Its single validated helper-time snapshot seeds every system built from that object; setup itself does not sample again. Each installed frame hook then samples the current provider exactly once and updates only its own system before simulation. A fresh wrapper is required only when a later build must use a new build-time snapshot before it starts. Animating two systems produces two independent samples, one per animation call. An unstarted call returns without sampling. A stopped-but-started system still samples before its drain update because `stopParticleSystem` does not clear `_started`.

### 5.4 One animation call

`animateParticleSystem(system, scaledRatio)` performs these operations in this exact order:

1. Return when `_started` is false.
2. Invoke `_prepareFrame?.()` when present.
3. Compute `scaledUpdateSpeed = updateSpeed * scaledRatio` and assign it to `_scaledUpdateSpeed`.
4. Evaluate `_emitRateGetter()` when present; otherwise read `emitRate`. A connected getter observes the current `_actualFrame` before this call advances it.
5. Compute `emission = emitRate * scaledUpdateSpeed` and `newParticles = emission >> 0`.
6. Add `emission - newParticles` to `_newPartsExcess`. Only when `_newPartsExcess > 1.0`, take `extra = _newPartsExcess >> 0`, add `extra` to `newParticles`, and subtract `extra` from `_newPartsExcess`. Equality with `1.0` does not release a particle.
7. If `_stopped` was already true, set `newParticles = 0`. The rate getter and fractional-carry calculation have already run.
8. If `_stopped` was false, add `scaledUpdateSpeed` to `_actualFrame`. When `targetStopDuration` is truthy and `_actualFrame >= targetStopDuration`, call `stopParticleSystem`. The `newParticles` count computed for this call is retained, so the threshold call still creates its computed cohort.
9. Update all particles that were live at the start of the update loop.
10. Create up to `newParticles`, subject to capacity.

The `| 0` and `>> 0` operations use JavaScript signed 32-bit conversion. Rates, ratios, and speeds are not clamped or validated.

### 5.5 Existing-particle update and death

For each dense slot, in ascending slot order:

1. Set `stepSpeed = scaledUpdateSpeed` and `ageBefore = age[i]`.
2. Write `age[i] = ageBefore + stepSpeed`.
3. If the new age is greater than `lifeTime[i]`, compute:

    ```ts
    const diff = age[i] - ageBefore;
    const remaining = lifeTime[i] - ageBefore;
    stepSpeed = (remaining * stepSpeed) / diff;
    age[i] = lifeTime[i];
    ```

4. Assign the possibly shortened value to `_scaledStep`.
5. Run every function in `updateSteps` in array order.
6. If `age[i] >= lifeTime[i]`, swap-remove the particle. Decrement the loop index so a particle copied from the last live slot is evaluated at its new slot during the same call.

Update steps run once on the death boundary before the slot is recycled. `_scaledStep` contains the lifetime-clamped per-particle step. `_scaledUpdateSpeed` retains the full call-wide value, including while a dying particle is evaluated.

### 5.6 Creation

For every requested birth, `spawnParticle` is called. A `-1` result stops the creation loop, so no creation getter and no creation random draw runs for that birth or any remaining requested birth.

Successful births run non-null slots in this fixed order:

1. `createLifeTime`
2. `createPosition`
3. `createDirection`
4. `createEmitPower`
5. `createSize`
6. `createAngle`
7. `createColor`
8. `createColorDead`

This order is independent of graph traversal and is part of the random-consumption contract. Sprite birth initialization is attached to `createColorDead` and runs after its captured color-dead step.

### 5.7 Determinism requirements

- Shape emitters use `randomRange(min, max)`. It returns `min` without calling `Math.random()` when `min === max`; otherwise it returns `Math.random() * (max - min) + min`.
- `ParticleRandomBlock` always consumes a draw per output component, including equal bounds.
- The fixed creation order, ordered `updateSteps`, update-before-create order, emission carry threshold, target-stop timing, and death-step clamp must remain exact.
- Position, direction, standard render fields, and most feature values are stored at Float32 precision. Age, lifetime, and OncePerParticle cached values use Float64 storage. Sprite cells use Uint16 storage and ids use Uint32 storage.
- Vector and color getters may return shared scratch values. A consumer must copy all needed components from one getter before calling another getter that can share or overwrite that scratch.

## 6. Serialized graph and parser

### 6.1 Input shape

The parser accepts the inner node-particle payload:

```ts
interface SerializedSource {
    blocks: Array<{
        customType?: string;
        id?: number;
        name?: string;
        inputs?: Array<{
            name?: string;
            targetBlockId?: number;
            targetConnectionName?: string;
            value?: unknown;
            valueType?: string;
        }>;
        [blockField: string]: unknown;
    }>;
}
```

### 6.2 Normalization

For each block in array order, `parseNodeParticleSource`:

- Requires `typeof id === "number"`.
- Converts a leading `BABYLON.` in `customType` to the unprefixed class name. A missing type becomes `""`.
- Uses `name ?? ""` without trimming the block name.
- Uses `inputs ?? []`.
- Trims each input name.
- Keeps a numeric `targetBlockId`; every other value becomes `null`.
- Trims a string `targetConnectionName`; every other value becomes `null`.
- Retains `value` by reference and retains a string `valueType`.
- Stores the raw block value itself as `serialized`.
- Stores the parsed block in `Map<number, ParsedParticleBlock>` and appends every encountered `SystemBlock` id to `systemBlockIds`.

Duplicate ids overwrite the map entry with the last block carrying that id. `systemBlockIds` is not deduplicated, so repeated serialized `SystemBlock` ids produce repeated root entries that resolve through the final map entry. An id recorded as a System root can also resolve to a different class when a later block overwrites that map entry.

The TypeScript graph interfaces use `readonly`, `ReadonlyMap`, and `Readonly<Record<...>>`. Parsing does not call `Object.freeze`, does not deep clone the source, and does not make the runtime `Map`, arrays, or raw serialized values immutable.

### 6.3 Parser errors

The parser throws these explicit errors:

- `NodeParticle: invalid source — expected a \`blocks\` array`
- `NodeParticle: block missing numeric id (name=<stringified name>)`
- `NodeParticle: graph has no SystemBlock`

It does not validate class names, duplicate ids, connection targets, output names, block-specific fields, or array contents.

### 6.4 Snippet transport

`parseNodeParticleSetFromSnippet` uses `options.json` when it is not `undefined`. A string is parsed with `JSON.parse`; an object is sent directly to the graph parser. In this path `snippetId` is ignored.

Without inline JSON, the function dynamically imports `npe-snippet.ts`. `fetchNodeParticleSnippet`:

1. Uses `https://snippet.babylonjs.com` unless a server is supplied.
2. Converts every `#` in the snippet id to `/`.
3. Fetches `${server}/${convertedId}`.
4. Throws `NodeParticle: snippet fetch failed (<status>)` for a non-OK response.
5. Parses the response as `{ jsonPayload: string }`.
6. Parses `jsonPayload` as `{ nodeParticle: string | object }`.
7. Parses `nodeParticle` again when it is a string.

Malformed JSON and malformed response shapes produce native `JSON.parse`, property-access, or fetch errors.

## 7. Graph builder

### 7.1 Root setup

`buildNodeParticleSet` creates one fresh runtime system for every id in `graph.systemBlockIds` that resolves to a map entry. A missing root entry is skipped.

For each root:

- Capacity is `systemBlock.serialized.capacity` when it is a number, otherwise `1000`.
- `createParticleSystem(capacity)` runs before any block evaluator.
- `isLocal` is true only when `systemBlock.serialized.isLocal === true`.
- `options.emitterWorldMatrix` has precedence over `options.emitter`. The public build options contain no provider field. Their one internal extension point is an optional `_setupEmitter(state)` callback whose declaration is trimmed from the public package types.
- The builder copies the static emitter position once, synchronously, before its first await: indices 12, 13, and 14 of a static matrix, otherwise the emitter option, otherwise zero. A caller that reuses one scratch vector across builds therefore cannot move a pending build. Every root gets a fresh emitter `Vec3` from that copy.
- A static matrix keeps its reference, because shape evaluators read it while emitting. Without a matrix, every root gets its own translation matrix built from the copy.
- Immediately after constructing `NpeBuildState`, the builder calls `options._setupEmitter?.(state)` and then begins the graph walk. With ordinary options this call does nothing and the system retains no emitter state or provider handle. Provider setup copies its validated initial sample before any evaluator captures the stable emitter references.
- Every implicit Cylinder evaluator computes its static inverse normally and optionally appends its stable `{ inverse }` state through `state.emitterInverseWorldMatrices?.push(...)`. Explicit-direction cylinders append nothing. A static build leaves the field absent and allocates no collection array. Provider setup installs the fresh list before traversal, so it collects every reachable implicit cylinder in one system without evaluator imports or provider-specific branching.
- `scene` and `textureBaseUrl` are carried only during the graph walk in `NpeBuildState`.
- The single walk makes the pre-traversal optional setup call. It does not allocate a containing emitter-state object, import provider code, branch on provider behavior, or retain `NpeBuildState` after the walk.
- Before the first root is created, `loadReachableBlocks(graph)` walks every connected input from every root id, collects the distinct reachable class names, and resolves each through `loadNpeBlock` in parallel. Each block class is its own lazy chunk, so preloading costs at most two parallel rounds of fetches instead of one sequential fetch per class during the depth-first build: base-table blocks and, when a reachable class is outside the base table, the extension table first, then the extension blocks (section 7.4). An unsupported reachable class rejects this preload, so no system is built for a graph that cannot be fully built.
- Each root gets its own output map and block-id set. `ParticleTextureSourceBlock` only publishes a static texture descriptor on its `texture` output. Its consumers own loading: `SystemBlock` schedules the GPU upload, and `UpdateFlowMapBlock` and `UpdateNoiseBlock` schedule CPU decoding. One source connected to both a system and a CPU texture update is therefore evaluated once, uploaded once, and decoded once.
- `enableNodeParticleBlendModes(set)` installs an `_registerBillboard` callback on every system in any already-built set and returns that same set. The callback reads the system's current mutable `blendMode` when registration occurs, applies the exact Babylon.js descriptor, attaches the private Multiply shader for modes `3` and `4`, and selects one or two passes. `buildNodeParticleSetWithBlendModes` accepts provider-wrapped options, so both opt-ins compose without changing the evaluator walk.
- `buildNodeParticleSetWithBlendModes` is the convenience form `enableNodeParticleBlendModes(await buildNodeParticleSet(...))`. Importing either public enabler is the opt-in boundary for exact particle blend state and advanced rendering; ordinary builders have no runtime import edge to the optional modules.
- `withNodeParticleEmitterProvider(provider, options)` is synchronous and validates its initial provider sample before building. It returns options carrying the provider-owned setup callback. `buildNodeParticleSetWithEmitterProvider` is the default-builder convenience form `buildNodeParticleSet(engine, scene, graph, withNodeParticleEmitterProvider(provider, options))`. Snippet and exact blend-mode composition pass the wrapped options to their existing builder entry points. There is no post-build enabler or replacement path.
- Build promises are accumulated for the whole set and awaited together after all roots have been traversed. Each promise gets a rejection observer when it is added, so a rejection that settles before that aggregate, or after a later block throws and the aggregate is never reached, is not reported as unhandled. The aggregate still rejects with it.

`CreateParticleBlock` does not create the system. `SystemBlock` does not set capacity or locality; the builder consumes those serialized fields before DFS.

### 7.2 Reachability and traversal

Only blocks reachable by following input connections from a root are built. Detached blocks load no block module and allocate no columns.

The asynchronous `buildBlock(id)` algorithm is exact:

1. Return when `id` is already in `built`, then add it before recursion.
2. Return when the map has no block for `id`.
3. Traverse every connected input named exactly `particle`, in serialized input order.
4. Traverse every other connected input in serialized input order.
5. Look up the evaluator that `loadReachableBlocks` preloaded for the block's class.
6. Run and await `evaluator.build(block, ctx)`. A block whose optional implementation path is a block-local lazy import returns a promise, so downstream blocks build only after that path is installed.

Every builder uses this one walk. There is no specialized texture-update walk, dependency override, or per-feature evaluator substitution.

Marking before recursion terminates cycles. A cycle can still fail when an evaluator asks for an output that has not been installed.

An input is connected only when both `targetBlockId != null` and `targetConnectionName != null`. An empty connection-name string is connected. A target id without a connection name, or a connection name without a target id, is unconnected.

The output map key is `${blockId}:${connectionName}`. Getter outputs are:

- `output`: `ParticleInputBlock`, `ParticleRandomBlock`, `ParticleMathBlock`, `ParticleLerpBlock`, `ParticleGradientBlock`, `ParticleGradientValueBlock`, `ParticleConditionBlock`, `ParticleFloatToIntBlock`, and `ParticleVectorLengthBlock`.
- `color`, `xyz`, `xy`, `zw`, `x`, `y`, `z`, and `w`: `ParticleConverterBlock`.

`ParticleTextureSourceBlock` publishes its `texture` output through `ctx.setTexture` into a separate texture map with the same key form. The value is one static `NpeTextureValue { url, invertY }` descriptor, not a per-particle getter.

`SystemBlock`, `CreateParticleBlock`, all six shape classes, `SetupSpriteSheetBlock`, `BasicSpriteUpdateBlock`, and all seven update classes install no getter output. Their `particle` connections control reachability and ordering only. Update blocks do not publish flow outputs.

### 7.3 Input resolution and literals

`ctx.input(block, name, fallback)` finds the first input with that name.

- A connected input must find its exact output-map key. A key found only in the texture map throws `NodeParticle: <ClassName>.<inputName> does not accept a texture`; any other miss throws `NodeParticle: unresolved connection <ClassName>.<inputName>`.
- An unconnected input with a parsed literal returns a closure over that literal.
- If there is no parsed literal, the supplied fallback is returned.
- Without a fallback, the getter returns `null` cast to the graph value type.

`ctx.texture(block, name)` is the texture-port counterpart, used by `SystemBlock.texture`, `UpdateFlowMapBlock.flowMap`, and `UpdateNoiseBlock.noiseTexture`. An unconnected input returns `null`. A connected input returns the descriptor from the texture map, or throws `NodeParticle: <ClassName>.<inputName> expects a texture` when the source is not a texture output. Both kinds of cross-wiring are rejected once, during the build walk, so no per-particle type check exists. Babylon.js restores serialized connections without type constraints, so it would accept such a graph and evaluate the wrong kind of value; Lite rejects it.

Literal parsing is:

- A numeric value, or a value tagged `number`, is accepted only when the runtime value is a number.
- `BABYLON.Vector2` arrays become `{ x: value[0] ?? 0, y: value[1] ?? 0 }`.
- `BABYLON.Vector3` arrays add `z: value[2] ?? 0`.
- `BABYLON.Color4` arrays become `{ r: value[0] ?? 0, g: value[1] ?? 0, b: value[2] ?? 0, a: value[3] ?? 1 }`.
- Other literal forms are ignored.

### 7.4 Block manifest

The block manifest maps every supported serialized Babylon.js class name to one lazy block module through two tables split by class, and `loadNpeBlock(className)` in `npe-manifest.ts` resolves it:

- Each table is one object literal with a `null` prototype. Each entry is `ClassName: () => import("./blocks/<file>.js")`, where every block module has the uniform export `npeBlock: NpeBlockEvaluator`. The null prototype keeps serialized class names such as `constructor` or `toString` from resolving to inherited `Object.prototype` members.
- The base table in `npe-manifest.ts` lists exactly the 11 classes that Babylon.js `ConvertToNodeParticleSystemSetAsync` emits for a default box-emitter `ParticleSystem` without gradients: `SystemBlock`, `CreateParticleBlock`, `BoxShapeBlock`, `UpdatePositionBlock`, `UpdateColorBlock`, `ParticleTextureSourceBlock`, `ParticleInputBlock`, `ParticleMathBlock`, `ParticleLerpBlock`, `ParticleConverterBlock`, and `ParticleRandomBlock`. The set also covers the editor's default graph (`NodeParticleSystemSet.setToDefault`). `npe-particle-build.test.ts` checks the table against the converted scene 262 graph.
- The extension table `NPE_EXTRA_BLOCKS` in `npe-manifest-extra.ts` lists the other 19 classes, including `ParticleLocalVariableBlock`. Every newly supported class is added there. Table membership follows this rule, never a per-class size measurement.
- `loadNpeBlock` reads the base table first and imports the extension table only on a miss. A graph whose reachable classes are all in the base table never fetches the extension chunk. Any other graph fetches it once, then fetches its extension block chunks. The `OPTIONAL_FEATURES` table of `npe-particle-bundle-content.test.ts` lists the canonical scenes allowed to fetch it.
- `ParticleTeleportInBlock`, `ParticleTeleportOutBlock`, `ParticleElbowBlock`, and `ParticleDebugBlock` have no entry in either table, because `normalizeNodeParticleGraph` removes them before a builder runs (section 9.31).
- Every class name without an entry in either table throws `NodeParticle: unsupported block "<ClassName>"`. `loadReachableBlocks` calls the loader for every reachable class before the first root is built (section 7.1), so an unsupported class fails the build before any system is created.
- One manifest entry owns every serialized property of its Babylon.js class. The builder never routes on properties, connection identity, or system locality. A heavy optional path that only some instances of a class need is a lazy import inside that class's block module, behind the serialized property that selects it. Instances that do not select it never fetch it.

The block-local lazy paths are:

| Block module                  | Selecting condition                                                                | Lazy module                                                                                                |
| ----------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Each of the six shape blocks  | `state.isLocal === true`                                                           | `blocks/<shape>-shape-local.ts`                                                                            |
| `particle-input-block.ts`     | Contextual source `0x0018` (LocalPositionUpdated)                                  | `blocks/particle-input-local-position.ts`                                                                  |
| `particle-input-block.ts`     | Any other nonzero contextual source that `npe-contextual.ts` does not build inline | `npe-contextual-extra.ts`                                                                                  |
| `particle-random-block.ts`    | Lock mode `3` (OncePerParticle)                                                    | `blocks/particle-random-once.ts` for value type `number`; otherwise `blocks/particle-random-once-typed.ts` |
| `setup-sprite-sheet-block.ts` | `randomStartCell === true`                                                         | `particle/sprite-columns-random.ts`                                                                        |

Inline contextual sources are Position, Age, Lifetime, Color, ScaledDirection, and ScaledColorStep. The OncePerParticle value type is the `valueType` of the first available `min` or `max` input, defaulting to `number`.

Shared helpers that several blocks need, such as `npe-texture-content.ts` for `UpdateFlowMapBlock` and `UpdateNoiseBlock`, are ordinary static imports of those block modules. The bundler emits them as shared chunks fetched only by scenes that reach one of those classes.

Adding a block therefore takes one new module that exports `npeBlock`, one line in the extension table of `npe-manifest-extra.ts`, and, when the block is optional for existing scenes, one row in the `OPTIONAL_FEATURES` isolation table of `npe-particle-bundle-content.test.ts`. No registry tier, variant module, feature bit, builder family, or builder branch is involved.

Every block module is side-effect free and imports only `import type` declarations from `npe-build.ts`, so loading a block never pulls the builder into another chunk.

### 7.5 Asynchronous texture work

Texture consumers add promises to the build-promise array. A builder traverses every root, then awaits `Promise.all(buildPromises)`, and returns the set. It does not run a texture-resolution pass. `SystemBlock` schedules the GPU upload of its connected `texture` descriptor. `UpdateFlowMapBlock` and `UpdateNoiseBlock` schedule CPU decoding of their connected descriptors. All of these settle before the set is returned.

## 8. Values and sources

### 8.1 Getter contract

```ts
type NpeValue = number | Vec2 | Vec3 | Color4;
type NpeGetter = (i: number) => NpeValue;
type ParticleStep = (i: number) => void;
```

Scalar getters return a number. Vector and color getters generally fill one value captured by the getter and return that same value on every call. Consumers copy components before invoking another volatile getter.

Texture ports carry a build-time descriptor instead of a getter, through `ctx.setTexture` and `ctx.texture` (section 7.3):

```ts
interface NpeTextureContent {
    readonly width: number;
    readonly height: number;
    readonly data: Uint8ClampedArray;
}

interface NpeTextureValue {
    readonly url: string;
    readonly invertY: boolean;
    _content?: Promise<NpeTextureContent | null>;
}
```

`_content` is absent unless a CPU texture consumer requests it. The first request stores the decode promise on the value, so multiple consumers of the same source share one fetch and decode within that system build.

### 8.2 Contextual particle sources

| Id       | Name                 | Return and behavior                                                                                                                       |
| -------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `0x0001` | Position             | scratch `Vec3` from base position columns                                                                                                 |
| `0x0002` | Direction            | scratch `Vec3` from base direction columns                                                                                                |
| `0x0003` | Age                  | `number` from `age[i]`                                                                                                                    |
| `0x0004` | Lifetime             | `number` from `lifeTime[i]`                                                                                                               |
| `0x0005` | Color                | scratch `Color4` from standard color columns                                                                                              |
| `0x0006` | ScaledDirection      | scratch `Vec3 = direction * system._scaledStep`                                                                                           |
| `0x0007` | Scale                | scratch `Vec2` from standard scale columns                                                                                                |
| `0x0008` | AgeGradient          | `age[i] / lifeTime[i]`, without a zero guard                                                                                              |
| `0x0009` | Angle                | `number` from the standard angle column                                                                                                   |
| `0x0013` | InitialColor         | scratch `Color4`; requests four initial-color columns and wraps `createColorDead` to copy current color before invoking the captured step |
| `0x0014` | ColorDead            | scratch `Color4`; requests four dead-color columns and installs `_writeColorDead`                                                         |
| `0x0015` | InitialDirection     | scratch `Vec3`; normally requests three columns and wraps `createEmitPower` to copy direction before invoking the captured step           |
| `0x0016` | ColorStep            | scratch `Color4` from standard color-step columns                                                                                         |
| `0x0017` | ScaledColorStep      | scratch `Color4 = colorStep * system._scaledUpdateSpeed`                                                                                  |
| `0x0018` | LocalPositionUpdated | scratch world `Vec3` and a write to base position, as specified below                                                                     |
| `0x0019` | Size                 | `number` from the standard size column                                                                                                    |
| `0x0020` | DirectionScale       | `number` equal to `system._scaledStep`                                                                                                    |

InitialColor captures the current `createColorDead` function when its getter is built. Its installed function copies standard RGBA into `initialColor.*` and then calls the captured function when non-null. ColorDead installs a writer that copies the supplied RGBA to `colorDead.*`; `CreateParticleBlock.createColorDead` invokes it before deriving standard color steps.

When `_suppressInitialDirectionCapture` is true as InitialDirection is built, the source returns one shared zero `Vec3` and requests no initial-direction columns. Otherwise it captures the current `createEmitPower`, installs a wrapper that copies base direction into `initialDir.*` when suppression is still false, and then calls the captured function when non-null. Its getter reads the three columns into scratch.

Supported contextual ids are exactly those in the table. Source `0x0018` has its own evaluator. Direction and the other optional sources use the extra contextual factory, whose default arm throws `NodeParticle: unsupported contextual source 0x<lowercase hex>` during build. A nonzero numeric id routed through the common factory but not handled there installs a null output; a consuming connection then throws the unresolved-connection error during the same graph build. Unsupported sources are not deferred to a per-particle update.

### 8.3 LocalPositionUpdated

Source `0x0018` first checks `state.isLocal`. If false, it throws `NodeParticle: LocalPositionUpdated requires SystemBlock.isLocal` before requesting any local-position column.

When valid, the source allocates the five local columns and installs `_seedLocalPosition`. Every local shape calls `finishLocalPosition` at the end of `createPosition` while the base position still contains emitter-local coordinates. The helper:

1. Calls `_seedLocalPosition(i)` when installed, copying local xyz plus the current particle id and valid flag.
2. Transforms the base position through `emitterWorldMatrix`.
3. Writes the transformed result back to base position.

Each source read verifies `valid !== 0` and cached id equals `buffer.id[i]`. Failure throws `NodeParticle: LocalPositionUpdated read before local shape position creation`.

For a valid read, `step = 0` when `age[i] === 0`; otherwise `step = system._scaledStep`. It advances each local component by `direction * step`, transforms local xyz through the emitter matrix, writes the world result to base position, and returns the same scratch world vector. The age-zero rule permits reads during creation after the local shape has seeded the slot without moving it.

### 8.4 System sources and timing

| Id  | Name    | Return                                                                                                         |
| --- | ------- | -------------------------------------------------------------------------------------------------------------- |
| `1` | Time    | `system._actualFrame`                                                                                          |
| `2` | Delta   | `system._scaledUpdateSpeed`                                                                                    |
| `3` | Emitter | the stable build-state emitter `Vec3`, refreshed in provider-backed builds before each started simulation call |

Other ids throw `NodeParticle: unsupported system source <decimal id>` during build.

Time has three observable phases in an animation call. A dynamic emit-rate getter sees the value before increment. Update steps and creation getters see the incremented value when the system was emitting at call entry. A call that was already stopped does not increment it.

Emitter is stable by reference. Static builds retain their build-time value. A provider-backed frame mutates its components before emit-rate evaluation, existing-particle updates, and births, so every contextual read in one simulation call observes that system's committed snapshot.

Delta is assigned before emit-rate evaluation and remains the full `updateSpeed * scaledRatio` throughout the call. DirectionScale is assigned immediately before each live particle's `updateSteps`; it can be shortened on that particle's death boundary. Outside an existing-particle update, it retains its initialized value or the value from the most recently processed particle.

### 8.5 ParticleInputBlock constants

When both contextual and system source ids are zero, the block reads `serialized.type`, defaulting to Float `0x0002`:

| Type id          | Result                                                           |
| ---------------- | ---------------------------------------------------------------- |
| `0x0001` Int     | numeric serialized value or `0`                                  |
| `0x0002` Float   | numeric serialized value or `0`                                  |
| `0x0004` Vector2 | array components with missing entries `0`                        |
| `0x0008` Vector3 | array components with missing entries `0`                        |
| `0x0080` Color4  | array RGB with missing entries `0`, alpha with missing entry `1` |
| any other id     | numeric serialized value or `0`                                  |

Contextual source has precedence over system source, and system source has precedence over a constant. The block installs `output`.

## 9. Supported blocks

Builders support exactly 34 block class names after graph normalization. The 29 ordinary classes work on a directly parsed graph; `ParticleTeleportInBlock`, `ParticleTeleportOutBlock`, `ParticleLocalVariableBlock`, `ParticleElbowBlock`, and `ParticleDebugBlock` are supported only at the normalized boundary. The parser itself can represent arbitrary serialized class names.

```text
SystemBlock                         CreateParticleBlock
BoxShapeBlock                       PointShapeBlock
SphereShapeBlock                    ConeShapeBlock
CylinderShapeBlock                  MeshShapeBlock
ParticleInputBlock                  ParticleRandomBlock
ParticleMathBlock                   ParticleLerpBlock
ParticleConverterBlock              ParticleGradientBlock
ParticleGradientValueBlock          ParticleConditionBlock
ParticleFloatToIntBlock             ParticleVectorLengthBlock
ParticleTextureSourceBlock          SetupSpriteSheetBlock
BasicSpriteUpdateBlock              UpdatePositionBlock
UpdateColorBlock                    UpdateDirectionBlock
UpdateAngleBlock                    UpdateSizeBlock
UpdateAttractorBlock                UpdateFlowMapBlock
UpdateNoiseBlock                    ParticleTeleportInBlock
ParticleTeleportOutBlock            ParticleLocalVariableBlock
ParticleElbowBlock                   ParticleDebugBlock
```

Each class has exactly one manifest entry (section 7.4). Local shape modules and the other block-local lazy paths are implementation paths of their class's block module and retain that class name.

### 9.1 SystemBlock

The builder has created the system before this evaluator runs. The evaluator:

- Assigns `serialized.updateSpeed` only when it is a number.
- Assigns `serialized.blendMode` only when it is a number.
- For an unconnected `emitRate`, evaluates the input once at build with fallback `10` and assigns a numeric result.
- For a connected `emitRate`, installs `_emitRateGetter`. Each call evaluates the graph at particle index `0` and returns its number result, or the system's constant `emitRate` when the result is not numeric. It is not evaluated during build.
- Evaluates `targetStopDuration` once at build with fallback `0` and assigns a numeric result.
- For a connected `texture`, reads the `NpeTextureValue` descriptor once at build. A nonempty URL adds a build promise that dynamically imports `loadTexture2D`, calls `loadTexture2D(engine, url, { invertY: !descriptor.invertY })`, and assigns the result to `system.texture`. The loader import lives inside that promise, so the block chunk holds no static cross-chunk import and a graph without a texture never requests the loader. A failed loader-module import rejects the build like any other block-local lazy import (section 11). Image fetch, decode, and upload failures from `loadTexture2D` are caught and leave `system.texture` unchanged. An empty URL schedules nothing.

`capacity` and `isLocal` are builder fields. `billBoardMode` and `isBillboardBased` are ignored. The evaluator installs no output getter.

### 9.2 CreateParticleBlock

This block captures the twelve standard buffer fields and installs six creation slots. Shape blocks install position and direction.

Input defaults are:

| Input       | Default                      |
| ----------- | ---------------------------- |
| `lifeTime`  | `1`                          |
| `emitPower` | `1`                          |
| `color`     | `{ r: 1, g: 1, b: 1, a: 1 }` |
| `colorDead` | `{ r: 0, g: 0, b: 0, a: 0 }` |
| `scale`     | `{ x: 1, y: 1 }`             |
| `angle`     | `0`                          |
| `size`      | `1`                          |

The slots are:

- `createLifeTime`: writes `lifeTime[i]` and evaluates `emitPower` into `_emitPower`.
- `createEmitPower`: when `_emitPower === 0`, writes all direction components to zero. Otherwise it multiplies each direction component by `_emitPower`. An installed InitialDirection wrapper captures direction before this step runs.
- `createSize`: writes a numeric size, using `1` for a non-number. An object scale writes `.x` and `.y`; a scalar scale is copied to both components.
- `createAngle`: writes the numeric angle through typed-array coercion.
- `createColor`: writes RGBA when the evaluated value is truthy.
- `createColorDead`: sends the evaluated dead color to `_writeColorDead` when installed, then writes `(dead - current) / lifeTime` to each color-step component. There is no zero-lifetime guard.

The block does not create the runtime system and installs no output getter.

### 9.3 Shape transform contract

Matrices are column-major. Position uses:

```text
rx = x*m[0] + y*m[4] + z*m[8]  + m[12]
ry = x*m[1] + y*m[5] + z*m[9]  + m[13]
rz = x*m[2] + y*m[6] + z*m[10] + m[14]
rw = 1 / (x*m[3] + y*m[7] + z*m[11] + m[15])
position = (rx*rw, ry*rw, rz*rw)
```

Direction uses the upper 3x3 with no translation, perspective divide, or normalization:

```text
direction = (
    x*m[0] + y*m[4] + z*m[8],
    x*m[1] + y*m[5] + z*m[9],
    x*m[2] + y*m[6] + z*m[10]
)
```

World shape modules transform birth position and direction. Local shape modules store emitter-local direction and use `finishLocalPosition` for birth position. Sphere and Cone implicit local directions are computed from the transformed birth point and emitter translation and are therefore world-oriented values. Box, Point, explicit Sphere/Cone/Cylinder, and Mesh directions remain emitter-local. Cylinder's implicit local algorithm converts its radial vector through the inverse matrix before writing direction.

All shape closures retain only stable build-state matrix, emitter, and shape-local values. In a provider-backed build, world-shape births use the current stable matrix, every local shape's `finishLocalPosition` uses that matrix, `LocalPositionUpdated` transforms existing local positions with it, and implicit Sphere/Cone/Cylinder direction calculations read the current stable emitter translation. Frame refresh mutates those stable references in place, so evaluator closures never need rebuilding.

For Sphere, Cone, and Cylinder, explicit direction mode is selected only when both `direction1` and `direction2` satisfy the two-field connected criterion. One connected direction port does not select explicit mode.

### 9.4 BoxShapeBlock

Defaults are `direction1 = direction2 = (0,1,0)`, `minEmitBox = (-0.5,-0.5,-0.5)`, and `maxEmitBox = (0.5,0.5,0.5)`.

Position evaluates and copies all minimum components before evaluating the maximum, draws each component with `randomRange`, and transforms the result in the world module. Direction performs the same copied-bound component draws between direction1 and direction2 and transforms only in the world module. The local module calls `finishLocalPosition` after writing local position. Both modules install `createPosition` and `createDirection` and no output getter.

### 9.5 PointShapeBlock

Defaults are `direction1 = direction2 = (0,1,0)`. Position is local `(0,0,0)`; the world module transforms it and the local module passes it through `finishLocalPosition`. Direction copies direction1 components, evaluates direction2, draws each component with `randomRange`, and transforms only in the world module. Both modules install `createPosition` and `createDirection` and no output getter.

### 9.6 SphereShapeBlock

Defaults are `radius = 1`, `radiusRange = 1`, `directionRandomizer = 0`, and both direction bounds `(0,1,0)`. `isHemispheric` is true only for serialized `true`.

Position draws:

```text
sampleRadius = radius - randomRange(0, radius * radiusRange)
v = randomRange(0, 1)
phi = randomRange(0, 2*pi)
theta = acos(2*v - 1)
x = sampleRadius*cos(phi)*sin(theta)
y = sampleRadius*cos(theta)
z = sampleRadius*sin(phi)*sin(theta)
```

Hemispheric mode applies `y = abs(y)`. The world module transforms the point and retains the unquantized transformed components for direction. The local module writes local components, calls `finishLocalPosition`, and retains its transformed scratch components for direction.

Explicit direction draws each component between the two bounds. World mode transforms that direction; local mode writes it directly.

Implicit direction starts with transformed birth position minus the emitter translation, normalizes only when length is neither zero nor one, adds `randomRange(0, directionRandomizer)` independently to x, y, and z, and applies the same conditional normalization. World mode then transforms the normal through the emitter matrix; local mode writes the computed components directly.

Both modules install `createPosition` and `createDirection` and no output getter.

### 9.7 ConeShapeBlock

Defaults are `radius = 1`, `angle = pi`, `radiusRange = 1`, `heightRange = 1`, `directionRandomizer = 0`, and both direction bounds `(0,1,0)`. `emitFromSpawnPointOnly` is true only for serialized `true`.

Position computes:

```text
heightFactor = emitFromSpawnPointOnly
    ? 0.0001
    : 1 - randomRange(0, heightRange)^2
sampleRadius = (radius - randomRange(0, radius * radiusRange)) * heightFactor
azimuth = randomRange(0, 2*pi)
x = sampleRadius * sin(azimuth)
z = sampleRadius * cos(azimuth)
y = heightFactor * (angle !== 0 ? radius / tan(angle / 2) : 1)
```

World and local position handling matches Sphere. Explicit and implicit direction handling also matches Sphere, including its normalization and positive-component jitter rules. Both modules install `createPosition` and `createDirection` and no output getter.

### 9.8 CylinderShapeBlock

Defaults are `radius = 1`, `height = 1`, `radiusRange = 1`, `directionRandomizer = 0`, and both direction bounds `(0,1,0)`.

Position computes:

```text
y = randomRange(-height/2, height/2)
angle = randomRange(0, 2*pi)
sampleRadius = sqrt(randomRange((1-radiusRange)^2, 1)) * radius
x = sampleRadius * cos(angle)
z = sampleRadius * sin(angle)
```

Explicit direction uses component ranges and avoids matrix inversion. The world module transforms it; the local module writes it directly.

For implicit direction, each evaluator computes `invertMat4(emitterWorldMatrix)` during build and substitutes a new identity matrix when the determinant magnitude is below `1e-10`. It appends stable `{ inverse }` state to `emitterInverseWorldMatrices`. The opt-in provider refreshes every listed inverse in place before each started simulation call, again substituting identity for a singular current matrix. Per birth it:

1. Forms transformed birth position minus emitter translation and conditionally normalizes it.
2. Applies `transformNormal` with the inverse matrix into scratch.
3. Draws `y = randomRange(-randomizer/2, randomizer/2)`.
4. Computes `azimuth = atan2(scratch.x, scratch.z) + randomRange(-pi/2, pi/2) * randomizer`.
5. Sets `x = sin(azimuth)` and `z = cos(azimuth)` and conditionally normalizes xyz.
6. In world mode, applies `transformNormal` with the emitter matrix. In local mode, writes xyz directly.

At randomizer zero, the y draw short-circuits because its bounds are equal, while the azimuth draw still consumes one random number before multiplication by zero. Both modules install `createPosition` and `createDirection` and no output getter.

### 9.9 MeshShapeBlock

The block reads `serialized.cachedVertexData.positions`, `.indices`, optional `.normals`, and optional `.colors`. Missing positions or indices cause the evaluator to return without installing position or direction. Arrays are not checked for nonzero length, valid triangle counts, valid indices, or matching attribute lengths.

Each position creation consumes three raw `Math.random()` calls:

```text
faceOffset = 3 * ((random() * (indices.length / 3)) | 0)
u = random()
v = random() * (1 - u)
w = 1 - u - v
```

The selected triangle's position is `u*A + v*B + w*C`. World mode transforms the point. Local mode writes it and calls `finishLocalPosition`.

Mesh normals control direction when `useMeshNormalsForDirection !== false` and a truthy normals array exists. The block interpolates xyz with the same weights without normalization. World mode transforms that normal; local mode writes it directly. It also sets `_suppressInitialDirectionCapture`, so InitialDirection reads zero. Without mesh-normal direction, direction1 and direction2 default to `(0,1,0)`, are always evaluated as component ranges, and are transformed only in world mode.

Mesh colors control birth color when `useMeshColorForColor === true` and a truthy colors array exists. The block requests the standard RGBA columns, sets `createColor = null`, and writes weighted four-component vertex color during `createPosition`. Color-dead creation then derives color steps from this color.

The serialized mesh `worldSpace` field is not read. Only `emitterWorldMatrix` transforms world-mode geometry. Both modules install `createPosition` and `createDirection` and no output getter.

### 9.10 ParticleInputBlock

The block selects a contextual source when `serialized.contextualValue` is a nonzero number. Otherwise it selects a system source when `serialized.systemSource` is a nonzero number. Otherwise it creates the constant specified in section 8.5. Unsupported source ids fail during build as specified in section 8. It installs `output`.

Position, Age, Lifetime, Color, ScaledDirection, and ScaledColorStep build inline through `npe-contextual.ts`. Source `0x0018` (LocalPositionUpdated) lazy-loads `blocks/particle-input-local-position.ts`. Every other nonzero contextual source lazy-loads `npe-contextual-extra.ts`, which owns the optional columns and the unsupported-source diagnostic. System sources build inline.

### 9.11 ParticleRandomBlock

Defaults are `min = 0`, `max = 1`, and `lockMode = 1`. The draw function selects shape from the evaluated minimum, copies all minimum components, evaluates maximum, and computes `min + Math.random() * (max - min)` per component. It does not use `randomRange` and does not skip equal bounds. A mismatched maximum shape supplies zero for unavailable components.

Lock modes are:

| Mode                | Behavior                                                                                                                                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `0` None            | draw on every getter call                                                                                                                                                                                                      |
| `1` PerParticle     | hold one `stored` value and one `currentLockId`; draw when `buffer.id[i]` differs from the id used by the immediately cached value. Consecutive reads for the same id share the value, but an A-B-A access order draws A twice |
| `2` PerSystem       | use lock id `0`; the first getter call draws and all calls share that value                                                                                                                                                    |
| `3` OncePerParticle | use per-block typed-array id, valid, and Float64 component caches at particle slots; draw once for each particle id, including id zero and slot reuse                                                                          |

Mode 3 lazy-loads its per-particle cache. When the `valueType` of the first available `min` or `max` input is `number` (also the default), it loads `blocks/particle-random-once.ts` and results use `value0`. Otherwise it loads `blocks/particle-random-once-typed.ts`, which uses two, three, or four value columns according to the serialized value type and returns a reused Vector2, Vector3, or Color4 scratch value. Numeric modes outside 0 through 3 reach the ordinary getter but never satisfy its draw condition, so the initialized stored scalar `0` is returned. The block installs `output`.

### 9.12 ParticleMathBlock

Operations are `0 Add`, `1 Subtract`, `2 Multiply`, `3 Divide`, `4 Max`, and `5 Min`; default is Add. An unsupported operation returns the left component. JavaScript division and `Math.max`/`Math.min` are used directly, with no finite or zero checks.

Two scalars produce a scalar. A scalar and Vector2, Vector3, or Color4 splat the scalar across the other shape. Two non-scalars use the left shape and operate component-wise.

The one evaluator is alias-safe for every graph. Left and right may both read a getter that rewrites one shared scratch value on every call, such as a lock-mode-0 `ParticleRandomBlock`, without a separate variant. It evaluates left first. A scalar left selects the result shape from right: Color4 when it has `r`, Vector3 when it has `z`, otherwise Vector2. A non-scalar left copies all its components into the result scratch before right is evaluated. For a non-scalar left, a scalar right is splatted, a matching right supplies components, and an incompatible right supplies zero. Results use one reused scratch value per shape. The block installs `output`.

### 9.13 ParticleLerpBlock

`gradient` defaults to `0`. The result is `left + (right - left) * gradient` without clamping. The getter copies all left components before evaluating right. Shape is determined by left; an incompatible right supplies zero. It supports scalar, Vector2, Vector3, and Color4, writes non-scalars into reused scratch, and installs `output`.

### 9.14 ParticleConverterBlock

Only connected inputs participate. If `color` is connected, it supplies all four components and has total precedence. Otherwise values begin at zero and are applied in this order:

1. Connected scalar `x`, `y`, `z`, and `w`.
2. Connected `xy` overwrites x and y.
3. Connected `zw` overwrites z and w, using its x and y components.
4. Connected `xyz` overwrites x, y, and z.

The shared four-component data maps `r/g/b/a` to `x/y/z/w`. The block installs `color`, `xyz`, `xy`, `zw`, `x`, `y`, `z`, and `w`; each getter refills data, and vector outputs use dedicated scratch values.

### 9.15 ParticleGradientValueBlock

`reference` is the numeric serialized value or `0`. `value` is a lazy getter with fallback `0`. The block installs `output`, whose internal value is `{ reference, value }` metadata consumed by a Gradient block.

### 9.16 ParticleGradientBlock

`gradient` defaults to `1`. Inputs whose names start with `value` and whose target id is non-null are resolved at build index `0` as gradient entries, then sorted by numeric reference ascending. Valid entries come from `ParticleGradientValueBlock.output`; malformed entries use ordinary JavaScript property-access and sort behavior.

At evaluation:

- No entries return scalar `0`.
- One entry returns its lazy value for every gradient.
- A gradient below every reference in a multi-entry gradient returns scalar `0`.
- At or above the greatest applicable reference with no upper entry, return that entry's value.
- Between entries, compute `(gradient - lower.reference) / (upper.reference - lower.reference)`, clamp the amount to `[0,1]`, and use the same alias-safe interpolation as Lerp.

Scalar values return scalars; vector and color values are copied into reused scratch. The block installs `output`.

### 9.17 ParticleConditionBlock

Defaults are `test = 0`, `epsilon = 0`, `left = 0`, `right = 0`, `ifTrue = 1`, and `ifFalse = 0`. It evaluates scalar left and right and lazily evaluates only the selected result getter.

| Test           | Id  | Predicate                              |
| -------------- | --- | -------------------------------------- |
| Equal          | `0` | `abs(left-right) <= epsilon`           |
| NotEqual       | `1` | `abs(left-right) > epsilon`            |
| LessThan       | `2` | `left < right + epsilon`               |
| GreaterThan    | `3` | `left > right - epsilon`               |
| LessOrEqual    | `4` | `left <= right + epsilon`              |
| GreaterOrEqual | `5` | `left >= right - epsilon`              |
| Xor            | `6` | one operand truthy and the other falsy |
| Or             | `7` | either operand truthy                  |
| And            | `8` | both operands truthy                   |

Unknown test ids select false. The block installs `output`.

### 9.18 ParticleFloatToIntBlock

Input defaults to `0`. Operation ids are `0 Math.round`, `1 Math.ceil`, `2 Math.floor`, and `3 Math.trunc`. Missing and unknown operation ids use `Math.round`. The block installs `output`.

### 9.19 ParticleVectorLengthBlock

The block installs scalar `output`: `abs(value)` for a scalar, Euclidean length over two or three vector components, or Euclidean length over four Color4 components. Its input has no explicit fallback, so a missing input returns the builder's null value and fails when the getter inspects it.

### 9.20 ParticleTextureSourceBlock

The block performs no loading. It installs one `texture` output whose getter returns the same `NpeTextureValue { url, invertY }` descriptor for every index.

- `url` is a nonempty string `serialized.textureDataUrl`, otherwise a nonempty string `serialized.url`, otherwise the empty string. This matches Babylon.js `_deserialize`, where an embedded data URL takes precedence over the serialized URL. Babylon serialization clears `url` when `textureDataUrl` is set, so serializer output carries only one of them. The `serializedCachedData` flag alone has no effect because it carries no pixels.
- HTTP(S), protocol-relative, and root-relative URLs are kept as written. Any other nonempty source is resolved with `new URL(source, textureBaseUrl).href` when `textureBaseUrl` is supplied; `data:` and `blob:` URLs are absolute and resolve to themselves.
- `invertY` is `serialized.invertY !== false`. An omitted field applies Lite's block class default of `true`. This differs from Babylon's `_deserialize` fallback for a missing field, but Babylon's serializer always emits the field.

Consumers own the loading. `SystemBlock` uploads the descriptor with `loadTexture2D` (section 9.1); an omitted or `true` `invertY` passes loader `invertY: false` because Lite's billboard V convention is the opposite of Babylon's. `UpdateFlowMapBlock` and `UpdateNoiseBlock` decode it with `loadNpeTextureContent` (sections 9.24 and 9.25). Decoding caches its promise on the descriptor, so one source that feeds a system and a CPU texture update is uploaded once and decoded once, and neither consumer replaces the other.

### 9.21 SetupSpriteSheetBlock

Configuration defaults are:

| Serialized field        | Default                          |
| ----------------------- | -------------------------------- |
| `start`                 | `0`                              |
| `end`                   | `0`                              |
| `loop`                  | `true`                           |
| `spriteCellChangeSpeed` | `1`                              |
| `width`, `height`       | `0`                              |
| `randomStartCell`       | non-random unless exactly `true` |

The ordinary path allocates `sprite.cellIndex`. Birth writes `startCellID`. Update computes:

```text
distance = endCellID - startCellID + 1
progress = age * changeSpeed
ratio = loop
    ? clamp01((progress % lifeTime) / lifeTime)
    : clamp01(progress / lifeTime)
cellIndex = (startCellID + ratio * distance) | 0
```

`clamp01(value)` returns 0 below zero, 1 above one, and the input otherwise. Assignment to Uint16 applies Uint16 conversion.

The random-start path lazy-loads `particle/sprite-columns-random.ts` and also allocates `sprite.randomOffset`. Birth writes offset `-1` and the start cell. On an update with a negative offset, it writes `Math.random() * lifeTime`. With zero `changeSpeed`, progress is the offset; otherwise progress is `(age + offset) * changeSpeed`. Ratio and cell math then match the ordinary path.

Both paths set `_spriteSheet` with cell dimensions, the cell array, and the update function. They capture the current `createColorDead` and assign a wrapper so sprite birth runs after that function when non-null; when it is null, sprite birth becomes the slot. They install no output getter.

### 9.22 BasicSpriteUpdateBlock

The block requires `_spriteSheet` during build or throws `NodeParticle: BasicSpriteUpdateBlock requires SetupSpriteSheetBlock`. It appends one `updateSteps` function that calls the captured sheet update. It installs no output getter.

### 9.23 UpdateAttractorBlock

Inputs are `particle`, `attractor`, and `strength`. `attractor` defaults to `(0,0,0)` and `strength` defaults to `1`. The block allocates no columns and appends one direction-only update step.

For attractor position $a$, particle position $p$, direction $d$, strength $s$, and the particle's lifetime-clamped `system._scaledStep` $\Delta t$:

```text
offset = attractor - position
lengthSquared = dot(offset, offset)

if lengthSquared != 0:
    scale = strength * scaledStep / ((lengthSquared + 1) * sqrt(lengthSquared))
    direction += offset * scale
```

This is equivalent to adding `normalize(offset) * strength / (lengthSquared + 1) * scaledStep`. Coincident position and attractor produce no force. Negative strength repels. The attractor components are copied before evaluating strength because both inputs may ultimately depend on shared scratch-backed getters.

The block observes position and direction as left by earlier `updateSteps`, and later steps observe its direction change. It does not update position itself. Serialized local systems use the same evaluator; there is no local/world attractor variant.

### 9.24 UpdateFlowMapBlock

Inputs are `particle`, `flowMap`, and `strength`; `strength` defaults to `1`. The block allocates no particle columns and appends one direction-only update step. `flowMap` accepts the `texture` output of a `ParticleTextureSourceBlock` through `ctx.texture`. An unconnected input leaves the update step installed with no loaded map, so it has no effect; a non-texture source rejects the build.

During build, a descriptor with a nonempty URL adds a build promise that calls `loadNpeTextureContent`. A URL with an explicit scheme other than `http`, `https`, `data`, or `blob` resolves to a null map without fetching; relative and scheme-less URLs are fetched as resolved by `ParticleTextureSourceBlock`. The loader fetches the URL and rejects a non-OK response, decodes an `ImageBitmap` with `premultiplyAlpha: "none"` and `colorSpaceConversion: "none"`, and draws it into an `OffscreenCanvas` when available or an HTML canvas otherwise. For `invertY === true`, the canvas transform vertically flips the bitmap before `getImageData`; false preserves source row order. The resulting `{ width, height, data: Uint8ClampedArray }` promise is cached on the texture value. The evaluator catches decode failures and retains a null map, making every update a no-op.

After a successful decode, the block composes a preparation callback into the system's `_prepareFrame` (section 5.3), keeping any earlier callback first. Each call derives the camera view-projection matrix with the effective viewport aspect and copies all 16 components into an evaluator-owned matrix from `allocateMat4()`. Its storage therefore follows the process-wide F32/F64 matrix policy and never aliases camera-owned matrix storage. A missing camera marks the prepared matrix unavailable. Canvas width and height are normalized independently to finite positive values before aspect calculation. A map that fails to decode or resolves to null installs no callback, so a failed decode or a discarded or rejected build leaves no per-frame work. Babylon.js reads the scene transform matrix inside its update queue; one snapshot per simulation call is equivalent because the camera cannot move during an update.

The callback does not capture the scene. At build time, a descriptor with a nonempty URL obtains the scene's projection source: one `{ scene }` record per scene, held in a lazily created module `WeakMap` and shared by every flow-map system built against that scene. Creating the source pushes its only scene registration, one `_disposables` entry that sets `scene` to null; it is not frame work, and later builds on the same scene reuse it. Scene disposal runs that entry before clearing the camera, so a set retained for manual stepping after disposal holds no scene. Disposal drains `_disposables` once, so a scene already disposed when its first flow-map build runs, for example while the build awaited block loads, gets a source that starts detached and registers nothing. A detached source leaves the prepared matrix and its availability unchanged, so the system keeps applying its last projection. A build still decoding at disposal, or one that never prepared a matrix, applies no force. Babylon.js keeps reading the disposed scene's last transform matrix; keeping the last snapshot matches that without retaining a Lite scene.

For each particle update, a missing prepared matrix or map returns immediately without evaluating strength. Otherwise the evaluator transforms the current particle position through the prepared matrix including perspective divide and samples nearest-neighbor RGBA data:

```text
screen = transformCoordinates(position, viewProjection)
u = screen.x * 0.5 + 0.5
v = 1 - (screen.y * 0.5 + 0.5)
x = floor(u * width)
y = floor(v * height)

if x or y is outside the texture:
    return

index = (y * width + x) * 4
alphaStrength = strength * scaledStep * data[index + 3] / 255
direction.x += (data[index]     / 255 * 2 - 1) * alphaStrength
direction.y += (data[index + 1] / 255 * 2 - 1) * alphaStrength
direction.z += (data[index + 2] / 255 * 2 - 1) * alphaStrength
```

`strength` is evaluated for every particle after the map and prepared-matrix checks and before the bounds check. `scaledStep` is the particle's lifetime-clamped `system._scaledStep`. RGB byte value `127.5` is neutral; integer bytes therefore have no exact zero except through alpha or strength. Alpha zero produces no force. Coordinates at `screen.x === 1` or `screen.y === -1` map to the exclusive upper edge and are rejected.

The block uses one reused screen-position scratch and allocates nothing per particle. It observes position and direction from earlier update steps; later steps observe its direction change. It does not integrate position. Local systems use the same evaluator and current stored position; there is no separate local flow-map variant. Preparation runs inside the system's own simulation call, so a live set registered after its camera controls always runs controls → matrix preparation → simulation, whenever the set was built.

### 9.25 UpdateNoiseBlock

Inputs are `particle`, `noiseTexture`, and `strength`. Strength defaults to `{ x: 100, y: 100, z: 100 }`. The block allocates eight optional columns: two three-component Float64 coordinate sets, a Uint32 particle id, and a Uint8 validity flag. The id and validity columns regenerate all six random coordinates on the first update of each new particle id, including a recycled slot; subsequent updates reuse them.

Build awaits the same static CPU texture decode used by flow maps. A missing or failed texture leaves the update step inactive and consumes no random values. Live procedural-texture frame refresh is not part of the serialized contract implemented here.

For each component pair, sampling matches Babylon's `_fetchR` exactly:

```text
u = abs(u) * 0.5 + 0.5
v = abs(v) * 0.5 + 0.5
x = trunc((u * width) % width)
y = trunc((v * height) % height)
red = data[(x + y * width) * 4] / 255

sampleX = red(coord1.x, coord1.y)
sampleY = red(coord1.z, coord2.x)
sampleZ = red(coord2.y, coord2.z)
direction += (2 * sample - 1) * strength * scaledStep
```

Only the red channel is read; alpha and particle position do not affect noise. Strength is resolved once during build and the returned Vector3 reference is retained, matching Babylon's connection-point timing. `_scaledStep` is the lifetime-clamped update delta. The block observes direction from earlier updates and affects later updates in graph order.

### 9.26 UpdatePositionBlock

When `position` is connected, append an update step that evaluates a Vec3 and writes base position xyz. With an unconnected input, append nothing. No output getter is installed.

### 9.27 UpdateColorBlock

When `color` is connected, request the standard RGBA columns and append an update step that evaluates Color4 and writes all components. With an unconnected input, append nothing. No output getter is installed.

### 9.28 UpdateDirectionBlock

When `direction` is connected, append an update step that evaluates Vec3 and writes base direction xyz. With an unconnected input, append nothing. No output getter is installed.

### 9.29 UpdateAngleBlock

When `angle` is connected, request the standard angle column and append an update step that writes the scalar result. With an unconnected input, append nothing. No output getter is installed.

### 9.30 UpdateSizeBlock

When `size` is connected, request the standard size column and append an update step that writes the scalar result. With an unconnected input, append nothing. No output getter is installed.

### 9.31 Phase 3 graph-plumbing architecture (Phase 3C implemented)

This section began as the Phase 3A contract for five serialized class names: `ParticleTeleportInBlock`, `ParticleTeleportOutBlock`, `ParticleLocalVariableBlock`, `ParticleElbowBlock`, and `ParticleDebugBlock`. The parser stores class names opaquely. Phase 3B added Teleport routing; Phase 3C adds LocalVariable storage plus Elbow and Debug compile-away routing. The supported count is now 34 after the required normalized boundary.

#### 9.31.1 Executive summary

| Concern                | Hybrid behavior                                                                                                                                                             |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Direct parser users    | Ordinary graphs go straight to any builder at zero feature bytes. Graphs containing a Phase 3 candidate explicitly call `normalizeNodeParticleGraph` before any builder.    |
| Snippet users          | `parseNodeParticleSetFromSnippet` automatically invokes the helper for inline and fetched content because it is already asynchronous and arbitrary-content-aware.           |
| Teleports              | Reachable TeleportOut outputs are rewritten to their TeleportIn source before evaluator traversal. An omitted direct opt-in preserves the existing unsupported-block error. |
| Elbow                  | Copy-on-write source rewrite for every connection role; no evaluator and no runtime call.                                                                                   |
| Debug                  | Copy-on-write `NpeValue` pass-through; `stackSize`, logs, and observables remain editor-only and add no simulation state.                                                   |
| Particle local         | Float64 component snapshot per particle id, stored in swap-remove-aware optional columns.                                                                                   |
| Loop local             | Snapshot per started `animateParticleSystem` call and system, shared by updates and births in that call.                                                                    |
| Detached candidate     | A helper hit fetches the runtime, whose root-only walk returns a marked graph sharing parsed storage with no diagnostic or feature storage.                                 |
| Repeated normalization | A normalized candidate graph carries an internal marker, so a second helper call returns the exact graph without rescanning or refetching.                                  |
| Candidate-free helper  | The thin helper scans once, returns the exact graph reference, and never executes the dynamic import.                                                                       |

The requirements are:

- **GP-REQ-01 — one public opt-in:** `normalizeNodeParticleGraph(graph: ParticleGraph): Promise<ParticleGraph>` is the only new package-root function. No graph type is newly named-exported; the heavy runtime and marker remain internal and are trimmed from declarations.
- **GP-REQ-02 — hybrid pay-for-use:** the parser and all builders contain no graph-plumbing detection, metadata, branch, or import. Direct ordinary graph users therefore pay 0 B. Explicit helper users and snippet users pay the thin scan; only a TeleportOut, LocalVariable, Elbow, or Debug candidate hit dynamically imports the heavy runtime.
- **GP-REQ-03 — teleport equivalence:** any number of distinct TeleportOut blocks may read one TeleportIn. Teleport and Elbow rewrite opaque connection pairs for value, particle flow, system flow, texture, and gradient connections without materializing the carried value. Every consumer observes the terminal source's original output name, value, and volatility.
- **GP-REQ-04 — deterministic graph failures:** malformed reachable proxy routes fail before any particle system is returned. Diagnostics distinguish missing endpoints, wrong endpoint class, disconnected proxy inputs, unsupported output names, and proxy cycles.
- **GP-REQ-05 — source immutability and idempotence:** normalization never mutates caller JSON, `ParsedParticleBlock`, `ParsedParticleInput`, or the original `ParticleGraph`. A candidate graph uses copy-on-write blocks only when a route changes and returns an internally marked graph; a repeated helper call returns that exact graph. A graph with no candidate is returned exactly and receives no marker.
- **GP-REQ-06 — zero proxy runtime:** TeleportIn, TeleportOut, Elbow, and Debug install no getter, step, column, frame callback, or evaluator module. Normalized consumer edges point directly to the terminal non-proxy source. Debug nevertheless validates its Babylon-compatible `NpeValue`-only connection restriction before it compiles away.
- **GP-REQ-07 — particle snapshot:** Particle scope evaluates the input at most once for each particle id, copies every component immediately, survives swap-remove, and invalidates a reused slot by id rather than a reset callback.
- **GP-REQ-08 — loop snapshot:** Loop scope evaluates the input at most once per started animation call for one system. Existing-particle updates, system getters, and births in that call observe the same snapshot.
- **GP-REQ-09 — scratch safety and precision:** scalar and component snapshots use Float64 storage. Vector and color outputs use block-owned reused scratch values and therefore retain the existing copy-on-read consumer rule.
- **GP-REQ-10 — deterministic merge remapping:** a future graph-merge operation must remap ordinary connection ids and TeleportOut `entryPoint` ids through the same source-local id map before normalization. Raw id collisions never create cross-source teleport pairs.
- **GP-REQ-11 — builder parity:** one explicitly normalized graph composes with the default, blend-mode, and provider-backed builders, including the deprecated texture-update aliases of the default builder. Inline and fetched snippet builds normalize automatically before their default root walk.
- **GP-REQ-12 — oracle and isolation coverage:** implementation requires state fixtures, malformed-graph fixtures, inline/fetched snippet coverage, an official Teleport parity graph, and fetched-module assertions proving that direct non-users load neither helper nor runtime.

#### 9.31.2 Current data flow

Pre-Phase-3B flow:

```text
serialized blocks
    -> parseNodeParticleSource
    -> readonly block map
    -> root DFS
    -> manifest lookup for reachable class
    -> unsupported block error
```

Current direct Phase 3C flow:

```text
serialized blocks
    -> parseNodeParticleSource
    -> readonly block map with no feature metadata
    -> caller chooses boundary
        ordinary graph -> any builder directly
        Phase 3 graph -> await normalizeNodeParticleGraph(graph)
            already marked -> exact graph; no scan or import
            no candidate -> exact graph; no runtime import
            candidate -> dynamic npe-graph-plumbing-runtime.ts
                detached candidate -> marked graph sharing parsed storage; no diagnostic or feature storage
                reachable candidate -> role and two-bit domain validation
                                    -> copy-on-write proxy source resolution
                                    -> cycle / endpoint validation
                                    -> marked normalized graph
    -> parallel block-manifest preload and existing root DFS
         Teleport / Elbow / Debug are no longer reachable
         LocalVariable alone loads its block module and storage
```

The snippet path is the automatic half of the hybrid:

```text
inline JSON or fetched snippet
    -> parseNodeParticleSource
    -> await normalizeNodeParticleGraph
    -> buildNodeParticleSet
```

The public helper is side-effect-free and contains no module-level allocation. Its complete loading decision is:

```ts
if (graph._isGraphPlumbingNormalized) return graph;
for (const block of graph.blocks.values()) {
    if (
        block.className === "ParticleTeleportOutBlock" ||
        block.className === "ParticleLocalVariableBlock" ||
        block.className === "ParticleElbowBlock" ||
        block.className === "ParticleDebugBlock"
    ) {
        return (await import("./npe-graph-plumbing-runtime.js")).normalizeNodeParticleGraphRuntime(graph);
    }
}
return graph;
```

`NodeParticleSet._graph` remains exactly the graph supplied to the selected builder. Builders do not normalize, replace, or annotate it. A direct caller therefore observes the normalized graph only when it supplied one; snippet callers observe the graph normalized by the snippet boundary.

#### 9.31.3 Serialized block contracts

| Class                        | Input             | Output   | Serialized field | Contract                                                                                                                                                            |
| ---------------------------- | ----------------- | -------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ParticleTeleportInBlock`    | mandatory `input` | none     | none             | Defines the source side of one or more TeleportOut endpoints and accepts every serialized connection kind.                                                          |
| `ParticleTeleportOutBlock`   | none              | `output` | `entryPoint`     | `entryPoint` is the numeric block id of a TeleportIn. Multiple distinct TeleportOut ids may name the same TeleportIn id.                                            |
| `ParticleElbowBlock`         | mandatory `input` | `output` | none             | Visual routing only; every serialized connection kind is normalized to the input source.                                                                            |
| `ParticleDebugBlock`         | mandatory `input` | `output` | `stackSize`      | `NpeValue` pass-through only. Lite does not reconstruct logs, observables, or editor instrumentation. `stackSize` remains serialized but is not read by simulation. |
| `ParticleLocalVariableBlock` | mandatory `input` | `output` | `scope`          | `NpeValue` snapshot only. `scope === 0` selects Particle; every other value, including a missing field, selects Loop.                                               |

Babylon leaves TeleportIn and Elbow `AutoDetect` without excluding Particle, System, Texture, or gradient connection types. Lite therefore treats their routes as opaque `(targetBlockId, targetConnectionName)` rewrites: they may carry particle or system flow, textures, gradients, or ordinary values because they never materialize the payload. This does not add gradient metadata to `NpeValue`; support after rewrite is determined by the terminal evaluator and consumer.

Babylon excludes Particle, System, Texture, and all four gradient connection types from Debug and LocalVariable. Lite keeps that boundary: those two classes accept only scalar, Vector2, Vector3, and Color4 `NpeValue` paths. The normalizer reports a class-specific unsupported-connection diagnostic when the consumer-role table identifies a flow, texture, or gradient route; LocalVariable also performs the runtime shape validation in section 9.31.6 because serialized output points contain no usable type or `valueType` metadata.

#### 9.31.4 Reachability, feature loading, and copy-on-write normalization

The helper and runtime use this exact path:

1. `parseNodeParticleSource` constructs only the existing block map and root-id list. It neither recognizes Teleports nor adds feature metadata.
2. A direct caller explicitly invokes `normalizeNodeParticleGraph`; `parseNodeParticleSetFromSnippet` invokes it automatically after either inline or network parsing.
3. The thin helper first returns an already marked normalized graph. Otherwise it scans `graph.blocks.values()` for TeleportOut, LocalVariable, Elbow, or Debug. No hit returns the exact graph and never executes the dynamic import. A hit dynamically imports side-effect-free `npe-graph-plumbing-runtime.ts`, even when every candidate is detached.
4. The heavy runtime seeds domain-mask traversal from `systemBlockIds` only. Detached malformed candidates are never visited, so normalization returns a marked graph that shares the original block map and root ids and emits no diagnostic or feature storage. Reachable routes are validated and rewritten before evaluator traversal.

TeleportIn is not a thin-helper trigger because it has no usable output and is semantically traversed only through a TeleportOut `entryPoint`. A source containing TeleportIn without TeleportOut therefore returns exactly from the helper; if malformed hand-authored input directly connects to it, the existing `NodeParticle: unsupported block "ParticleTeleportInBlock"` manifest error is intentional. LocalVariable, Elbow, and Debug are candidate triggers. No parser or builder detector is added.

The runtime performs root-seeded reachability with a two-bit domain map. It starts only from `systemBlockIds`, records the OR of every incoming particle/system domain on each block, and revisits a shared block's inputs only when that block gains a new bit.

Traversal is consumer-edge driven. For every visited block, connected inputs named `particle` are selected first in serialized order, followed by all remaining connected inputs in serialized order. Particle-first traversal therefore determines deterministic diagnostic priority for every visited block, not only `SystemBlock`; once validation succeeds, the normalized rewrite result is otherwise independent of traversal order. For each connected consumer input, the normalizer performs these operations in order:

1. Resolve the source pair `(targetBlockId, targetConnectionName)` through the complete Teleport proxy chain before descending into the terminal source.
2. Replace only the source pair. Preserve the consumer input's `name`, position, literal `value`, and `valueType`; preserve the resolved terminal source's `targetConnectionName` rather than the proxy's `output` name.
3. Descend into the resolved terminal source. The later owning builder therefore still resolves a `particle` edge before assigning/building value dependencies, even when that edge originally targeted TeleportOut.

The outgoing domain is derived from the consumer input, never from a proxy or terminal output: a System consumer input named `particle` starts the particle bit, every other System input starts the system bit, and non-System consumers propagate their accumulated incoming mask.

Connection roles are derived from consumers using this fixed internal table rather than missing source-output type metadata:

| Role              | Consumer rule                                                                                                                       |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| particle flow     | any input named `particle`                                                                                                          |
| system flow       | an input named `system`, `onStart`, or `onEnd`                                                                                      |
| texture           | `SystemBlock.texture`, `UpdateFlowMapBlock.flowMap`, or `UpdateNoiseBlock.noiseTexture`                                             |
| gradient metadata | a `ParticleGradientBlock` input whose name starts with `value`; its separate `gradient` input remains an ordinary scalar `NpeValue` |
| `NpeValue`        | every other input accepted by the current evaluator contracts                                                                       |

The role is carried unchanged through every proxy. Teleport and Elbow accept every role. Debug and LocalVariable reject every role except `NpeValue` before evaluator traversal. A future supported block that adds a non-value connection must extend this table in the same PR; unknown unsupported classes still fail the ordinary manifest diagnostic after normalization.

Preserving the consumer input keeps each consumer's role intact. `SystemBlock.texture`, `UpdateFlowMapBlock.flowMap`, and `UpdateNoiseBlock.noiseTexture` keep their unchanged input names after normalization and read the texture descriptor from the resolved terminal source. The terminal `targetConnectionName` is likewise retained for output lookup. A texture routed through Teleport or Elbow therefore remains a texture dependency rather than becoming a generic `output` value.

The proxy resolver recognizes:

- **TeleportOut:** require output name `output`; require `entryPoint` to be a number that is finite, integral, and at least zero; resolve that id through the parser's final block map and require a TeleportIn; require the TeleportIn's `input` connection; then recursively resolve that input's complete source pair. Id `0` is valid when block `0` exists. An empty string is invalid rather than disconnected.
- **Elbow and Debug:** require output name `output` and a connected `input`, validate Debug's role as `NpeValue`, then recursively resolve the complete source pair.
- **LocalVariable:** require output name `output`, a connected `input`, and an `NpeValue` role, then return it as the terminal evaluator source.
- **Other terminal source:** return the pair unchanged.

The resolver records the ordered proxy-id stack. Revisiting a proxy already on that stack is a plumbing cycle and reports the complete repeated path. TeleportOut reachability explicitly crosses its `entryPoint` to the TeleportIn input even though TeleportOut itself has no serialized inputs. Memoization occurs only after successful terminal resolution, so a failed or cyclic path cannot poison another diagnostic.

Copy-on-write occurs after successful edge resolution. Only an input whose source pair changes is copied; only a block containing a changed input is copied. Its id, class, name, raw serialized object, unmodified input objects, literal values, and value-type tags remain by reference. A new block map is constructed only when at least one reachable edge changes; `systemBlockIds` and every untouched block reference are preserved. Every graph returned from the heavy runtime carries internal `_isGraphPlumbingNormalized: true`, including a detached-candidate graph that shares both original collections. The thin helper checks that marker before scanning, so repeat normalization returns the exact graph and cannot refetch the runtime. The marker is trimmed from the public declaration and is never written onto the parsed graph. The original graph and raw JSON remain reusable after normalization.

The parser preserves its existing last-record-wins behavior uniformly for every repeated block id, including TeleportOut and TeleportIn route ids. Normalization reads the final parsed map entry, so a final valid endpoint route succeeds and a final block of the wrong class receives the ordinary wrong-endpoint-class diagnostic. Distinct TeleportOut ids may reference the same final TeleportIn entry for fan-out.

#### 9.31.5 Graph merge contract

Lite has no public graph-merge API in Phase 3. The following contract reserves safe behavior for a future merge without adding current API or code:

1. Allocate a unique destination id for every incoming raw block before restoring any edge.
2. Apply that same source-local id map to every input `targetBlockId` and every TeleportOut `entryPoint`.
3. Combine the remapped blocks only after all ids and endpoint ids are rewritten.
4. Run graph-plumbing normalization against the combined unique-id graph.
5. Never resolve a TeleportOut from one source to a TeleportIn from another source merely because their pre-merge raw ids matched.

Merging already parsed graphs without their source-local remap is unsupported. This avoids exposing mutable graph-authoring APIs as part of Phase 3.

This is intentional hardening beyond Babylon's current reconnect behavior. Babylon uses a truthy `entryPoint` guard, so serialized `0` and `""` are silently ignored, and raw-id merge collisions can reconnect to the wrong source. Lite accepts finite integer id `0` when present, rejects empty strings and all other invalid endpoint values, and requires source-local remapping so collisions cannot cross-link graphs.

#### 9.31.6 Particle-scope local-variable storage

Each reachable Particle-scope LocalVariable requests six optional columns named with its block id:

| Column suffix             | Storage | Purpose                                                                        |
| ------------------------- | ------- | ------------------------------------------------------------------------------ |
| `id`                      | Uint32  | Particle id whose snapshot occupies this dense slot.                           |
| `valid`                   | Uint8   | Distinguishes a real id-zero snapshot from zero-initialized storage.           |
| `value0` through `value3` | Float64 | Scalar or Vector2/Vector3/Color4 components. Unused components remain ignored. |

Serialized output connection points do not preserve a usable `type` or `valueType`, so build time cannot specialize this layout by output shape. Every reachable Particle-scope block allocates all six columns unconditionally. The capacity cost is `4 + 1 + 4 * 8 = 37` bytes per particle slot per block, excluding the six typed-array object headers and allocator/alignment overhead.

Both scopes use this exact runtime discriminator after evaluating the input once:

1. `typeof value === "number"` selects scalar. No additional finiteness check is added.
2. Otherwise, a non-null object for which `"r" in value` selects Color4 and must have numeric `r`, `g`, `b`, and `a` properties.
3. Otherwise, an object for which `"z" in value` selects Vector3 and must have numeric `x`, `y`, and `z` properties.
4. Otherwise, an object with numeric `x` and `y` properties selects Vector2.
5. `null`, nonobjects, and objects malformed for their selected branch are unsupported values. A malformed Color4 or Vector3 does not fall through to a smaller vector shape.

The first read for a Particle slot compares both `valid` and cached id with `buffer.id[i]`. A miss evaluates the input exactly once, classifies and validates it, copies all components before any other getter can overwrite scratch, and only then commits the id, components, and valid flag. The first accepted value fixes that evaluator's runtime shape. A later valid value with another shape throws the shape-change diagnostic; a malformed value throws the unsupported-value diagnostic. Either failure leaves the prior snapshot and validity unchanged.

All six columns join `buffer._all`, so swap-remove carries the snapshot, id, and validity with a moved live particle. A newly spawned particle receives a fresh id; stale tail data cannot match unless the global Uint32 id source wraps, which is the existing id-wrap limitation described in section 11. No spawn or death callback is added.

Scalar output reads `value0`. Vector2, Vector3, and Color4 output copy the required components into one reused block-owned scratch value. Callers retain the normal `NpeGetter` rule: consume or copy one scratch-backed result before invoking another getter that may overwrite it.

This id-plus-valid design intentionally avoids Babylon's reset callback coupling. Babylon assigns one particle object's single `_properties.onReset` callback from each LocalVariable block, so a later local block can overwrite an earlier block's cleanup. Lite has no per-particle callback or hidden block ordering: each local's columns move with swap-remove and id mismatch invalidates stale data. The separate valid column also distinguishes particle id `0` from empty storage.

#### 9.31.7 Loop-scope epoch and frame preparation

Loop intentionally means one started `animateParticleSystem` call for one built system. This is a Lite-defined simulation boundary, not a claim that manual calls reproduce Babylon's scene-frame-id cache. It gives deterministic semantics to manual simulation, fixed-step replay, and renderer-managed simulation without making a particle system depend on a Scene frame counter.

The first Loop-scope LocalVariable in one system creates one build-local epoch object and appends one epoch increment to the system's optional frame-preparation chain. Additional Loop blocks in that system share the epoch and add no frame callback. Each block stores its last observed epoch, valid flag, runtime shape, and four Float64 JavaScript number fields plus one reused output scratch value. Loop scope allocates no capacity-sized columns.

`_prepareFrame` uses ordered feature-local composition. Provider setup installs its callback before evaluator traversal. During traversal, the first Loop local captures that callback and replaces it with one wrapper that invokes the captured callback first and then increments the shared Loop epoch. Additional Loop blocks reuse the epoch and install nothing.

```text
started animate call
    -> provider preparation, when present (installed before evaluator traversal)
    -> one local-variable epoch increment, when any Loop block is reachable
    -> dynamic emit-rate evaluation
    -> existing-particle updates
    -> particle births
```

The provider callback and Loop wrapper capture no system and create no self-cycle. A provider exception prevents the epoch increment and simulation, preserving error atomicity. Systems without Loop retain their exact Phase 2 provider hook or no `_prepareFrame` field at all, while the existing optional call in `animateParticleSystem` remains the only common simulation cost.

The first Loop read in an epoch evaluates and snapshots its input with the discriminator in section 9.31.6. Every subsequent read in that same call returns the snapshot, including reads from a system getter, multiple existing particles, and newly created particles. An unstarted call returns before the epoch advances. A stopped-but-started drain call advances it. Zero scaled ratio still advances it because one explicit animation call is one Loop.

Each System root receives fresh evaluators, epoch state, and snapshots. Separate systems and separate builds are therefore independent even when they came from one parsed graph and are animated in the same call sequence. This intentionally differs from Babylon, where one LocalVariable block instance shares its Loop map across systems that observe the same scene frame id. Lite keeps state owned by the pure-state system, avoids a cross-system hidden registry, and makes manual simulation deterministic. Tests must expect independent systems.

Particle-scope LocalVariable is rejected on any path whose accumulated mask contains the system bit, including a shared block whose mask is particle plus system. Loop scope is valid on either or both domains and snapshots whichever path reads it first in that started call. This is an intentional safety deviation from Babylon: Babylon permits Particle scope on system-domain paths, buckets a missing particle context under `-1`, and also maps particle id `0` to `-1` through `id || -1`. Lite refuses the ambiguous system path, while its independent `valid` and Uint32 `id` columns preserve id `0` correctly.

There is no direct Babylon oracle for Lite's Loop boundary. Babylon requires a non-null scene to read a Loop local, while the null-scene manual procedure in section 13.2 throws; retaining a scene and repeatedly calling particle animation without rendering does not advance its frame id. Deterministic Lite tests therefore own started-call semantics. No Babylon fixture is claimed as proof of that boundary. A future limited fixture may call `scene.render()` once per observed step with a real advancing frame id and exactly one relevant first read per render; it would cover only that compatible case.

#### 9.31.8 Elbow and Debug behavior

Elbow and Debug use the same recursive source resolver as TeleportOut. After normalization no reachable consumer targets either block, so neither class needs a manifest entry or block module.

Elbow preserves every serialized connection role, including particle/system flow, texture, and gradient routes, by rewriting only the opaque source pair. Debug preserves only `NpeValue` flow and deliberately omits Babylon's diagnostic side effects: there is no log array, string formatting, observable, or `stackSize`-limited collection. Those are editor instrumentation over runtime values, not serialized simulation output. Ignoring them prevents per-particle strings and observer notifications from entering the Lite hot path.

Elbow, Debug, and LocalVariable inputs are mandatory in Lite. A disconnected reachable block throws during normalization. This is a deliberate deterministic deviation from Babylon's disconnected Debug/Local null behavior and Elbow pass-through behavior: a graph that cannot produce the promised output never reaches a partially built system.

Chained Elbow, Debug, and Teleport routes resolve to one terminal source pair. A cycle among any combination of those proxies uses the same deterministic cycle diagnostic.

#### 9.31.9 Diagnostics

All implemented graph-plumbing and LocalVariable diagnostics are listed once in section 11. Their implementations use inline literal or template arguments so the Lite error extraction plugin can replace prose in production bundles.

#### 9.31.10 Pay-for-use and bundle contract

- Direct parser/build users have no detector, helper import, dynamic-import reference, or branch in the parser or any owning builder. Canonical direct graph scenes 262, 263, 264, 276, 277, 280, 281, 283, and 284 must remain raw-byte identical to the reviewed Phase 3B checkpoint and fetch neither graph-plumbing module nor the LocalVariable evaluator. Scene 302 exercises the required provider/frame-preparation integration and must retain the same graph/local module isolation.
- Explicit helper users pay the thin module and one block-map scan. Candidate-free graphs return exactly before the dynamic import, so the heavy runtime is not fetched. Repeated calls on a normalized candidate graph return at the internal marker before the scan.
- `parseNodeParticleSetFromSnippet` statically imports the thin helper because snippet parsing is the automatic feature boundary. Inline and network snippets share the same path. Non-Teleport snippets retain the helper but do not fetch the heavy runtime; Teleport snippets fetch it.
- Any TeleportOut, LocalVariable, Elbow, or Debug candidate in an explicit/snippet helper call fetches the heavy runtime. A detached malformed candidate remains semantically inert because root-only normalization returns a marked graph sharing parsed storage without a diagnostic or feature storage. TeleportIn alone does not trigger the runtime and remains unsupported if malformed input targets it directly.
- Teleport, Elbow, and Debug add no evaluator file, output getter, update step, creation slot, particle column, or per-animation callback. Their validation and rewrite live only in the normalizer.
- Particle local storage is allocated only for a reachable Particle-scope block. Loop local state and its one preparation closure are allocated only for a reachable Loop-scope block.
- The local-variable evaluator is reached through its own `ParticleLocalVariableBlock` manifest entry. Graphs without LocalVariable do not fetch its module.
- Production bundle assertions inspect generated bundle-info under the current CI-published baseline workflow; no generated manifest belongs in the PR.
- Existing canonical direct particle scenes reject both graph-plumbing modules and the local-variable evaluator. Scene 305 explicitly calls the helper and must fetch the thin helper, heavy runtime, and local evaluator. Teleport, Elbow, and Debug evaluator modules do not exist.

#### 9.31.11 Alternatives and risks

| Alternative                                                    | Decision                                                                                                                                                          |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reproduce Babylon object maps and particle reset callbacks     | Rejected. Lite particles are dense slots, not objects; id-validated columns preserve lifetime through swap-remove without callbacks or per-particle allocation.   |
| Use `scene` frame id for Loop                                  | Rejected. Manual simulation and pure Sprite2D use must remain scene-frame independent. One started animation call is the deterministic Lite loop boundary.        |
| Share one Loop map across systems as Babylon does              | Rejected. Per-root evaluators preserve system ownership, avoid a hidden cross-system registry, and make manual simulation deterministic.                          |
| Runtime pass-through evaluators for Teleport, Elbow, and Debug | Rejected. They add getter calls and module bytes for topology that can be removed before traversal.                                                               |
| Automatic parser flag plus three builder seams                 | Rejected after measurement. Even though ordinary scenes did not fetch the normalizer, scenes 262/280/281/302 grew by 175–193 raw bytes. Direct users require 0 B. |
| Statically import the full normalizer from each owning walk    | Rejected. It charges every direct graph user for optional topology rewriting.                                                                                     |
| Public helper for every caller with snippet auto-normalization | Chosen. Direct Teleport users opt in explicitly; the existing async snippet boundary preserves automatic imported-content behavior.                               |
| Add a statically imported candidate/reachability probe         | Rejected after measurement. It raised unrelated scenes by roughly 1.1 KB despite the normalizer itself remaining lazy.                                            |
| On-demand builder resolver                                     | Rejected after measurement. Existing direct scenes still grew by 185–191 raw bytes.                                                                               |
| Direct owner scan in each builder                              | Rejected after measurement. Existing direct scenes grew by 207–221 raw bytes.                                                                                     |
| Shared helper or parser thunk behind automatic builders        | Rejected after measurement. Both were larger than the approved hybrid boundary and still charged direct users.                                                    |
| Mutate parsed inputs in place                                  | Rejected. It would make graph reuse and comparative builds order-dependent.                                                                                       |
| Store local snapshots as JS objects or arrays                  | Rejected. It allocates per particle and aliases volatile getter scratch unless every value is cloned.                                                             |
| Infer LocalVariable shape from serialized output metadata      | Rejected. Output points omit a reliable type/valueType, so every Particle local reserves the complete 37-byte slot layout.                                        |
| Add an unconditional epoch field to every system               | Rejected. A shared feature-owned epoch object and existing optional frame seam keep non-users allocation-free.                                                    |
| Silently follow malformed teleport routes                      | Rejected. Explicit endpoint, connection, output-name, and cycle diagnostics keep malformed reachable graphs deterministic.                                        |

The main implementation risks are proxy-cycle handling, accidentally diagnosing detached blocks, scratch aliasing, and slot reuse. The ordered-stack resolver, root-only traversal, component copies, and id/valid columns are the required mitigations.

#### 9.31.12 Implementation and test slices

Phase 3A changed this architecture document only.

Phase 3B implements two side-effect-free node infrastructure files:

```text
packages/babylon-lite/src/particle/node/npe-graph-plumbing.ts
packages/babylon-lite/src/particle/node/npe-graph-plumbing-runtime.ts
```

The thin file owns the public scan and lazy import; the runtime owns copy-on-write route resolution and diagnostics. `npe-types.ts` carries only the internal normalized-return marker. `node-particle.ts` invokes the helper at the snippet boundary, `index.ts` root-exports the helper, and Scene 305 invokes it explicitly between parse and build. The parser and all three owning walks remain byte-for-byte at their ordinary baseline in the affected regions. This raises node infrastructure from 27 to 29 files and the normalized-builder class count from 29 to 31; neither Teleport class receives an evaluator.

The corrected 46-file evaluator/helper manifest includes `embedded-texture-source-block.ts`, which existed before Phase 3B but was omitted from the prior 45-file manifest. It is not a Phase 3B evaluator addition.

Focused Phase 3B fixtures cover direct unnormalized omission failure; explicit normalized success; Teleport fan-out and chains across scalar, Vector2, Vector3, Color4, gradient, particle/system flow, and texture edges; terminal output-name preservation; System `particle` ordering; one normalized graph across every specialized builder; endpoint id `0`; invalid/empty/missing/wrong endpoints; repeated Teleport route ids with final-record-wins behavior; disconnected TeleportIn; cycles; graph immutability; parser metadata absence for all graphs; TeleportIn-only exact helper return plus the existing unsupported error; non-Teleport exact-reference return; detached malformed Teleport shared-storage normalization without diagnostics or storage; repeat-normalization identity; automatic inline and fetched snippet support; non-Teleport snippet behavior; declaration trimming; no Teleport evaluator/registry body; and generated runtime-chunk/module isolation. Particle-flow Teleport coverage is mandatory in focused tests.

Phase 3B also introduced official Scene 305 (`scene305-npe-teleport`) and all of its anchors: the Lite, Babylon reference, and bundle pages (`lab/lite/scene305.html`, `lab/lite/babylon-ref-scene305.html`, and `lab/lite/bundle-scene305.html`); the shared graph source `lab/lite/src/shared/scene305-teleport-npe.ts`; the Babylon and Lite source entries `lab/lite/src/bjs/scene305.ts` and `lab/lite/src/lite/scene305.ts`; `reference/lite/scene305-npe-teleport/babylon-ref-golden.png`; `lab/public/thumbnails/scene305.jpg`; `tests/lite/parity/scenes/scene305-npe-teleport.spec.ts`; and scene configuration. The graph payload uses the standard `*-npe.ts` suffix, so bundle accounting excludes checked-in graph data and the Scene 305 ceiling measures engine/runtime code. Lab HTML/Vite inputs and gallery cards are config/file-discovered, so no hardcoded Vite or gallery list changes are required. Phase 3C keeps the Teleport fan-out and threads Elbow, Debug, and a Particle-scope LocalVariable around the creation-only random-size value. It adds no Loop semantics. Its Lite entry explicitly calls `normalizeNodeParticleGraph(parseNodeParticleSource(...))` before the default builder; Babylon and Lite parse the same shared graph.

Scene 305 follows Scene 262's deterministic runtime reference convention but is a frozen, non-interactive parity fixture. Both entries create the same fixed camera, and neither imports nor attaches camera controls; the Lite entry intentionally mirrors the Babylon.js oracle. This ownership is specific to Scene 305 and does not change interactive or general NPE scene conventions. Its parity specification invokes the shared `captureGolden` helper for the Babylon WebGPU page before opening Lite, then compares Lite at `MAD <= 0.01`. The Phase 3B run produced `MAD = 0.000`, `43,936` raw bytes, and `25,906` gzip bytes. Phase 3C does not modify or regenerate the committed golden or thumbnail: a focused nonvisual test proves exact 200-step particle-state equality against Scene 262, while CI owns the visual/parity result. Generated bundle output remains ignored and no generated manifest belongs in the change.

Phase 3C explicitly replaces Phase 3B's root-seeded plain visited `Set` with the domain-mask traversal specified in section 9.31.4. It extends the thin helper candidate scan and heavy runtime for LocalVariable, Elbow, and Debug, adds `blocks/particle-local-variable-block.ts`, routes it from `npe-registry-extra-values.ts`, composes Loop epochs through the existing `_prepareFrame` seam inside the LocalVariable evaluator, extends `NpeBuildState` with feature-owned Loop epoch sharing, and adds deterministic tests covering:

- Particle ids zero and nonzero, A-B-A reads, two particles, swap-remove, tail-slot reuse, id mismatch, scalar/Vector2/Vector3/Color4 snapshots, volatile source scratch, and runtime shape mismatch.
- Exact runtime discriminator precedence, malformed properties, unconditional 37-byte Particle slot layout, and no Loop capacity columns.
- Loop first-read behavior across dynamic emit rate, existing updates, and births; multiple reads and blocks; zero-ratio, unstarted, stopped drain, restart, independent systems, provider composition order, and callback errors.
- Particle-scope rejection for system-only and shared particle-plus-system masks; Loop acceptance in either domain; id-zero robustness; and the documented Babylon deviations.
- Elbow routes for every connection role; Debug `NpeValue` routing; class-specific unsupported flow/texture/gradient diagnostics; teleport-plus-pass-through chains; disconnected inputs; mixed proxy cycles; ignored `stackSize`; graph immutability; and detached malformed blocks.
- Default, flow-map, noise, combined texture-update, blend, provider, and snippet builder parity.
- Deterministic Lite Loop semantics, with the Babylon frame-id limitation explicitly documented rather than misrepresented as proof of Lite's call boundary.

Phase 3C changes the shared Scene 305 graph to thread Elbow, Debug, and a Particle-scope LocalVariable around a deterministic per-particle value whose snapshot equals its source. It adds no Loop block. The frozen, non-interactive Lite entry intentionally does not import or call `attachControl`, matching the Babylon.js oracle's fixed camera. Its ceiling therefore measures Phase 3 graph feature cost rather than optional input controls; this fixture-specific choice does not apply to general NPE scenes. The committed Phase 3B golden and thumbnail remain unchanged by policy; nonvisual state equality is local evidence and CI supplies parity. Bundle checks require the local-variable evaluator only for Scene 305 while canonical scenes continue to reject the normalizer and local evaluator, and they reject `arc-rotate-controls` for Scene 305 at source, runtime-chunk, and runtime-module boundaries.

Phase 3C raises the normalized-builder class count from 31 to 34 and block evaluator/helper files from 46 to 47. Node infrastructure stays at 29 and particle root files stay at 11 because the thin helper/runtime and frame-preparation composition extend existing files.

The block manifest (section 7.4) later replaced the registry chain described in these historical slices. `ParticleLocalVariableBlock` now loads through its own manifest entry rather than `npe-registry-extra-values.ts`, the flow-map, noise, and combined texture-update builders became deprecated aliases of the default builder, and `embedded-texture-source-block.ts` and every other registry, variant, and specialized-walk module was removed or folded into its class's block module. That refactor added no Phase 3 behavior and changed no graph-plumbing contract.

The current descriptive sections are synchronized at 34 normalized-builder classes, 11 particle root files, 18 node infrastructure files, and 39 block evaluator/helper files.

## 10. Rendering and live registration

### 10.1 Billboard creation

`createParticleBillboard` converts a `ParticleSystem` into its generic `FacingBillboardSpriteSystem` rendering representation. It requires `system.texture`; a null texture throws `createParticleBillboard: the particle system has no texture`.

It creates a row-major grid atlas over the existing texture:

- Sprite systems use `cellWidth` and `cellHeight` when each is greater than zero.
- A missing, zero, or negative dimension uses the full texture dimension for that axis.
- Margin and spacing are zero.
- Columns are `max(1, floor(texture.width / cellWidth))` and rows are `max(1, floor(texture.height / cellHeight))`.
- Each frame has top-down UV bounds, source size equal to the cell dimensions, and pivot `[0.5, 0.5]`.
- `premultipliedAlpha` is false.

It then creates a camera-facing billboard system with initial capacity `system.buffer.capacity` and the mapped blend descriptor. Billboard construction clamps its internal capacity to at least one and allocates `capacity * 16` Float32 instance values plus `capacity * 2` Float32 saved-size values.

The plain builder retains the pre-existing billboard mapping: mode `0` uses the generic OneOne descriptor, mode `1` uses generic alpha blending, and every other number uses generic Add. This path imports no exact or advanced blend module; modes `3` and `4` therefore degrade safely to Add.

`enableNodeParticleBlendModes` resolves private particle-owned descriptors from the current mutable mode at registration time, so alpha-channel state and advanced modes match Babylon.js without changing public billboard descriptors. Its exact mapping is:

| Particle `blendMode` | Passes             | Color factors                                         | Alpha factors                    |
| -------------------- | ------------------ | ----------------------------------------------------- | -------------------------------- |
| `0`                  | OneOne             | source `one`, destination `one`                       | source `zero`, destination `one` |
| `1`                  | Standard           | source `src-alpha`, destination `one-minus-src-alpha` | source `one`, destination `one`  |
| `2`                  | Add                | source `src-alpha`, destination `one`                 | source `zero`, destination `one` |
| `3`                  | Multiply           | source `dst`, destination `zero`                      | source `one`, destination `one`  |
| `4`                  | Multiply, then Add | first pass uses mode `3`; second pass uses mode `2`   | per-pass factors above           |
| any other number     | Add                | source `src-alpha`, destination `one`                 | source `zero`, destination `one` |

Every blend operation is `add`. All mappings use the transparent billboard path and disable depth writes.

The Multiply pass uses a dedicated fragment variant. Given the sampled atlas texel, per-particle tint, and billboard opacity, it computes:

```wgsl
let sampled = textureSample(atlasTex, atlasSamp, in.uv);
let baseColor = sampled * in.tint * billboards.opacityMul;
let sourceAlpha = sampled.a * in.tint.a * billboards.opacityMul.a;
return vec4f(baseColor.rgb * sourceAlpha + vec3f(1.0) * (1.0 - sourceAlpha), baseColor.a);
```

Interpolating toward white before destination-color blending makes a zero-alpha texel leave the framebuffer unchanged. The Add pass uses the stock billboard fragment (`sampled * tint * opacityMul`).

The internal particle-blend registrar configures the freshly created facing-billboard representation in place. Modes without `_particlePasses` delegate to `addBillboardSystemToScene`. Advanced modes attach the private Multiply shader and join the same scene billboard collection (membership, picking, removal, discovery) with a particle-owned deferred renderable builder, all from the opt-in particle module.

The generic `buildBillboardRenderable(engine, system)` API and its ordinary scene registrar remain unchanged. The optional particle path attaches its static shader before calling that base builder. A single lazily created descriptor and per-device/orientation shader-module cache are shared by every particle system, so identical systems share shader modules and pipeline-cache keys.

The private descriptor emits no `SpriteFx` UBO declaration, layout entry, allocation, or per-frame write. Its hook intentionally mirrors the public billboard-custom-shader hook instead of importing that optional feature and its core into Multiply-only bundles. The mirror remains behaviorally compatible with the last-writer-wins global hook and uses one module-level empty parameter array rather than allocating per update.

Mode `3` uses the resulting normal billboard renderable unchanged. Mode `4` wraps its draw binding with one stock Add pipeline, a second bind group, and a second system uniform buffer. The two pipelines require distinct bind groups because each pipeline owns its bind-group layout. The base renderable deliberately keeps its GPU buffer private, so the optional mode-4 module owns and dirty-updates its own 32-byte copy rather than exposing GPU internals through the generic billboard contract. It remains one transparent renderable with one logical billboard system, one sorted instance upload, one instance buffer, and one index buffer.

Mode `4` draws the normal Multiply binding first. The primary draw leaves its instance and index buffers bound, so the wrapper then binds only the Add pipeline and Add bind group before issuing the second indexed draw over the same instances. It restores the primary Multiply pipeline so the render task's consecutive-pipeline cache remains correct. The draw reports two GPU draw calls when particles are visible and zero when the system is hidden or empty.

`registerNodeParticleSet` invokes each system's installed `_registerBillboard` callback, falling back to `addBillboardSystemToScene`. Enriched systems therefore resolve all five modes exactly from the current `system.blendMode`; ordinary builders retain the stock live-registration path and Add fallback.

### 10.2 Billboard synchronization

`syncParticleBillboard` clears the billboard count and saved sizes, requests the standard size, scale, angle, and color columns, then iterates `[0, buffer.alive)`. It calls `addBillboardSpriteIndex` once per particle with:

```ts
{
    position: [posX[i], posY[i], posZ[i]],
    sizeWorld: [size[i] * scaleX[i], size[i] * scaleY[i]],
    color: [colorR[i], colorG[i], colorB[i], colorA[i]],
    rotation: angle[i],
    frame: spriteSheet ? spriteSheet.cellIndex[i] : 0,
}
```

The property value and its position, size, and color tuples are transient allocations for each live particle. The billboard writes them into its packed Float32 instance arrays. Since the billboard starts at particle capacity and `alive <= capacity`, normal synchronization does not grow it.

Frame lookup is bounds-checked by the sprite atlas. An invalid cell throws `resolveSpriteFrame: index <frame> out of range [0, <frameCount>)` during sync. A non-sprite graph always requests frame zero.

The billboard path uses the transient allocations above and the billboard subsystem's storage, shader, pipeline, bind groups, deferred renderable, and picking support.

### 10.3 Billboard scene registration

`registerNodeParticleSet(scene, set, options = {})` uses `autoStart = options.autoStart ?? true`. For each system, in `set.systems` order, it:

1. Creates the particle billboard.
2. Calls `(system._registerBillboard ?? addBillboardSystemToScene)(scene, billboard)`. Only the explicit blend-mode builder installs the particle-blend registrar, and only for descriptors carrying `_particlePasses`.
3. Calls `startParticleSystem` when auto-start is true.
4. Appends one internal callback to `scene._beforeRender`.

Each callback computes:

```ts
const ratio = deltaMs > 0 ? deltaMs / (1000 / 60) : 1;
animateParticleSystem(system, ratio);
syncParticleBillboard(system, billboard);
```

There is no synchronization during registration; the first registered callback performs the first live animation and upload. Internal callbacks append, so camera controls and feature preparation registered before the set run first, and callbacks for a multi-system set preserve system-registration order.

The registration function returns `void`, exposes no billboard, and supplies no callback-unregister handle. With auto-start false, the callback is still registered; animation is a no-op until the system is started, while synchronization still runs every frame.

### 10.4 Sprite2D bridge creation and mapping

`createParticleSprite2DBridge(system, options = {})` is the manual pure-2D bridge factory. It requires `system.texture`; a missing texture throws `createParticleSprite2DBridge: the particle system has no texture`.

The factory builds the same row-major grid atlas rules described in section 10.1, including full-texture fallback for missing or non-positive cell dimensions and bounds-checked frame lookup. It creates one centered `Sprite2DLayer` with:

- `capacity` fixed from `system.buffer.capacity`;
- `depth: "none"` and `pivot: [0.5, 0.5]`;
- blend mode owned by the bridge mapping below; and
- optional `opacity`, `visible`, `order`, and `view` forwarded from `options.layer`.

Capacity, depth, blend, and pivot cannot be overridden through `options.layer`. The returned bridge keeps readonly references to the system and layer and mutable coordinate fields. `pixelsPerUnit` defaults to `1` and must be a positive finite number. `originPx` defaults to `[0, 0]` and both components must be finite. `invertY` defaults to `true`.

For each live slot, let `ySign = invertY ? -1 : 1`. The mapping is:

```ts
positionPx = [originPx[0] + posX[i] * pixelsPerUnit, originPx[1] + posY[i] * pixelsPerUnit * ySign];
sizePx = [size[i] * scaleX[i] * pixelsPerUnit, size[i] * scaleY[i] * pixelsPerUnit];
rotation = angle[i] * ySign;
color = [colorR[i], colorG[i], colorB[i], colorA[i]];
frame = spriteSheet ? spriteSheet.cellIndex[i] : 0;
```

This explicitly converts NPE world XY with +Y up into Sprite2D pixels with +Y down by default. Disabling `invertY` preserves +Y-up position and rotation. `posZ` is not consumed; the bridge supports XY only and does not promise XZ/YZ projection.

Blend mapping is:

| Particle `blendMode` | Sprite2D descriptor   | Color factors                                         | Alpha factors                                   |
| -------------------- | --------------------- | ----------------------------------------------------- | ----------------------------------------------- |
| `0`                  | `spriteBlendOneOne`   | source `one`, destination `one`                       | source `one`, destination `one`                 |
| `1`                  | `spriteBlendAlpha`    | source `src-alpha`, destination `one-minus-src-alpha` | source `one`, destination `one-minus-src-alpha` |
| any other number     | `spriteBlendAdditive` | source `src-alpha`, destination `one`                 | source `one`, destination `one`                 |

Every blend operation is `add`. Mode `0` is pure one-one additive; unlike the alpha-weighted additive fallback, source RGB is not multiplied by source alpha.

`enableNodeParticleBlendModes` does not change this baseline Sprite2D mapping. It installs only the billboard `_registerBillboard` callback. Modes `3`, `4`, and unknown values therefore remain `spriteBlendAdditive` when callers explicitly choose the ordinary bridge. Exact Sprite2D rendering is a separate opt-in described next.

### 10.5 Exact Sprite2D blend-mode bridge

`particle-sprite-2d-blend-modes.ts` is the particle-owned opt-in for exact Sprite2D output. It works on any built `NodeParticleSet` by reading each system's current mutable `blendMode` when the bridge is created; neither `buildNodeParticleSetWithBlendModes` nor `enableNodeParticleBlendModes` is required because those APIs configure only billboard registration.

`createParticleSprite2DBridgeWithBlendModes(system, options = {})` delegates baseline texture, mapping, and atlas validation to `createParticleSprite2DBridge`. Before exposing that bridge, it replaces the primary layer's internal descriptor with `createParticleBlend(system.blendMode)`. This structural reuse is safe because `BillboardBlendDescriptor` extends `SpriteBlendDescriptor`; Sprite2D reads only `_key`, `_descriptor`, and `_premultipliedOpacity`. `particle-blend.ts` imports the billboard descriptor only as a type, so exact Sprite2D bundles retain no billboard runtime module.

The factory returns one logical bridge with one mutable mapping state. `layer` is the authoritative presentation layer and `layers` exposes every ordered render-pass layer for renderer attachment and inspection. The internal `_passes` list holds one baseline packed bridge per pass so atlas interpretation and instance mapping remain single-sourced.

The exact mode table is:

| Particle `blendMode` | Sprite2D passes    | Color factors                                         | Alpha factors                    |
| -------------------- | ------------------ | ----------------------------------------------------- | -------------------------------- |
| `0`                  | OneOne             | source `one`, destination `one`                       | source `zero`, destination `one` |
| `1`                  | Standard           | source `src-alpha`, destination `one-minus-src-alpha` | source `one`, destination `one`  |
| `2`                  | Add                | source `src-alpha`, destination `one`                 | source `zero`, destination `one` |
| `3`                  | Multiply           | source `dst`, destination `zero`                      | source `one`, destination `one`  |
| `4`                  | Multiply, then Add | first pass uses mode `3`; second pass uses mode `2`   | per-pass factors above           |
| any other number     | Add                | source `src-alpha`, destination `one`                 | source `zero`, destination `one` |

Every blend operation is `add`. Modes `0`, `1`, `2`, `3`, and the default create one layer. Mode `4` creates exactly two layers over the same atlas and capacity. Both receive the same `order` and are attached consecutively. `SpriteRenderer` uses a stable ascending-order sort, so equal-order Multiply and Add layers remain immediately adjacent in that order. The binding owns membership; callers must not remove/reinsert individual pass layers. No generic SpriteRenderer multipass machinery is added.

Modes `3` and `4` use one lazily created `Sprite2DCustomShader` on the primary layer. Given the sampled atlas texel, per-particle tint, and layer opacity, its exact body is:

```wgsl
let sampled = textureSample(atlasTex, atlasSamp, in.uv);
let baseColor = sampled * in.tint * L.opacityMul;
let sourceAlpha = sampled.a * in.tint.a * L.opacityMul.a;
return vec4f(baseColor.rgb * sourceAlpha + vec3f(1.0) * (1.0 - sourceAlpha), baseColor.a);
```

The alpha-to-white transform makes a transparent texel neutral under destination-color multiplication. It matches the billboard formula while using Sprite2D's in-scope `L.opacityMul`. Mode `4`'s second layer has no custom shader and therefore uses the stock Sprite2D fragment, including the same tint and opacity semantics. Module state is only `let _multiplyShader = null`; the shader descriptor and its cache are allocated on the first advanced Multiply bridge creation, and custom-shader hook registration occurs through that explicit call.

`syncParticleSprite2DBridgeWithBlendModes(bridge)` validates the one logical mapping and every pass layer's exclusive ownership before writing any pass. It copies `pixelsPerUnit`, both `originPx` components, and `invertY` into the internal pass bridges without allocation. The primary `layer` is authoritative for mutable presentation state: opacity, visibility, order, view position/zoom/rotation, and pivot are copied to secondary layers before synchronization. It then invokes the baseline packed synchronizer once per pass. Mode `4` therefore duplicates only layer instance storage/upload, not simulation: both passes contain byte-equivalent particle instances and current mapping values.

Manual callers add every `bridge.layers` entry to one renderer in array order and call `animateParticleSystem` exactly once before each advanced sync. `registerNodeParticleSet2DWithBlendModes(renderer, set, options = {})` supplies that policy:

1. Create and initially synchronize every logical bridge before mutating the renderer.
2. Attach every pass layer in system order and pass order. Any failure removes every new pass layer by identity, including a layer pushed immediately before its pipeline creation threw.
3. Start each system once when `autoStart = options.autoStart ?? true`.
4. Install one renderer hook for the complete set. Per renderer update it computes the ordinary frame ratio, then animates each system exactly once and synchronizes all of that system's pass layers.

`NodeParticleSet2DBlendModesBinding` owns the hook and all pass-layer attachments. `disposeNodeParticleSet2DBlendModesBinding` is idempotent, and renderer disposal invokes it automatically. Disposal removes every layer and callback but does not stop systems or dispose particle textures. The optional Handle API is forbidden on every bridge-owned pass layer for the same exclusive-live-range reason as the baseline bridge.

### 10.6 Sprite2D bridge synchronization

`syncParticleSprite2DBridge(bridge)` owns the layer's complete live range. The layer cannot contain independent Index API sprites, and the function rejects a layer on which the optional Handle API has installed hooks.

For `[0, system.buffer.alive)`, synchronization resolves the sprite-sheet frame and writes position, size, UV bounds, rotation, and RGBA directly into the existing `depth: "none"` 13-float instance layout. It writes width and height into the layer's saved-size side buffer at the same time. There are no per-particle objects, tuples, or other transient allocations.

After the packed loop, synchronization clears saved-size entries in the stale tail `[alive, previousCount)`, updates the layer count once, and marks at most one dirty range: `[0, max(previousCount, alive))`. This makes both growth and shrinkage visible to the next renderer upload without calling the public per-sprite mutation APIs. Invalid sprite-sheet cells retain the shared `resolveSpriteFrame` bounds error.

Because mapping fields are mutable, each synchronization revalidates `pixelsPerUnit` and `originPx` before touching the packed range. This supports moving the origin or changing scale between frames while rejecting non-finite state.

### 10.7 SpriteRenderer registration and lifecycle

Manual callers create a bridge, add `bridge.layer` to a `SpriteRenderer`, and choose when to call `animateParticleSystem` and `syncParticleSprite2DBridge`. `registerNodeParticleSet2D(renderer, set, options = {})` supplies the managed path:

1. Create and initially synchronize every bridge before mutating the renderer.
2. Attach one bridge-owned layer per system, preserving `set.systems` order. If any attachment throws, remove every layer attached by this call before rethrowing.
3. Start every system when `autoStart = options.autoStart ?? true`.
4. Append one renderer before-update hook for the complete set. It computes `ratio = deltaMs > 0 ? deltaMs / (1000 / 60) : 1`, then animates and synchronizes each bridge in order.

Creation and initial synchronization are transactional with respect to renderer membership: a missing texture, invalid mapping, or invalid sprite frame in any system leaves no bridge layer attached and starts no system. Unlike billboard scene registration, the returned layers are synchronized before the function returns.

The returned `NodeParticleSet2DBinding` owns the update hook, renderer attachment, and bridge-created layers. Its `bridges` array is readonly and its `active` flag is mutable state set to `false` on disposal. `disposeNodeParticleSet2DBinding(binding)` is idempotent: it removes the hook, renderer-disposal callback, and every bridge layer. Disposing the renderer invokes the same disposal automatically. Particle systems, their simulation state, and their textures remain caller-owned; binding disposal does not stop systems or dispose textures.

## 11. Error and failure behavior

The implementation preserves these explicit failures:

- Parser: `NodeParticle: invalid source — expected a \`blocks\` array`.
- Parser: `NodeParticle: block missing numeric id (name=<stringified name>)`.
- Parser: `NodeParticle: graph has no SystemBlock`.
- Direct builder with an unnormalized reachable TeleportOut: `NodeParticle: unsupported block "ParticleTeleportOutBlock"`.
- Teleport endpoint value: `NodeParticle: ParticleTeleportOutBlock <outId> has invalid entryPoint`.
- Missing Teleport endpoint: `NodeParticle: ParticleTeleportOutBlock <outId> references missing entryPoint <entryId>`.
- Wrong Teleport endpoint class: `NodeParticle: ParticleTeleportOutBlock <outId> entryPoint <entryId> is not ParticleTeleportInBlock`.
- Disconnected Teleport input: `NodeParticle: ParticleTeleportInBlock <id> input is not connected`.
- Disconnected Elbow, Debug, or LocalVariable input: `NodeParticle: <ClassName> <id> input is not connected`.
- Plumbing output mismatch: `NodeParticle: <ClassName> <id> does not expose output "<name>"`.
- Debug or LocalVariable carrying particle/system flow, texture, or gradient metadata: `NodeParticle: <ClassName> <id> does not support <role> connections`.
- Mixed proxy route cycle: `NodeParticle: graph plumbing cycle <id> -> ... -> <id>`.
- Particle LocalVariable on a domain containing the system bit: `NodeParticle: ParticleLocalVariableBlock <id> Particle scope requires particle-only evaluation`.
- Unsupported LocalVariable runtime value: `NodeParticle: ParticleLocalVariableBlock <id> received an unsupported value`.
- LocalVariable runtime shape change: `NodeParticle: ParticleLocalVariableBlock <id> changed value type`.
- Snippet HTTP response: `NodeParticle: snippet fetch failed (<status>)`.
- Connected value with no installed getter: `NodeParticle: unresolved connection <ClassName>.<inputName>`.
- Texture output wired into a value input: `NodeParticle: <ClassName>.<inputName> does not accept a texture`.
- Value output wired into a texture input: `NodeParticle: <ClassName>.<inputName> expects a texture`.
- Any reachable class without a block-manifest entry: `NodeParticle: unsupported block "<ClassName>"`. The parallel preload throws it before any system is built.
- Unsupported contextual source: `NodeParticle: unsupported contextual source 0x<lowercase hex>`.
- Unsupported system source: `NodeParticle: unsupported system source <decimal id>`.
- Invalid local source use: `NodeParticle: LocalPositionUpdated requires SystemBlock.isLocal`.
- Invalid local source timing or recycled slot: `NodeParticle: LocalPositionUpdated read before local shape position creation`.
- Invalid emitter provider result: `NodeParticle: emitter provider must return a finite 16-element matrix`.
- Sprite update without setup: `NodeParticle: BasicSpriteUpdateBlock requires SetupSpriteSheetBlock`.
- Billboard creation without texture: `createParticleBillboard: the particle system has no texture`.
- Sprite2D bridge creation without texture: `createParticleSprite2DBridge: the particle system has no texture`.
- Invalid Sprite2D scale at creation: `createParticleSprite2DBridge: pixelsPerUnit must be a positive finite number, got <value>`.
- Invalid Sprite2D origin at creation: `createParticleSprite2DBridge: originPx must be finite, got [<x>, <y>]`.
- Invalid mutable Sprite2D scale during sync: `syncParticleSprite2DBridge: pixelsPerUnit must be a positive finite number, got <value>`.
- Invalid mutable Sprite2D origin during sync: `syncParticleSprite2DBridge: originPx must be finite, got [<x>, <y>]`.
- Handle API installed on a bridge-owned layer: `syncParticleSprite2DBridge: the bridge-owned layer cannot use the Sprite2D Handle API`.
- Exact bridge creation delegates texture and initial mapping validation to the baseline factory and therefore preserves its `createParticleSprite2DBridge` error strings.
- Invalid mutable exact-bridge scale during sync: `syncParticleSprite2DBridgeWithBlendModes: pixelsPerUnit must be a positive finite number, got <value>`.
- Invalid mutable exact-bridge origin during sync: `syncParticleSprite2DBridgeWithBlendModes: originPx must be finite, got [<x>, <y>]`.
- Handle API installed on any exact bridge pass layer: `syncParticleSprite2DBridgeWithBlendModes: bridge-owned layers cannot use the Sprite2D Handle API`.
- Invalid sprite frame during sync: `resolveSpriteFrame: index <frame> out of range [0, <frameCount>)`.

Additional behavior is observable:

- `normalizeNodeParticleGraph` reports malformed reachable Phase 3 routes and invalid LocalVariable domains before a builder runs. The snippet API invokes it automatically; direct callers see those diagnostics only after opting in. Omitting direct normalization leaves compile-away classes unsupported and bypasses LocalVariable role/domain validation.
- A dangling target block id is marked built and skipped. It fails only if a consumer requests its absent getter; a flow-only edge can remain silent.
- Detached unsupported blocks are ignored because they are unreachable.
- Dynamic-import failures for reachable manifest block modules or their block-local lazy paths propagate from the asynchronous build.
- Exceptions thrown by a `NodeParticleEmitterProvider` propagate unchanged from helper creation, the default convenience build, or animation. A structurally invalid or non-finite result throws the explicit provider error before any stable matrix, translation, inverse, or simulation field is modified. The next valid frame sample can continue normally.
- Missing mesh positions or indices silently leave the system without mesh creation slots. Malformed or empty arrays can produce `undefined`, `NaN`, out-of-range access, or native errors during creation.
- Particle texture fetch, decode, and upload failures are caught inside `SystemBlock`; build resolves with `texture` unchanged. A failed import of the texture loader module is not caught and rejects the build. Rendering then fails at billboard or Sprite2D bridge creation when no other texture was assigned.
- `registerNodeParticleSet2D` creates and synchronizes every bridge before attachment. Creation or synchronization failure leaves renderer membership unchanged; an attachment failure removes layers already attached by that call and then propagates.
- `registerNodeParticleSet2DWithBlendModes` provides the same transaction across all systems and pass layers. It removes a just-pushed layer when that layer's pipeline creation throws, then removes every earlier pass layer from the same call.
- Flow-map fetch or CPU decode failures are caught inside `UpdateFlowMapBlock`; build resolves, the block applies no force, and it installs no frame preparation.
- Noise-texture fetch or CPU decode failures are caught inside `UpdateNoiseBlock`; build resolves, applies no force, and consumes no coordinate RNG.
- Invalid relative URL resolution can throw synchronously from `new URL`.
- Invalid JSON, malformed snippet payloads, invalid typed-array lengths, and wrong runtime value shapes use native JavaScript errors or typed-array coercion.
- Capacity exhaustion drops all creation requests from the first failed spawn through the rest of that animation call. Emission carry and simulated time are not restored.
- Numeric fields are not checked for finiteness, sign, integer range, or compatible graph value type.
- A zero lifetime produces division by zero in color-step creation. Zero lifetime in sprite update produces JavaScript remainder/division results and Uint16 coercion.
- `_nextId` is an unbounded JavaScript number while the stored particle and cache ids are Uint32 values, so stored ids wrap at Uint32 assignment.

## 12. Current limitations

- The parser represents arbitrary serialized class names. Builders support the 29 ordinary classes directly and five Phase 3 classes at the required normalized boundary, for 34 supported classes after normalization. Other reachable NPE classes fail with the manifest error in section 11.
- Simulation is CPU-only.
- Rendering is selected explicitly by the caller: camera-facing billboards or pure-2D Sprite2D. Serialized `billBoardMode` and `isBillboardBased` do not select either runtime path.
- The Sprite2D bridge maps only NPE world XY. It ignores `posZ` and does not support XZ/YZ projection.
- Exact particle blend factors and specialized Multiply/MultiplyAdd output are explicit per render target. Billboards require `buildNodeParticleSetWithBlendModes` or `enableNodeParticleBlendModes`; Sprite2D requires `createParticleSprite2DBridgeWithBlendModes` or `registerNodeParticleSet2DWithBlendModes` and works with a set from any builder.
- The plain billboard path maps mode `0` to OneOne, mode `1` to alpha, and modes `2`, `3`, `4`, and unknown values to Add. The baseline Sprite2D bridge independently maps mode `0` to `spriteBlendOneOne`, mode `1` to `spriteBlendAlpha`, and every other value to `spriteBlendAdditive`. These fallback contracts remain intentionally unchanged for callers that do not opt in.
- System source 4 and every system source outside 1, 2, and 3 are unsupported.
- Custom emitter functions, sub-emitter triggers, and inherited emitter velocity have no supported block evaluator.
- ParticleTextureSource supports serialized static URL/data-URL pixels. Babylon's live `sourceTexture`, including `NoiseProceduralTexture` refresh, is not reconstructed because it is an in-memory object and is not serialized into NPE graph JSON.
- Emit power scales the created direction; exactly zero clears it. No inherited velocity term is added.
- Mesh emission reads only `cachedVertexData`; mesh `worldSpace` is ignored, and mesh data is not structurally validated.
- A renderable particle system needs a successfully loaded or manually assigned texture. Neither render target has an untextured fallback.
- Local-position integration is available only through source `0x0018` on a system whose root has `isLocal === true`.
- Billboard scene registration provides no unregister handle and does not set `_started` false when a stopped system becomes empty. Sprite2D renderer registration returns an idempotently disposable binding but likewise does not stop caller-owned systems.
- The simulation structure is allocation-free per indexed step. Live emitter refresh copies into stable matrix/vector/inverse storage and also allocates nothing per call. Billboard synchronization allocates transient values; Sprite2D bridge synchronization is allocation-free per particle and update.

## 13. Verification contract

### 13.1 Deterministic state tests

Oracle-state tests build through the parser and builder, install this generator after asynchronous build completes, start the system, and call `animateParticleSystem(system, 1)` for the fixture step count:

```ts
let seed = 1;
Math.random = () => {
    const value = Math.sin(seed++) * 10000;
    return value - Math.floor(value);
};
```

Snapshots sort live slots by particle id. The scene 262 canonical state test uses tolerance `1e-6`; the other canonical, emitter, sprite, Basic Properties, and Change state suites use `1e-4` for numeric particle fields. Id order is exact, with a constant id offset permitted for emitter fixtures whose oracle process assigns process-wide ids. Sprite `cellIndex` is exact.

The current unit categories are:

- Buffer and lifecycle: base-only allocation, string-key column sharing, dense spawn/swap-remove, capacity, emission, integration, death clamp, and sprite-column math.
- Build behavior: inline JSON, root reachability, one parallel load of every reachable block class before any block builds, detached-block isolation, two-field connection criteria, dynamic emit-rate laziness, system-time reevaluation, Babylon.js data-over-URL precedence for dual-source input, and `SystemBlock` embedded texture upload with explicit-false mapping and Lite's class default when `invertY` is omitted.
- Canonical graph state: scenes 262, 263, 264, and 276; full Basic Properties; Size; Sphere; and deterministic/random-start sprite variants.
- Change graphs: Size, Color, Speed, Angular Speed, multi-stop Angular Speed, Drag, Emit Rate, Lifetime, Start Size, and Speed Limit.
- Emitters: Point, Box, Sphere, directed Sphere, Hemisphere, Cone, directed Cone, Cylinder, directed Cylinder, Mesh, rotated Cylinder, all six transformed local shapes, mesh vertex color, mesh InitialDirection, shared volatile bounds, and local source build/read guards.
- Moving emitters: translating and rotating provider snapshots, newly returned matrices and in-place mutation, static-option precedence and immutability, world births, all six world/local shape paths, `LocalPositionUpdated`, contextual Emitter, every implicit Cylinder inverse in one system, every builder, Parse-option preservation, unstarted and stopped-but-started calls, independent multi-system sampling, wrapped-options reuse isolation, and provider exception/invalid-result atomicity across matrix, translation, inverse, and particle state.
- Value correctness: shared-scratch Math, Lerp/Gradient endpoints, Random min/max aliasing, lock modes, Uint32 id edge cases, and capacity-bounded OncePerParticle caches.
- Attractors: softened inverse-square attraction, negative-strength repulsion, defaults, coincident-point handling, lifetime-clamped step scaling, and lazy evaluator isolation.
- Flow maps: projected nearest-neighbor sampling including non-zero row stride, vertical screen mapping, RGBA force decoding, alpha and bounds handling, per-particle strength evaluation, lifetime-clamped step scaling, allocator-selected F32/F64 matrix snapshots, `textureDataUrl` precedence, cached decoding, unsupported-scheme rejection, and lazy texture/evaluator isolation.
- Noise textures: exact three-sample red-channel addressing, six deterministic Float64 random coordinates, coordinate reuse and slot recycling, Vector3 defaults/strength, lifetime-clamped step scaling, extraction failure, parsed graph wiring including one embedded texture source shared by the system upload and CPU noise decoding, Babylon multi-step state fixtures, and lazy block isolation.
- Graph plumbing: direct unnormalized pass-through failure and explicit success; parser metadata absence; TeleportIn-only exact helper return; candidate-free exact-reference and detached-malformed shared-storage paths; Teleport and Elbow routes for scalar, Vector2, Vector3, Color4, gradient, particle/system flow, and texture roles; Debug value-only routing; two-bit shared-domain revisits; consumer-edge-first diagnostic priority; texture consumers reading through rewritten edges; endpoint id `0`; malformed endpoints; final-record-wins behavior; mixed cycles; copy-on-write identity, idempotence, and raw-source immutability; every builder; automatic inline/fetched snippets; no Teleport/Elbow/Debug evaluator body; and thin/runtime chunk/module isolation.
- LocalVariable state: exact shape discrimination and malformed-shape precedence; scalar/Vector2/Vector3/Color4 volatile-scratch snapshots; exact 37-byte Particle slot allocation; id `0`; A-B-A, two-particle, swap-remove, tail reuse, and failure atomicity; Particle system/shared-domain rejection; Loop unstarted/zero-ratio/stopped/restart epochs; dynamic emit-rate/update/birth sharing; multiple blocks; independent systems/builds; provider ordering and errors; and no Loop capacity columns.
- Feature isolation: runtime chunk manifests and, when bundle-info exists, fetched module contents.
- Baseline Sprite2D bridge: texture and mapping validation, exact XY/+Y conversion, blend mapping including the additive fallback for modes 3, 4, and unknown values, sprite-sheet mapping and its out-of-range cell error, Handle-API ownership rejection, full-range packed synchronization, stale saved-size clearing, single dirty updates, transactional multi-system registration, auto-start control, idempotent disposal, and renderer-disposal cleanup.
- Exact Sprite2D blend bridge: descriptors for modes 0 through 4 and default, mode-3 custom shader structure and opacity formula, mode-4 `[Multiply, Add]` layers and stable order, one animation per system/update, byte-equivalent pass synchronization under mutable mapping/presentation, all-pass Handle ownership rejection, transactional creation/attachment rollback, manual and renderer disposal, and baseline isolation.
- Public declarations: `normalizeNodeParticleGraph` is present with a representable `ParticleGraph` promise signature; its runtime function and marker are absent; the removed post-build provider API is absent; both build-time provider helpers are present; the generic options intersection preserves extended builder options; and `_setupEmitter`, the Loop epoch, plus provider internals are trimmed from the emitted package declaration.
- Path ownership: the `particle/soa` source directory and `particle-soa*.test.ts` unit-test names must not exist. TypeScript compilation validates all source and test imports.

Loop oracle separation is intentional: deterministic Lite tests own manual started-call semantics. No Babylon fixture is claimed to prove that boundary.

### 13.2 Oracle fixture procedure

For reproducible Babylon.js equivalence data:

1. Construct the target CPU particle system and convert it with `ConvertToNodeParticleSystemSetAsync` while the NPE block registrations are loaded.
2. Call `buildAsync(scene)` so serialization has all attached blocks.
3. Serialize the node-particle set and normalize only external texture URLs needed by the Lite fixture.
4. Set the oracle system scene reference to null so each explicit animation call uses ratio 1 and has no scene frame-id suppression.
5. Install the same seeded generator after build.
6. Run the exact fixture step count.
7. Record ids, position, direction, color, size, scale, angle, age, lifetime, and sprite cell when applicable.

Use conversion for graph extraction. The oracle's direct parse path does not preserve every Color4 input needed by these fixtures. Babylon.js is used only as the compatibility oracle for this procedure.

Moving-emitter fixtures additionally assign the oracle emitter's translation/rotation schedule immediately before each explicit animation call, force its world matrix current, and record that matrix with the resulting particle state. Lite builds with provider-wrapped options and replays the same schedule by returning the recorded matrix before each matching call. Fixtures include translation and rotation changes that distinguish current translation, upper-3x3 direction transforms, local-position reprojection, and inverse-dependent Cylinder direction.

A future limited Loop LocalVariable oracle would be an explicit exception to this manual procedure. It must not null Babylon's scene and must not call particle animation repeatedly within one unchanged scene frame: null scene access throws for Loop scope, while unchanged frame ids suppress new snapshots. It may call `scene.render()` once per step and observe one compatible first read per render, but that sequence would not serve as an oracle for Lite's one-started-`animateParticleSystem`-call boundary. No such fixture is required for or claimed by the current implementation.

### 13.3 Visual scenes

The ten frozen billboard oracle Lite scenes seed after build, synchronize one billboard, and register a frozen scene. Scenes 262 through 281 and Scene 305 use a black clear color; scenes 283 and 284 use the warm destination color specified in section 13.5. Scenes 262, 263, 264, 276, 277, and 305 run 200 ratio-1 steps. Scene 280 runs 300, scene 281 runs 240, scene 283 runs 40, and scene 284 runs 20. Scene 280's Babylon reference calls `scene.updateTransformMatrix(true)` before manual steps because Babylon's UpdateFlowMap reads the scene transform matrix before the first render. Scene 302 is the eleventh billboard oracle and adds a default-live mode plus a deterministic frozen query mode.

| Scene                                 | Coverage                                                                      | Camera                                                       | MAD ceiling | Raw ceiling |
| ------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------- | ----------- |
| 262 `scene262-npe-size`               | Basic Properties - Size, Box                                                  | alpha `-pi/2`, beta `1.2`, radius `4`, target `(0,0.3,0)`    | `0.01`      | `44.1 KB`   |
| 263 `scene263-npe-sphere`             | Sphere emitter                                                                | alpha `-pi/2`, beta `1.2`, radius `14`, target origin        | `0.01`      | `44.1 KB`   |
| 264 `scene264-npe-change-size`        | Gradient, GradientValue, UpdateSize                                           | alpha `-pi/2`, beta `1.2`, radius `12`, target `(0,0.7,0)`   | `0.01`      | `44.1 KB`   |
| 276 `scene276-npe-animations`         | deterministic sprite sheet, cells 0 through 9, 64 by 64 cells, speed 30       | alpha `-pi/2`, beta `1.2`, radius `4`, target `(-1,0,0)`     | `0.01`      | `45.0 KB`   |
| 277 `scene277-npe-attractor`          | UpdateAttractor after position integration, attractor `(0,2,0)`, strength `8` | alpha `-pi/2`, beta `1.2`, radius `5`, target `(0,0.8,0)`    | `0.01`      | `45.0 KB`   |
| 280 `scene280-npe-flow-map`           | UpdateFlowMap after integration, flipped repel map, strength `15`, size `0.6` | alpha `pi/2`, beta `pi/2`, radius `9`, target `(-5,0,0)`     | `0.01`      | `45.0 KB`   |
| 281 `scene281-npe-noise-texture`      | UpdateNoise after integration, cached 8x8 noise, strength `(1.5,0.5,1.5)`     | alpha `-pi/2`, beta `1.2`, radius `11`, target `(0,1,0)`     | `0.01`      | `45.0 KB`   |
| 283 `scene283-npe-multiply-blend`     | Multiply blend with procedural radial alpha over a warm destination           | alpha `-pi/2`, beta `pi/2`, radius `12`, target origin       | `0.01`      | `45.0 KB`   |
| 284 `scene284-npe-multiply-add-blend` | MultiplyAdd blend with a sparse procedural radial-alpha field                 | alpha `-pi/2`, beta `pi/2`, radius `12`, target origin       | `0.01`      | `45.0 KB`   |
| 302 `scene302-npe-moving-emitter`     | local Point, moving provider, `LocalPositionUpdated`, live/frozen modes       | alpha `-pi/2`, beta `1.2`, radius `8.5`, target `(0,0.35,0)` | `0.01`      | `61.5 KB`   |
| 305 `scene305-npe-teleport`           | Teleport/Elbow/Debug routing plus Particle LocalVariable size snapshot        | alpha `-pi/2`, beta `1.2`, radius `4`, target `(0,0.3,0)`    | `0.01`      | `45.0 KB`   |

Each camera uses near plane `0.1` and far plane `100`. The ten always-frozen scenes set both `canvas.dataset.animationFrozen` and `canvas.dataset.ready` to `"true"` after engine start. Scene 302 sets `ready` in both modes and sets `animationFrozen` only for a finite nonnegative `seekTime`.

Each parity specification waits for its deterministic ready/frozen flag, allows a short GPU settle, screenshots the canvas, and compares full-image MAD against `reference/lite/<scene-slug>/babylon-ref-golden.png`. Specifications 262, 263, 264, 277, 280, 281, 283, 284, and 305 invoke the shared golden-capture helper before opening the Lite page; specifications 276 and 302 read committed goldens directly. Scene 302's parity test must never navigate to its Babylon.js page at runtime. The pass criterion comes from `scene-config.json` and is `MAD <= 0.01` for all eleven scenes.

Scene 305 follows the runtime-capture group, not Scene 302's manual committed-only convention. It is a frozen, non-interactive fixture: its Lite camera intentionally has no controls import or attachment because the Babylon.js oracle also leaves its camera unattached. This does not establish a camera policy for other NPE scenes. Its shared graph retains Teleport fan-out and adds Elbow, Debug, and a Particle LocalVariable on the creation-only random-size path. The wrapped value, random consumption, and 200-step state are unchanged; a focused nonvisual test compares that full state to Scene 262 exactly. No Loop block is used. The existing golden and thumbnail are not modified locally; CI owns visual parity.

Scene 300 (`scene300-npe-sprite2d`) is a separate deterministic Lite-native integration fixture. It advances an authored NPE graph for 200 seeded ratio-1 steps, freezes simulation, registers the set through `registerNodeParticleSet2D`, and keeps the renderer hook sampling the stable packed layer. `scene-config.json` marks it `skipParity: true` because Babylon.js has no equivalent pure-2D SpriteRenderer path. Its Playwright specification verifies active binding state, live sampling, equal particle/layer counts, frozen particle age, one renderer layer, draw calls, and visible flare pixels; it does not use a Babylon golden or MAD comparison. The fixture uses a two-cell 128 by 64 atlas. Deterministic slot 0 is isolated as an unrotated 64 px marker sprite centered at canvas coordinates `(96,96)` on cell 1; an upper-versus-lower marker-band assertion detects vertical texture or UV inversion. `demo-npe-sprite2d` is the interactive counterpart and mutates the bridge origin from pointer/touch input while the renderer-managed simulation remains live.

Scene 301 (`scene301-npe-sprite2d-blend-modes`) is the deterministic Lite-native exact-blend integration fixture. It renders one mode-3 particle and one mode-4 particle side by side over the warm destination color from scenes 283/284, using the same procedural radial-alpha texture and tint. It builds both systems through ordinary `buildNodeParticleSet`, combines their mutable system arrays, and registers through `registerNodeParticleSet2DWithBlendModes`; the billboard enabler is not involved. Layer opacity is `0.75`, making the exact center equations observable:

```text
multiplySource = tint.rgb * 0.75 + white * 0.25
multiplyResult = destination.rgb * multiplySource
multiplyAddResult = multiplyResult + tint.rgb * 0.75
```

`scene-config.json` marks Scene 301 `skipParity: true` because Babylon.js has no pure-2D renderer. Its focused Playwright test checks ready/frozen state, one layer for Multiply, two ordered `[p4, p2]` layers for MultiplyAdd, three renderer layers/draws, both center pixels against the equations above, and transparent-edge pixels against the unchanged destination. It has no Babylon reference page and no PNG golden. Its gallery thumbnail is an exact 1280 by 720 JPG captured from the Lite fixture.

Scene 302 (`scene302-npe-moving-emitter`) is the Phase 2 moving-emitter visual and bundle fixture. Both engines parse one shared compact graph containing an `isLocal` SystemBlock, PointShapeBlock, UpdatePositionBlock, and contextual `LocalPositionUpdated` source `0x18`. They use the same generated 64 by 64 nearest-filtered radial RGBA texture, camera, clear color, seeded generator, 60 Hz step count, and looping XYZ-translation plus Z-rotation pose function. The graph has no external texture or network asset.

The default Lite URL is continuously live. A stable matrix is mutated in place by a `NodeParticleEmitterProvider`, and the set is built through `buildNodeParticleSet(..., withNodeParticleEmitterProvider(provider, options))`. `registerNodeParticleSet` owns automatic start, per-frame simulation, and ordinary 3D billboard synchronization. Camera controls remain attached. Telemetry publishes emitter X/Y/Z, Z angle, provider-call count, active-particle count, draw calls, ready state, and errors. The live Playwright test samples two frames, requires finite X/Y telemetry, angle and provider calls to change, active-particle count to be nonzero, and canvas pixels to be nonblank and changed; it does not open Babylon.js. X/Y use no strict per-axis inequality because either sinusoid can repeat at an extremum after floating-point rounding.

Any finite nonnegative `?seekTime=T` selects deterministic frozen mode. Both engines install the same seeded generator, apply the initial pose, and replay poses for steps `1...round(T * 60)` immediately before matching explicit simulation calls. For the committed capture `T=2`, this is exactly 120 calls. Lite manually calls `animateParticleSystem(system, 1)`, sets `updateSpeed = 0`, leaves the provider returning the final stable matrix, and registers with `autoStart: false`. Babylon.js assigns a hidden concrete `AbstractMesh` emitter to `set.systemBlocks[0].emitter` before `buildAsync`, updates its position and `rotation.z`, forces `computeWorldMatrix(true)`, and calls the real `ParticleSystem.animate(true)` path. Its native update therefore refreshes `_emitterWorldMatrix`; no particle position is emulated manually. Both pages stamp `data-animation-frozen="true"` only in seek mode.

The Babylon.js page is a manual golden oracle only. The committed `reference/lite/scene302-npe-moving-emitter/babylon-ref-golden.png` is captured once from `babylon-ref-scene302.html?seekTime=2`; the automated frozen test loads only `scene302.html?seekTime=2`, verifies telemetry, and compares the resulting canvas to that golden. The initial ceiling is `MAD <= 0.01`; changing it requires measured parity evidence and approval. Scene 302 itself adds no package API. Phase 3C adds no package-root API: the public count remains twenty-five functions and twelve types, and the current particle implementation counts are 11 root files, 18 node infrastructure files, and 39 block evaluator/helper files.

### 13.4 Bundle manifests and conditional content

Bundle output and per-scene manifests are generated and ignored. The table below is the historical Phase 3C measurement: its "Current" columns are Phase 3C totals, not the later flat-block-manifest totals, which the isolation rules below check per chunk instead of through a recorded size table. Before the conflict-driven upstream integration and renumber, one filtered build generated exactly scenes 262, 263, 264, 276, 277, 280, 281, 283, 284, 302, and the NPE graph-plumbing fixture now numbered 305. A detached same-environment build at reviewed Phase 3B checkpoint `37ac466e93b2842337248901955c4fc4b195096e` supplied the comparison totals:

| Scene | Current raw | Current gzip | Phase 3B raw | Phase 3B gzip |  Raw delta | Gzip delta | Ignored graph payload raw |   Ceiling |
| ----- | ----------: | -----------: | -----------: | ------------: | ---------: | ---------: | ------------------------: | --------: |
| 262   |  `40,849 B` |   `24,745 B` |   `40,849 B` |    `24,745 B` |      `0 B` |      `0 B` |                `29,222 B` | `44.1 KB` |
| 263   |  `42,984 B` |   `25,359 B` |   `42,984 B` |    `25,357 B` |      `0 B` |     `+2 B` |                `28,166 B` | `44.1 KB` |
| 264   |  `41,074 B` |   `26,599 B` |   `41,074 B` |    `26,596 B` |      `0 B` |     `+3 B` |                `35,205 B` | `44.1 KB` |
| 276   |  `45,241 B` |   `25,905 B` |   `45,241 B` |    `25,903 B` |      `0 B` |     `+2 B` |                `27,796 B` | `45.0 KB` |
| 277   |  `42,734 B` |   `25,930 B` |   `42,734 B` |    `25,926 B` |      `0 B` |     `+4 B` |                `30,538 B` | `45.0 KB` |
| 280   |  `42,466 B` |   `26,560 B` |   `42,466 B` |    `26,556 B` |      `0 B` |     `+4 B` |                `31,697 B` | `45.0 KB` |
| 281   |  `42,405 B` |   `26,751 B` |   `42,405 B` |    `26,745 B` |      `0 B` |     `+6 B` |                `32,909 B` | `45.0 KB` |
| 283   |  `42,563 B` |   `24,727 B` |   `42,563 B` |    `24,725 B` |      `0 B` |     `+2 B` |                `29,326 B` | `45.0 KB` |
| 284   |  `42,426 B` |   `24,672 B` |   `42,426 B` |    `24,669 B` |      `0 B` |     `+3 B` |                `29,326 B` | `45.0 KB` |
| 302   |  `56,705 B` |   `22,761 B` |   `56,683 B` |    `22,761 B` |    `+22 B` |      `0 B` |                     `0 B` | `61.5 KB` |
| 305   |  `44,827 B` |   `27,356 B` |   `41,012 B` |    `25,906 B` | `+3,815 B` | `+1,450 B` |                `32,250 B` | `45.0 KB` |

Scenes 262, 263, 264, 276, 277, 280, 281, 283, and 284 are raw-byte identical to Phase 3B and fetch neither graph-plumbing module nor the LocalVariable evaluator. Scene 302 is `22` raw bytes larger, remains below ceiling, is gzip-identical, and fetches no graph/local module. Its fetched provider, particle-system, and builder runtime sources are unchanged from Phase 3B; the only shared source delta is an erased internal build-state type field. The raw movement is therefore build-wide error-code/minifier allocation drift rather than retained Phase 3C behavior. No compensating runtime code is added for that incidental movement. The `2` to `6` gzip-byte movements on otherwise raw-identical scenes likewise do not weaken the runtime-module isolation criterion.

Scene 305 fetches the thin helper, heavy runtime, and LocalVariable block module as required. It intentionally fetches no `arc-rotate-controls` chunk or module because this frozen fixture mirrors the non-interactive Babylon.js oracle. Its checked-in graph is named `scene305-teleport-npe.ts`, following the standard `*-npe.ts` convention so bundle accounting excludes graph payload rather than charging it as engine runtime. After merging current upstream and moving the fixture from Scene 304 to Scene 305, a focused build measures `42,077` raw bytes and `26.4 KB` gzip, leaving `4,003` bytes below the approved `45.0 KB` (`46,080` byte) ceiling. The historical table retains the same-environment Phase 3B/3C comparison rather than mixing in unrelated upstream runtime reductions.

The Phase 3B run originally measured `43,936` raw bytes while the same 2,924-byte Scene 305 graph payload had a noncanonical filename and was counted. The comparison column subtracts that payload from the Phase 3B raw result as well (`43,936 - 2,924 = 41,012`) so the `+3,815` raw delta remains an honest engine/runtime comparison. Gzip subsets cannot be removed from a mixed chunk, so the measured gzip values remain unadjusted.

Local `*-npe.ts` graph payload modules are excluded from engine runtime-byte accounting and appear in ignored bytes. The general bundle-size specification identifies scene ids 262, 263, 264, 276, 277, 280, 281, 283, 284, 300, 301, 302, and 305 as sprite users. Scenes 262 through 284, 302, and 305 in that list render through billboard sprite modules. Scene 300 requires `particle-sprite-2d.ts` and `sprite-renderer.ts` while rejecting the exact Sprite2D module, custom-shader path, particle billboard, particle scene-registration, depth-hosted Sprite2D, and billboard rendering paths. Scene 301 requires `particle-sprite-2d-blend-modes.ts`, `particle-blend.ts`, `sprite-custom-shader.ts`, and `sprite-renderer.ts` while rejecting `particle-billboard-renderable.ts`, `particle-billboard-scene.ts`, and the scene-rendered sprite path. Representative unrelated Sprite2D scene 50 also rejects every particle exact-blend and custom-shader module. CI-published baselines and generated bundle-info are comparison inputs, and no per-scene manifest is committed.

Scene 302 is the positive moving-emitter bundle fixture. Its fetched module list must contain `npe-emitter-provider.ts`, `invert-mat4-to-ref-or-identity.ts`, `particle-scene.ts`, `particle-billboard.ts`, `billboard-scene.ts`, and `billboard-renderable.ts`. It must not contain the deleted `npe-live-emitter.ts`, ordinary allocating `invert-mat4.ts`, `npe-texture-content.ts`, the flow-map and noise update blocks, advanced particle blend modules, either graph-plumbing module, or either Sprite2D bridge/render path. The final filtered build measures `56,705` raw bytes (`55.4 KB`) and `22,761` gzip bytes (`22.2 KB`). The shared fixture and scene entry do not match the `*-npe.ts` payload exclusion and are intentionally counted, so this measurement is conservative and not directly comparable to sibling payload-excluded scenes.

The particle bundle-content test applies one table-driven unused-feature rule to the nine canonical billboard parity scenes. Every block class is its own lazy chunk, so a canonical scene that fetches an optional block or helper its graph does not use is a tree-shaking leak. The `OPTIONAL_FEATURES` table pairs each optional pattern with the scenes allowed to fetch it:

| Optional chunk or module pattern                                                                                                                                                                                                                                                                                                                                      | Allowed canonical scenes     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `particle-blend`, `particle-billboard-renderable`, `particle-billboard-scene`, `npe-blend-modes`                                                                                                                                                                                                                                                                      | 283, 284                     |
| `update-attractor-block`                                                                                                                                                                                                                                                                                                                                              | 277                          |
| `update-flow-map-block`                                                                                                                                                                                                                                                                                                                                               | 280                          |
| `update-noise-block`                                                                                                                                                                                                                                                                                                                                                  | 281                          |
| `npe-texture-content`                                                                                                                                                                                                                                                                                                                                                 | 280, 281                     |
| `npe-manifest-extra` (extension table)                                                                                                                                                                                                                                                                                                                                | 263, 264, 276, 277, 280, 281 |
| UpdateDirection and UpdateAngle blocks; `npe-contextual-extra`, emitter provider, graph plumbing, live emitter, and local position; typed once-random; random sprite columns; Condition, FloatToInt, LocalVariable, VectorLength, and local-position input modules; every local shape body; the Point, Cone, Cylinder, and Mesh shape blocks; and `math/invert-mat4*` | none                         |

Each canonical scene must have a nonempty runtime chunk list, and every fetched chunk name is checked against the table. Scene 277 must fetch `update-attractor-block`, scene 280 must fetch `update-flow-map-block` and `npe-texture-content`, and scene 281 must fetch `update-noise-block` and `npe-texture-content`. These required features are matched against the module ids inside the fetched runtime chunks when bundle-info exists, because a valid build may fold a required module into another fetched chunk; without bundle-info the check falls back to chunk names. A pure-helper test proves the table accepts an allowed feature chunk and rejects every other optional chunk.

Scenes 1 and 12 are non-particle glTF controls. When their manifests exist, each must record a nonempty runtime chunk list, fetch no chunk named `npe-manifest`, and, when bundle-info exists, fetch neither `npe-manifest.ts` nor `npe-manifest-extra.ts`.

When `lab/public/bundle/bundle-info/sceneN.json` exists, the same test also applies the table to every `particle/` and `math/` module inside the scene's fetched runtime chunks, so a feature folded into a shared chunk is still rejected. It requires scenes 283 and 284 to fetch `particle-blend`, `npe-blend-modes`, `particle-billboard-scene`, and `particle-billboard-renderable`, whether Rollup emits named chunks or folds them into the scene entry. When bundle-info is absent, this module-level branch is skipped while the runtime-chunk assertions still run.

`npe-emitter-provider.ts` is optional content. A separate provider-isolation check requires a nonempty runtime chunk list for scene 12 and every configured particle scene. When bundle-info exists, scene 302 must fetch the provider module. Scene 12 and every other configured particle scene (262, 263, 264, 276, 277, 280, 281, 283, 284, 300, and 301) reject both provider and live-emitter module/chunk names. Filtered bundle builds and the authoritative Bundle Size job measure actual output; generated runtime chunk manifests, fetched-module checks, and provider isolation are the regression guards, without a unit assertion that compares a manifest byte value to a duplicated constant.

Phase 3 bundle guards filter generated bundle-info through each scene's `runtimeChunks`, because Vite may build a lazy runtime chunk without fetching it. Existing canonical direct scenes and Scene 302 reject both `npe-graph-plumbing.ts` and `npe-graph-plumbing-runtime.ts`, plus `particle-local-variable-block.ts`; Scene 305 requires all three while rejecting `arc-rotate-controls`, the provider, `npe-texture-content`, the flow-map and noise update blocks, exact-blend, and Sprite2D modules. A source guard also rejects any Scene 305 `attachControl` import or call. The detached malformed unit fixture proves marked shared block/root storage and build success but deliberately makes no false no-import assertion after an explicit helper hit. No existing lab scene uses `parseNodeParticleSetFromSnippet`, so no representative snippet scene is added to the filtered bundle list; inline/network unit coverage and the helper's dynamic-import source guard cover that boundary. No bundle may contain a Teleport, Elbow, or Debug evaluator module because those files do not exist.

The parser, builder, and block manifest contain no graph-plumbing source. The thin helper is retained only by an explicit helper/snippet import; the heavy runtime is reached only by its dynamic import after a candidate hit. Against the exact Phase 3B raw totals, all nine canonical direct graph scenes moved by `0 B` and fetched neither graph-plumbing module nor the local evaluator. Scene 305 fetches the thin helper, heavy runtime, and LocalVariable block module, fetches no camera controls, and remains below its approved `45.0 KB` ceiling after excluding checked-in `*-npe.ts` graph payloads.

The provider implementation is synchronous because its public options helper must install the callback before a builder starts. Tree shaking removes the entire module, including its matrix validation and inverse-refresh dependencies, from non-provider scenes.

The Sprite2D blend loop for scenes 50, 300, and 301 requires the exact Sprite2D blend modules only in scene 301 and rejects them in the other two.

### 13.5 Multiply blend parity scene

Scene 283 (`scene283-npe-multiply-blend`) is the dedicated Babylon.js/Lite oracle for particle blend mode `3`. Both engines parse the same graph derived from scene 262 with these changes:

- `SystemBlock.blendMode = 3`, capacity `64`, update speed `0.05`, and emit rate `8`.
- Emit power and direction are zero, so particles remain at their creation positions.
- The emit box is `[-3, -1.65, 0]` to `[3, 1.65, 0]`. Paired with the tripled camera radius, this preserves the field's screen-space extent while reducing each sprite's projected size to one third and limiting overlapping Multiply passes.
- Lifetime is fixed at `10`, size is fixed at `0.8`, and creation/dead color is fixed at `[0.3, 0.8, 0.45, 1]`.
- Both engines create the same 32 by 32 nearest-filtered procedural RGBA texture. RGB is white; alpha has a fully opaque radial core, fades through deterministic 8-bit values, and is zero at the outer texels. This exercises the Multiply fragment's interpolation toward white from texture alpha without network or decoder differences.
- The clear color is `[0.65, 0.45, 0.25, 1]`. Fully transparent flare texels must leave this destination unchanged, while covered texels must darken and tint it. An additive fallback therefore produces an obvious full-image difference.
- Both engines install the deterministic sine-based random generator, start the system, and execute exactly 40 ratio-1 simulation steps. This creates 16 stationary particles. Lite builds the set through `buildNodeParticleSetWithBlendModes`; both engines then set `updateSpeed = 0`, and Lite registers the enriched set through `registerNodeParticleSet(..., { autoStart: false })`.
- The camera uses alpha `-pi/2`, beta `pi/2`, radius `12`, target origin, near plane `0.1`, and far plane `100`.

The parity specification refreshes `reference/lite/scene283-npe-multiply-blend/babylon-ref-golden.png` from the Babylon.js WebGPU reference page, captures the frozen Lite canvas, and requires full-image `MAD <= 0.01`. The bundle scene must fetch the optional particle Multiply renderable and stay within its scene-configured raw-byte ceiling.

Appending `?live` to either scene-283 page selects a non-parity inspection mode. Both engines parse the same live graph variant: emit power is fixed at `1`, direction is fixed at `[0, 0.6, 0]`, and all other blend, texture, lifetime, size, color, and emitter-box settings remain unchanged. The seeded generator is installed before start, but neither engine pre-steps or freezes the system. Babylon.js leaves its native particle system running; Lite's explicit blend-mode builder has installed the advanced registrar, so `registerNodeParticleSet` advances, synchronizes, and renders the system from the scene's frame delta. Both pages set `data-ready="true"` after their first rendered frame but omit `data-animation-frozen`, so they remain visibly animated for side-by-side local inspection.

### 13.6 MultiplyAdd blend parity scene

Scene 284 (`scene284-npe-multiply-add-blend`) is the isolated Babylon.js/Lite oracle for particle blend mode `4`. It reuses scene 283's procedural texture, warm clear color, camera, emitter box, fixed lifetime/size/color, and zero-motion graph, with these differences:

- `SystemBlock.blendMode = 4` selects Multiply followed by Add.
- Both engines execute exactly 20 ratio-1 simulation steps, creating eight stationary particles. The sparse field contains one overlap pair, enough to verify ordered two-pass composition without accumulating the cross-GPU blend variance of a dense field.
- Lite builds with `buildNodeParticleSet`, applies `enableNodeParticleBlendModes(set)`, mutates no evaluator state, and registers through `registerNodeParticleSet(..., { autoStart: false })`. This proves the enabler composes with an independently produced set.
- The parity specification refreshes `reference/lite/scene284-npe-multiply-add-blend/babylon-ref-golden.png`, captures Lite, and requires full-image `MAD <= 0.01`. Initial local MAD is `0.00044`.
- The production bundle must fetch all four optional blend modules and stay within `45.0 KB` raw.

## 14. Exact file manifest

### 14.1 Particle root: 11 files

```text
packages/babylon-lite/src/particle/particle-billboard.ts
packages/babylon-lite/src/particle/particle-billboard-renderable.ts
packages/babylon-lite/src/particle/particle-billboard-scene.ts
packages/babylon-lite/src/particle/particle-blend.ts
packages/babylon-lite/src/particle/particle-buffer.ts
packages/babylon-lite/src/particle/particle-scene.ts
packages/babylon-lite/src/particle/particle-sprite-2d.ts
packages/babylon-lite/src/particle/particle-sprite-2d-blend-modes.ts
packages/babylon-lite/src/particle/particle-system.ts
packages/babylon-lite/src/particle/sprite-columns-random.ts
packages/babylon-lite/src/particle/sprite-columns.ts
```

### 14.2 Node infrastructure: 19 files

```text
packages/babylon-lite/src/particle/node/node-particle.ts
packages/babylon-lite/src/particle/node/npe-blend-modes.ts
packages/babylon-lite/src/particle/node/npe-build.ts
packages/babylon-lite/src/particle/node/npe-contextual-extra.ts
packages/babylon-lite/src/particle/node/npe-contextual.ts
packages/babylon-lite/src/particle/node/npe-emitter-provider.ts
packages/babylon-lite/src/particle/node/npe-flow-map.ts
packages/babylon-lite/src/particle/node/npe-graph-plumbing-runtime.ts
packages/babylon-lite/src/particle/node/npe-graph-plumbing.ts
packages/babylon-lite/src/particle/node/npe-local-position.ts
packages/babylon-lite/src/particle/node/npe-manifest-extra.ts
packages/babylon-lite/src/particle/node/npe-manifest.ts
packages/babylon-lite/src/particle/node/npe-noise.ts
packages/babylon-lite/src/particle/node/npe-parser.ts
packages/babylon-lite/src/particle/node/npe-snippet.ts
packages/babylon-lite/src/particle/node/npe-texture-content.ts
packages/babylon-lite/src/particle/node/npe-texture-updates.ts
packages/babylon-lite/src/particle/node/npe-types.ts
packages/babylon-lite/src/particle/node/npe-value.ts
```

The block manifest replaced the eight `npe-registry*.ts` tiers and the flow-map, noise, and texture-update runtime modules with `npe-manifest.ts` and its single extension table `npe-manifest-extra.ts`. `npe-flow-map.ts`, `npe-noise.ts`, and `npe-texture-updates.ts` remain only as `@deprecated` builder aliases.

### 14.3 Block evaluators and helpers: 39 files

Thirty files are manifest block modules that export `npeBlock`. The other nine are lazy block-local paths: six `*-shape-local.ts` bodies, `particle-input-local-position.ts`, `particle-random-once.ts`, and `particle-random-once-typed.ts`. The block manifest removed the old variant and wrapper modules: compact math, CPU and embedded texture sources, dynamic emit rate, the extra and local input variants, random-sprite setup, the once-random wrapper blocks, and the `*-shape-local-block.ts` wrappers.

```text
packages/babylon-lite/src/particle/node/blocks/basic-sprite-update-block.ts
packages/babylon-lite/src/particle/node/blocks/box-shape-block.ts
packages/babylon-lite/src/particle/node/blocks/box-shape-local.ts
packages/babylon-lite/src/particle/node/blocks/cone-shape-block.ts
packages/babylon-lite/src/particle/node/blocks/cone-shape-local.ts
packages/babylon-lite/src/particle/node/blocks/create-particle-block.ts
packages/babylon-lite/src/particle/node/blocks/cylinder-shape-block.ts
packages/babylon-lite/src/particle/node/blocks/cylinder-shape-local.ts
packages/babylon-lite/src/particle/node/blocks/mesh-shape-block.ts
packages/babylon-lite/src/particle/node/blocks/mesh-shape-local.ts
packages/babylon-lite/src/particle/node/blocks/particle-condition-block.ts
packages/babylon-lite/src/particle/node/blocks/particle-converter-block.ts
packages/babylon-lite/src/particle/node/blocks/particle-float-to-int-block.ts
packages/babylon-lite/src/particle/node/blocks/particle-gradient-block.ts
packages/babylon-lite/src/particle/node/blocks/particle-gradient-value-block.ts
packages/babylon-lite/src/particle/node/blocks/particle-input-block.ts
packages/babylon-lite/src/particle/node/blocks/particle-input-local-position.ts
packages/babylon-lite/src/particle/node/blocks/particle-lerp-block.ts
packages/babylon-lite/src/particle/node/blocks/particle-local-variable-block.ts
packages/babylon-lite/src/particle/node/blocks/particle-math-block.ts
packages/babylon-lite/src/particle/node/blocks/particle-random-block.ts
packages/babylon-lite/src/particle/node/blocks/particle-random-once-typed.ts
packages/babylon-lite/src/particle/node/blocks/particle-random-once.ts
packages/babylon-lite/src/particle/node/blocks/particle-vector-length-block.ts
packages/babylon-lite/src/particle/node/blocks/point-shape-block.ts
packages/babylon-lite/src/particle/node/blocks/point-shape-local.ts
packages/babylon-lite/src/particle/node/blocks/setup-sprite-sheet-block.ts
packages/babylon-lite/src/particle/node/blocks/sphere-shape-block.ts
packages/babylon-lite/src/particle/node/blocks/sphere-shape-local.ts
packages/babylon-lite/src/particle/node/blocks/system-block.ts
packages/babylon-lite/src/particle/node/blocks/texture-source-block.ts
packages/babylon-lite/src/particle/node/blocks/update-angle-block.ts
packages/babylon-lite/src/particle/node/blocks/update-attractor-block.ts
packages/babylon-lite/src/particle/node/blocks/update-color-block.ts
packages/babylon-lite/src/particle/node/blocks/update-direction-block.ts
packages/babylon-lite/src/particle/node/blocks/update-flow-map-block.ts
packages/babylon-lite/src/particle/node/blocks/update-noise-block.ts
packages/babylon-lite/src/particle/node/blocks/update-position-block.ts
packages/babylon-lite/src/particle/node/blocks/update-size-block.ts
```

TeleportIn, TeleportOut, Elbow, and Debug add no evaluator files. Frame-preparation composition remains a function in existing `particle-system.ts`, so section 14.1 stays at 11 root files.

### 14.4 Direct integration dependencies

These files are imported directly by particle source files or define the package-root exports:

```text
packages/babylon-lite/src/camera/camera.ts
packages/babylon-lite/src/engine/engine.ts
packages/babylon-lite/src/math/_matrix-allocator.ts
packages/babylon-lite/src/math/create-identity-mat4.ts
packages/babylon-lite/src/math/invert-mat4.ts
packages/babylon-lite/src/math/invert-mat4-to-ref-or-identity.ts
packages/babylon-lite/src/math/mat4-transform.ts
packages/babylon-lite/src/math/create-translation-mat4.ts
packages/babylon-lite/src/math/random-range.ts
packages/babylon-lite/src/math/types.ts
packages/babylon-lite/src/scene/scene-core.ts
packages/babylon-lite/src/scene/scene.ts
packages/babylon-lite/src/sprite/billboard-blend.ts
packages/babylon-lite/src/sprite/billboard-scene.ts
packages/babylon-lite/src/sprite/billboard-sprite.ts
packages/babylon-lite/src/sprite/shared/sprite-atlas.ts
packages/babylon-lite/src/sprite/sprite-2d.ts
packages/babylon-lite/src/sprite/sprite-blend.ts
packages/babylon-lite/src/sprite/sprite-custom-shader.ts
packages/babylon-lite/src/sprite/sprite-renderer.ts
packages/babylon-lite/src/texture/texture-2d.ts
packages/babylon-lite/src/index.ts
```

The billboard subsystem owns its additional rendering, picking, GPU, and blend-descriptor dependencies. The Sprite2D subsystem owns its packed layer layout, dirty tracking, renderer, GPU upload, and blend descriptors. They are outside the particle implementation boundary; the particle package owns only conversion and registration policy.

### 14.5 Scene and configuration anchors

```text
demos-config.json
scene-config.json
lab/lite/src/demos/npe-sprite2d.ts
lab/lite/src/lite/scene262.ts
lab/lite/src/lite/scene263.ts
lab/lite/src/lite/scene264.ts
lab/lite/src/lite/scene276.ts
lab/lite/src/lite/scene277.ts
lab/lite/src/lite/scene280.ts
lab/lite/src/lite/scene281.ts
lab/lite/src/lite/scene283.ts
lab/lite/src/lite/scene284.ts
lab/lite/src/lite/scene300.ts
lab/lite/src/lite/scene301.ts
lab/lite/src/lite/scene302.ts
lab/lite/src/lite/scene305.ts
lab/lite/src/bjs/scene302.ts
lab/lite/src/bjs/scene305.ts
lab/lite/src/shared/scene262-npe.ts
lab/lite/src/shared/scene263-npe.ts
lab/lite/src/shared/scene264-npe.ts
lab/lite/src/shared/scene276-npe.ts
lab/lite/src/shared/scene277-npe.ts
lab/lite/src/shared/scene280-npe.ts
lab/lite/src/shared/scene281-npe.ts
lab/lite/src/shared/scene283-npe-multiply-blend.ts
lab/lite/src/shared/scene284-npe-multiply-add-blend.ts
lab/lite/src/shared/scene302-npe-moving-emitter.ts
lab/lite/src/shared/scene305-teleport-npe.ts
lab/lite/src/shared/npe-sprite2d-fixture.ts
lab/public/thumbnails/scene301.jpg
lab/public/thumbnails/scene302.jpg
lab/public/thumbnails/scene305.jpg
lab/lite/bundle-scene301.html
lab/lite/scene301.html
lab/lite/babylon-ref-scene302.html
lab/lite/bundle-scene302.html
lab/lite/scene302.html
lab/lite/babylon-ref-scene305.html
lab/lite/bundle-scene305.html
lab/lite/scene305.html
reference/lite/scene302-npe-moving-emitter/babylon-ref-golden.png
reference/lite/scene305-npe-teleport/babylon-ref-golden.png
tests/lite/parity/scenes/scene262-npe-size.spec.ts
tests/lite/parity/scenes/scene263-npe-sphere.spec.ts
tests/lite/parity/scenes/scene264-npe-change-size.spec.ts
tests/lite/parity/scenes/scene276-npe-animations.spec.ts
tests/lite/parity/scenes/scene277-npe-attractor.spec.ts
tests/lite/parity/scenes/scene280-npe-flow-map.spec.ts
tests/lite/parity/scenes/scene281-npe-noise-texture.spec.ts
tests/lite/parity/scenes/scene283-npe-multiply-blend.spec.ts
tests/lite/parity/scenes/scene284-npe-multiply-add-blend.spec.ts
tests/lite/parity/scenes/scene300-npe-sprite2d.spec.ts
tests/lite/parity/scenes/scene301-npe-sprite2d-blend-modes.spec.ts
tests/lite/parity/scenes/scene302-npe-moving-emitter.spec.ts
tests/lite/parity/scenes/scene305-npe-teleport.spec.ts
tests/lite/parity/bundle-size.spec.ts
tests/lite/unit/npe-particle-flow-map.test.ts
tests/lite/unit/npe-particle-noise-texture.test.ts
tests/lite/unit/npe-particle-bundle-content.test.ts
tests/lite/unit/npe-particle-305-graph.test.ts
tests/lite/unit/npe-particle-graph-plumbing.test.ts
tests/lite/unit/npe-particle-graph-plumbing-phase3c.test.ts
tests/lite/unit/npe-particle-local-variable.test.ts
tests/lite/unit/npe-particle-moving-emitter.test.ts
tests/lite/unit/particle-sprite-2d.test.ts
tests/lite/unit/particle-sprite-2d-blend-modes.test.ts
```
