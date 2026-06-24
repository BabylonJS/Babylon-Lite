# Module: flow-graph

> Package path: `packages/babylon-lite/src/flow-graph/`
>
> Status: **DESIGN / PORT PLAN** (no runtime code yet). This document is the
> formal specification for porting the Babylon.js `FlowGraph` system to Babylon
> Lite. It is written so that the subsystem can be implemented from this doc
> alone, in line with GUIDANCE §4 (Documentation-Driven Architecture).

---

## Purpose

The flow graph is Babylon's **visual scripting / behaviour runtime**: a directed
graph of nodes ("blocks") that react to engine events and drive scene behaviour
(animate properties, play sounds, branch on conditions, do math). Its primary
real-world consumer is the glTF **`KHR_interactivity`** extension, which embeds
an interactivity graph inside a `.glb` and expects the engine to execute it at
runtime.

**Goal of this port (phase priority, locked):** load and run interactive glTF
assets. The plan therefore phases:

1. a minimal **pure-state runtime** (graph + context + connection model),
2. the **subset of blocks** that `KHR_interactivity` actually maps to, and
3. the **`loader-gltf` extension** that parses the interactivity JSON into a
   Lite graph and resolves JSON pointers to scene accessors.

Full editor-authored parity (all ~170 BJS blocks, the BJS snippet/serialization
format, the debugger, multi-context coordinators) is explicitly **out of scope
for the MVP** and is listed as later phases.

