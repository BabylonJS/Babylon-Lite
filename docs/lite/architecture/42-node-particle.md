# Module: Node Particles (NPE)

> Package path: `packages/babylon-lite/src/particle/`
>
> This document specifies the complete node-particle feature. It is sufficient to recreate the parser, graph builder, CPU simulation, feature storage, sprite-sheet support, billboard synchronization, and scene registration.

## 1. Scope and goals

The feature executes serialized Node Particle Editor graphs on the CPU. Its compatibility boundary is the set of NPE blocks and serialized values listed here, not the full classic `ParticleSystem` surface.

The design requirements are:

- CPU NPE graphs only. There is no GPU particle simulation path.
- `ParticleSystem` is mutable pure state. Behavior is supplied by standalone functions. The public surface is imperative through functions such as `startParticleSystem`, `stopParticleSystem`, and `animateParticleSystem`; it does not expose a Babylon-style particle constructor or attached particle-system methods.
- Particle attributes use Struct-of-Arrays storage. A particle is an integer slot, not an allocated particle value.
- Simulation order, random-number consumption, numeric storage, and lifecycle boundaries follow the Babylon.js compatibility contract and are verified against Babylon.js as the equivalence oracle.
- Rendering always uses camera-facing billboard sprites.
- Code and optional storage are pay-for-use. Reachable block evaluators are dynamically imported, and optional feature columns are allocated only by features that need them. Every buffer contains the base simulation and standard NPE render/lifecycle columns described in section 4.
- The indexed simulation path does not allocate per particle or per update. Graph getters return scalars or reused scratch values. Billboard synchronization does allocate transient values for each live particle.

## 2. Package-root API

`packages/babylon-lite/src/index.ts` exports exactly ten node-particle functions and five node-particle types.

### 2.1 Functions

```ts
function parseNodeParticleSource(source: unknown): ParticleGraph;

function buildNodeParticleSet(engine: EngineContext, scene: SceneContext, graph: ParticleGraph, options?: BuildNodeParticleOptions): Promise<NodeParticleSet>;

function parseNodeParticleSetFromSnippet(engine: EngineContext, scene: SceneContext, snippetId: string, options?: ParseNodeParticleOptions): Promise<NodeParticleSet>;

function startParticleSystem(system: ParticleSystem): void;
function stopParticleSystem(system: ParticleSystem): void;
function prepareParticleSystemFrame(system: ParticleSystem, camera: Camera | null | undefined, targetWidth: number, targetHeight: number): void;
function animateParticleSystem(system: ParticleSystem, scaledRatio: number): void;

function createParticleBillboard(system: ParticleSystem): FacingBillboardSpriteSystem;
function syncParticleBillboard(system: ParticleSystem, billboard: FacingBillboardSpriteSystem): void;

function registerNodeParticleSet(scene: SceneContext, set: NodeParticleSet, options?: RegisterNodeParticleOptions): void;
```

`ParticleGraph` is the return and input type of two public functions, but it is not a named node-particle type export from the package root.

### 2.2 Types

```ts
interface BuildNodeParticleOptions {
    emitter?: Vec3;
    emitterWorldMatrix?: Mat4;
    textureBaseUrl?: string;
}

interface ParseNodeParticleOptions {
    json?: string | object;
    snippetServer?: string;
    emitter?: Vec3;
    emitterWorldMatrix?: Mat4;
    textureBaseUrl?: string;
}

interface NodeParticleSet {
    readonly systems: ParticleSystem[];
    /** @internal */
    _graph: ParticleGraph;
}

interface RegisterNodeParticleOptions {
    autoStart?: boolean;
}
```

`ParticleSystem` is the fifth exported type and is specified in section 5. `NodeParticleSet.systems` is a mutable array behind a readonly property, and each system and its typed arrays are mutable.

### 2.3 Internal APIs

The following symbols are implementation APIs and are not node-particle package-root exports:

- Graph types: `ParticleGraph`, `ParsedParticleBlock`, and `ParsedParticleInput`.
- Build types: `NpeBuildState`, `NpeBuildContext`, and `NpeBlockEvaluator`.
- Value types: `NpeValue`, `NpeGraphValue`, `NpeTextureValue`, `NpeTextureContent`, `NpeGetter`, `ScalarGetter`, `Vec3Getter`, `Color4Getter`, and `ParticleStep`.
- Storage types and functions: `ParticleColumn`, `ParticleBuffer`, `createParticleBuffer`, `column`, `spawnParticle`, and `killParticle`.
- Runtime construction: `ParticleSpriteHandle` and `createParticleSystem`.
- Sprite features: `SpriteSheetConfig`, `SpriteSheet`, `useSpriteSheet`, and `useRandomSpriteSheet`.
- Snippet transport: `fetchNodeParticleSnippet`.
- Contextual factories, local-position helpers, evaluator values, and registry loaders.

## 3. Modules, ownership, and data flow

The data flow is:

```text
serialized value or snippet response
    -> parseNodeParticleSource
    -> ParticleGraph
    -> buildNodeParticleSet
    -> NodeParticleSet { systems }
    -> startParticleSystem / stopParticleSystem / prepareParticleSystemFrame / animateParticleSystem
    -> createParticleBillboard + syncParticleBillboard
    -> addFacingBillboardSystem or registerNodeParticleSet
```

The runtime layers are:

```text
particle-buffer.ts       dense typed-array storage and slot lifecycle
particle-system.ts       mutable system state and CPU simulation
sprite-columns*.ts       optional sprite cell state and animation
particle-billboard.ts    conversion of live columns to billboard instances
particle-scene.ts        scene registration and per-frame callback wiring

node/npe-parser.ts       serialized source normalization
node/npe-types.ts        readonly TypeScript graph shapes
node/npe-build.ts        root-reachable DFS and system construction
node/npe-value.ts        indexed getter and step contracts
node/npe-texture-content.ts
                         pay-for-use CPU RGBA texture decoding
node/npe-contextual*.ts  contextual source getters and optional columns
node/npe-local-position.ts
                         local birth seeding and world-position conversion
node/npe-registry*.ts    side-effect-free dynamic evaluator dispatch
node/blocks/*.ts         supported block classes, variants, and helpers
```

