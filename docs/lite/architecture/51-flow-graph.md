# Module: flow-graph

> Package path: `packages/babylon-lite/src/flow-graph/`
>
> Status: **IMPLEMENTED / CURRENT COMPATIBILITY BASELINE COMPLETE**. This document is
> the formal specification for Babylon Lite's `FlowGraph` runtime, stable glTF
> `KHR_interactivity` support, and Babylon.js Flow Graph Editor JSON compatibility.

---

## Purpose

The flow graph is Babylon's **visual scripting / behaviour runtime**: a directed
graph of nodes ("blocks") that react to engine events and drive scene behaviour
(animate properties, play sounds, branch on conditions, do math). Its primary
real-world consumer is the glTF **`KHR_interactivity`** extension, which embeds
an interactivity graph inside a `.glb` and expects the engine to execute it at
runtime.

**Goal of this port:** load and run interactive glTF assets and execute JSON
saved by the Babylon.js Flow Graph Editor. The two formats are separate parser
front-ends over the same pure-state runtime:

1. a minimal **pure-state runtime** (graph + context + connection model),
2. the **blocks** that `KHR_interactivity` maps to,
3. the **`loader-gltf` extension** that parses the interactivity JSON into a
   Lite graph and resolves JSON pointers to scene accessors, and
4. an **editor-JSON adapter** that translates Babylon.js serialized block
   graphs into the same Lite graph representation.

Debugger parity and editor-only blocks outside Lite's supported block registry
remain later work. Loading the editor's coordinator and legacy single-graph JSON
formats is in scope; unsupported editor-only block classes fail with a precise
diagnostic rather than being silently discarded.

> **Spec stability caveat (read before touching `flow-graph/gltf/`):**
> `KHR_interactivity` reached Khronos release-candidate status and was submitted
> for ratification in July 2026, but the checked sources do not yet establish
> final ratification. Babylon.js has replaced the implementation that this port
> originally mirrored. This port therefore continues to isolate all
> spec-dependent code in `flow-graph/gltf/` and records exact reference commits
> so future revisions remain localized.

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

- The **scene owns** the graphs via an **optional** `scene._flowGraphs?:
  FgRuntime[]` field (plain data). It is left `undefined` for non-interactivity
  scenes and **lazily created by `attachFlowGraph()`** — so core stays
  byte-identical when no graph is attached (verified: the per-scene bundle
  manifest is unchanged by this subsystem's existence).
- The graph is **driven** through the scene's existing generic seams, NOT a
  hardcoded loop in `scene-core.ts` (GUIDANCE §4c′): `attachFlowGraph()` registers
  a `onBeforeRender(scene, cb)` driver (exactly how animation groups are ticked)
  and an `onSceneDispose(scene, cb)` teardown. The flow-graph drive therefore
  lives entirely in `flow-graph/scene-flow-graph.ts`, pulled into a bundle only
  when something imports it (the glTF interactivity feature or user code).
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
    /** glTF JSON Pointer string. The empty string is the null reference. */
    Reference = "ref",
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
    /** @internal monotonic token source for addPending (unique task tokens) */
    _tokenSeq: number;
}

