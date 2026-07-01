# Module: Node Particle System (NPE)

> Package path: `packages/babylon-lite/src/particle/`
> Public entry: `parseNodeParticleSetFromSnippet()`
> Babylon.js equivalence: `BABYLON.NodeParticleSystemSet` → `ParticleSystemSet` of `ThinParticleSystem`s

## Purpose

Add support for **Node Particle Editor (NPE)** graphs — the particle-system analogue of the
Node Material Editor (NME) support that already lives in `material/node/`. An NPE graph (authored
at <https://npe.babylonjs.com> and saved to the Babylon snippet server) describes one or more
particle systems as a node graph: an emitter shape, per-particle creation values (lifetime, colour,
size, angle), and a chain of per-frame update steps (position, colour, size, angle, noise, …).

This module parses that graph and builds a **CPU-simulated particle system** whose particles are
rendered through Lite's existing **world-space billboard** renderer (`sprite/billboard-*`).

### Why this is structurally different from NME

| | NME (node material) | NPE (node particle) |
|---|---|---|
| Graph is consumed by | a one-time **WGSL shader** compile | a **per-particle, per-frame CPU evaluator** |
| Output artifact | a `GPURenderPipeline` (static) | a live `NodeParticleSet` (stateful simulation) |
| Runtime cost of the graph | zero (baked into the shader) | runs every frame on the CPU |
| Pre-existing Lite substrate | materials + render pipeline | **none** — Lite had no particle runtime |

So NPE support is **two layers**:

1. **A CPU particle runtime** (`particle/`) — emission, lifecycle, recycling, per-frame update,
   and writing particle state into a billboard instance buffer. This did not exist in Lite before.
2. **A node-graph layer** (`particle/node/`) — parser, build state, lazy block registry, and the
   per-particle closure builder that wires graph blocks onto the runtime. This mirrors `material/node/`.

The rendering layer is **reused, not rebuilt**: `createFacingBillboardSystem` + `billboardBlendAdditive`
already provide camera-facing, non-uniformly sized, per-instance-coloured, per-instance-rotated quads —
exactly what a particle system needs.

---

## Public API Surface

Designed to parallel `parseNodeMaterialFromSnippet`, and to obey GUIDANCE §4b (pure-state interfaces,
standalone functions, scene is the owner).

```typescript
// particle/node/node-particle.ts

export interface ParseNodeParticleOptions {
    /** Inline graph JSON (string or parsed object); bypasses the network. */
    json?: string | object;
    /** Override the snippet server origin. */
    snippetServer?: string;
    /** Override ParticleTextureSourceBlock URLs by block name → Texture2D. */
    textures?: Record<string, Texture2D>;
    /** Custom block-evaluator loader (parallels NME `blockLoader`). */
    blockLoader?: (className: string) => Promise<ParticleBlockEvaluator>;
}

/** Plain-state handle for a built node particle set (≈ BJS ParticleSystemSet). */
export interface NodeParticleSet {
    readonly systems: readonly ParticleSystem[];
    /** @internal parsed graph, kept for debugging / live edits. */
    _graph: ParticleGraph;
    // …internal build artifacts
}

export async function parseNodeParticleSetFromSnippet(
    scene: SceneContext,
    snippetId: string,
    options?: ParseNodeParticleOptions
): Promise<NodeParticleSet>;

// Lifecycle — standalone functions (GUIDANCE §4b′), scene drives per-frame animate().
export function startParticleSet(set: NodeParticleSet): void;
export function stopParticleSet(set: NodeParticleSet): void;
```

### Target scene usage (parallels the NME scenes)

```typescript
const set = await parseNodeParticleSetFromSnippet(scene, "", { json: SCENE262_NPE_JSON });
startParticleSet(set);
await registerScene(scene); // scene drives the per-frame CPU update + billboard upload
await startEngine(engine);
```

---

## Architecture Overview

```
snippet/JSON ──► npe-parser ──► ParticleGraph ──► npe-build ──► NodeParticleSet
                                     │                 │              │
                                     ▼                 ▼              ▼
                              npe-registry      per-particle      ParticleSystem[]
                            (lazy block evals)  create/update        (runtime)
                                                   closures             │
                                                                        ▼
                                                          billboard instance buffer
                                                         (createFacingBillboardSystem)
```

- **`particle/` (runtime, no graph knowledge):** `ParticleSystem` plain-state + `Particle` pool +
  `animateParticleSystem()` (emit/update/recycle) + the billboard binding.
- **`particle/node/` (graph layer):** parser, build state, registry, block evaluators, and the public
  `parseNodeParticleSetFromSnippet`. Blocks attach **closures** onto the runtime's create/update queues.

---

## Runtime: CPU Particle System

> Package path: `particle/particle-system.ts`, `particle/particle.ts`
> Mirrors the math of `Babylon.js/.../Particles/thinParticleSystem.pure.ts` (validated, not copied).

### Data structures (pure state, flat where it helps the GPU upload)

```typescript
interface Particle {
    position: Vec3; direction: Vec3;
    color: Color4; colorDead: Color4; initialColor: Color4; colorStep: Color4;
    age: number; lifeTime: number;
    angle: number; angularSpeed: number;
    size: number; scale: Vec2;
    cellIndex: number;
    // scratch / contextual
    _directionScale: number; _scaledDirection: Vec3; _initialDirection: Vec3; _localPosition: Vec3;
}

interface ParticleSystem {
    capacity: number; emitRate: number; updateSpeed: number;
    targetStopDuration: number; startDelay: number;
    preWarmCycles: number; preWarmStepOffset: number;
    blendMode: number; billboardMode: number; isBillboardBased: boolean; isLocal: boolean;
    texture: Texture2D | null; textureMask: Color4; translationPivot: Vec2;
    emitter: Vec3;                       // emitter position (world)
    // runtime state
    _particles: Particle[]; _stock: Particle[];
    _started: boolean; _stopped: boolean; _actualFrame: number; _newPartsExcess: number;
    _scaledUpdateSpeed: number; _emitterWorldMatrix: Mat4; _emitterInverseWorldMatrix: Mat4;
    // graph-attached closures (see node layer)
    _createQueue: ProcessItem[];         // lifetime, colour, size, angle, position, direction…
    _updateQueue: ProcessItem[];         // position, colour, size, angle, …
    _emitPower: number;                  // set by the create closure
    // rendering
    _billboard: FacingBillboardSpriteSystem;
}

type ProcessItem = (p: Particle, sys: ParticleSystem) => void;
```

### Per-frame algorithm — `animateParticleSystem(sys, scaledRatio)`

A faithful re-statement of `thinParticleSystem.animate` + `_update` + `_createNewOnes`:

```
scaledUpdateSpeed = updateSpeed * scaledRatio          // scaledRatio = animationRatio (live) or preWarmStepOffset (prewarm)
newParticles      = trunc(emitRate * scaledUpdateSpeed)
_newPartsExcess  += emitRate * scaledUpdateSpeed - newParticles
if (_newPartsExcess > 1) { newParticles += trunc(_newPartsExcess); _newPartsExcess -= trunc(_newPartsExcess) }
_actualFrame     += scaledUpdateSpeed
if (targetStopDuration && _actualFrame >= targetStopDuration) stop()

// update existing
for (i = 0; i < _particles.length; i++):
    p = _particles[i]
    tmp = scaledUpdateSpeed; prevAge = p.age; p.age += tmp
    if (p.age > p.lifeTime):                              // clamp the final partial step
        tmp = (p.lifeTime - prevAge) * tmp / (p.age - prevAge); p.age = p.lifeTime
    p._directionScale = tmp
    for item in _updateQueue: item(p, sys)               // graph update closures
    if (p.age >= p.lifeTime): recycle(swap with last); i--; continue

// create new
for (n = 0; n < newParticles && _particles.length < capacity; n++):
    p = _stock.pop()?reset() ?? newParticle()
    _particles.push(p)
    for item in _createQueue: item(p, sys)               // graph create closures (emitter shape, colour, …)
```

The update is identical whether live or pre-warming; only `scaledRatio` differs. Pre-warm runs
`preWarmCycles` iterations with `scaledRatio = preWarmStepOffset` **before** the first rendered frame.

### Recycling

Dead particles are swapped with the last live particle and pushed onto `_stock` for reuse (zero
allocation in steady state), exactly as BJS does. The swap order matters for parity because it
determines which billboard instance slot a particle occupies.

### Random-call discipline (parity-critical — see §Determinism)

The **order and count** of `Math.random()` calls during creation must match BJS exactly. The emitter
shape block is normally the only creation step that consumes random values (e.g. `PointShapeBlock`
calls `RandomRange` three times: X, Y, Z of the start direction). `RandomRange(min,max) = min + (max-min)*Math.random()`.

Creation runs a fixed slot order — lifeTime (which also draws `_emitPower`), position, direction,
**emitPower**, size, angle, colour, colourDead — and each slot must draw the same randoms in the same
order as BJS. The **emitPower slot scales the (unit) emission direction by `_emitPower`** so a particle's
velocity magnitude equals its emit power, mirroring BJS `_CreateEmitPowerData` (a zero emit power parks the
particle and stashes its facing in `_initialDirection`). This is silent when `minEmitPower === maxEmitPower
=== 1` (the direction is unit either way) but parity-critical once emit power varies, e.g. the sphere scene.

Shape blocks implemented so far: `BoxShapeBlock` (uniform point in `[minEmitBox, maxEmitBox]`, direction
`RandomRange(direction1, direction2)`) and `SphereShapeBlock` (uniform spherical-coordinate point of
`radius`/`radiusRange`, direction radially outward from the emitter with optional `directionRandomizer`).

---

## Node Graph Layer

> Package path: `particle/node/`. Mirrors `material/node/` file-for-file in spirit.

### `npe-types.ts`
Pure graph data: `ParticleBlock { id, className, name, inputs: Map<name, {source|null}>, outputs, serialized }`,
`ParticleGraph { blocks: Map<id, ParticleBlock>, systemBlockIds: number[] }`, `ParticleBuildState`,
`ParticleBlockEvaluator`. No module-level state.

### `npe-parser.ts`
`parseNodeParticleSource(json) → ParticleGraph`. The snippet nests as
`jsonPayload → { nodeParticle: "<stringified graph>" }` (cf. NME's `nodeMaterial`). The graph object has
`{ name, customType, editorData, blocks[] }`; each block carries `customType` (e.g. `BABYLON.SystemBlock`),
`id`, `name`, `inputs[] ({ name, targetBlockId?, targetConnectionName? })`, `outputs[]`, and block-specific
serialized fields (`value`, `valueType`, `type`, `url`, `capacity`, `blendMode`, …). The system roots are
the blocks whose `customType` is `SystemBlock`.

### `npe-snippet.ts`
`fetchNodeParticleSnippet(id, server?)` — fetch `https://snippet.babylonjs.com/{id}` and unwrap the
nested `nodeParticle` payload. Same shape as `node-snippet.ts`.

### `npe-build.ts`
`buildNodeParticleSet(scene, graph, evaluators, opts) → NodeParticleSet`. For each `SystemBlock` root it
walks the `particle` input chain (System ← AlignAngle ← BasicPositionUpdate ← PointShape ← CreateParticle),
calls each block evaluator's `build(state)` to attach create/update closures onto a fresh `ParticleSystem`,
applies `SystemBlock` properties (capacity, emitRate, blendMode → billboard blend, texture), and creates the
backing `FacingBillboardSpriteSystem`.

`ParticleBuildState` carries the per-particle evaluation context — the analogue of BJS
`NodeParticleBuildState`: `particleContext`, `systemContext`, `emitterWorldMatrix`, `getContextualValue()`,
`adapt()`. Input/value blocks resolve through `getConnectedValue(state)`.

### `npe-registry.ts` (+ future `npe-registry-extra-*.ts`)
`loadParticleBlockEvaluator(className) → Promise<ParticleBlockEvaluator>` — a `switch` of
`() => import("./blocks/…")` arms, one per block class, so a scene bundles only the blocks its graph uses
(tree-shaking; unused blocks cost zero bytes). Mirrors `node-registry.ts`. Rarely-used block families move
to `npe-registry-extra-*.ts` later to keep common scenes lean.

### `particle/node/blocks/*`
One file per block, each exporting a pure `ParticleBlockEvaluator`:

```typescript
interface ParticleBlockEvaluator {
    /** Attach this block's behaviour (closures / values) during the build walk. */
    build(block: ParticleBlock, state: ParticleBuildState, ctx: BuildContext): void;
    /** Resolve an output value for a downstream input (Input/value/math blocks). */
    value?(block: ParticleBlock, outputName: string, state: ParticleBuildState, ctx: BuildContext): unknown;
}
```

---

## Scene-1 Block Set (NPE "Angle align", snippet `W5054F`)

The first reference scene (Scene 262) uses the only dedicated NPE Babylon.js visual test ("NPE - Angle align",
playground `#H5RP91` → graph snippet `W5054F`). Seven block classes:

| Block | Role | Behaviour |
|---|---|---|
| `SystemBlock` | root | capacity 1000, emitRate 10, blendMode 0 (ONEONE → additive), flare texture |
| `CreateParticleBlock` | particle factory | create-queue: lifeTime=1, colour=white, colorDead=0, size=1, scale=(0.1,1), angle=0, emitPower=1 |
| `PointShapeBlock` | emitter shape | create-queue: position=origin; direction = `RandomRange((-1,-1,-1),(1,1,1))` per component |
| `BasicPositionUpdateBlock` | update | update-queue: `position += direction * _directionScale` |
| `AlignAngleBlock` | update | update-queue: `angle = atan2(dirView.y, dirView.x) + π/2` (direction in camera-view space) |
| `ParticleTextureSourceBlock` | texture | loads `flare.png` → 1-frame sprite atlas |
| `ParticleInputBlock` | constants | Vector2 `(0.1,1)` → scale; two Vector3 → direction1/direction2 |

### Billboard mapping (no new billboard code needed)

```
sizeWorld = [particle.size * particle.scale.x, particle.size * particle.scale.y]   // (0.1 × 1) → stretched
rotation  = particle.angle                                                          // from AlignAngle
color     = particle.color                                                          // RGBA, multiplies texture
```
System is `createFacingBillboardSystem(atlas, { blendMode: billboardBlendAdditive, capacity })`.

---

## Determinism & Parity Strategy

Particle output depends on `Math.random()`. The Babylon.js visual-test harness
(`tools/tests/.../visualizationPlaywright.utils.ts`) makes it deterministic by seeding:

```js
let seed = 1;
Math.random = () => { const x = Math.sin(seed++) * 10000; return x - Math.floor(x); };
```

We do **not** rely on the upstream harness's frame timing. Instead, following GUIDANCE §2c
(deterministic-freeze for animated scenes), we **control both sides**:

1. A BJS **oracle** scene and the Lite scene each install the identical seeded `Math.random` at the very top.
2. Both build the identical graph (`W5054F`, committed inline as `scene262-npe.ts`).
3. Both step the simulation a **fixed** number of frames with a **fixed** `scaledRatio`, then freeze
   (`canvas.dataset.animationFrozen = "true"`) and snapshot.

Identical CPU algorithm + identical RNG sequence + identical step count ⇒ identical particle
position/colour/angle on both engines. The only residual is rasterisation of the billboard quads,
which the existing billboard parity already keeps tight. The golden is captured **once** from the BJS
oracle and committed (per GUIDANCE §2c); it is **not** the upstream `npe-angle-align.png` (different
frame timing).

> Build-time detail to verify empirically: `preWarmStepOffset` defaults to `0` on `SystemBlock`, which
> makes pre-warm a no-op; the golden state is therefore whatever the fixed post-start frame count produces.
> Because both sides use identical settings, the exact value does not affect parity.

---

## Babylon.js Equivalence Map

| Babylon.js | Babylon Lite |
|---|---|
| `NodeParticleSystemSet` | `NodeParticleSet` (plain state) |
| `NodeParticleSystemSet.buildAsync(scene)` | `buildNodeParticleSet(scene, graph, …)` |
| `NodeParticleBuildState` | `ParticleBuildState` |
| `ThinParticleSystem` / `ParticleSystem` | `ParticleSystem` (`particle/particle-system.ts`) |
| `Particle` | `Particle` (`particle/particle.ts`) |
| `ParticleSystem.animate()` | `animateParticleSystem(sys, scaledRatio)` |
| `_createQueueStart` / `_updateQueueStart` linked lists | `_createQueue` / `_updateQueue` arrays |
| `SystemBlock`, `CreateParticleBlock`, `PointShapeBlock`, `BasicPositionUpdateBlock`, `AlignAngleBlock`, `ParticleTextureSourceBlock`, `ParticleInputBlock` | `blocks/*` evaluators of the same names |
| `RandomRange(min,max)` | `randomRange(min,max)` (`particle/particle-math.ts`) |
| billboard vertex emit (`_appendParticleVertex`) | `FacingBillboardSpriteSystem` instance write |

---

## Tree-Shaking / Bundle Size

- Block evaluators are dynamically imported per class via `npe-registry.ts` (`() => import(...)`),
  so a scene bundles only the blocks its graph references. Zero module-level allocations (GUIDANCE §4).
- The graph JSON lives in a per-scene `lab/lite/src/shared/scene262-npe.ts` payload module. Like the
  NME `*-nme.ts` payloads, **`*-npe.ts` modules are excluded from bundle-size accounting** — this
  requires adding `*-npe.ts` to the exclusion list in `scripts/bundle-scenes-core.ts` alongside `*-nme.ts`.
- The CPU runtime and the billboard renderer are the only mandatory runtime bytes; the graph layer and
  unused blocks tree-shake away for scenes that do not use NPE.

---

## Test Specification

- **Parity:** `tests/lite/parity/scenes/scene262-npe-angle-align.spec.ts` loads `scene262.html`, waits for
  `animationFrozen`, screenshots, and compares against the committed golden via MAD ≤ `scene-config.json` `maxMad`.
- **Golden:** `reference/lite/scene262-npe-angle-align/babylon-ref-golden.png`, captured once from the BJS oracle
  with the seeded RNG + fixed frame stepping.
- **Bundle size:** ceiling in `tests/lite/parity/bundle-size.spec.ts` + per-scene manifest
  `lab/public/bundle/manifest/scene262.json`.
- **Unit:** runtime emit/update/recycle and `randomRange` sequence covered by vitest where practical.

---

## File Manifest

```
packages/babylon-lite/src/particle/
  particle.ts                      // Particle pure-state + pool reset
  particle-system.ts               // ParticleSystem state + animateParticleSystem + recycle
  particle-math.ts                 // randomRange, vec/colour scratch helpers
  particle-billboard.ts            // bind ParticleSystem → FacingBillboardSpriteSystem instance buffer
  particle-scene.ts                // register/start/stop + per-frame animate hook into SceneContext
  node/
    node-particle.ts               // PUBLIC parseNodeParticleSetFromSnippet + NodeParticleSet
    npe-types.ts
    npe-parser.ts
    npe-snippet.ts
    npe-build.ts
    npe-registry.ts
    blocks/
      system-block.ts
      create-particle-block.ts
      point-shape-block.ts
      particle-input-block.ts
      texture-source-block.ts
      basic-position-update-block.ts
      align-angle-block.ts
```

Plus scene wiring: `lab/lite/scene262.html`, `lab/lite/src/lite/scene262.ts`,
`lab/lite/src/shared/scene262-npe.ts`, `lab/vite.config.ts` input, `scene-config.json` entry,
`tests/lite/parity/scenes/scene262-npe-angle-align.spec.ts`, the BJS oracle reference HTML, the golden,
the thumbnail, and the `index.ts` exports.

---

## Incremental Scene Roadmap

Scene 262 is the minimum vertical slice (one emitter shape, one position update, angle alignment, additive
billboards). Subsequent scenes grow coverage one block family at a time, each with its own parity golden:
box/sphere/cone emitter shapes, colour-over-life and size-over-life updates, gradients, math/lerp/random
value blocks, sprite-sheet animation, and multi-system sets. Each new block is added to `npe-registry.ts`
and, once common scenes would otherwise pay for it, relocated into an `npe-registry-extra-*.ts` chunk.