The particle package owns no shader, material, render pipeline, bind group, or GPU instance-buffer implementation. `particle-billboard.ts` produces a `FacingBillboardSpriteSystem`; the billboard subsystem owns atlas interpretation, pipeline selection, GPU data, picking registration, and renderable construction.

### 3.1 Direct dependencies outside `particle/`

- Camera: `camera/camera.ts`.
- Engine type: `engine/engine.ts`.
- Math: `math/types.ts`, `math/random-range.ts`, `math/mat4-identity.ts`, `math/mat4-invert.ts`, `math/mat4-transform.ts`, and `math/mat4-translation.ts`.
- Scene: `scene/scene.ts` and `scene/scene-core.ts`.
- Texture: `texture/texture-2d.ts`.
- Sprite: `sprite/shared/sprite-atlas.ts`, `sprite/billboard-sprite.ts`, `sprite/billboard-blend.ts`, and `sprite/billboard-scene.ts`.

`billboard-scene.ts` registers the billboard as a scene-owned deferred renderable and pick source. It dynamically imports `sprite/billboard-renderable.ts` when scene renderables are built and `picking/billboard-pick-pipeline.ts` when picking first needs that source.

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
| `angle`                                                | `Float32Array` | billboard rotation             |
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

`CreateParticleBlock` initializes these fields for each birth, contextual and update blocks read or modify them, and `syncParticleBillboard` reads the render subset directly. They are part of every buffer because the primary runtime contract is a renderable NPE particle system.

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
    _spriteSheet?: ParticleSpriteHandle;
    _writeColorDead?: (i: number, color: Color4) => void;
    _suppressInitialDirectionCapture?: boolean;
    _seedLocalPosition?: ParticleStep;
    _frameSteps?: Array<(camera: Camera | null | undefined, targetWidth: number, targetHeight: number) => void>;
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

### 5.3 Frame preparation

`prepareParticleSystemFrame(system, camera, targetWidth, targetHeight)` returns immediately when `_frameSteps` is absent. Otherwise it normalizes each non-finite or non-positive dimension to `1`, clamps positive fractional dimensions to at least `1`, then invokes every frame step in array order with the camera and safe dimensions. The function does not retain the scene or camera. Features copy or reference only the derived state they need for subsequent particle updates.

Live registration calls frame preparation once immediately before each animation call. Manual simulation that uses a camera-dependent block calls it explicitly whenever the camera or target size changes. A static frozen simulation may call it once before its step loop.

### 5.4 One animation call

`animateParticleSystem(system, scaledRatio)` returns immediately when `_started` is false. Otherwise it performs these operations in this exact order:

1. Compute `scaledUpdateSpeed = updateSpeed * scaledRatio` and assign it to `_scaledUpdateSpeed`.
2. Evaluate `_emitRateGetter()` when present; otherwise read `emitRate`. A connected getter observes the current `_actualFrame` before this call advances it.
3. Compute `emission = emitRate * scaledUpdateSpeed` and `newParticles = emission >> 0`.
4. Add `emission - newParticles` to `_newPartsExcess`. Only when `_newPartsExcess > 1.0`, take `extra = _newPartsExcess >> 0`, add `extra` to `newParticles`, and subtract `extra` from `_newPartsExcess`. Equality with `1.0` does not release a particle.
5. If `_stopped` was already true, set `newParticles = 0`. The rate getter and fractional-carry calculation have already run.
6. If `_stopped` was false, add `scaledUpdateSpeed` to `_actualFrame`. When `targetStopDuration` is truthy and `_actualFrame >= targetStopDuration`, call `stopParticleSystem`. The `newParticles` count computed for this call is retained, so the threshold call still creates its computed cohort.
7. Update all particles that were live at the start of the update loop.
8. Create up to `newParticles`, subject to capacity.

The `>> 0` operations use JavaScript signed 32-bit conversion. Rates, ratios, and speeds are not clamped or validated.

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
- `options.emitterWorldMatrix` has precedence over `options.emitter`. The matrix reference is retained, and its indices 12, 13, and 14 are copied into a fresh emitter `Vec3`.
- Without a matrix, the emitter option or `{ x: 0, y: 0, z: 0 }` is copied into the emitter value and a translation matrix.
- `scene` and `textureBaseUrl` are carried in `NpeBuildState`. The target block id of the root's `texture` input is stored as `billboardTextureBlockId`; this lets multiple texture-source blocks coexist without a flow-map source replacing the rendered billboard texture.
- Each root gets its own output map and built-id set.
- Build promises are accumulated for the whole set and awaited together after all roots have been traversed.

`CreateParticleBlock` does not create the system. `SystemBlock` does not set capacity or locality; the builder consumes those serialized fields before DFS.

### 7.2 Reachability and traversal

Only blocks reachable by following input connections from a root are built. Detached blocks load no evaluator and allocate no columns.

The asynchronous `buildBlock(id)` algorithm is exact:

1. Return when `id` is already in `built`.
2. Add `id` to `built` before map lookup.
3. Return when the map has no block for `id`.
4. Traverse every connected input named exactly `particle`, in serialized input order.
5. Traverse every other connected input, in serialized input order.
6. Select and dynamically import one evaluator.
7. Run `evaluator.build(block, ctx)`.

Marking before recursion terminates cycles. A cycle can still fail when an evaluator asks for an output that has not been installed.

An input is connected only when both `targetBlockId != null` and `targetConnectionName != null`. An empty connection-name string is connected. A target id without a connection name, or a connection name without a target id, is unconnected.

The output map key is `${blockId}:${connectionName}`. Getter outputs are:

- `output`: `ParticleInputBlock`, `ParticleRandomBlock`, `ParticleMathBlock`, `ParticleLerpBlock`, `ParticleGradientBlock`, `ParticleGradientValueBlock`, `ParticleConditionBlock`, `ParticleFloatToIntBlock`, and `ParticleVectorLengthBlock`.
- `color`, `xyz`, `xy`, `zw`, `x`, `y`, `z`, and `w`: `ParticleConverterBlock`.
- `texture`: `ParticleTextureSourceBlock`.

`SystemBlock`, `CreateParticleBlock`, all six shape classes, `SetupSpriteSheetBlock`, `BasicSpriteUpdateBlock`, and all seven update classes install no getter output. Their `particle` connections control reachability and ordering only. Update blocks do not publish flow outputs.

### 7.3 Input resolution and literals

`ctx.input(block, name, fallback)` finds the first input with that name.

- A connected input must find its exact output-map key. Otherwise the call throws `NodeParticle: unresolved connection <ClassName>.<inputName>`.
- An unconnected input with a parsed literal returns a closure over that literal.
- If there is no parsed literal, the supplied fallback is returned.
- Without a fallback, the getter returns `null` cast to the graph value type.

Literal parsing is:

- A numeric value, or a value tagged `number`, is accepted only when the runtime value is a number.
- `BABYLON.Vector2` arrays become `{ x: value[0] ?? 0, y: value[1] ?? 0 }`.
- `BABYLON.Vector3` arrays add `z: value[2] ?? 0`.
- `BABYLON.Color4` arrays become `{ r: value[0] ?? 0, g: value[1] ?? 0, b: value[2] ?? 0, a: value[3] ?? 1 }`.
- Other literal forms are ignored.

### 7.4 Lazy registry structure

Evaluators are not preloaded. Selection and dynamic import occur when DFS reaches each block.

- `npe-registry.ts` handles System, Create, Box, UpdatePosition, UpdateColor, TextureSource, Input, compact Math, Lerp, Converter, and ordinary Random.
- Shape names that miss the Box arm route to `npe-registry-extra-emitters.ts`, which handles Point, Sphere, Cone, Cylinder, and Mesh.
- `npe-registry-extra.ts` handles UpdateSize, Gradient, GradientValue, SetupSpriteSheet, and BasicSpriteUpdate.
- Its remaining route handles UpdateAttractor and UpdateFlowMap directly, sends other names beginning with `Particle` to `npe-registry-extra-values.ts` for Condition, FloatToInt, and VectorLength, and sends remaining names to `npe-registry-extra-basic.ts` for UpdateDirection and UpdateAngle.
- `npe-registry-local-shapes.ts` selects separate local implementations for all six shape classes when `state.isLocal` is true.
- `npe-registry-variants.ts` selects extra contextual Input, source `0x18` Input, alias-safe Math, typed OncePerParticle Random, dynamic-emit-rate System, and random-start SetupSpriteSheet evaluators.
- Scalar OncePerParticle Random imports its evaluator directly from the builder.

Variant selection uses serialized data and connection identity:

- Input uses a variant for every nonzero contextual source outside Position, Age, Lifetime, Color, ScaledDirection, and ScaledColorStep.
- Random lock mode `3` uses the scalar evaluator when the `min` or `max` value type selected by first availability is exactly `number`; all other tags use the typed evaluator.
- Math uses the alias-safe evaluator when left and right have equal target ids and equal target connection names, including two absent or equivalently unconnected targets.
- System uses the dynamic variant when `emitRate` is connected.
- SetupSpriteSheet uses the random variant only when `randomStartCell === true`.

### 7.5 Asynchronous texture work

Texture evaluators add promises to the shared build-promise array. The builder traverses every root, then awaits `Promise.all(buildPromises)`, and returns the set. It does not run a texture-resolution pass or call a `_resolveTexture` hook. The billboard texture source schedules its GPU upload, while UpdateFlowMap schedules CPU decoding of its connected source. Both must settle before the set is returned.

## 8. Values and sources

### 8.1 Getter contract

```ts
type NpeValue = number | Vec2 | Vec3 | Color4;
type NpeGraphValue = NpeValue | NpeTextureValue;
type NpeGetter<T extends NpeGraphValue = NpeValue> = (i: number) => T;
type ParticleStep = (i: number) => void;
```

Scalar getters return a number. Vector and color getters generally fill one value captured by the getter and return that same value on every call. Consumers copy components before invoking another volatile getter.

Texture connections carry one build-local value:

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

| Id  | Name    | Return                         |
| --- | ------- | ------------------------------ |
| `1` | Time    | `system._actualFrame`          |
| `2` | Delta   | `system._scaledUpdateSpeed`    |
| `3` | Emitter | the build-state emitter `Vec3` |

Other ids throw `NodeParticle: unsupported system source <decimal id>` during build.

Time has three observable phases in an animation call. A dynamic emit-rate getter sees the value before increment. Update steps and creation getters see the incremented value when the system was emitting at call entry. A call that was already stopped does not increment it.

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