> **⚠️ Spec stability caveat (read before touching `flow-graph/gltf/`):**
> `KHR_interactivity` is **not yet ratified** and is actively changing; Babylon.js
> is reworking its implementation to the newer spec draft in
> **[PR #18455 "KHR_interactivity rework"](https://github.com/BabylonJS/Babylon.js/pull/18455)**
> (currently closed-for-age, expected to be reopened/merged soon). This port
> therefore **isolates all spec-dependent code in `flow-graph/gltf/`** and keeps
> the runtime core spec-agnostic, so future spec revisions are cheap, localized
> edits. See "The spec is NOT ratified" under the loader section and the risks at
> the end.

---

## Architectural Decision: Pure-State, Not Classes

Babylon.js `FlowGraph` is a deep OOP hierarchy
(`FlowGraphBlock` → `FlowGraphExecutionBlock` → `FlowGraphAsyncExecutionBlock` →
`FlowGraphEventBlock`), with methods on every node, a **global class registry**
(`RegisterClass`) used for deserialization, and module-level `new RichType(...)`
allocations. None of that is permitted in Lite (GUIDANCE §4b′ pure-state
interfaces, §4 zero module-level side effects, 100% tree-shakable).

**Lite re-architects the same semantics as data + functions:**

| Concern | Babylon.js (OOP) | Babylon Lite (pure-state) |
|---|---|---|
| A node | `class FooBlock extends FlowGraphBlock` with methods | `FgBlock` **plain data** + a `FgBlockDef` record of **pure functions** |
| Node behaviour | `block._execute(ctx)` method | `def.execute(block, ctx, env, signal)` standalone fn |
| Data output calc | `block._updateOutputs(ctx)` method | `def.updateOutputs(block, ctx, env)` standalone fn |
| Type info | `class RichType` instances at module scope | `const enum FgType` string tags + pure `defaultForType()` |
| className → ctor | global `RegisterClass` registry (side-effect) | tree-shakable `getBlockDef(type)` dynamic-import switch |
| Per-run state | fields on `FlowGraphContext` instance | `FgContext` **plain data** mutated by standalone fns |
| Scene access | block holds/queries `Scene` | block touches **only accessors/handles** wired by the loader; the scene **owns and drives** the graph |

The key insight that makes this clean: **BJS already keeps per-instance state in
`FlowGraphContext` keyed by block `uniqueId`, not on the block.** The block is
nearly a stateless definition already. Lite finishes the job — the block becomes
*pure data describing topology*, and all behaviour moves into a registry of pure
functions. This also means **porting one block = writing one small data record +
one or two pure functions**, which keeps future block ports mechanical (see the
companion skill `port-flow-graph-block.md`).

This mirrors two existing Lite patterns:

- **`loader-gltf/gltf-feature-registry.ts`** — `[trigger, () => import(...)]`
  tuples, dynamic-imported only when needed. The block registry uses the same
  idea.
- **BJS's own `blockFactory`** — already a tree-shakable `switch` of dynamic
  imports (no global side effect). We keep that shape; we only drop the class
  bodies behind it.

---

## One-Way Ownership & Scene Drive Model (Critical)

GUIDANCE §4b forbids components from referencing the scene. A flow graph
obviously needs to read/write node transforms, fire on scene events, and play
animations — so the wiring is inverted exactly like the animation subsystem:

- The **scene owns** the graphs: `scene._flowGraphs: FgRuntime[]` (plain data).
- The graph is **driven** by the scene's existing per-frame hook
  (`onBeforeRender(scene, cb)` → `scene._beforeRender`), exactly how animation
  groups are ticked (`ctx._beforeRender.push(deltaMs => …)`).
- Blocks **never see the scene**. Anything scene-dependent is pre-resolved by the
  **loader** into plain capability objects stored in `FgEnv`:
  - **Object accessors** (`FgAccessor { get, set?, target }`) — closures over the
    already-loaded Lite scene objects, produced when a glTF JSON pointer is
    resolved. A `pointer/get` block just calls `accessor.get()`.
  - **Animation handles** — references to the `AnimationGroup` plain-data objects
    the glTF loader already created.
  - **Event sources** — an `FgEventBus` the scene driver feeds (tick, start,
    pointer, key). Event blocks subscribe to the bus, not to the scene.

This keeps the dependency arrow pointing **scene → flow-graph**, never the
reverse, preserving zero circular deps and tree-shakability.

---

## Public API Surface

All exported from `packages/babylon-lite/src/flow-graph/index.ts` and re-exported
from the package `index.ts`. Everything is plain data + standalone functions.

### Core data types (`flow-graph/types.ts`)

```typescript
/** A value that can flow along a data edge. */
export type FgValue =
    | number | boolean | string
    | Vec2 | Vec3 | Vec4 | Quat | Mat4
    | FgInteger        // tagged 32-bit int (see CustomTypes below)
    | FgMatrix2D | FgMatrix3D
    | Color3 | Color4
    | null | undefined;

/** Type tags. const enum → fully erased at build, zero runtime cost. */
export const enum FgType {
    Any = "any",
    Number = "number",
    Boolean = "boolean",
    String = "string",
    Integer = "FlowGraphInteger",
    Vector2 = "Vector2",
    Vector3 = "Vector3",
    Vector4 = "Vector4",
    Quaternion = "Quaternion",
    Matrix = "Matrix",
    Matrix2D = "Matrix2D",
    Matrix3D = "Matrix3D",
    Color3 = "Color3",
    Color4 = "Color4",
}

/** A data input/output port — plain data. */
export interface FgDataSocket {
    readonly name: string;
    readonly type: FgType;
    /** wired source (for inputs): producing block id + its output socket name */
    source?: { blockId: string; socket: string };
    /** literal fallback used when `source` is undefined */
    defaultValue?: FgValue;
}

/** A control-flow (signal) port — plain data. Push model. */
export interface FgSignalSocket {
    readonly name: string;
    /** wired targets (for outputs): consuming block id + its input signal name */
    readonly targets: { blockId: string; socket: string }[];
}

/** A node instance — PURE DATA describing topology + config only. */
export interface FgBlock {
    readonly id: string;
    readonly type: string;                 // FgBlockType value or "module/Name"
    readonly config?: Readonly<Record<string, unknown>>;
    readonly dataIn: readonly FgDataSocket[];
    readonly dataOut: readonly FgDataSocket[];
    readonly signalIn: readonly FgSignalSocket[];
    readonly signalOut: readonly FgSignalSocket[];
    /** declared by event blocks; which bus event activates them */
    readonly event?: FgEventType;
}

/** A parsed graph — pure data. */
export interface FgGraph {
    readonly blocks: readonly FgBlock[];
    /** id → block index, for O(1) edge resolution (built by the parser) */
    readonly byId: Readonly<Record<string, number>>;
    /** declared graph variables: name → { type, initialValue } */
    readonly variables: Readonly<Record<string, { type: FgType; value: FgValue }>>;
}
```

### Behaviour definitions (`flow-graph/block-def.ts`)

```typescript
/** The shape a def declares when a block is instantiated. */
export interface FgBlockShape {
    dataIn?: FgDataSocket[];
    dataOut?: FgDataSocket[];
    signalIn?: FgSignalSocket[];
    signalOut?: FgSignalSocket[];
    event?: FgEventType;
}

/**
 * Pure behaviour record for one block type. No classes, no `this`.
 * Exactly ONE of these per block kind; this is what a porter writes.
 */
export interface FgBlockDef {
    readonly type: string;

    /** Declare sockets/signals from config (called once at instantiation). */
    readonly build: (config: Readonly<Record<string, unknown>> | undefined) => FgBlockShape;

    /** DATA blocks: compute outputs from inputs (PULL). Pure-ish: writes via setDataValue. */
    readonly updateOutputs?: (block: FgBlock, ctx: FgContext, env: FgEnv) => void;

    /** EXECUTION blocks: run when an input signal fires (PUSH). For async blocks
     *  this is also where a task is started, via addPending(ctx, block). */
    readonly execute?: (block: FgBlock, ctx: FgContext, env: FgEnv, incomingSignal: string) => void;

    /** ASYNC blocks: advance one outstanding task each frame (e.g. delay countdown,
     *  animation progress). The tick loop passes the specific FgPendingTask. */
    readonly onTick?: (block: FgBlock, ctx: FgContext, env: FgEnv, deltaMs: number, task: FgPendingTask) => void;
    /** ASYNC blocks: teardown hook called on dispose/cancel; mark tasks canceled. */
    readonly cancelPending?: (block: FgBlock, ctx: FgContext, env: FgEnv) => void;
}
```

### Execution context & environment (`flow-graph/context.ts`)

```typescript
/** Per-execution-instance MUTABLE state — plain data. */
export interface FgContext {
    /** data transport slots: `${blockId}:${socket}` → last value the producer wrote.
     *  NOT a validity cache — producers recompute on every pull (see execution model). */
    readonly connectionValues: Record<string, FgValue>;
    /** per-block scratch: `${blockId}:${key}` → value (counter state, async tokens, resolving guard) */
    readonly executionVariables: Record<string, unknown>;
    /** live graph variable values (seeded from FgGraph.variables) */
    readonly userVariables: Record<string, FgValue>;
    /** async task records, ticked each frame (deduped; carry cancel tokens) */
    readonly pending: FgPendingTask[];
    /** glTF graphs are right-handed; drives Z/handedness coercion on read */
    readonly rightHanded: boolean;
}

/** One outstanding async task (a delay, an animation). Token enables precise cancel. */
export interface FgPendingTask {
    readonly blockId: string;
    readonly token: number;        // unique per task; a block may own several concurrently
    canceled: boolean;
    state: Record<string, unknown>; // e.g. remainingMs, delayIndex, animation handle
}

/** Per-graph RESOLVED capabilities, wired by the loader. Read-mostly. */
export interface FgEnv {
    readonly graph: FgGraph;
    /** block defs resolved up-front (awaited dynamic imports), type → def */
    readonly defs: Record<string, FgBlockDef>;
    /** scene-object accessors resolved from JSON pointers, keyed by pointer id */
    readonly accessors: Record<string, FgAccessor>;
    /** animation handles by glTF animation index */
    readonly animations: readonly AnimationGroup[];
    /** scene-owned capabilities blocks may invoke WITHOUT a scene reference:
     *  play/stop animation, create a temp interpolation group, subscribe to
     *  animation-end, etc. Provided by the loader/animation subsystem. */
    readonly caps: FgCapabilities;
    /** event bus the scene driver feeds */
    readonly events: FgEventBus;
}

export interface FgAccessor {
    readonly type: FgType;
    readonly get: () => FgValue;
    readonly set?: (value: FgValue) => void;
    readonly target?: unknown;
}
```

### Standalone runtime functions (`flow-graph/runtime.ts`)

```typescript
/** PULL a data input: resolve source, run its def.updateOutputs, read cache. */
export function getDataValue(ctx: FgContext, env: FgEnv, block: FgBlock, socket: string): FgValue;
/** Write a data output into the cache (called from def.updateOutputs). */
export function setDataValue(ctx: FgContext, block: FgBlock, socket: string, value: FgValue): void;
/** PUSH a signal: for each target, dispatch into its def.execute. */
export function activateSignal(ctx: FgContext, env: FgEnv, block: FgBlock, socket: string): void;

/** Instantiate runtime state for a parsed graph. */
export function createFgContext(graph: FgGraph, opts?: { rightHanded?: boolean }): FgContext;
/** Build the resolved env (await needed defs, attach accessors/animations/bus). */
export function createFgEnv(graph: FgGraph, wiring: FgWiring): Promise<FgEnv>;

/** One graph runtime = graph + context + env, owned by the scene. */
export interface FgRuntime {
    readonly graph: FgGraph;
    readonly context: FgContext;
    readonly env: FgEnv;
    started: boolean;
}

/** Start the graph: fire `onStart` event blocks once. */
export function startFlowGraph(rt: FgRuntime): void;
/** Per-frame drive: pump tick events + advance pending async blocks. */
export function tickFlowGraph(rt: FgRuntime, deltaMs: number): void;
/** Tear down: cancel pending, clear caches, detach bus listeners. */
export function disposeFlowGraph(rt: FgRuntime): void;
```

### Block-type names & registry (`flow-graph/block-type.ts`, `block-registry.ts`)

```typescript
/** Lite block type identifiers (const enum string tags). */
export const enum FgBlockType {
    // Events
    SceneStart = "SceneReadyEvent",
    SceneTick = "SceneTickEvent",
    SendCustomEvent = "SendCustomEvent",
    ReceiveCustomEvent = "ReceiveCustomEvent",
    // Control flow
    Branch = "Branch", Sequence = "Sequence", Switch = "Switch",
    ForLoop = "ForLoop", WhileLoop = "WhileLoop", DoN = "DoN",
    MultiGate = "MultiGate", WaitAll = "WaitAll", Throttle = "Throttle",
    SetDelay = "SetDelay", CancelDelay = "CancelDelay",
    // Data / math (subset; see block list)
    Constant = "Constant", Add = "Add", Subtract = "Subtract", /* … */
    // Pointer / variable / animation
    GetProperty = "GetProperty", SetProperty = "SetProperty",
    JsonPointerParser = "JsonPointerParser",
    GetVariable = "GetVariable", SetVariable = "SetVariable",
    ValueInterpolation = "ValueInterpolation",
    PlayAnimation = "PlayAnimation", StopAnimation = "StopAnimation",
    // Debug
    ConsoleLog = "ConsoleLog",
}

/**
 * Tree-shakable, side-effect-free. Returns a lazy loader for one def.
 * Unused cases are code-split and never fetched — zero bytes for scenes
 * without interactivity. Mirrors BJS blockFactory + Lite gltf-feature-registry.
 */
export function getBlockDef(type: string): () => Promise<FgBlockDef> {
    switch (type) {
        case FgBlockType.Branch:
            return async () => (await import("./blocks/control-flow/branch.js")).branchDef;
        case FgBlockType.Add:
            return async () => (await import("./blocks/math/add.js")).addDef;
        // … one case per supported block …
        default:
            return null; // unknown type — caller decides (see note)
    }
}
```

> **Note on side effects:** the `switch` function body is pure (no module-level
> allocation), so the registry module is fully tree-shakable.
>
> **Unknown ops:** `getBlockDef` returns `null` for unknown types; the **caller**
> chooses the policy. The **glTF interactivity parser fails loudly** (collects a
> structured `unsupportedOp` diagnostic and aborts/flags that graph) so a
> `KHR_interactivity` asset can't silently render a broken interaction. A
> permissive editor/snippet path (post-MVP) may instead substitute an explicit
> `noopDef`. Never silently swallow an unknown op on the KHR path — it makes
> parity failures undiagnosable.

---

## Internal Architecture

### Execution model (pull data, push signals)

Identical semantics to BJS, re-expressed functionally:

- **Data edges are PULL, and recompute on every pull.** When a block needs an
  input, `getDataValue` looks at the socket's `source`. If wired, it finds the
  producing block and **invokes that block's `def.updateOutputs` every time**
  (matching BJS `FlowGraphDataConnection.getValue`, which calls the owner's
  `_updateOutputs` on each read). `ctx.connectionValues` is the **transport slot**
  the producer writes into and the consumer reads back — **not** a validity
  cache. Do **not** skip recomputation based on a cached value: producers like
  `pointer/get`, `GetVariable`, `random`, and event-payload outputs would return
  stale data after an intervening `pointer/set`/`SetVariable` in the same
  cascade. (A future optimization may add explicit dirty-tracking with cascade
  IDs, but it must exclude all non-pure producers; the MVP recomputes.)
- **Cycles.** Data pulls assume an acyclic data subgraph (as glTF interactivity
  requires). `getDataValue` carries an in-progress guard
  (`ctx.executionVariables["${id}:resolving"]`) to break accidental data cycles
  and return the socket default rather than recursing infinitely.
- **Type coercion on read.** `getDataValue` applies (a) any socket/port
  `dataTransformer` declared by the declaration mapper, then (b) `coerceValue`
  for the consumer socket's `FgType` — this is where BJS's RichType
  `typeTransformer` lives (notably `Vector4`/`Matrix` → `Quaternion`). Coercion
  happens at the boundary so block bodies stay type-clean.
- **Signal edges are PUSH.** `activateSignal` iterates `signalSocket.targets`;
  for each, it looks up the target block's def and calls `def.execute`, passing
  the incoming signal name. Execution blocks call `activateSignal` on their own
  outputs to continue the cascade.
- **Event blocks** declare `event: FgEventType`. The scene driver, on receiving a
  bus event, finds matching event blocks and fires their output signals
  (`out` / `done`), starting a cascade. **Listener registration ordering is
  significant:** `startFlowGraph` first subscribes/initializes *all* event
  receivers (in init-priority order — `ReceiveCustomEvent` before scene-start-like
  events, matching BJS `initPriority`), and *only then* fires the `onStart`
  cascade. Otherwise a graph like `onStart → SendCustomEvent → ReceiveCustomEvent`
  would drop the event because the receiver wasn't listening yet. Custom events
  are **scene/coordinator-scoped**, not per-graph, so multiple `KHR_interactivity`
  graphs in one asset can communicate.
- **Async blocks** (`SetDelay`, `PlayAnimation`) register an `FgPendingTask` via
  `addPending(ctx, block)` (which assigns a unique token and **dedupes** so a
  block re-entered while already pending does not double-tick), get `onTick`'d
  each frame, and fire a completion signal (`done`) when finished, then remove
  the task. A single block may own **multiple concurrent tasks** (BJS supports
  several in-flight delays per block, tracked by index) — state lives on the
  task record, not the block. `cancelPending` marks the matching task(s)
  `canceled`; the tick loop skips canceled/removed tasks (see below).

### Async task lifecycle (ordering hazards)

The per-frame pending loop must be cancellation-safe. A task can be canceled or a
new task added **during** the loop by another block's signal cascade. Rules:

```
for task of ctx.pending.slice():          // snapshot
  if task.canceled: continue              // skip if canceled this frame
  if !stillPending(ctx, task): continue   // skip if already removed
  env.defs[blockOf(task)].onTick(task, …) // may add/cancel further tasks
ctx.pending = ctx.pending.filter(t => !t.canceled && !t.done)  // compact after
```

Tasks added mid-loop are picked up next frame (not retro-ticked), matching BJS.
Each `FgContext` has its own `pending` list, so multiple contexts (multi-actor)
never interfere.

### Per-frame flow

```
scene._beforeRender(deltaMs)               // existing Lite hook
  └─ for rt of scene._flowGraphs:
       if !rt.started:
         registerEventListeners(rt)         // subscribe ALL receivers first (init-priority order)
         startFlowGraph(rt)                  // THEN fire onStart event blocks once
       tickFlowGraph(rt, deltaMs):
         resetCustomEventRecursionCounters(rt.context)   // guard against runaway re-entrancy
         env.events.pump("tick", { deltaTime: deltaMs/1000 })  // → onTick blocks
         for task of ctx.pending.slice():   // cancellation-safe (see async lifecycle)
           if task.canceled || !stillPending(ctx, task): continue
           env.defs[blockOf(task)].onTick?.(task, ctx, env, deltaMs)
         compactPending(ctx.context)
```

Pointer/key events are fed into `env.events` by the picking/input layer the same
way (the scene driver forwards them); event blocks for those simply subscribe to
the corresponding bus channel.

### Custom math & types live IN the subsystem (bundle discipline)

Lite's core `math/` module is intentionally minimal (Vec3-centric; **no Vec2,
no general quaternion/matrix algebra**). Flow-graph math blocks need Vec2,
quaternion mul/conjugate/slerp, matrix transpose/determinant/inverse/compose/
decompose, integer bitwise ops, etc. Per GUIDANCE §4c′ (always extensions, never
bloat the core) these helpers live **inside `flow-graph/`** (e.g.
`flow-graph/fg-math.ts`, `flow-graph/custom-types/`), lazily imported by the
blocks that use them. Scenes without interactivity pay **zero bytes**. Core
`math/` is reused where it already suffices (`addVec3`, `dotVec3`, `crossVec3`,
`mat4Multiply`, `mat4Invert`, `mat4Compose`, `mat4Decompose`, `mat4FromQuat`).

