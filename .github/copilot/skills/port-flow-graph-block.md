# Port a Flow-Graph Block to Babylon Lite

You are porting **one block** (node) from the Babylon.js `FlowGraph` system to
**Babylon Lite's** flow-graph subsystem. Babylon.js blocks are classes; Lite
blocks are **plain-data definitions + pure functions**. This skill is the
mechanical recipe to do that conversion correctly and to wire the block into the
glTF `KHR_interactivity` path when applicable.

> Read first: `docs/lite/architecture/42-flow-graph.md` (the subsystem design)
> and `GUIDANCE.md` (pillars: no classes, pure-state, zero module-level side
> effects, 100% tree-shakable). This skill assumes that architecture.

---

## What a block becomes

| Babylon.js | Babylon Lite |
|---|---|
| `class FooBlock extends FlowGraphBlock` | a `const fooDef: FgBlockDef` exported from one file |
| `class … extends FlowGraphExecutionBlock` | `FgBlockDef` with an `execute()` |
| `class … extends FlowGraphAsyncExecutionBlock` | `FgBlockDef` with `execute` (start task) + `onTick(task)` + `cancelPending` |
| `class … extends FlowGraphEventBlock` | `FgBlockDef.build()` returns `{ event: FgEventType.X }` |
| constructor `registerDataInput/Output` | sockets declared in `build()` |
| `_registerSignalInput/Output` | signal sockets declared in `build()` |
| `getValue(ctx)` / `setValue(v, ctx)` | `getDataValue(ctx, env, block, name)` / `setDataValue(ctx, block, name, v)` |
| `signal._activateSignal(ctx)` | `activateSignal(ctx, env, block, name)` |
| `this.config.foo` | `block.config?.foo` |
| per-instance field / state | `ctx.executionVariables["${block.id}:key"]` |
| `RegisterClass(name, Class)` + `blockFactory` case | one `getBlockDef` switch case (dynamic import) |
| `getClassName()` returns `FlowGraphBlockNames.X` | `FgBlockType.X` string tag |

**No classes. No `this`. No methods on data. No module-level `new`.**

---

## Step-by-step

### 1. Locate the source block

In the Babylon.js clone (`~/Babylon.js/packages/dev/core/src/FlowGraph/Blocks/**`)
open the block's `.pure.ts` file (the `.ts` wrapper only calls `RegisterClass`,
ignore it). Identify:

- **Kind:** data (has `_updateOutputs`), execution (has `_execute`), async
  (extends `FlowGraphAsyncExecutionBlock`), or event (extends
  `FlowGraphEventBlock`).
- **Data inputs/outputs:** each `registerDataInput("name", RichTypeX, default)`
  and `registerDataOutput(...)`.
- **Signal inputs/outputs:** the inherited `in`/`error`, plus each
  `_registerSignalOutput("name")`.
- **Config:** fields read off `this.config`.
- **Per-instance state:** anything read/written via
  `context._getExecutionVariable/_setExecutionVariable`.
- **Class name:** the `FlowGraphBlockNames.X` returned by `getClassName()`.

### 2. Add the type tag

In `flow-graph/block-type.ts`, add a member to the `FgBlockType` const enum if it
does not exist. **Keep the string value identical to the BJS class name**
(e.g. `Branch = "Branch"` matches `FlowGraphBranchBlock` → name `"Branch"`),
so serialized graphs and the declaration mapper line up.

### 3. Create the block file

Path: `flow-graph/blocks/<category>/<kebab-name>.ts`. Export a single
`FgBlockDef`. Use the matching template below.

#### Template — DATA block (pull)

BJS reference (`flowGraphConstantBlock.pure.ts` style):

```typescript
// flow-graph/blocks/math/add.ts
import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgAdd } from "../../fg-math.js"; // type-generic add (number|vecN|…)

export const addDef: FgBlockDef = {
    type: FgBlockType.Add,
    build: () => ({
        dataIn: [sockIn("a", FgType.Any), sockIn("b", FgType.Any)],
        dataOut: [sockOut("value", FgType.Any)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        const b = getDataValue(ctx, env, block, "b");
        setDataValue(ctx, block, "value", fgAdd(a, b));
    },
};
```

