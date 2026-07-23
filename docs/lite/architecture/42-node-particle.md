# Module: Node Particles (NPE)

> Package path: `packages/babylon-lite/src/particle/`
>
> This is the standalone, one-shot architecture document for the node-particle
> module. **The goal is parity with Babylon.js's Node Particle Editor (NPE)** —
> the particle-system analogue of the Node Material Editor — _not_ with the full
> classic CPU `ParticleSystem` (which can express more than an NPE graph can).
> Lite has no imperative particle API; a user authors an NPE graph directly (or
> loads one from the snippet server), Lite parses it into an immutable graph,
> "compiles" the graph once into indexed getters and fixed creation/update slots,
> and runs those slots each frame with a deterministic simulation loop. NPE builds
> a real Babylon `ParticleSystem`, so that loop is a faithful port of the
> `ThinParticleSystem.animate` runtime such a system runs; the _scope_ of what
> Lite supports is bounded by what an NPE graph can express, block by block. Live
> particles are bound to a camera-facing billboard sprite system for rendering.
> Canonical particle scenes use the data-oriented runtime under `particle/soa/`;
> the object runtime remains as the compatibility implementation and an exact
> behavioural oracle pending the atomic public-API cutover. SoA now implements
> every block evaluator supported by that compatibility runtime.
>
> This document contains the full specification needed to implement the module
> from scratch — the determinism contract, the CPU runtime, the node-graph build,
> every block, the emitter world matrix, rendering, the Babylon.js equivalence
> map, the not-yet-supported gaps, tests, and file manifest. No prior particle
> design document is required for context.

## Purpose

Lite renders particles the same way Babylon's NPE does at runtime: a node
graph configures a `ParticleSystem`, and the system is simulated on the CPU.
Lite does **not** ship the classic imperative `ParticleSystem` API
(`addSizeGradient`, `createConeEmitter`, …); a Lite user authors an NPE graph
directly (or loads one from the snippet server) and Lite builds it. This keeps
one code path (the graph) and lets every block tree-shake independently.

**Scope.** The target is NPE parity, block for block. Babylon's classic
`ParticleSystem` supports features NPE does not (or exposes only via imperative
setters); those are out of scope unless and until an NPE block exposes them.
Every "gap" below is therefore an _NPE-expressible_ behaviour not yet ported —
never a classic-only feature.

The non-negotiable requirement is **deterministic parity with Babylon.js**:
given the same graph and the same seeded `Math.random`, Lite must reproduce
every particle's position, direction, colour, size, angle, and age to within
`1e-6` of Babylon's output. That single requirement dictates almost every
design decision below — the fixed creation-slot order, the `randomRange`
short-circuit, the emission accounting, and the age clamp all exist to keep the
per-particle `Math.random()` sequence and the arithmetic identical to Babylon's.

## Pillars (front and centre)

- **Deterministic CPU simulation.** The simulation is a direct port of
  `ThinParticleSystem.animate` → `_update`. Parity is verified by seeding
  `Math.random`, stepping N frames, and comparing to Babylon-extracted ground
  truth at `1e-6`. There is **no GPU particle path**.
- **The graph is compiled to indexed operations.** The build walk runs once and
  produces getter closures plus fixed creation slots and an ordered update list.
  The SoA hot loop passes particle indices into these operations and never walks
  the graph or allocates per-particle objects.
- **Pay-for-use.** Block evaluators are lazily `import()`-ed per class. SoA uses
  base, optional, serialized-variant, emitter, and local-shape registries; feature
  columns are allocated only by the block/source that reads or writes them. A
  world-space point emitter therefore loads neither local shape code nor local
  position memory, and a non-cylinder system does not compute an inverse emitter
  matrix. Modules have no top-level allocations.
- **Pure state + standalone functions.** `Particle` and `ParticleSystem` are
  plain interfaces; all behaviour is standalone functions operating on them. No
  classes, no methods, no per-feature nullable `_properties` bag (Babylon uses
  one; Lite uses fixed fields and lazily allocated SoA columns).
- **Author NPE directly.** The emitter transform, capacity, blend mode, etc. are
  caller-supplied or graph-encoded; there is no imperative configuration surface.

## Architecture — Runtime Layers