Exactly 28 block class names are supported:

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
```

Local shape modules and serialized variants retain their class name from this list.

### 9.1 SystemBlock

The builder has created the system before this evaluator runs. The evaluator:

- Assigns `serialized.updateSpeed` only when it is a number.
- Assigns `serialized.blendMode` only when it is a number.
- For an unconnected `emitRate`, evaluates the input once at build with fallback `10` and assigns a numeric result.
- For a connected `emitRate`, the dynamic evaluator installs `_emitRateGetter`. Each call evaluates the graph at particle index `0` and returns its number result, or the system's constant `emitRate` when the result is not numeric. It is not evaluated during build.
- Evaluates `targetStopDuration` once at build with fallback `0` and assigns a numeric result.

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

For implicit direction, the evaluator computes `mat4Invert(emitterWorldMatrix)` once during build. A determinant magnitude below `1e-10` yields `null`, and the evaluator substitutes a new identity matrix. Per birth it:

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

### 9.11 ParticleRandomBlock

Defaults are `min = 0`, `max = 1`, and `lockMode = 1`. The draw function selects shape from the evaluated minimum, copies all minimum components, evaluates maximum, and computes `min + Math.random() * (max - min)` per component. It does not use `randomRange` and does not skip equal bounds. A mismatched maximum shape supplies zero for unavailable components.

Lock modes are:

| Mode                | Behavior                                                                                                                                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `0` None            | draw on every getter call                                                                                                                                                                                                      |
| `1` PerParticle     | hold one `stored` value and one `currentLockId`; draw when `buffer.id[i]` differs from the id used by the immediately cached value. Consecutive reads for the same id share the value, but an A-B-A access order draws A twice |
| `2` PerSystem       | use lock id `0`; the first getter call draws and all calls share that value                                                                                                                                                    |
| `3` OncePerParticle | use per-block typed-array id, valid, and Float64 component caches at particle slots; draw once for each particle id, including id zero and slot reuse                                                                          |

Mode 3 scalar results use `value0`. Typed mode uses two, three, or four value columns according to the serialized value type and returns a reused Vector2, Vector3, or Color4 scratch value. Numeric modes outside 0 through 3 reach the ordinary evaluator but never satisfy its draw condition, so the initialized stored scalar `0` is returned. The block installs `output`.

### 9.12 ParticleMathBlock

Operations are `0 Add`, `1 Subtract`, `2 Multiply`, `3 Divide`, `4 Max`, and `5 Min`; default is Add. An unsupported operation returns the left component. JavaScript division and `Math.max`/`Math.min` are used directly, with no finite or zero checks.

Two scalars produce a scalar. A scalar and Vector2, Vector3, or Color4 splat the scalar across the other shape. Two non-scalars use the left shape and operate component-wise.

The compact evaluator is selected when left and right do not reference the same source pair. It evaluates left and right, selects the non-scalar shape or left shape, and reads that shape's component properties directly. Graph type compatibility is assumed; incompatible shapes can supply `undefined` and produce `NaN`.

The alias-safe evaluator is selected when both inputs have equal target ids and equal target connection names. It evaluates left first and copies all non-scalar components before evaluating right. For a non-scalar left, a scalar right is splatted, a matching right supplies components, and an incompatible right supplies zero. Results use one reused scratch value per shape. Both variants install `output`.

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

The raw source is a nonempty string `serialized.textureDataUrl` when present, otherwise string `serialized.url`, otherwise the empty string. Explicit schemes are accepted only for `http`, `https`, `data`, and `blob`; an unsupported scheme produces an empty resolved URL. A source is absolute when it has an accepted scheme, starts with `//`, or starts with `/`. When a nonempty source is relative and `textureBaseUrl` exists, `new URL(rawUrl, base).href` resolves it.

`serialized.invertY` defaults to true by testing `!== false`. The block installs `texture`, returning one `NpeTextureValue` containing the resolved URL and block invert-Y value.

When the block id equals `NpeBuildState.billboardTextureBlockId`, it also schedules the GPU load. The texture loader receives the opposite value, `{ invertY: !blockInvertY }`. Other loader options retain `loadTexture2D` defaults: mipmaps enabled, repeat addressing on U and V, linear minification and magnification, non-sRGB storage, and no alpha premultiplication. The asynchronous result is stored on `system.texture`. Any rejection is caught and leaves the current texture unchanged, normally `null`.

Other texture sources do not load a GPU texture merely by being built. A CPU consumer such as UpdateFlowMap uses the output value and its own lazy decoder. A single source may feed both the system texture and a CPU consumer; the GPU load and shared CPU decode then both occur without either texture role replacing the other.

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

The ordinary variant allocates `sprite.cellIndex`. Birth writes `startCellID`. Update computes:

```text
distance = endCellID - startCellID + 1
progress = age * changeSpeed
ratio = loop
    ? clamp01((progress % lifeTime) / lifeTime)
    : clamp01(progress / lifeTime)
cellIndex = (startCellID + ratio * distance) | 0
```

`clamp01(value)` returns 0 below zero, 1 above one, and the input otherwise. Assignment to Uint16 applies Uint16 conversion.

The random-start variant also allocates `sprite.randomOffset`. Birth writes offset `-1` and the start cell. On an update with a negative offset, it writes `Math.random() * lifeTime`. With zero `changeSpeed`, progress is the offset; otherwise progress is `(age + offset) * changeSpeed`. Ratio and cell math then match the ordinary variant.

Both variants set `_spriteSheet` with cell dimensions, the cell array, and the update function. They capture the current `createColorDead` and assign a wrapper so sprite birth runs after that function when non-null; when it is null, sprite birth becomes the slot. They install no output getter.

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

Inputs are `particle`, `flowMap`, and `strength`; `strength` defaults to `1`. The block allocates no particle columns and appends one direction-only update step. `flowMap` accepts the `texture` output of a `ParticleTextureSourceBlock`. An absent or non-texture value leaves the update step installed with no loaded map, so it has no effect.

During build, the first CPU request for a texture value calls `loadNpeTextureContent`. It fetches the resolved URL and rejects a non-OK response, decodes an `ImageBitmap` with `premultiplyAlpha: "none"` and `colorSpaceConversion: "none"`, and draws it into an `OffscreenCanvas` when available or an HTML canvas otherwise. For `invertY === true`, the canvas transform vertically flips the bitmap before `getImageData`; false preserves source row order. The resulting `{ width, height, data: Uint8ClampedArray }` promise is cached on the texture value. The evaluator catches decode failures and retains a null map, making every update a no-op.

The block installs one optional frame step that derives the camera view-projection matrix with the effective viewport aspect, then copies all 16 components into an evaluator-owned matrix from `allocateMat4()`. Its storage therefore follows the process-wide F32/F64 matrix policy. It never retains `SceneContext`, `Camera`, or camera-owned matrix storage. A missing camera marks the prepared matrix unavailable. Width and height have already been clamped to at least `1` by `prepareParticleSystemFrame`, so aspect calculation cannot divide by a zero target height.

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