#### Template — EXECUTION block (push)

BJS reference (`flowGraphBranchBlock.pure.ts`):

```typescript
// flow-graph/blocks/control-flow/branch.ts
import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, activateSignal } from "../../runtime.js";
import { sockIn, sigIn, sigOut } from "../../sockets.js";

export const branchDef: FgBlockDef = {
    type: FgBlockType.Branch,
    build: () => ({
        dataIn: [sockIn("condition", FgType.Boolean, false)],
        signalIn: [sigIn("in")],
        signalOut: [sigOut("onTrue"), sigOut("onFalse")],
    }),
    execute(block, ctx, env /*, incomingSignal */) {
        if (getDataValue(ctx, env, block, "condition")) {
            activateSignal(ctx, env, block, "onTrue");
        } else {
            activateSignal(ctx, env, block, "onFalse");
        }
    },
};
```

#### Template — ASYNC block (delay / animation)

> Async state lives on an **`FgPendingTask`** (with a unique `token`), not on the
> block and not as a single scalar — a block may have **multiple concurrent
> tasks** (e.g. several in-flight delays). `addPending` dedupes the block in the
> tick loop and returns a task; `cancelPending` marks tasks canceled and the tick
> loop skips them.

```typescript
// flow-graph/blocks/control-flow/set-delay.ts
import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, activateSignal, addPending, cancelTasksFor } from "../../runtime.js";
import { sockIn, sigIn, sigOut } from "../../sockets.js";

export const setDelayDef: FgBlockDef = {
    type: FgBlockType.SetDelay,
    build: () => ({
        dataIn: [sockIn("duration", FgType.Number, 0)],
        signalIn: [sigIn("in"), sigIn("cancel")],
        signalOut: [sigOut("out"), sigOut("done"), sigOut("error")],
    }),
    execute(block, ctx, env, incomingSignal) {
        if (incomingSignal === "cancel") {
            cancelTasksFor(ctx, block); // marks this block's tasks canceled
            return;
        }
        const seconds = getDataValue(ctx, env, block, "duration") as number;
        const task = addPending(ctx, block);       // unique token, deduped in tick loop
        task.state.remainingMs = seconds * 1000;
        activateSignal(ctx, env, block, "out");     // sync flow continues immediately
    },
    onTick(block, ctx, env, deltaMs, task) {        // task passed by the tick loop
        if (task.canceled) { return; }
        const left = (task.state.remainingMs as number) - deltaMs;
        if (left <= 0) {
            task.done = true;                        // tick loop compacts it out
            activateSignal(ctx, env, block, "done");
        } else {
            task.state.remainingMs = left;
        }
    },
};
```

#### Template — EVENT block

```typescript
// flow-graph/blocks/events/scene-tick.ts
import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { FgEventType } from "../../event-bus.js";
import { setDataValue, activateSignal } from "../../runtime.js";
import { sockOut, sigOut } from "../../sockets.js";

export const sceneTickDef: FgBlockDef = {
    type: FgBlockType.SceneTick,
    build: () => ({
        dataOut: [sockOut("timeSinceStart", FgType.Number), sockOut("deltaTime", FgType.Number)],
        signalOut: [sigOut("out"), sigOut("done")],
        event: FgEventType.Tick, // the scene driver fires this block on the tick channel
    }),
    // event blocks expose outputs via updateOutputs; the driver sets payload then fires signals
    updateOutputs(block, ctx, env) {
        // values written by the driver into connectionValues before firing
    },
};
```

> Event blocks do **not** have an `in` signal (BJS removes it). The scene driver
> reads `block.event`, pushes the payload into `ctx.connectionValues`, then calls
> `activateSignal(ctx, env, block, "out")` and `"done"`.

### 4. Map the rich types

Replace BJS `RichTypeX` with the `FgType` tag:

| BJS RichType | FgType |
|---|---|
| `RichTypeAny` | `FgType.Any` |
| `RichTypeNumber` | `FgType.Number` |
| `RichTypeBoolean` | `FgType.Boolean` |
| `RichTypeString` | `FgType.String` |
| `RichTypeFlowGraphInteger` | `FgType.Integer` |
| `RichTypeVector2/3/4` | `FgType.Vector2/3/4` |
| `RichTypeQuaternion` | `FgType.Quaternion` |
| `RichTypeMatrix/2D/3D` | `FgType.Matrix/Matrix2D/Matrix3D` |
| `RichTypeColor3/4` | `FgType.Color3/Color4` |

Default values come from `defaultForType(FgType.X)` (in `rich-type.ts`), never
from a module-level `new RichType(...)`.

### 5. Map the math

Lite core `math/` is **Vec3-centric and minimal** — it has `addVec3`, `subVec3`,
`scaleVec3`, `dotVec3`, `crossVec3`, `lengthVec3`, `normalizeVec3`, `lerpVec3`,
`mat4Multiply`, `mat4Invert`, `mat4Compose`, `mat4Decompose`, `mat4FromQuat`, and
little else. It has **no Vec2, no general quaternion algebra, no
transpose/determinant**.

Rule (GUIDANCE §4c′): **do not add these to core `math/`.** Put block-specific
math in `flow-graph/fg-math.ts` (and `flow-graph/custom-types/`), lazily imported
by the blocks that need it, so non-interactivity scenes stay byte-for-byte
unchanged. Reuse core `math/` only where it already covers the op.

When a math op is type-generic (works on number/vecN/matrix), implement a small
dispatcher in `fg-math.ts` (e.g. `fgAdd`, `fgMul`, `fgLength`) that branches on
the runtime value shape — mirroring BJS's per-component handling.

### 6. Convert per-instance state

Anything BJS stores via `context._getExecutionVariable(this, key, def)` /
`_setExecutionVariable(this, key, v)` becomes
`getExecVar(ctx, block, key, def)` / `setExecVar(ctx, block, key, v)` (keyed by
`block.id`). **Never** add fields to `FgBlock` for mutable runtime state — it is
immutable topology data; all mutable state lives in `FgContext`.

### 7. Register the block

Add **one case** to the `getBlockDef` switch in `flow-graph/block-registry.ts`:

```typescript
case FgBlockType.Branch:
    return async () => (await import("./blocks/control-flow/branch.js")).branchDef;
```

