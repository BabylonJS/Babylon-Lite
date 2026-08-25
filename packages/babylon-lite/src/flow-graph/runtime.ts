// Standalone runtime functions — the functional re-expression of BJS's
// FlowGraph execution. Data edges PULL (recompute on every read); signal edges
// PUSH (cascade through `execute`). Async work is tracked as `FgPendingTask`
// records ticked in a cancellation-safe per-frame loop. See
// docs/lite/architecture/51-flow-graph.md → Internal Architecture.

import type { FgBlockDef } from "./block-def.js";
import type { FgContext, FgEnv, FgPendingTask, FgWiring } from "./context.js";
import { createFgEventBus, pumpFgEvent, subscribeFgEvent } from "./event-bus.js";
import { getBlockDef } from "./block-registry.js";
import { coerceValue, defaultForType } from "./rich-type.js";
import type { FgBlock, FgGraph, FgValue } from "./types.js";
import { FgEventType } from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Data edges (PULL)
// ─────────────────────────────────────────────────────────────────────────────

/** PULL a data input: resolve the wired source, run its producer's
 *  `updateOutputs` (every time — `connectionValues` is a transport slot, not a
 *  validity cache), read the produced value, then coerce to the consumer type.
 *  Falls back to the socket's literal default when unwired. */
export function getDataValue(ctx: FgContext, env: FgEnv, block: FgBlock, socket: string): FgValue {
    const input = block.dataIn.find((s) => s.name === socket);
    if (!input) {
        return undefined;
    }

    let raw: FgValue;
    if (input.source) {
        const producer = blockById(env.graph, input.source.blockId);
        if (producer) {
            const guardKey = `${producer.id}:resolving`;
            // Break accidental data cycles: return the default rather than recurse.
            if (ctx.executionVariables[guardKey]) {
                raw = input.defaultValue ?? defaultForType(input.type);
            } else {
                const def = env.defs[producer.type];
                ctx.executionVariables[guardKey] = true;
                try {
                    def?.updateOutputs?.(producer, ctx, env);
                } finally {
                    ctx.executionVariables[guardKey] = false;
                }
                const slot = `${producer.id}:${input.source.socket}`;
                raw = slot in ctx.connectionValues ? ctx.connectionValues[slot] : (input.defaultValue ?? defaultForType(input.type));
            }
        } else {
            raw = input.defaultValue ?? defaultForType(input.type);
        }
    } else {
        raw = input.defaultValue ?? defaultForType(input.type);
    }

    return coerceValue(raw, input.type);
}