### Custom types (`flow-graph/custom-types/`)

- `FgInteger` — glTF distinguishes `int` from `float`; represented as a tagged
  plain object `{ value: number; __fgInt: true }` (no class) so type coercion and
  bitwise ops work. Pure helpers `fgInt(n)`, `isFgInt(v)`.
- `FgMatrix2D` / `FgMatrix3D` — plain `Float32Array`-backed (`{ m: Float32Array }`)
  for `float2x2` / `float3x3` glTF types, with pure op helpers.
- `Vec2` — add to `flow-graph/types.ts` (or a tiny local) since core math lacks it.

### Rich-type behaviour without RichType instances (`flow-graph/rich-type.ts`)

BJS's `RichType` carries three things Lite must preserve even though it drops the
class: a **default value**, a **typeTransformer**, and an **animationType**.

- `defaultForType(t: FgType): FgValue` — pure switch returning the type's default
  (e.g. `0`, `false`, fresh `Vec3.zero`, identity quaternion). Replaces
  `RichType.defaultValue`. Constructs values **inside the function** (no
  module-level allocation).
- `coerceValue(value, target: FgType): FgValue` — the home of BJS's
  `typeTransformer`. Critically includes **`Vector4`/`Matrix` → `Quaternion`** and
  numeric↔integer coercions. Invoked by `getDataValue` on read (step (b) above),
  and by the mapper when a config/socket declares a `flowGraphType` different from
  its `gltfType`.