The block uses one reused screen-position scratch and allocates nothing per particle. It observes position and direction from earlier update steps; later steps observe its direction change. It does not integrate position. Local systems use the same evaluator and current stored position; there is no separate local flow-map variant.

### 9.25 UpdatePositionBlock

When `position` is connected, append an update step that evaluates a Vec3 and writes base position xyz. With an unconnected input, append nothing. No output getter is installed.

### 9.26 UpdateColorBlock

When `color` is connected, request the standard RGBA columns and append an update step that evaluates Color4 and writes all components. With an unconnected input, append nothing. No output getter is installed.

### 9.27 UpdateDirectionBlock

When `direction` is connected, append an update step that evaluates Vec3 and writes base direction xyz. With an unconnected input, append nothing. No output getter is installed.

### 9.28 UpdateAngleBlock

When `angle` is connected, request the standard angle column and append an update step that writes the scalar result. With an unconnected input, append nothing. No output getter is installed.

### 9.29 UpdateSizeBlock

When `size` is connected, request the standard size column and append an update step that writes the scalar result. With an unconnected input, append nothing. No output getter is installed.

## 10. Rendering and live registration

### 10.1 Billboard creation

`createParticleBillboard` requires `system.texture`. A null texture throws `createParticleBillboard: the particle system has no texture`.

It creates a row-major grid atlas over the existing texture:

- Sprite systems use `cellWidth` and `cellHeight` when each is greater than zero.
- A missing, zero, or negative dimension uses the full texture dimension for that axis.
- Margin and spacing are zero.
- Columns are `max(1, floor(texture.width / cellWidth))` and rows are `max(1, floor(texture.height / cellHeight))`.
- Each frame has top-down UV bounds, source size equal to the cell dimensions, and pivot `[0.5, 0.5]`.
- `premultipliedAlpha` is false.

It then creates a camera-facing billboard system with initial capacity `system.buffer.capacity` and the mapped blend descriptor. Billboard construction clamps its internal capacity to at least one and allocates `capacity * 16` Float32 instance values plus `capacity * 2` Float32 saved-size values.

Blend mapping is:

| Particle `blendMode` | Billboard descriptor     | Color factors                                         | Alpha factors                                   |
| -------------------- | ------------------------ | ----------------------------------------------------- | ----------------------------------------------- |
| `0`                  | `billboardBlendOneOne`   | source `one`, destination `one`                       | source `one`, destination `one`                 |
| `1`                  | `billboardBlendAlpha`    | source `src-alpha`, destination `one-minus-src-alpha` | source `one`, destination `one-minus-src-alpha` |
| `2`                  | `billboardBlendAdditive` | source `src-alpha`, destination `one`                 | source `one`, destination `one`                 |
| `3`                  | `billboardBlendAdditive` | source `src-alpha`, destination `one`                 | source `one`, destination `one`                 |
| `4`                  | `billboardBlendAdditive` | source `src-alpha`, destination `one`                 | source `one`, destination `one`                 |
| any other number     | `billboardBlendAdditive` | source `src-alpha`, destination `one`                 | source `one`, destination `one`                 |

Every blend operation is `add`. All mappings use the transparent billboard path.

### 10.2 Synchronization

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

Only simulation is allocation-free by structure. Particle rendering uses the allocations above and the billboard subsystem's storage, shader, pipeline, bind groups, deferred renderable, and picking support.

### 10.3 Scene registration

`registerNodeParticleSet(scene, set, options = {})` uses `autoStart = options.autoStart ?? true`. For each system, in `set.systems` order, it:

1. Creates the particle billboard.
2. Adds the facing billboard system to the scene.
3. Calls `startParticleSystem` when auto-start is true.
4. Registers one `onBeforeRender` callback.

Each callback computes:

```ts
const ratio = deltaMs > 0 ? deltaMs / (1000 / 60) : 1;
const canvas = scene.surface.canvas;
prepareParticleSystemFrame(system, scene.camera, canvas.width, canvas.height);
animateParticleSystem(system, ratio);
syncParticleBillboard(system, billboard);
```

There is no synchronization during registration; the first registered callback performs the first live animation and upload. `onBeforeRender` inserts each callback at the front of the scene callback array, so callbacks for a multi-system set execute in reverse system-registration order when the scene processes that array in order.

The registration function returns `void`, exposes no billboard, and supplies no callback-unregister handle. With auto-start false, the callback is still registered; animation is a no-op until the system is started, while synchronization still runs every frame.

## 11. Error and failure behavior

The implementation preserves these explicit failures:

- Parser: `NodeParticle: invalid source — expected a \`blocks\` array`.
- Parser: `NodeParticle: block missing numeric id (name=<stringified name>)`.
- Parser: `NodeParticle: graph has no SystemBlock`.
- Snippet HTTP response: `NodeParticle: snippet fetch failed (<status>)`.
- Connected value with no installed getter: `NodeParticle: unresolved connection <ClassName>.<inputName>`.
- Unsupported world shape: `NodeParticle: unsupported emitter block "<ClassName>"`.
- Unsupported local shape: `NodeParticle: unsupported local shape "<ClassName>"`.
- Unsupported name beginning with `Particle`: `NodeParticle: unsupported value block "<ClassName>"`.
- Other unsupported names routed through the basic registry: `NodeParticle: unsupported Basic Properties block "<ClassName>"`.
- Unsupported direct variant-loader request: `NodeParticle: unsupported block variant "<ClassName>"`.
- Unsupported contextual source: `NodeParticle: unsupported contextual source 0x<lowercase hex>`.
- Unsupported system source: `NodeParticle: unsupported system source <decimal id>`.
- Invalid local source use: `NodeParticle: LocalPositionUpdated requires SystemBlock.isLocal`.
- Invalid local source timing or recycled slot: `NodeParticle: LocalPositionUpdated read before local shape position creation`.
- Sprite update without setup: `NodeParticle: BasicSpriteUpdateBlock requires SetupSpriteSheetBlock`.
- Billboard creation without texture: `createParticleBillboard: the particle system has no texture`.
- Invalid sprite frame during sync: `resolveSpriteFrame: index <frame> out of range [0, <frameCount>)`.