/** Write a data output into the transport slot (called from `updateOutputs`). */
export function setDataValue(ctx: FgContext, block: FgBlock, socket: string, value: FgValue): void {
    ctx.connectionValues[`${block.id}:${socket}`] = value;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-block execution variables (mutable runtime state, keyed by block id)
// ─────────────────────────────────────────────────────────────────────────────

/** Read a block-local execution variable, falling back to `def` when unset.
 *  Replaces BJS `context._getExecutionVariable(this, key, def)`. */
export function getExecVar<T>(ctx: FgContext, block: FgBlock, key: string, def: T): T {
    const slot = `${block.id}:${key}`;
    return slot in ctx.executionVariables ? (ctx.executionVariables[slot] as T) : def;
}

/** Write a block-local execution variable.
 *  Replaces BJS `context._setExecutionVariable(this, key, value)`. */
export function setExecVar(ctx: FgContext, block: FgBlock, key: string, value: unknown): void {
    ctx.executionVariables[`${block.id}:${key}`] = value;
}

// ─────────────────────────────────────────────────────────────────────────────
// Signal edges (PUSH)
// ─────────────────────────────────────────────────────────────────────────────

/** PUSH a signal: for each wired target of `socket`, dispatch into the target
 *  block's `def.execute`, passing the target's incoming signal name. */
export function activateSignal(ctx: FgContext, env: FgEnv, block: FgBlock, socket: string): void {
    const output = block.signalOut.find((s) => s.name === socket);
    if (!output) {
        return;
    }
    for (const target of output.targets) {
        const targetBlock = blockById(env.graph, target.blockId);
        if (!targetBlock) {
            continue;
        }
        env.defs[targetBlock.type]?.execute?.(targetBlock, ctx, env, target.socket);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Async pending tasks
// ─────────────────────────────────────────────────────────────────────────────

/** Register a new async task owned by `block`. Returns the task (with a unique
 *  token) so the caller can stash handles on `task.state`. A block may own
 *  several concurrent tasks. */
export function addPending(ctx: FgContext, block: FgBlock, state: Record<string, unknown> = {}): FgPendingTask {
    const task: FgPendingTask = {
        blockId: block.id,
        token: ctx._tokenSeq++,
        canceled: false,
        done: false,
        state,
    };
    ctx.pending.push(task);
    return task;
}

/** True while `task` is still live (present, not canceled, not done). */
export function stillPending(ctx: FgContext, task: FgPendingTask): boolean {
    return !task.canceled && !task.done && ctx.pending.indexOf(task) >= 0;
}

/** Cancel every outstanding task owned by `block` (marks them; compacted later). */
export function cancelPendingForBlock(ctx: FgContext, block: FgBlock): void {
    for (const task of ctx.pending) {
        if (task.blockId === block.id) {
            task.canceled = true;
        }
    }
}

/** Drop canceled/done tasks from `ctx.pending` in place (preserves order). */
export function compactPending(ctx: FgContext): void {
    let write = 0;
    for (let read = 0; read < ctx.pending.length; read++) {
        const task = ctx.pending[read];
        if (task && !task.canceled && !task.done) {
            ctx.pending[write++] = task;
        }
    }
    ctx.pending.length = write;
}

// ─────────────────────────────────────────────────────────────────────────────
// Context / env / runtime construction
// ─────────────────────────────────────────────────────────────────────────────

/** Instantiate runtime state for a parsed graph (variables seeded live). */
export function createFgContext(graph: FgGraph, opts?: { rightHanded?: boolean }): FgContext {
    const userVariables: Record<string, FgValue> = {};
    for (const name of Object.keys(graph.variables)) {
        userVariables[name] = graph.variables[name]!.value;
    }
    return {
        connectionValues: {},
        executionVariables: {},
        userVariables,
        pending: [],
        rightHanded: opts?.rightHanded ?? false,
        _tokenSeq: 0,
    };
}

/** Build the resolved env: await every block def the graph needs (registry or
 *  wiring override), then attach accessors/animations/caps/bus.
 *
 *  Unknown op policy: the registry returns `null` for an unknown type and this
 *  loader FAILS LOUDLY (throws with the offending types) so a `KHR_interactivity`
 *  asset can't silently render a broken interaction. */
export async function createFgEnv(graph: FgGraph, wiring: FgWiring = {}): Promise<FgEnv> {
    const defs: Record<string, FgBlockDef> = {};
    const unsupported: string[] = [];

    for (const block of graph.blocks) {
        if (defs[block.type]) {
            continue;
        }
        const override = wiring.defs?.[block.type];
        if (override) {
            defs[block.type] = override;
            continue;
        }
        const loader = getBlockDef(block.type);
        if (!loader) {
            if (!unsupported.includes(block.type)) {
                unsupported.push(block.type);
            }
            continue;
        }
        defs[block.type] = await loader();
    }

    if (unsupported.length > 0) {
        throw new Error(`flow-graph: unsupported block type(s): ${unsupported.join(", ")}`);
    }

    return {
        graph,
        defs,
        accessors: wiring.accessors ?? {},
        animations: wiring.animations ?? [],
        caps: wiring.caps ?? {},
        events: wiring.events ?? createFgEventBus(),
    };
}

/** One graph runtime = graph + context + env, owned by the scene. */
export interface FgRuntime {
    readonly graph: FgGraph;
    readonly context: FgContext;
    readonly env: FgEnv;
    started: boolean;
    /** @internal Bus unsubscribe fns registered at start, called on dispose. */
    _unsub: (() => void)[];
}

/** Assemble a runtime from a graph + wiring (creates context + env). */
export async function createFgRuntime(graph: FgGraph, wiring: FgWiring = {}, opts?: { rightHanded?: boolean }): Promise<FgRuntime> {
    const env = await createFgEnv(graph, wiring);
    const context = createFgContext(graph, opts);
    return { graph, context, env, started: false, _unsub: [] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle: start / tick / dispose
// ─────────────────────────────────────────────────────────────────────────────

/** Init priority for event blocks: lower runs/subscribes first. Custom-event
 *  receivers must be listening BEFORE the start cascade can send to them. */
function eventInitPriority(event: FgEventType): number {
    switch (event) {
        case FgEventType.CustomEvent:
            return 0;
        case FgEventType.Pointer:
        case FgEventType.Key:
            return 1;
        case FgEventType.Tick:
            return 2;
        case FgEventType.Start:
            return 3;
        default:
            return 2;
    }
}

/** Subscribe every non-start event block to the bus, in init-priority order,
 *  then fire the `Start` blocks once. Idempotent: a started runtime is skipped. */
export function startFlowGraph(rt: FgRuntime): void {
    if (rt.started) {
        return;
    }
    const { context: ctx, env } = rt;

    const eventBlocks = rt.graph.blocks.filter((b): b is FgBlock & { event: FgEventType } => b.event !== undefined);
    eventBlocks.sort((a, b) => eventInitPriority(a.event) - eventInitPriority(b.event));

    // 1. Subscribe ALL non-start receivers first (custom-event before start-like).
    for (const block of eventBlocks) {
        if (block.event === FgEventType.Start) {
            continue;
        }
        const def = env.defs[block.type];
        const unsub = subscribeFgEvent(env.events, block.event, (payload) => {
            ctx.executionVariables[`${block.id}:lastEvent`] = payload;
            def?.execute?.(block, ctx, env, block.event);
        });
        rt._unsub.push(unsub);
    }

    rt.started = true;

    // 2. THEN fire onStart blocks once (receivers are now listening).
    for (const block of eventBlocks) {
        if (block.event !== FgEventType.Start) {
            continue;
        }
        env.defs[block.type]?.execute?.(block, ctx, env, FgEventType.Start);
    }
}

/** Per-frame drive: pump the tick event, then advance pending async tasks in a
 *  cancellation-safe loop (a task may be canceled / a new one added mid-loop). */
export function tickFlowGraph(rt: FgRuntime, deltaMs: number): void {
    if (!rt.started) {
        startFlowGraph(rt);
    }
    const { context: ctx, env } = rt;

    pumpFgEvent(env.events, FgEventType.Tick, { deltaMs, deltaTime: deltaMs / 1000 });

    // Snapshot: tasks added during the loop are picked up next frame (not retro-ticked).
    const snapshot = ctx.pending.slice();
    for (const task of snapshot) {
        if (task.canceled || !stillPending(ctx, task)) {
            continue;
        }
        const block = blockById(env.graph, task.blockId);
        if (block) {
            env.defs[block.type]?.onTick?.(block, ctx, env, deltaMs, task);
        }
    }
    compactPending(ctx);
}

/** Tear down: cancel pending tasks (invoking `cancelPending` once per block),
 *  detach bus listeners, clear caches. Safe to call more than once. */
export function disposeFlowGraph(rt: FgRuntime): void {
    const { context: ctx, env } = rt;

    for (const unsub of rt._unsub) {
        unsub();
    }
    rt._unsub.length = 0;

    const visited = new Set<string>();
    for (const task of ctx.pending) {
        task.canceled = true;
        if (!visited.has(task.blockId)) {
            visited.add(task.blockId);
            const block = blockById(env.graph, task.blockId);
            if (block) {
                env.defs[block.type]?.cancelPending?.(block, ctx, env);
            }
        }
    }
    ctx.pending.length = 0;

    for (const key of Object.keys(ctx.connectionValues)) {
        delete ctx.connectionValues[key];
    }
    for (const key of Object.keys(ctx.executionVariables)) {
        delete ctx.executionVariables[key];
    }
    rt.started = false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function blockById(graph: FgGraph, id: string): FgBlock | undefined {
    const index = graph.byId[id];
    return index === undefined ? undefined : graph.blocks[index];
}