- `animationTypeForFgType(t: FgType): number` — replaces `RichType.animationType`,
  used by `ValueInterpolation`/animation blocks to pick the correct keyframe
  interpolation (float/vector/quaternion/color/matrix). Quaternion targets must
  resolve to slerp; the mapper's `useSlerp` flag forces `FgType.Quaternion`.

These three pure functions are the complete replacement for the `RichType` class
and its module-scope instances.

---

## glTF `KHR_interactivity` Loader Extension

> Package path: `packages/babylon-lite/src/loader-gltf/gltf-feature-interactivity.ts`
> plus `flow-graph/gltf/` for the parser + declaration mapper.

### ⚠️ The spec is NOT ratified — isolate everything spec-dependent

`KHR_interactivity` is **still a draft / not ratified**; the op set, type system,
JSON pointer semantics, and node/declaration shapes **will change**. Babylon.js
is reworking its implementation to the newer spec draft in
**[PR #18455 "KHR_interactivity rework"](https://github.com/BabylonJS/Babylon.js/pull/18455)**
— currently **closed** (it was auto-closed for age) but **expected to be
reopened/merged soon**. So even BJS is a moving target here, and our mapping
tables must track that PR as it lands.

**Design rule (mandatory):** the spec-volatile surface must be **quarantined in
`flow-graph/gltf/`** and depend on the runtime, never the reverse. The runtime
core (`runtime.ts`, `block-def.ts`, `context.ts`, blocks) must contain **zero**
glTF/`KHR_interactivity` knowledge, so a spec revision never touches the engine —
only the `gltf/` translation layer:

- `interactivity-parser.ts` — JSON shape of nodes/declarations/variables/flows.
- `declaration-mapper.ts` — the op→block table (the part most likely to churn).
- `path-converter.ts` + `object-model-mapping.ts` — JSON-pointer semantics.
- a `gltf/spec-version.ts` constant + a place to branch behaviour if we must
  support more than one draft simultaneously.

**Practical guardrails so future spec changes are cheap:**
- Keep the op→block mapping a **plain-data table**, not code, so edits are diffs
  to data (and so a future "import the BJS table" step stays mechanical).
- Treat the **BJS rework PR ([#18455 "KHR_interactivity rework"](https://github.com/BabylonJS/Babylon.js/pull/18455),
  closed-for-age, to be reopened)** as the reference target; when it lands,
  re-diff our `declaration-mapper.ts` against it. Record which BJS commit/PR our
  table mirrors in a header comment so drift is auditable.
- **Version-tag** parser/mapper behaviour; if Khronos bumps the draft, add a
  branch keyed on the asset's declared spec version rather than mutating the
  existing path.
- Unknown/changed ops already **fail loudly** with a structured diagnostic (see
  registry note) — that is the early-warning signal that the spec moved.
- The companion skill (`port-flow-graph-block.md`) is the routine for absorbing
  new/changed ops as the spec and the BJS PR evolve.

### Registration (no side effects, lazy)

Add one tuple to `gltf-feature-registry.ts`, identical to every other feature:

```typescript
["KHR_interactivity", () => import("./gltf-feature-interactivity.js")],
```

The feature implements `GltfFeature.applyAsset(meshes, root, ctx)`:

1. Read `ctx._json.extensions.KHR_interactivity.graphs`.
2. For each graph, run the **interactivity parser** → `FgGraph` (plain data).
3. **Resolve JSON pointers** in the graph to `FgAccessor`s over the already-built
   Lite scene objects (nodes/meshes/cameras/materials/animations) via a path
   converter (Lite analogue of BJS `gltfPathToObjectConverter` +
   `objectModelMapping`).
4. Build `FgEnv` (await needed block defs, attach accessors/animations/event bus).
5. Return `{ flowGraphs: [FgRuntime] }` merged into the `AssetContainer`.
   `addToScene` pushes them onto `scene._flowGraphs` and registers the
   `_beforeRender` driver + disposer.

> The loader sets the equivalent of BJS's `_skipStartAnimationStep` — animations
> referenced by interactivity must **not** auto-play; the graph controls them.

### Interactivity parser (`flow-graph/gltf/interactivity-parser.ts`)

Pure translation of the glTF interactivity JSON
(`types`, `declarations`, `variables`, `events`, `nodes`, `flows`) into an
`FgGraph`. Stages mirror BJS `InteractivityGraphToFlowGraphParser`:
`parseTypes → parseDeclarations → parseVariables → parseEvents → parseNodes →
parseConnections`. Output is plain data — **no block instances, no class registry**.

glTF→Lite type table (from BJS, kept verbatim):

| glTF type | length | FgType | element |
|---|---|---|---|
| `float` | 1 | Number | number |
| `bool` | 1 | Boolean | boolean |
| `int` | 1 | Integer | number |
| `float2` | 2 | Vector2 | number |
| `float3` | 3 | Vector3 | number |
| `float4` | 4 | Vector4 | number |
| `float2x2` | 4 | Matrix2D | number |
| `float3x3` | 9 | Matrix3D | number |
| `float4x4` | 16 | Matrix | number |

### Declaration mapper (`flow-graph/gltf/declaration-mapper.ts`)

The largest single artefact (BJS = ~1,851 lines, **168 ops**). It is a **data
table** mapping each glTF op (`"math/add"`, `"flow/branch"`, `"pointer/set"`, …)
to: target Lite block type(s), socket renames, config translation, value
transformers (e.g. seconds→frames for animation time), and multi-block expansions
(e.g. `pointer/set` → `SetProperty` + `JsonPointerParser` linked by an
inter-block connector). This is plain data + small pure transformer functions —
no classes. Porting entries is the bulk of ongoing work and is exactly what the
companion **skill** automates.

```typescript
export interface FgDeclMapping {
    blocks: FgBlockType[];
    inputs?: { values?: Record<string, FgPortMap>; flows?: Record<string, FgPortMap> };
    outputs?: { values?: Record<string, FgPortMap>; flows?: Record<string, FgPortMap> };
    configuration?: Record<string, FgPortMap>;
    interBlockConnectors?: { input: string; output: string; inBlock: number; outBlock: number }[];
    extraProcessor?: (gltfBlock: unknown, /* … */) => FgBlock[];
}
export function getMappingForOp(op: string, extension?: string): FgDeclMapping | undefined;
```

---

## Block coverage for the MVP (KHR_interactivity subset)

`KHR_interactivity` maps to ~60 distinct Lite block types (the 168 ops collapse
onto fewer blocks via config). MVP target set, by category:

- **Events (4):** `onStart`→SceneStart, `onTick`→SceneTick, `event/send`→SendCustomEvent, `event/receive`→ReceiveCustomEvent.
- **Flow control (11):** branch, sequence, switch, while, for, doN, multiGate, waitAll, throttle, setDelay, cancelDelay.
- **Math constants/arithmetic/comparison/trig/exp (~60 ops → ~40 blocks):** E, Pi, Inf, NaN, random; abs/sign/trunc/floor/ceil/round/fract/neg; add/sub/mul/div/rem/min/max/clamp/saturate/mix; eq/lt/le/gt/ge/select; sin…atanh; exp/log/log2/log10/sqrt/cbrt/pow; isNaN/isInf; rad/deg.
- **Vector/matrix/quaternion (~25 ops):** length, normalize, dot, cross, rotate2D/3D, transform, transpose, determinant, inverse, matMul, matCompose/Decompose, combineN/extractN, quat ops.
- **Integer bitwise (9):** not/and/or/xor/asr/lsl/clz/ctz/popcnt.
- **Type conversion (6):** bool/int/float cross conversions.
- **Variables (3):** get, set, interpolate.
- **Pointers (3):** get, set, interpolate (+ JsonPointerParser).
- **Animation (3):** start, stop, stopAt (+ ArrayIndex / data provider).
- **Debug (1):** log.

Each block is one small file under `flow-graph/blocks/<category>/<name>.ts`
exporting a `FgBlockDef`. See the skill doc for the exact file template.

---

## State Machine / Lifecycle

```
load .glb with KHR_interactivity
  └─ gltf-feature-interactivity.applyAsset
       ├─ interactivity-parser → FgGraph (pure data)
       ├─ path-converter → FgAccessor map
       ├─ createFgEnv (await needed defs, wire bus/accessors/animations)
       ├─ createFgContext (seed userVariables)
       └─ return { flowGraphs:[ FgRuntime ] }
addToScene
  └─ scene._flowGraphs.push(rt); onBeforeRender(scene, drive); onSceneDispose(scene, () => disposeFlowGraph(rt))
first frame
  └─ registerEventListeners(rt)   // subscribe ALL receivers first, init-priority order
  └─ startFlowGraph(rt)           // THEN fire onStart cascade once
each frame
  └─ tickFlowGraph(rt, deltaMs)   // reset recursion counters → pump tick → advance pending async
dispose
  └─ disposeFlowGraph(rt)         // cancel pending tasks, clear ctx, detach bus listeners
```

---

## Babylon.js Equivalence Map

| Babylon.js | Babylon Lite |
|---|---|
| `FlowGraphBlock` (class) | `FgBlock` (data) + `FgBlockDef` (functions) |
| `FlowGraphExecutionBlock._execute` | `FgBlockDef.execute` |
| `FlowGraphBlock._updateOutputs` | `FgBlockDef.updateOutputs` |
| `FlowGraphAsyncExecutionBlock` | `FgBlockDef.execute` (starts task) + `onTick(task)` + `cancelPending` |
| `FlowGraphEventBlock` | `FgBlock.event` + scene-driven bus dispatch |
| `FlowGraphDataConnection.getValue/setValue` | `getDataValue` / `setDataValue` |
| `FlowGraphSignalConnection._activateSignal` | `activateSignal` |
| `FlowGraphContext` | `FgContext` (data) + `FgEnv` (resolved caps) |
| `FlowGraphCoordinator` (multi-graph) | `scene._flowGraphs` + scene driver |
| `FlowGraphSceneEventCoordinator` | `FgEventBus` fed by scene/input layer |
| `RichType` instances | `const enum FgType` + `defaultForType()` |
| `RegisterClass` global registry | `getBlockDef` dynamic-import switch |
| `blockFactory` (already lazy) | `getBlockDef` (same shape, no classes) |
| `gltfPathToObjectConverter` + `objectModelMapping` | `flow-graph/gltf/path-converter.ts` → `FgAccessor` |
| `InteractivityGraphToFlowGraphParser` | `flow-graph/gltf/interactivity-parser.ts` |
| `declarationMapper.ts` table | `flow-graph/gltf/declaration-mapper.ts` table |
| `KHR_interactivity` loader extension | `loader-gltf/gltf-feature-interactivity.ts` |

---

## Dependencies

- **Core math** (`src/math/`): reuse `addVec3`, `dotVec3`, `crossVec3`,
  `mat4Multiply`, `mat4Invert`, `mat4Compose`, `mat4Decompose`, `mat4FromQuat`.
- **Animation** (`src/animation/`): `AnimationGroup` handles for animation blocks;
  `ValueInterpolation` reuses the interpolation/easing machinery where possible.
- **Scene** (`src/scene/`): `onBeforeRender`, `onSceneDispose`, `addToScene`
  dispatch, the `_flowGraphs` array (new field).
- **Loader-gltf** (`src/loader-gltf/`): `GltfFeature` hook + registry tuple; the
  node/material/camera maps the path-converter resolves against.
- **Picking/input**: pointer & key events forwarded into `FgEventBus`.
- **New, subsystem-local:** `flow-graph/fg-math.ts`, `flow-graph/custom-types/`.

---

## Test Specification

- **Unit (vitest):** per-block defs — feed inputs, assert outputs/signals
  (pure functions, trivial to test). Runtime: **pull recompute** (verify a
  producer re-runs on every read, no stale cache), push cascade, async delay
  countdown with **cancellation mid-tick** and **multiple concurrent delays per
  block**, event dispatch with **listener-before-onStart ordering** (custom event
  fired from `onStart` is received).
- **Math parity tests (focused):** quaternion mul/conjugate/slerp,
  matrix compose/decompose/transpose/inverse, `math/transform`, and the
  **accessor-boundary handedness** (right-handed glTF value → Lite LH) — these are
  the easiest places to diverge on multiplication order / row-vs-column layout.
- **Coercion tests:** `Vector4`/`Matrix` → `Quaternion` via `coerceValue`;
  `animationTypeForFgType` picks slerp for quaternion targets.
- **Parser unit tests:** representative interactivity JSON → expected `FgGraph`
  topology; declaration-mapper entries → expected blocks/sockets/config; an
  **unknown op fails loudly** with a structured diagnostic (not a silent no-op).
- **Integration / parity:** a `KHR_interactivity` sample `.glb` (e.g. a
  Khronos sample like a button that animates on click, or `onStart`→rotate)
  loaded in Lite; assert the driven property changes over frames. Where a visual
  golden is warranted, follow §2c animated-scene golden convention
  (`?seekTime=` freeze). Add a `scene-config.json` entry + bundle-size ceiling
  only when a parity scene is added.
- **Bundle-size guard:** verify a non-interactivity scene's bundle is
  **byte-unchanged** (the subsystem must be fully tree-shaken away when unused).

---

## File Manifest (target)

```
packages/babylon-lite/src/flow-graph/
  index.ts                       # public exports
  types.ts                       # FgValue, FgType, FgBlock, FgGraph, sockets
  block-def.ts                   # FgBlockDef, FgBlockShape
  block-type.ts                  # FgBlockType const enum
  block-registry.ts              # getBlockDef() dynamic-import switch
  context.ts                     # FgContext, FgEnv, FgAccessor
  runtime.ts                     # getDataValue/setDataValue/activateSignal, FgRuntime, start/tick/dispose
  event-bus.ts                   # FgEventBus, FgEventType
  fg-math.ts                     # Vec2 + quaternion/matrix/bitwise helpers (lazy)
  rich-type.ts                   # defaultForType(), coerceValue(), animationTypeForFgType()
  custom-types/
    fg-integer.ts
    fg-matrix.ts
  blocks/
    events/{scene-start,scene-tick,send-custom-event,receive-custom-event}.ts
    control-flow/{branch,sequence,switch,for-loop,while-loop,do-n,multi-gate,wait-all,throttle,set-delay,cancel-delay}.ts
    math/{add,subtract,…}.ts
    data/{constant,get-variable,set-variable,get-property,set-property,json-pointer-parser}.ts
    animation/{play-animation,stop-animation,value-interpolation}.ts
    debug/console-log.ts
    noop.ts
  gltf/
    interactivity-parser.ts
    declaration-mapper.ts
    path-converter.ts
    object-model-mapping.ts
packages/babylon-lite/src/loader-gltf/
  gltf-feature-interactivity.ts  # GltfFeature.applyAsset
  gltf-feature-registry.ts       # + ["KHR_interactivity", () => import(...)]
packages/babylon-lite/src/scene/
  scene-core.ts                  # + _flowGraphs field + addToScene dispatch
```

---

## Phased Implementation Plan

> Each phase is independently mergeable; engine-changing phases must pass
> `pnpm build:bundle-scenes` + `pnpm test:parity` and commit the regenerated
> `lab/public/bundle/manifest.json` (GUIDANCE §0c).

**Phase 0 — Spec & skill (this doc + `port-flow-graph-block.md`).** ✅ no code.

**Phase 1 — Core runtime, no blocks.** `types.ts`, `block-def.ts`,
`context.ts`, `runtime.ts`, `event-bus.ts`, `rich-type.ts`, `block-type.ts`,
empty `block-registry.ts`. Pure functions only. Full unit tests for pull
recompute, push cascade, async pending (dedupe + cancel mid-tick), event
dispatch + listener ordering, with a couple of hand-built test defs. Wire
`scene._flowGraphs` + driver (behind a no-op when empty so bundle is unchanged).
**Guard:** non-interactivity bundle byte-identical.

**Phase 2 — Vertical slice (end-to-end EARLY).** Implement the *minimum* set that
proves the whole pipeline before the long tail of blocks: `SceneStart`,
`SceneTick`, `Branch`, `Sequence`, one math op (`Add`), `GetProperty`/`SetProperty`
+ `JsonPointerParser`, `PlayAnimation`/`StopAnimation`; plus a **minimal**
parser + declaration-mapper (just those ops) + path-converter + the
`gltf-feature-interactivity.ts` loader hook; plus **one** Khronos
`KHR_interactivity` sample running end-to-end as a parity scene. This surfaces
mapper/accessor/runtime/handedness mismatches immediately rather than after the
whole block library is written.

**Phase 3 — Broaden block library.** Fill in the rest of the ~60 blocks
(full math/trig/exp, vector/matrix/quaternion, integer bitwise, type conversion,
variables, interpolation, control-flow remainder) + `fg-math.ts` +
`custom-types/**`; register each in `block-registry.ts`. Unit-test each def.

**Phase 4 — Complete the declaration mapper + more scenes.** Extend `gltf/`
mapper/parser to the full 168-op surface; add further `KHR_interactivity` parity
scenes, `scene-config.json` entries, bundle ceilings. Run full `pnpm test`.

**Phase 5+ (post-MVP, out of MVP scope):** remaining blocks toward full parity;
BJS snippet/editor serialization format; multi-context coordinator; debugger
hooks; physics/audio interactivity ops.

---

## Open Questions / Risks

- **⚠️ Unratified spec (highest-churn risk).** `KHR_interactivity` is a draft; the
  op set/types/pointer semantics will change, and BJS is reworking its
  implementation to the newer draft in
  **[PR #18455](https://github.com/BabylonJS/Babylon.js/pull/18455)** (closed for
  age, to be reopened) — so even BJS is a moving target. Mitigation is
  structural — all spec-dependent code is quarantined in `flow-graph/gltf/`
  (parser, mapper, path-converter), version-tagged, and mirrored against a
  recorded BJS commit; the runtime core stays spec-agnostic so revisions never
  touch the engine. Re-sync the mapper when #18455 lands. See the loader
  section's "spec is NOT ratified" subsection.
- **Event bus surface.** Exact channels (tick/start/pointer/key/custom) and how
  the picking/input layer forwards pointer & key events need a small design pass
  in Phase 1; the bus must stay pure data + standalone subscribe/pump fns.
- **`ValueInterpolation` reuse.** Decide how much of `src/animation/` easing the
  interpolation block can reuse vs. a subsystem-local easing helper.
- **Right-handedness.** glTF graphs are right-handed; confirm where Z/quaternion
  coercion happens on accessor read/write to match Lite's LH convention.
- **Parser scale.** The declaration mapper is large; Phases 3–4 should land an
  initial subset (events + flow + core math + pointer get/set) before the long
  tail of math ops, so an end-to-end scene works early.