Additional behavior is observable:

- A dangling target block id is marked built and skipped. It fails only if a consumer requests its absent getter; a flow-only edge can remain silent.
- Detached unsupported blocks are ignored because they are unreachable.
- Dynamic-import failures for reachable evaluator or registry modules propagate from the asynchronous build.
- Missing mesh positions or indices silently leave the system without mesh creation slots. Malformed or empty arrays can produce `undefined`, `NaN`, out-of-range access, or native errors during creation.
- Billboard texture fetch, decode, and upload failures are caught inside `ParticleTextureSourceBlock`; build resolves with `texture` unchanged. Rendering then fails at billboard creation when no other texture was assigned.
- Flow-map fetch or CPU decode failures are caught inside `UpdateFlowMapBlock`; build resolves and the block applies no force.
- Invalid relative URL resolution can throw synchronously from `new URL`.
- Invalid JSON, malformed snippet payloads, invalid typed-array lengths, and wrong runtime value shapes use native JavaScript errors or typed-array coercion.
- Capacity exhaustion drops all creation requests from the first failed spawn through the rest of that animation call. Emission carry and simulated time are not restored.
- Numeric fields are not checked for finiteness, sign, integer range, or compatible graph value type.
- A zero lifetime produces division by zero in color-step creation. Zero lifetime in sprite update produces JavaScript remainder/division results and Uint16 coercion.
- `_nextId` is an unbounded JavaScript number while the stored particle and cache ids are Uint32 values, so stored ids wrap at Uint32 assignment.

## 12. Current limitations

- Only the 28 classes in section 9 are accepted. Other NPE classes follow the registry errors in section 11.
- Simulation is CPU-only.
- Rendering is always camera-facing. Serialized `billBoardMode` and `isBillboardBased` do not affect runtime state.
- Blend modes 3 and 4, plus unknown values, render with the additive descriptor used by mode 2.
- System source 4 and every system source outside 1, 2, and 3 are unsupported.
- Custom emitter functions, sub-emitter triggers, inherited emitter velocity, and noise updates have no supported block evaluator.
- Emit power scales the created direction; exactly zero clears it. No inherited velocity term is added.
- Mesh emission reads only `cachedVertexData`; mesh `worldSpace` is ignored, and mesh data is not structurally validated.
- A renderable particle system needs a successfully loaded or manually assigned texture. There is no untextured billboard fallback.
- Local-position integration is available only through source `0x0018` on a system whose root has `isLocal === true`.
- Live registration provides no unregister handle and does not set `_started` false when a stopped system becomes empty.
- The simulation structure is allocation-free per indexed step; billboard synchronization is not allocation-free.

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
- Build behavior: inline JSON, root reachability, detached-block isolation, two-field connection criteria, dynamic emit-rate laziness, and system-time reevaluation.
- Canonical graph state: scenes 262, 263, 264, and 276; full Basic Properties; Size; Sphere; and deterministic/random-start sprite variants.
- Change graphs: Size, Color, Speed, Angular Speed, multi-stop Angular Speed, Drag, Emit Rate, Lifetime, Start Size, and Speed Limit.
- Emitters: Point, Box, Sphere, directed Sphere, Hemisphere, Cone, directed Cone, Cylinder, directed Cylinder, Mesh, rotated Cylinder, all six transformed local shapes, mesh vertex color, mesh InitialDirection, shared volatile bounds, and local source build/read guards.
- Value correctness: shared-scratch Math, Lerp/Gradient endpoints, Random min/max aliasing, lock modes, Uint32 id edge cases, and capacity-bounded OncePerParticle caches.
- Attractors: softened inverse-square attraction, negative-strength repulsion, defaults, coincident-point handling, lifetime-clamped step scaling, and lazy evaluator isolation.
- Flow maps: projected nearest-neighbor sampling including non-zero row stride, vertical screen mapping, RGBA force decoding, alpha and bounds handling, per-particle strength evaluation, lifetime-clamped step scaling, allocator-selected F32/F64 matrix snapshots, and lazy texture/evaluator isolation.
- Feature isolation: runtime chunk manifests and, when bundle-info exists, fetched module contents.
- Path ownership: the `particle/soa` source directory and `particle-soa*.test.ts` unit-test names must not exist. TypeScript compilation validates all source and test imports.

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

### 13.3 Visual scenes

All six Lite scenes seed after build, synchronize one billboard, register the frozen scene, and use a black clear color. Scenes 262, 263, 264, 276, and 277 run 200 ratio-1 steps. Scene 280 prepares its flow matrix once and runs 300 ratio-1 steps. Its Babylon reference calls `scene.updateTransformMatrix(true)` before those manual steps because Babylon's UpdateFlowMap reads the scene transform matrix before the first render.