This is the only place the block is referenced by string. It is dynamic-imported,
so a scene that never uses the block never bundles it. (`getBlockDef` returns
`null` for unknown types; the glTF interactivity parser treats that as a
loud, structured *unsupported-op* error rather than silently substituting a
no-op — don't change that.)

### 8. (If glTF-driven) add the declaration-mapper entry

If the block backs a `KHR_interactivity` op, add an entry to
`flow-graph/gltf/declaration-mapper.ts` mapping the glTF op name to this block.
Copy the structure from the BJS `declarationMapper.ts` entry for the same op, but
as Lite plain data:

```typescript
"flow/branch": {
    blocks: [FgBlockType.Branch],
    inputs: {
        values: { condition: { name: "condition", gltfType: "bool" } },
        flows: { in: { name: "in" } },
    },
    outputs: {
        flows: { true: { name: "onTrue" }, false: { name: "onFalse" } },
    },
},
```

Handle BJS specifics when present: **value transformers** (e.g. animation time
`seconds → frames`: `dataTransformer: (t) => [t[0] * fps]`), **socket renames**
(`in_$N` for switch cases), **multi-block expansions** (`pointer/set` →
`SetProperty` + `JsonPointerParser` linked via `interBlockConnectors`), and
**integer validation** (switch/multiGate cases must be ints). Reproduce these as
pure functions/data, not classes.

> **⚠️ The spec is unratified and moving.** `KHR_interactivity` is a draft and
> Babylon.js is reworking its implementation to the newer spec in
> **[PR #18455 "KHR_interactivity rework"](https://github.com/BabylonJS/Babylon.js/pull/18455)**
> (closed-for-age, to be reopened). Treat the op name, its types, and its mapping
> as **volatile**: keep changes confined to `flow-graph/gltf/`
> (mapper/parser/path-converter), never leak op-specific logic into the runtime or
> a block's `execute`/`updateOutputs`. When in doubt, check the op against the
> latest Khronos draft **and** PR #18455; record which BJS commit your mapper
> entry mirrors. If the op changed, prefer a version-tagged branch over silently
> editing the existing entry.

### 9. Test

Add a vitest spec next to the block (or in the subsystem test folder):

```typescript
// build the block + a minimal context/env, drive it, assert.
const block = instantiate(branchDef, { id: "b1", config: {} });
setDataValue(ctx, block, "condition", true);
branchDef.execute(block, ctx, env, "in");
expect(firedSignals).toContain("onTrue");
```

For async blocks, tick `onTick` with `deltaMs` and assert `done` fires at the
right time. For glTF-mapped blocks, add a parser test: a small interactivity
JSON fragment → expected `FgGraph` topology.

### 10. Validate (mandatory before done)

- `pnpm run lint:fix && pnpm run lint` — must pass (GUIDANCE §6).
- `pnpm test` (vitest unit) for the subsystem.
- If you added/changed an engine path that a parity scene exercises:
  `pnpm build:bundle-scenes && pnpm test:parity`, and **commit the regenerated
  `lab/public/bundle/manifest.json`** (GUIDANCE §0c).
- **Bundle discipline:** confirm a non-interactivity scene's bundle is unchanged
  — the block must tree-shake away entirely when unused. Never raise a bundle
  ceiling without explicit user approval (GUIDANCE §2 / §2b′).

---

## Checklist

- [ ] `FgBlockType` tag added, string value == BJS class name.
- [ ] One file under `blocks/<category>/`, exports a single `FgBlockDef`.
- [ ] No classes, no `this`, no module-level `new` / `Map` / `Set`.
- [ ] Sockets declared in `build()`; rich types mapped to `FgType`.
- [ ] Math reused from core where possible, else added to `fg-math.ts` (lazy).
- [ ] Per-instance state via `getExecVar/setExecVar`, not block fields.
- [ ] One `getBlockDef` switch case (dynamic import).
- [ ] Declaration-mapper entry added if glTF-driven (transformers/multi-block/validation preserved).
- [ ] Unit tests for outputs/signals/async timing; parser test if glTF-mapped.
- [ ] Lint + tests green; bundle unchanged for non-interactivity scenes.

---

## Common pitfalls

- **Pull vs push confusion.** Data inputs are *pulled* on demand inside
  `execute`/`updateOutputs` via `getDataValue` — do not "push" data. Signals are
  *pushed* via `activateSignal` — do not poll them.
- **Pull recompute, not cache.** `getDataValue` re-runs the producer's
  `updateOutputs` on **every** read (matching BJS). `connectionValues` is a
  transport slot, not a validity cache. Never short-circuit recomputation on a
  cached value or skip `updateOutputs` — a `pointer/get`/`GetVariable`/`random`
  output would go stale after an intervening write in the same cascade. Likewise
  never cache values on the (immutable) block.
- **Event blocks with an `in` signal.** Drop it — event blocks are driven by the
  bus, not an incoming signal (matches BJS `FlowGraphEventBlock`).
- **Module-level allocation.** A top-level `const x = new FgMatrix2D()` or
  `new Map()` kills tree-shaking. Construct inside functions; for constants use
  plain literals or typed arrays.
- **Bloating core math.** Resist adding Vec2/quaternion/matrix ops to `src/math/`.
  Keep them in `flow-graph/fg-math.ts` so unrelated scenes don't grow.
- **Handedness.** glTF is right-handed; if the block reads/writes transforms via
  an accessor, ensure Z/quaternion coercion happens at the accessor boundary, not
  scattered in block logic.