/** One outstanding async task (a delay, an animation). Token enables precise cancel. */
export interface FgPendingTask {
    readonly blockId: string;
    readonly token: number;        // unique per task; a block may own several concurrently
    canceled: boolean;
    /** set by onTick when finished; compacted out after the frame's pending loop */
    done: boolean;
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
/** Build the resolved env (await needed defs, attach accessors/animations/bus).
 *  Editor-authored unknown block types fail loudly. KHR unsupported operations
 *  are translated to registered typed no-op blocks before this boundary. */
export function createFgEnv(graph: FgGraph, wiring?: FgWiring): Promise<FgEnv>;

/** One graph runtime = graph + context + env, owned by the scene. */
export interface FgRuntime {
    readonly graph: FgGraph;
    readonly context: FgContext;
    readonly env: FgEnv;
    started: boolean;
    /** @internal bus unsubscribe fns registered at start, called on dispose */
    _unsub: (() => void)[];
}

/** Convenience: build env (awaiting defs) + context in one call. */
export function createFgRuntime(graph: FgGraph, wiring?: FgWiring, opts?: { rightHanded?: boolean }): Promise<FgRuntime>;

/** Start the graph: subscribe ALL non-start receivers first (init-priority
 *  order), THEN fire `onStart` event blocks once. Idempotent. */
export function startFlowGraph(rt: FgRuntime): void;
/** Per-frame drive: pump tick events + advance pending async blocks. */
export function tickFlowGraph(rt: FgRuntime, deltaMs: number): void;
/** Tear down: cancel pending, clear caches, detach bus listeners. */
export function disposeFlowGraph(rt: FgRuntime): void;

// Pending-task helpers used by async block defs and the tick loop:
export function addPending(ctx: FgContext, block: FgBlock, state?: Record<string, unknown>): FgPendingTask;
export function stillPending(ctx: FgContext, task: FgPendingTask): boolean;
export function cancelPendingForBlock(ctx: FgContext, block: FgBlock): void;
export function compactPending(ctx: FgContext): void;
```

### Scene attachment (`flow-graph/scene-flow-graph.ts`)

```typescript
/** Attach a runtime to a scene: starts on the first frame, ticks every frame,
 *  auto-disposed on scene dispose. Lazily creates `scene._flowGraphs`. Uses the
 *  generic onBeforeRender/onSceneDispose seams (no scene-core loop). */
export function attachFlowGraph(scene: SceneContext, rt: FgRuntime): void;
/** Detach + dispose a previously attached runtime. */
export function detachFlowGraph(scene: SceneContext, rt: FgRuntime): void;
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
> **Unknown ops:** `getBlockDef` returns `null`; each parser chooses the policy.
> Stable `KHR_interactivity` requires an unsupported declaration to become an
> explicit **typed no-op** so the rest of that graph can still execute. The
> parser reports the unsupported operation and preserves the declaration's
> declared sockets on the no-op. Invalid graph structure is different: reject
> only that graph and continue loading the other graphs in the asset. Editor JSON
> is authored specifically for Babylon blocks, so an unknown `className` fails
> loudly with its block id and class name.

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

Pointer/key events are fed into `env.events` by the picking/input layer; event
blocks simply subscribe to the corresponding bus channel. Pointer selection is
an explicit capability: call `enableFlowGraphPointerPicking(scene)` when a scene
uses pointer-event blocks. This keeps the GPU picker out of non-interactive glTF
bundles.

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

### Release-candidate spec — keep the translation layer isolated

The port originally targeted Babylon.js commit `8f728b23ea` while
**[PR #18455](https://github.com/BabylonJS/Babylon.js/pull/18455)** was still
open. That target is obsolete. The compatibility refresh targets:

- Khronos glTF repository commit `fdb8ce0e2e0b7ecf3466f8dacb9f1385257b8276`.
- Babylon.js commit `bd3837eed0890e590fdd6aeb6cc4d605e4eb8ac7`.

The release candidate was submitted for ratification in July 2026; final
ratification was not confirmed when these commits were recorded. The op set,
object model, and validation rules can therefore still evolve.

**Design rule (mandatory):** the spec-volatile surface must be **quarantined in
`flow-graph/gltf/`** and depend on the runtime, never the reverse. The runtime
core (`runtime.ts`, `block-def.ts`, `context.ts`, blocks) must contain **zero**
glTF/`KHR_interactivity` knowledge, so a spec revision never touches the engine —
only the `gltf/` translation layer:

- `interactivity-parser.ts` — JSON shape of nodes/declarations/variables/flows.
- `declaration-mapper.ts` — the op→block table (the part most likely to churn).
- `path-converter.ts` + `object-model-mapping.ts` — JSON-pointer semantics.
- a recorded Khronos/Babylon.js reference commit in the mapper header and tests.

**Practical guardrails so future spec changes are cheap:**
- Keep the op→block mapping a **plain-data table**, not code, so edits are diffs
  to data (and so a future "import the BJS table" step stays mechanical).
- Re-diff `declaration-mapper.ts` against the recorded Babylon.js commit when
  updating either reference. Keep an operation-coverage test that compares all
  known native operations with registered mappings.
- Do not invent an asset-level version switch: the release-candidate extension
  has no such discriminator. If a future revision adds one, branch at this
  translation boundary.
- Unknown operations produce structured diagnostics and typed no-op blocks.
  Structural/schema violations reject only the affected graph.
- The companion skill (`port-flow-graph-block.md`) is the routine for absorbing
  new/changed ops as the spec and the BJS PR evolve.

### Registration (no side effects, lazy)

Add one tuple to `gltf-feature-registry.ts`, identical to every other feature:

```typescript
["KHR_interactivity", () => import("./gltf-feature-interactivity.js")],
```

The feature implements `GltfFeature.applyAsset(meshes, root, ctx)`:

1. Read `ctx._json.extensions.KHR_interactivity`. `graphs` is required; optional
   `graph` selects the default graph.
2. For each graph, run the **interactivity parser** → `FgGraph` (plain data).
   Catch parse/validation errors per graph so one invalid graph cannot invalidate
   the asset.
3. **Resolve JSON pointers** in the graph to `FgAccessor`s over the already-built
   Lite scene objects (nodes/meshes/cameras/materials/animations) via a path
   converter (Lite analogue of BJS `gltfPathToObjectConverter` +
   `objectModelMapping`).
4. Build `FgEnv` (await needed block defs, attach accessors/animations/event bus).
5. Return the successfully parsed graphs in the `AssetContainer` and contribute
   a deferred `_sceneSetup` hook. `addToScene` resolves runtimes with the target
   scene's shared event bus, pushes them onto `scene._flowGraphs`, and registers
   paired cleanup. Callers do not need to invoke `runFlowGraphs` manually.

> The loader sets the equivalent of BJS's `_skipStartAnimationStep` — animations
> referenced by interactivity must **not** auto-play; the graph controls them.

### Interactivity parser (`flow-graph/gltf/interactivity-parser.ts`)

Pure translation of each glTF interactivity graph
(`types`, `declarations`, `variables`, `events`, and `nodes`) into an
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
| `ref` | 1 | Reference | JSON Pointer string (`""` = null) |

Release-candidate parser semantics:

- Type/default validation follows the Khronos schemas. Numeric, vector, and
  matrix defaults preserve the spec's NaN defaults where specified.
- `events` declares custom-event ids and typed payload fields. Send/receive
  blocks use those declarations for socket types and defaults.
- Event receivers expose an opaque event reference. `event/stopPropagation`
  consumes it and prevents later receivers in the same dispatch from running.
- glTF custom-event delivery is asynchronous by default. The coordinator's
  editor-JSON `dispatchEventsSynchronously` option remains independently
  configurable.
- A connected animation-time input is converted from seconds to frames at
  runtime; constants may be pre-transformed.
- Pointer templates validate all placeholders and support dynamic segments.
  Virtual/object-model pointers include the release-candidate active-camera,
  capability/limit, event-reference, delay, and animation-state surfaces.

### Declaration mapper (`flow-graph/gltf/declaration-mapper.ts`)

The largest single artefact (current BJS = **135 native ops**). It is a **data
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

## Block coverage (`KHR_interactivity`)

`KHR_interactivity` maps 135 native operations onto fewer Lite block types via
configuration. The refresh adds the ten operations absent from the original
126-operation target: `event/stopPropagation`, `math/Tau`,
`math/smoothStep`, `math/rgbToOkLCh`, `math/rgbFromOkLCh`,
`math/quatSlerp`, `math/slerp`, `ref/eq`, `math/quatFromUpForward`, and
`math/quatFromAngles`.

- **Events (4):** `onStart`→SceneStart, `onTick`→SceneTick, `event/send`→SendCustomEvent, `event/receive`→ReceiveCustomEvent.
- **Flow control (11):** branch, sequence, switch, while, for, doN, multiGate, waitAll, throttle, setDelay, cancelDelay.
- **Math constants/arithmetic/comparison/trig/exp (~60 ops → ~40 blocks):** E, Pi, Inf, NaN, random; abs/sign/trunc/floor/ceil/round/fract/neg; add/sub/mul/div/rem/min/max/clamp/saturate/mix; eq/lt/le/gt/ge/select; sin…atanh; exp/log/log2/log10/sqrt/cbrt/pow; isNaN/isInf; rad/deg.
- **Vector/matrix/quaternion (~25 ops):** length, normalize, dot, cross, rotate2D/3D, transform, transpose, determinant, inverse, matMul, matCompose/Decompose, combineN/extractN, quat ops.
- **Integer bitwise (9):** not/and/or/xor/asr/lsl/clz/ctz/popcnt.
- **Type conversion (6):** bool/int/float cross conversions.
- **Variables (3):** get, set, interpolate.
- **Pointers (3):** get, set, interpolate (+ JsonPointerParser).
- **Animation (3):** start, stop, stopAt (+ ArrayIndex / data provider).
- `flow/log` is a Babylon extension operation rather than a native KHR
  operation. `event/onSelect` remains extension-namespaced through
  `KHR_node_selectability`.

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
- **Picking/input**: pointer & key events forwarded into `FgEventBus`; the GPU
  pointer bridge is enabled explicitly with `enableFlowGraphPointerPicking`.
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
  topology; declaration-mapper entries → expected blocks/sockets/config;
  unsupported op → typed no-op + diagnostic; malformed graph → only that graph
  rejected.
- **Editor JSON tests:** coordinator and legacy single-graph fixtures saved by
  the current Babylon.js Flow Graph Editor; rich-value/default/context restore;
  connection reconstruction by connection-point id; execute the parsed graph;
  unknown editor block → precise diagnostic.
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
  event-bus.ts                   # FgEventBus, FgEventType, subscribe/pump/clear
  fg-math.ts                     # Vec2 + quaternion/matrix/bitwise helpers (lazy)
  rich-type.ts                   # defaultForType(), coerceValue(), animationTypeForFgType()
  scene-flow-graph.ts            # attachFlowGraph/detachFlowGraph (onBeforeRender/onSceneDispose seams)
  graph-builder.ts               # imperative builder shared by parser adapters
  editor-serialization.ts        # coordinator/single-graph editor JSON → FgGraph
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
    no-op.ts
  gltf/
    interactivity-parser.ts
    declaration-mapper.ts
    path-converter.ts
    object-model-mapping.ts
packages/babylon-lite/src/loader-gltf/
  gltf-feature-interactivity.ts  # GltfFeature.applyAsset
  gltf-feature-registry.ts       # + ["KHR_interactivity", () => import(...)]
packages/babylon-lite/src/scene/
  scene-core.ts                  # + optional `_flowGraphs?` field (type-only; zero runtime cost)
```

> Note: the scene driver is NOT hardcoded in `scene-core.ts`. `scene-flow-graph.ts`
> attaches via the existing `onBeforeRender`/`onSceneDispose` seams, so non-
> interactivity scenes stay byte-identical (verified against the bundle manifest).

---

## Phased Implementation Plan

> Each phase is independently mergeable; engine-changing phases must pass
> `pnpm build:bundle-scenes` + `pnpm test:parity` and commit the regenerated
> `lab/public/bundle/manifest.json` (GUIDANCE §0c).

**Phase 0 — Spec & skill (this doc + `port-flow-graph-block.md`).** ✅ DONE — no code.

**Phase 1 — Core runtime, no blocks.** ✅ **DONE.** `types.ts`, `block-def.ts`,
`context.ts`, `runtime.ts`, `event-bus.ts`, `rich-type.ts`, `block-type.ts`,
`custom-types/{fg-integer,fg-matrix}.ts`, `scene-flow-graph.ts`, and an empty
`block-registry.ts`. Pure functions only. 24 unit tests cover pull recompute,
push cascade, branch routing, async pending (countdown, dedupe, cancel
mid-tick, no retro-tick), event dispatch + custom-event-during-start ordering,
tick pump, dispose, variable seeding, loud-fail on unknown ops, and rich-type
defaults/coercion. Scene drive wired via the `onBeforeRender`/`onSceneDispose`
seams. **Guard met:** non-interactivity bundle manifest byte-identical.

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

**Phase 4 — Complete the original declaration mapper.** ✅ DONE for the old
126-operation target. Additional parity scenes remain optional coverage work.

**Phase 5a — Imperative builder and scene coordinator.** ✅ DONE. Builder creates the
same `FgGraph` plain data as parser front-ends. The coordinator owns multiple
graphs, one scene event bus, and synchronous/asynchronous custom-event policy.

**Phase 5b — Release-candidate KHR refresh.** ✅ DONE for the current Lite host
surface. Rebase parser/mapper behavior on
the recorded Khronos and Babylon.js commits. Add the ten operation gaps, `ref`,
declared events/payloads, event references and propagation, typed no-ops,
per-graph isolation, asynchronous event dispatch, dynamic pointer segments,
expanded object-model pointers, and runtime animation-time conversion.

**Phase 5c — Babylon.js Flow Graph Editor JSON.** ✅ DONE for serialized block
classes ported to Lite. Add a second parser front-end
alongside `gltf/interactivity-parser.ts`. Supported input forms:

```typescript
// Coordinator form
{ _flowGraphs: SerializedFlowGraph[], activeGraphIndex,
  dispatchEventsSynchronously, sceneSnippetId?, flowGraphSnippetId? }

// Legacy form
{ allBlocks: SerializedBlock[], executionContexts: SerializedContext[],
  name?, uniqueId?, rightHanded?, editorData? }
```

`SerializedBlock` contains `className`, `type`, `config`, `uniqueId`,
data/signal inputs and outputs, and metadata. Connections are reconstructed from
connection-point `uniqueId`/`connectedPointIds`. Values may come from a
connection's `defaultValue` or a context's `_connectionValues`; rich values use
`{ value, className }`. The adapter maps Babylon block class names to Lite
`FgBlockType`, restores user variables, and returns one graph/context record per
serialized execution context. It also recognizes serialized JSON embedded in
the Babylon-specific `BABYLON_flow_graph` glTF extension. Unsupported
editor-only blocks fail clearly; they are not typed no-ops.

**Phase 6+ — Editor-only block parity and debugger hooks.** Port blocks as
needed using the companion skill. Current editor-only gaps include input,
interpolation-animation construction, debounce/flip-flop, coordinate
transforms, easing/context/array/code, physics, and audio blocks.

---

## Open Questions / Risks

- **Release-candidate churn.** Final ratification was not confirmed at the
  recorded reference commits. Mitigation remains structural: all
  spec-dependent code is quarantined in `flow-graph/gltf/` and mirrored against
  exact Khronos/Babylon.js commits; the runtime core remains spec-agnostic.
- **Editor format churn.** Editor JSON is a Babylon.js serialization contract,
  not the Khronos format. Keep it isolated in `flow-graph/editor-serialization.ts`, test
  current official fixtures, and fail loudly when a serialized class is unknown.
- **Host object-model breadth.** Pointer support is limited to concepts exposed
  by Lite. Add accessors in `path-converter.ts` as Lite gains more glTF host
  objects; unsupported pointers remain runtime-invalid rather than crashing.