| Scene                          | Coverage                                                                      | Camera                                                     | MAD ceiling | Raw ceiling |
| ------------------------------ | ----------------------------------------------------------------------------- | ---------------------------------------------------------- | ----------- | ----------- |
| 262 `scene262-npe-size`        | Basic Properties - Size, Box                                                  | alpha `-pi/2`, beta `1.2`, radius `4`, target `(0,0.3,0)`  | `0.01`      | `44.1 KB`   |
| 263 `scene263-npe-sphere`      | Sphere emitter                                                                | alpha `-pi/2`, beta `1.2`, radius `14`, target origin      | `0.01`      | `44.1 KB`   |
| 264 `scene264-npe-change-size` | Gradient, GradientValue, UpdateSize                                           | alpha `-pi/2`, beta `1.2`, radius `12`, target `(0,0.7,0)` | `0.01`      | `44.1 KB`   |
| 276 `scene276-npe-animations`  | deterministic sprite sheet, cells 0 through 9, 64 by 64 cells, speed 30       | alpha `-pi/2`, beta `1.2`, radius `4`, target `(-1,0,0)`   | `0.01`      | `45.0 KB`   |
| 277 `scene277-npe-attractor`   | UpdateAttractor after position integration, attractor `(0,2,0)`, strength `8` | alpha `-pi/2`, beta `1.2`, radius `5`, target `(0,0.8,0)`  | `0.01`      | `45.0 KB`   |
| 280 `scene280-npe-flow-map`    | UpdateFlowMap after integration, flipped repel map, strength `15`, size `0.6` | alpha `pi/2`, beta `pi/2`, radius `9`, target `(-5,0,0)`   | `0.01`      | `45.0 KB`   |

Each camera uses near plane `0.1` and far plane `100`. Each scene sets both `canvas.dataset.animationFrozen` and `canvas.dataset.ready` to `"true"` after engine start.

Each parity specification waits for `canvas.dataset.ready === "true"`, waits 500 ms, screenshots the canvas, and compares full-image MAD against `reference/lite/<scene-slug>/babylon-ref-golden.png`. Specifications 262, 263, 264, 277, and 280 invoke the shared golden-capture helper before opening the Lite page; specification 276 reads its committed golden directly. The pass criterion comes from `scene-config.json` and is `MAD <= 0.01` for all six scenes.

### 13.4 Bundle manifests and conditional content

Current tracked measurements are:

| Scene | Runtime raw | Runtime gzip | Ignored graph payload raw |   Ceiling |
| ----- | ----------: | -----------: | ------------------------: | --------: |
| 262   |   `40.2 KB` |    `24.2 KB` |                 `28.5 KB` | `44.1 KB` |
| 263   |   `42.2 KB` |    `24.8 KB` |                 `27.5 KB` | `44.1 KB` |
| 264   |   `40.4 KB` |    `26.0 KB` |                 `34.4 KB` | `44.1 KB` |
| 276   |   `44.4 KB` |    `25.4 KB` |                 `27.1 KB` | `45.0 KB` |
| 277   |   `42.2 KB` |    `25.5 KB` |                 `29.8 KB` | `45.0 KB` |
| 280   |   `43.0 KB` |    `26.2 KB` |                 `31.0 KB` | `45.0 KB` |

Local `*-npe.ts` graph payload modules are excluded from engine runtime-byte accounting and appear in ignored bytes. The general bundle-size specification identifies scene ids 262, 263, 264, 276, 277, and 280 as sprite users because particles render through billboard sprite modules.

The particle bundle-content test always requires a nonempty runtime chunk list for each of the six scenes. It rejects fetched chunks matching unused variant, extra-basic, extra-emitter, extra-value, local-shape, attractor/flow-map/direction/angle update, CPU texture decode, typed once-random, random sprite, dynamic emit-rate, optional value block, local input/position, and optional emitter patterns. Scene 263 may fetch `npe-registry-extra-emitters` because it uses Sphere, scene 277 must fetch `update-attractor-block`, and scene 280 must fetch `update-flow-map-block` plus the remaining optional registry. Only scene 280 may include `npe-texture-content` in a fetched runtime chunk.

When `lab/public/bundle/bundle-info/sceneN.json` exists, the same test also inspects only modules in fetched runtime chunks. It rejects extra-value and local-shape registries, local-position support, dynamic emit rate, Condition, FloatToInt, VectorLength, every local shape body, and `math/mat4-invert.ts`. When bundle-info is absent, this module-level branch is skipped while the runtime-chunk assertions still run.

## 14. Exact file manifest

### 14.1 Particle root: 6 files

```text
packages/babylon-lite/src/particle/particle-billboard.ts
packages/babylon-lite/src/particle/particle-buffer.ts
packages/babylon-lite/src/particle/particle-scene.ts
packages/babylon-lite/src/particle/particle-system.ts
packages/babylon-lite/src/particle/sprite-columns-random.ts
packages/babylon-lite/src/particle/sprite-columns.ts
```

### 14.2 Node infrastructure and registries: 18 files

```text
packages/babylon-lite/src/particle/node/node-particle.ts
packages/babylon-lite/src/particle/node/npe-build.ts
packages/babylon-lite/src/particle/node/npe-contextual-extra.ts
packages/babylon-lite/src/particle/node/npe-contextual.ts
packages/babylon-lite/src/particle/node/npe-local-position.ts
packages/babylon-lite/src/particle/node/npe-parser.ts
packages/babylon-lite/src/particle/node/npe-registry-extra-basic.ts
packages/babylon-lite/src/particle/node/npe-registry-extra-emitters.ts
packages/babylon-lite/src/particle/node/npe-registry-extra-remaining.ts
packages/babylon-lite/src/particle/node/npe-registry-extra-values.ts
packages/babylon-lite/src/particle/node/npe-registry-extra.ts
packages/babylon-lite/src/particle/node/npe-registry-local-shapes.ts
packages/babylon-lite/src/particle/node/npe-registry-variants.ts
packages/babylon-lite/src/particle/node/npe-registry.ts
packages/babylon-lite/src/particle/node/npe-snippet.ts
packages/babylon-lite/src/particle/node/npe-texture-content.ts
packages/babylon-lite/src/particle/node/npe-types.ts
packages/babylon-lite/src/particle/node/npe-value.ts
```

### 14.3 Block evaluators and helpers: 43 files