```
particle.ts                    Runtime  — the Particle struct + pooling
particle-system.ts             Runtime  — ParticleSystem state + animateParticleSystem + recycle
node/npe-types.ts              Graph    — the (immutable) graph + build-context types + getter model
node/npe-parser.ts             Graph    — serialized JSON  ->  immutable ParticleGraph
node/npe-build.ts              Build    — post-order DFS: compile graph -> closures
node/npe-build-state.ts        Build    — contextual/system data sources (runtime reads)
node/npe-registry.ts           Build    — lazy per-block dispatch (tree-shaking)
node/blocks/*.ts               Blocks   — the 18 block evaluators
node/node-particle.ts          API      — parseNodeParticleSetFromSnippet (public entry)
node/npe-snippet.ts            API      — snippet-server fetch
particle-billboard.ts          Render   — bind live particles -> billboard instances
particle-scene.ts              Render   — register/start/stop + per-frame animate hook
soa/particle-buffer.ts         Runtime  — typed-array base columns + lazy feature columns
soa/animate.ts                 Runtime  — fixed creation slots + indexed update loop
soa/npe-build.ts               Build    — root-reachable graph walk -> SoA operations
soa/registry*.ts               Build    — lazy base/feature/variant/emitter/local dispatch
soa/blocks/*.ts                Blocks   — zero-allocation indexed evaluators
soa/soa-billboard.ts           Render   — upload live SoA columns to billboard instances
math/mat4-transform.ts         Math     — transformCoordinates/Normal + mat4GetTranslation (emitter matrix)
math/random-range.ts           Math     — randomRange (Scalar.RandomRange, with short-circuit)
```

Data flow: **snippet/JSON → `parseNodeParticleSource` → `ParticleGraph` →
`buildNodeParticleSet` → `NodeParticleSet { systems: ParticleSystem[] }` →
(live) `registerNodeParticleSet` → per-frame `animateParticleSystem` +
`syncParticleBillboard`.**

The canonical SoA path is **JSON → `parseNodeParticleSource` → `ParticleGraph` →
`buildSoaParticleSet` → `SoaParticleSet { systems: SoaSystem[] }` →
`animateSoa` + `syncSoaParticleBillboard`**.

## The Determinism Contract (read this first)

Every rule here exists to keep Lite's `Math.random()` sequence and arithmetic
identical to Babylon's. Break any one and parity collapses.

1. **Seeded RNG for tests.** Ground-truth is extracted from Babylon with
   `Math.random` overridden by a deterministic generator, and the Lite test
   installs the identical generator _after build, before stepping_:
    ```js
    let seed = 1;
    Math.random = () => {
        const x = Math.sin(seed++) * 10000;
        return x - Math.floor(x);
    };
    ```
2. **`randomRange(min, max)` short-circuits.** When `min === max` it returns
   `min` **without calling `Math.random()`** (Babylon `Scalar.RandomRange`).
   Emitter shape blocks call it per component; equal bounds (a common default)
   must not advance the RNG. Expression: `Math.random() * (max - min) + min`.
3. **`ParticleRandomBlock` never short-circuits.** Its `drawRandom` always draws
   per component even when `min === max` — the draw still advances the RNG. This
   is the deliberate _opposite_ of `randomRange`; do not route it through
   `randomRange`.
4. **Fixed creation-slot order — the single most important invariant.** On every
   spawn the eight named slots run in this exact order regardless of graph build
   order: **lifeTime → position → direction → emitPower → size → angle → colour →
   colourDead**. Each slot may draw randoms; reordering changes the RNG sequence.
   (Babylon builds this as a linked list via `_ConnectAfter`; Lite flattens it to
   fixed named fields on `ParticleSystem`.)