```text
packages/babylon-lite/src/particle/node/blocks/basic-sprite-update-block.ts
packages/babylon-lite/src/particle/node/blocks/box-shape-block.ts
packages/babylon-lite/src/particle/node/blocks/box-shape-local-block.ts
packages/babylon-lite/src/particle/node/blocks/cone-shape-block.ts
packages/babylon-lite/src/particle/node/blocks/cone-shape-local-block.ts
packages/babylon-lite/src/particle/node/blocks/create-particle-block.ts
packages/babylon-lite/src/particle/node/blocks/cylinder-shape-block.ts
packages/babylon-lite/src/particle/node/blocks/cylinder-shape-local-block.ts
packages/babylon-lite/src/particle/node/blocks/mesh-shape-block.ts
packages/babylon-lite/src/particle/node/blocks/mesh-shape-local-block.ts
packages/babylon-lite/src/particle/node/blocks/particle-condition-block.ts
packages/babylon-lite/src/particle/node/blocks/particle-converter-block.ts
packages/babylon-lite/src/particle/node/blocks/particle-float-to-int-block.ts
packages/babylon-lite/src/particle/node/blocks/particle-gradient-block.ts
packages/babylon-lite/src/particle/node/blocks/particle-gradient-value-block.ts
packages/babylon-lite/src/particle/node/blocks/particle-input-block.ts
packages/babylon-lite/src/particle/node/blocks/particle-input-extra-block.ts
packages/babylon-lite/src/particle/node/blocks/particle-input-local-block.ts
packages/babylon-lite/src/particle/node/blocks/particle-lerp-block.ts
packages/babylon-lite/src/particle/node/blocks/particle-math-block.ts
packages/babylon-lite/src/particle/node/blocks/particle-math-compact-block.ts
packages/babylon-lite/src/particle/node/blocks/particle-random-block.ts
packages/babylon-lite/src/particle/node/blocks/particle-random-once-block.ts
packages/babylon-lite/src/particle/node/blocks/particle-random-once-typed-block.ts
packages/babylon-lite/src/particle/node/blocks/particle-random-once-typed.ts
packages/babylon-lite/src/particle/node/blocks/particle-random-once.ts
packages/babylon-lite/src/particle/node/blocks/particle-vector-length-block.ts
packages/babylon-lite/src/particle/node/blocks/point-shape-block.ts
packages/babylon-lite/src/particle/node/blocks/point-shape-local-block.ts
packages/babylon-lite/src/particle/node/blocks/setup-sprite-sheet-block.ts
packages/babylon-lite/src/particle/node/blocks/setup-sprite-sheet-random-block.ts
packages/babylon-lite/src/particle/node/blocks/sphere-shape-block.ts
packages/babylon-lite/src/particle/node/blocks/sphere-shape-local-block.ts
packages/babylon-lite/src/particle/node/blocks/system-block.ts
packages/babylon-lite/src/particle/node/blocks/system-dynamic-emit-rate-block.ts
packages/babylon-lite/src/particle/node/blocks/texture-source-block.ts
packages/babylon-lite/src/particle/node/blocks/update-angle-block.ts
packages/babylon-lite/src/particle/node/blocks/update-attractor-block.ts
packages/babylon-lite/src/particle/node/blocks/update-color-block.ts
packages/babylon-lite/src/particle/node/blocks/update-direction-block.ts
packages/babylon-lite/src/particle/node/blocks/update-flow-map-block.ts
packages/babylon-lite/src/particle/node/blocks/update-position-block.ts
packages/babylon-lite/src/particle/node/blocks/update-size-block.ts
```

### 14.4 Direct integration dependencies

These files are imported directly by particle source files or define the package-root exports:

```text
packages/babylon-lite/src/camera/camera.ts
packages/babylon-lite/src/engine/engine.ts
packages/babylon-lite/src/math/mat4-identity.ts
packages/babylon-lite/src/math/mat4-invert.ts
packages/babylon-lite/src/math/mat4-transform.ts
packages/babylon-lite/src/math/mat4-translation.ts
packages/babylon-lite/src/math/random-range.ts
packages/babylon-lite/src/math/types.ts
packages/babylon-lite/src/scene/scene-core.ts
packages/babylon-lite/src/scene/scene.ts
packages/babylon-lite/src/sprite/billboard-blend.ts
packages/babylon-lite/src/sprite/billboard-scene.ts
packages/babylon-lite/src/sprite/billboard-sprite.ts
packages/babylon-lite/src/sprite/shared/sprite-atlas.ts
packages/babylon-lite/src/texture/texture-2d.ts
packages/babylon-lite/src/index.ts
```

The billboard subsystem owns its additional rendering, picking, GPU, and blend-descriptor dependencies. They are outside the particle implementation boundary.

### 14.5 Scene, configuration, and manifest anchors

```text
scene-config.json
lab/lite/src/lite/scene262.ts
lab/lite/src/lite/scene263.ts
lab/lite/src/lite/scene264.ts
lab/lite/src/lite/scene276.ts
lab/lite/src/lite/scene277.ts
lab/lite/src/lite/scene280.ts
lab/lite/src/shared/scene262-npe.ts
lab/lite/src/shared/scene263-npe.ts
lab/lite/src/shared/scene264-npe.ts
lab/lite/src/shared/scene276-npe.ts
lab/lite/src/shared/scene277-npe.ts
lab/lite/src/shared/scene280-npe.ts
lab/public/bundle/manifest/scene262.json
lab/public/bundle/manifest/scene263.json
lab/public/bundle/manifest/scene264.json
lab/public/bundle/manifest/scene276.json
lab/public/bundle/manifest/scene277.json
lab/public/bundle/manifest/scene280.json
tests/lite/parity/scenes/scene262-npe-size.spec.ts
tests/lite/parity/scenes/scene263-npe-sphere.spec.ts
tests/lite/parity/scenes/scene264-npe-change-size.spec.ts
tests/lite/parity/scenes/scene276-npe-animations.spec.ts
tests/lite/parity/scenes/scene277-npe-attractor.spec.ts
tests/lite/parity/scenes/scene280-npe-flow-map.spec.ts
tests/lite/unit/npe-particle-flow-map.test.ts
tests/lite/unit/npe-particle-bundle-content.test.ts
```