5. **Update-queue order = post-order DFS.** Update blocks push onto `_updateQueue`
   in the order the build walk visits them (post-order over each block's inputs).
   That traversal order must match Babylon's update-chain order for multi-update
   graphs.
6. **Emission accounting.** Per step, set `scaledUpdateSpeed = updateSpeed * ratio`,
  evaluate a connected emit-rate graph from the current system time (or use the
  constant `emitRate`), then compute `newParticles = (emitRate * scaledUpdateSpeed) >> 0`;
  the fractional remainder accumulates in `_newPartsExcess`, and when it exceeds
  `1.0` the whole part is added and subtracted back. The system-time accumulator
  advances only after the rate is read. Ratio = 1 for parity and real-frame-delta
  for live simulation.
7. **Final-step age clamp.** When a particle would overshoot its lifetime, its
   last step is shortened so it lands exactly at `lifeTime`: `stepSpeed =
(oldDiff * stepSpeed) / diff`. The shortened `stepSpeed` is what
   `_directionScale` holds for that step.
8. **Update before create.** `animate` runs `updateExistingParticles` _then_
   `createNewParticles`.
9. **Tolerance & extraction.** The object runtime compares at `1e-6`; SoA
   position/direction/feature columns are `Float32Array`, so repeated integration
   compares at `1e-4`, while age/lifetime remain float64 and exact at lifecycle
   boundaries. Ground truth is produced by a
   throwaway harness in the Babylon repo: build/convert a classic system, run
   `ConvertToNodeParticleSystemSetAsync` (use conversion, _not_ `Parse` — `Parse`
   drops some `Color4` input values), `await npe.buildAsync(scene)` (populates
   `attachedBlocks` so `serialize()` emits blocks), null the system's `_scene`
   (ratio 1, no frame-id skip), seed, step, dump `serialize()` + states. Delete
   the harness afterward.

## The CPU Runtime

### `particle.ts`

`Particle` is a pure-state struct mirroring Babylon's `Particle` field-for-field
(so the graph evaluator reproduces identical motion). Public fields: `id`,
`position`, `direction`, `color`, `colorDead`, `initialColor`, `colorStep`,
`age`, `lifeTime`, `angle`, `size`, `scale {x,y}`, `cellIndex`. Scratch fields
(`_`-prefixed, per-step intermediates read by contextual sources):
`_directionScale`, `_scaledDirection`, `_initialDirection`, `_localPosition`.
`Vec3`/`Color4` are plain objects, not classes.

- `createParticle(id)` — fresh particle with defaults (colour white, size 1,
  lifeTime 1).
- `resetParticle(particle, id)` — recycle a pooled particle; clears only the
  lifecycle scratch (`id`, `age`, `cellIndex`, `_directionScale`) because the
  creation queue overwrites everything else on every spawn.

### `particle-system.ts`

`ParticleSystem` is pure state: public config (`name`, `capacity`, `emitRate`,
`updateSpeed` [default `1/60`], `targetStopDuration`, `blendMode`,
`billboardMode`, `isBillboardBased`, `isLocal`, `emitter`, `texture`) plus
internal state (`_particles`, `_stock` [recycle pool], `_started`, `_stopped`,
`_actualFrame`, `_newPartsExcess`, `_scaledUpdateSpeed`, `_emitPower`,
`_nextParticleId`, `_scaledColorStep`), the eight named creation slots
(`_createLifeTime` … `_createColorDead`, each `ParticleProcess | null`), and
`_updateQueue: ParticleProcess[]`. `ParticleProcess = (particle, system) => void`.

- `createParticleSystem(name, capacity)` — Babylon defaults; the graph overrides.
- `startParticleSystem` / `stopParticleSystem`.
- `animateParticleSystem(system, scaledRatio)` — one step (see contract §6–8).
- `updateExistingParticles` — age + clamp (§7), set `_directionScale`, run
  `_updateQueue`, recycle if `age >= lifeTime`.
- `createNewParticles` — pull from `_stock` (or `createParticle`), assign a fresh
  monotonic id, run `runCreationSlots`.
- `runCreationSlots` — the eight slots in fixed order (§4), skipping nulls.
- `recycleParticle` — swap-with-last + `pop()` + push to `_stock` (O(1)).

## The Data-Oriented Runtime (`particle/soa`)

`ParticleBuffer` stores position and direction in six `Float32Array`s, age and
lifetime in `Float64Array`s, and IDs in `Uint32Array`. Live particles occupy the
dense range `[0, alive)`. `killParticle` swap-removes across `_all`, which contains
the base arrays and every lazily-created feature column, so optional state recycles
without feature-specific hooks. `column(buffer, name, ctor)` is the only feature
allocation surface.

`SoaSystem` owns the eight Babylon-ordered creation slots and an ordered
`updateSteps` array. `animateSoa` performs update-before-create, final-step lifetime
clamping, fractional emission accounting, optional per-step emit-rate evaluation,
and swap removal without per-frame allocation. Scratch-backed vector/color getters
must copy an operand's components before evaluating another getter because two ports
may share the same scratch.

`buildSoaParticleSet` creates the system and buffer before traversing each root,
then builds only blocks reachable from a `SystemBlock`. Common blocks use
`registry.ts`; optional features use `registry-extra.ts`; rare serialized forms use
`registry-variants.ts`; world emitter families use `registry-extra-emitters.ts`;
local shape bodies use `registry-local-shapes.ts`. Local and world implementations
are separate modules, so world systems contain no local-mode branches.

`LocalPositionUpdated` (`0x18`) owns five lazy columns: local x/y/z, particle ID,
and validity. Every local shape invokes the source's optional seed hook after it
writes birth position, at the same point Babylon calls `_CreateLocalPositionData`.
The local-only `finishLocalPosition` helper then mirrors Babylon's generic
`_CreateIsLocalData` queue item by transforming the age-zero render position into
world space before direction creation. Each subsequent source read advances local
position by `direction * scaledStep`, transforms through the emitter world matrix,
and writes/returns world position; creation-time reads after position use step zero.
A read from inside position creation is invalid in Babylon because local position
does not exist yet, so Lite throws before it can consume recycled slot data. ID
validation makes the source independent of graph build order and safe under
swap-remove/recycled slots. Systems without source `0x18` allocate none of these
columns; world systems load neither source nor local-position helper.

## The Node-Graph Layer

### Getter model (`npe-types.ts`)

`NpeGetter = (state: NpeBuildState) => ParticleValue` is the compiled form of a
connection — Babylon's `_storedFunction`. `ParticleValue = number | Vec3 | Color4
| Vec2 | ParticleSystem | Texture2D | null | undefined` (the system
itself flows along the `particle`/`output` ports). `NpeBuildState` is **dual
purpose**: build-time fields (`capacity`, `emitter`, `emitterWorldMatrix`,
`emitterInverseWorldMatrix`, `scene`, `textureBaseUrl`) and run-time fields
(`system`, `particle`) that the animate loop swaps per particle so getters read
live state. The parsed graph types are fully **immutable** (`readonly`,
`ReadonlyMap`, `Readonly<Record>`), matching NME's `node-types.ts`.

### Parser (`npe-parser.ts`)

`parseNodeParticleSource(source)` reads the Babylon serialize format
(`{ blocks: [...] }`, each block `{ customType, id, name, inputs[] }`), strips
the `BABYLON.` prefix from `customType`, normalizes inputs, keeps the whole raw
block as `serialized`, and collects `SystemBlock` ids as roots. Throws on a
missing `blocks` array, a non-numeric id, or zero `SystemBlock`s. Tolerant of
dangling `targetBlockId`s (they surface later as an unresolved connection).

### Build walk (`npe-build.ts`)

`buildNodeParticleSet(engine, scene, graph, options)`:

1. Preload the evaluator for each distinct `className` (parallel `import()`).
2. Per `SystemBlock` root: fresh `NpeBuildState`, an `outputs` map
   (`"blockId:connectionName" -> getter`), and a `built` memo set. Build via a
   **memoized post-order DFS** (`buildBlock`): recurse each input's target
   first, then `evaluator.build(block, ctx)`. Post-order guarantees upstream
   getters are registered before a downstream block resolves them, and fixes the
   update-queue order.
3. `ctx.input(block, name, fallback)` resolves a port: connected getter →
   inline literal (`parseInputLiteral`) → `fallback` → `() => null`. A port that
   is _connected but unresolvable_ **throws** (`unresolved connection …`).
4. Settle asset promises, then run each system's deferred `_resolveTexture`.

Options: `emitter?: Vec3`, `emitterWorldMatrix?: Mat4` (precedence over
`emitter`), `textureBaseUrl?`.

### Contextual & system sources (`npe-build-state.ts`)

`getContextualValue(state, id)` and `getSystemValue(state, id)` are the runtime
read layer (leaves of the getter tree). `SCALED_DIRECTION` and
`SCALED_COLOR_STEP` compute into particle/system scratch and return by reference
(zero-alloc, consume-immediately). Supported ids (hex, from Babylon
`NodeParticleContextualSources`): Position `0x1`, Direction `0x2`, Age `0x3`,
Lifetime `0x4`, Color `0x5`, ScaledDirection `0x6`, Scale `0x7`, AgeGradient
`0x8`, Angle `0x9`, InitialColor `0x13`, ColorDead `0x14`, InitialDirection
`0x15`, ColorStep `0x16`, ScaledColorStep `0x17`, LocalPositionUpdated `0x18`,
Size `0x19`, DirectionScale `0x20`. System sources: Time `1`, Delta `2`, Emitter `3`. `ParticleInputBlock`
**validates the id at build time** (`isContextualSourceSupported` /
`isSystemSourceSupported`, allocation-free switches) and throws for anything
else, rather than silently returning `null` per frame.

### Registries

The compatibility runtime uses the flat `npe-registry.ts`. SoA splits the same
supported evaluator set across base, optional, emitter, value-utility, local-shape,
and serialized-variant registries. Every arm remains a side-effect-free dynamic
import, and unsupported classes fail during graph construction.

## Supported Blocks

- **`SystemBlock`** (root) — configures the already-built system from
  `serialized` (`updateSpeed`, `blendMode`, `billBoardMode`→`billboardMode`,
  `isBillboardBased`, `isLocal`, `capacity`) and the `emitRate`/`targetStopDuration`
  input ports; sets up deferred texture resolution. Note the Babylon serialize
  key is `billBoardMode` (capital B) mapping to the system's `billboardMode`.
- **`CreateParticleBlock`** — creates the system (`createParticleSystem`) and
  fills six creation slots: `_createLifeTime` (also reads emitPower into
  `sys._emitPower`, matching Babylon reading it inside `_lifeTimeCreation`),
  `_createEmitPower` (a port of Babylon `_CreateEmitPowerData`: `emitPower === 0`
  parks the particle and stashes facing in `_initialDirection`, else
  `direction *= emitPower`; the inherited-velocity add is omitted — no
  sub-emitters), `_createSize` (size + scale, scalar-or-Vector2), `_createAngle`,
  `_createColor`, `_createColorDead` (derives `colorStep = (colorDead −
initialColor) / lifeTime`). Registers `particle` → system.
- **Shape blocks** — fill `_createPosition` + `_createDirection`; register
  `output` → system. Each uses `randomRange` per component. Emitter transform is
  baked in via the world matrix (below):
    - `BoxShapeBlock` — uniform point in `[minEmitBox, maxEmitBox]`; explicit
      direction between `direction1`/`direction2`.
    - `SphereShapeBlock` — spherical-coord point (`isHemispheric` flips y); radial
      direction (jittered by `directionRandomizer`) unless both directions are
      connected.
    - `PointShapeBlock` — position = emitter (no draw); explicit direction.
    - `ConeShapeBlock` — cone point from height/radius/azimuth
      (`emitFromSpawnPointOnly`); radial direction, else explicit.
    - `CylinderShapeBlock` — disc point (`sqrt` radius) at random height; direction
      is the surface normal via **inverse-then-forward** world-matrix transform (the
      azimuth is measured in the emitter's local frame). Azimuth jitter draws
      `randomRange(-π/2, π/2)` even when the randomizer is 0.
    - `MeshShapeBlock` — random triangle + barycentric point from
      `serialized.cachedVertexData` (positions/indices/normals/colors); direction =
      interpolated face normal (`useMeshNormalsForDirection`, default) else explicit.
      `useMeshColorForColor` makes interpolated vertex color own the birth color.
      Three raw `Math.random()` draws (face, then two barycentric). Empty geometry
      emits nothing. The mesh's own `worldSpace` transform is not applied.
- **`ParticleInputBlock`** — a constant (`parseConstant`: INT/FLOAT/Vector2/
  Vector3/Color4), a contextual source, or a system source. Validates source ids.
- **`ParticleRandomBlock`** — `drawRandom` (never short-circuits) with a lock
  (`none`/`perParticle`/`perSystem`/`oncePerParticle`) controlling re-draw
  frequency; `oncePerParticle` caches by particle id in a `Map`.
- **`ParticleMathBlock`** — add/sub/mul/div/max/min; scalar+vector splats the
  scalar across components (Babylon `adapt`).
- **`ParticleLerpBlock`** — `(1-g)·a + g·b`, component-wise; shape from `left`.
- **`ParticleConverterBlock`** — composes a `Color4` from `color`/`xyz`/`xy`/
  `zw`/`x`/`y`/`z`/`w` (precedence: scalars, then pairs, then `xyz`) and exposes
  every projection. Mapping `r↔x, g↔y, b↔z, a↔w`.
- **`ParticleTextureSourceBlock`** — loads `url` (relative resolved against
  `textureBaseUrl`) as a build promise; failure falls back to `null`.
- **Update blocks** (`UpdatePositionBlock`, `UpdateColorBlock`,
  `UpdateAngleBlock`, `UpdateDirectionBlock`) — identical shape: register the
  system as `output`, and if the value input is connected, push one
  `_updateQueue` closure that copies the input into the particle field each step.

## Emitter World Matrix

The emitter is a full `Mat4` world matrix (translation + rotation + scale),
matching Babylon's `emitterWorldMatrix` (a mesh emitter's world matrix, or
`Matrix.Translation` for a `Vector3`). `options.emitter` (`Vec3`) is the
translation shorthand; `options.emitterWorldMatrix` (`Mat4`) is the full form.
The object `NpeBuildState` carries `emitterWorldMatrix`, its inverse, and
`emitter` (the translation returned by the `Emitter` source). SoA carries only
the world matrix and translation in common build state; radial cylinder modules
compute the inverse lazily, and directed cylinders never compute it.

World shape blocks: position via `transformCoordinatesToRef(x,y,z, m, out)`
(point × matrix, with perspective divide), direction via
`transformNormalToRef(x,y,z, m, out)` (upper 3×3). `isLocal` uses the raw values.
`_initialDirection` takes the post-transform direction (Babylon
`direction.clone()`). `Mat4` is column-major, translation at indices 12–14
(matches Babylon), so the transform formulas port directly. A pure translation
matrix makes `transformCoordinates` = `+translation` and `transformNormal` =
identity. Local shape modules seed optional local columns from raw emitter-space
position, then transform the render position before direction creation; source
`0x18` owns later per-step world transforms. Translation-only emitters are
numerically identical to the component-add form (the base determinism tests prove
this).

## Rendering

### `particle-billboard.ts`

`createParticleBillboard(system)` builds a facing billboard system from the
system texture (single-frame atlas), sized to `capacity`, with a blend
descriptor from `blendForMode`. `syncParticleBillboard` clears and re-uploads
every alive particle each frame: `position`, `sizeWorld = [size·scale.x,
size·scale.y]`, `color`, `rotation = angle`, `frame: 0`.

Blend mapping (`blendForMode`):

| Babylon blend mode      | value | Billboard blend    |
| ----------------------- | ----- | ------------------ |
| `BLENDMODE_ONEONE`      | 0     | additive           |
| `BLENDMODE_STANDARD`    | 1     | alpha              |
| `BLENDMODE_ADD`         | 2     | additive           |
| `BLENDMODE_MULTIPLY`    | 3     | additive **(gap)** |
| `BLENDMODE_MULTIPLYADD` | 4     | additive **(gap)** |

### `particle-scene.ts`

`registerNodeParticleSet(scene, set, { autoStart })` — the live path. Per system:
create a billboard, add to scene, optionally start, and hook `onBeforeRender` to
`animateParticleSystem(system, ratio)` + `syncParticleBillboard`, where `ratio =
deltaMs > 0 ? deltaMs / (1000/60) : 1` (frame-rate-independent, non-deterministic).
Deterministic parity scenes bypass this and step manually at `ratio = 1`.

### Public API (`node-particle.ts`, `npe-snippet.ts`)

`parseNodeParticleSetFromSnippet(engine, scene, snippetId, { json?, snippetServer?,
emitter?, emitterWorldMatrix?, textureBaseUrl? })` — parse (from JSON or the
snippet server) and build. `fetchNodeParticleSnippet` unwraps
`jsonPayload.nodeParticle`.

## Babylon.js Equivalence Map

| Babylon.js                                           | Babylon Lite                                    |
| ---------------------------------------------------- | ----------------------------------------------- |
| `NodeParticleSystemSet`                              | `NodeParticleSet` (plain state)                 |
| `NodeParticleSystemSet.buildAsync(scene)`            | `buildNodeParticleSet(engine, scene, graph, …)` |
| `NodeParticleBuildState`                             | `NpeBuildState`                                 |
| `_storedFunction` on a connection point              | `NpeGetter`                                     |
| `NodeParticleBlock._build`                           | `ParticleBlockEvaluator.build`                  |
| `ThinParticleSystem` / `ParticleSystem`              | `ParticleSystem` (`particle-system.ts`)         |
| `ThinParticleSystem.animate` → `_update`             | `animateParticleSystem`                         |
| `_createQueueStart` linked list                      | fixed named `_createX` slots                    |
| `_updateQueueStart` linked list                      | `_updateQueue` array                            |
| `Particle`                                           | `Particle` (`particle.ts`)                      |
| `Scalar.RandomRange`                                 | `randomRange` (`math/random-range.ts`)          |
| `Vector3.TransformCoordinates/NormalFromFloatsToRef` | `transformCoordinates/NormalToRef`              |
| `emitterWorldMatrix` / `emitterPosition`             | `state.emitterWorldMatrix` / `state.emitter`    |
| billboard vertex emit                                | `FacingBillboardSpriteSystem` instance write    |

## Gaps / Not Yet Supported (future work)

Deliberate scope boundaries — each is an **NPE-expressible** behaviour not yet
ported (a documented follow-up), not an accidental omission and not a
classic-`ParticleSystem`-only feature.

- **MULTIPLY blend (mode 3)** — currently maps to additive. Add a
  `billboardBlendMultiply` descriptor to `sprite/billboard-blend.ts`
  (`color: { srcFactor: "dst", dstFactor: "zero", operation: "add" }` → `src·dst`)
  and an arm in `blendForMode`. Data-only (no shader change), but needs a parity
  **scene + golden screenshot** to validate (blend is visual, not covered by the
  CPU determinism tests).
- **MULTIPLYADD blend (mode 4)** — "multiply then add" is not a single standard
  blend equation; needs a specific setup. Larger than MULTIPLY.
- **Sub-emitters / triggers** — `_inheritedVelocityOffset` (the emit-power add
  Lite omits), `ParticleTriggerBlock`, teleport blocks.
- **Noise / flow-map / attractor updates** — `UpdateNoiseBlock`,
  `UpdateFlowMapBlock`, `UpdateAttractorBlock` (each needs texture/data plumbing).
- **Mesh `worldSpace`** — the mesh emitter's own world matrix (distinct from the
  emitter world matrix) is not applied; geometry is sampled in mesh-local space.
- **`CustomShapeBlock`** — unsupportable: its generators are JS functions that
  never serialize.
- **`CameraPosition` system source (4)** — not handled (returns null path).
- **GPU particles** — no GPU simulation path exists or is planned here.
- **Object-runtime registry split** — the compatibility object's
  `npe-registry.ts` remains flat; SoA already uses measured lazy family registries.
- **Serialized-read helpers** — the repeated `typeof x === "number" ? x : default`
  guards match NME's convention; a shared `readNumber`/`readBoolean` helper would
  be an ergonomic win but should be introduced across NME _and_ particles together
  (decide by measuring bundle size — size beats style-consistency in Lite).

## Test Specification

- **CPU determinism (vitest)** — `tests/lite/unit/npe-particle-*.test.ts`: parse a
  graph fixture, build, seed `Math.random`, step `N`, sort by id, compare every
  particle to the committed Babylon ground truth at `1e-6`. Covers size, basic
  properties, sphere, and the four emitter shapes.
- **Emitter rotation (vitest)** — `npe-particle-emitter-rotation.test.ts`: the
  cylinder graph with a rotated + translated `emitterWorldMatrix`, compared to a
  Babylon oracle (the cylinder exercises `transformCoordinates` + the
  inverse/forward `transformNormal`). Fixtures carry the 16-element matrix.
- **Transform math (vitest)** — `mat4-transform.test.ts`: identity/translation/
  rotation cases for `transformCoordinatesToRef` / `transformNormalToRef` /
  `mat4GetTranslationToRef`.
- **Ground-truth extraction** — a throwaway harness in the Babylon repo (deleted
  after use); see contract §9. Convert (not `Parse`), `buildAsync`, rotated
  emitter mesh, null `_scene`, seed, step, dump graph + states.
- **SoA emitter/local parity (vitest)** — `particle-soa-emitters-parity.test.ts`
  covers all committed emitter oracles, volatile shared direction getters,
  source-24 build order, mesh color/InitialDirection, and transformed local box,
  point, sphere, cone, cylinder, and mesh behavior against the object oracle.
- **SoA behavioral-closure parity (vitest)** —
  `particle-soa-change-emit-rate-parity.test.ts` validates per-step system-time
  emit-rate gradients and float-to-int conversion;
  `particle-soa-change-speed-limit-parity.test.ts` validates vector magnitude and
  conditional selection. Both compare every live particle to committed Babylon
  state after 200 deterministic steps.
- **Pixel parity (Playwright)** — per-scene `.spec.ts` load a lab scene, wait for
  `animationFrozen`, screenshot, compare to the committed golden via MAD ≤
  `scene-config.json` `maxMad`. Goldens are captured once from the Babylon oracle
  with seeded RNG + fixed frame stepping and are immutable.
- **Bundle size** — per-scene manifest + ceiling in the bundle-size spec. `*-npe.ts`
  graph payload modules are excluded from bundle accounting (like `*-nme.ts`).
  `particle-soa-bundle-content.test.ts` rejects unused local/emitter chunks and
  rejects local-shape or matrix-inversion modules folded into fetched chunks.

## File Manifest

```
packages/babylon-lite/src/particle/
  particle.ts                      // Particle pure-state + pool reset
  particle-system.ts               // ParticleSystem state + animateParticleSystem + recycle
  particle-billboard.ts            // bind ParticleSystem -> FacingBillboardSpriteSystem instance buffer
  particle-scene.ts                // register/start/stop + per-frame animate hook
  node/
    node-particle.ts               // PUBLIC parseNodeParticleSetFromSnippet + NodeParticleSet
    npe-types.ts                   // immutable graph + build-context types + getter model
    npe-parser.ts                  // serialized JSON -> ParticleGraph
    npe-snippet.ts                 // snippet-server fetch
    npe-build.ts                   // post-order build walk (graph -> closures)
    npe-build-state.ts             // contextual/system sources + id validators
    npe-registry.ts                // lazy per-block dispatch
    blocks/
      system-block.ts
      create-particle-block.ts
      box-shape-block.ts  sphere-shape-block.ts  point-shape-block.ts
      cone-shape-block.ts  cylinder-shape-block.ts  mesh-shape-block.ts
      particle-input-block.ts  particle-random-block.ts  particle-math-block.ts
      particle-lerp-block.ts  particle-converter-block.ts  texture-source-block.ts
      update-position-block.ts  update-color-block.ts
      update-angle-block.ts  update-direction-block.ts
  soa/
    particle-buffer.ts             // dense base columns + lazy feature columns
    animate.ts                     // SoaSystem + fixed-slot indexed simulation
    npe-build.ts                   // root-reachable graph -> indexed operations
    contextual.ts                  // common contextual sources
    contextual-extra.ts            // lazy optional contextual sources
    registry.ts                    // common block dispatch
    registry-extra*.ts             // optional/basic/world-emitter dispatch
    registry-variants.ts           // rare serialized variants
    registry-local-shapes.ts       // local-only shape dispatch
    local-position.ts              // local birth transform after optional source-24 seed
    soa-billboard.ts               // SoA columns -> billboard instances
    blocks/
      box/point/sphere/cone/cylinder/mesh-shape-block.ts
      box/point/sphere/cone/cylinder/mesh-shape-local-block.ts
      particle-input-local-block.ts
      create/update/value/gradient/sprite blocks

packages/babylon-lite/src/math/
  random-range.ts                  // randomRange (Scalar.RandomRange)
  mat4-transform.ts                // transformCoordinates/Normal + mat4GetTranslation
  color4-ref.ts                    // copyColor4, scaleColor4ToRef (in-place)
  vec3-ref.ts                      // copyVec3 (+ the existing in-place vec3 family)
```
