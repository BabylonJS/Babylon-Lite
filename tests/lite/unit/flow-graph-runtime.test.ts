import { describe, expect, it } from "vitest";

import type { FgBlock, FgBlockDef, FgGraph, FgPendingTask, FgValue } from "../../../packages/babylon-lite/src/flow-graph/index";
import {
    activateSignal,
    addPending,
    cancelPendingForBlock,
    createFgRuntime,
    disposeFlowGraph,
    FgEventType,
    FgType,
    getDataValue,
    pumpFgEvent,
    setDataValue,
    startFlowGraph,
    tickFlowGraph,
} from "../../../packages/babylon-lite/src/flow-graph/index";

// ─── tiny builders ──────────────────────────────────────────────────────────

function mkBlock(partial: Partial<FgBlock> & { id: string; type: string }): FgBlock {
    return { dataIn: [], dataOut: [], signalIn: [], signalOut: [], ...partial };
}

function mkGraph(blocks: FgBlock[], variables: FgGraph["variables"] = {}): FgGraph {
    const byId: Record<string, number> = {};
    blocks.forEach((b, i) => (byId[b.id] = i));
    return { blocks, byId, variables };
}

// ─── reusable hand-built defs ───────────────────────────────────────────────

/** Data producer: emits `value` = the named user variable (recomputes each pull). */
const getVarDef: FgBlockDef = {
    type: "getVar",
    build: () => ({ dataOut: [{ name: "value", type: FgType.Number }] }),
    updateOutputs: (block, ctx) => {
        const name = block.config?.name as string;
        setDataValue(ctx, block, "value", ctx.userVariables[name] ?? 0);
    },
};

/** Data passthrough: `value` = pulled `in`. Used for cycle-guard test. */
const passthroughDef: FgBlockDef = {
    type: "passthrough",
    build: () => ({ dataIn: [{ name: "in", type: FgType.Number }], dataOut: [{ name: "value", type: FgType.Number }] }),
    updateOutputs: (block, ctx, env) => {
        setDataValue(ctx, block, "value", getDataValue(ctx, env, block, "in"));
    },
};

const startDef: FgBlockDef = {
    type: "start",
    build: () => ({ event: FgEventType.Start, signalOut: [{ name: "out", targets: [] }] }),
    execute: (block, ctx, env) => activateSignal(ctx, env, block, "out"),
};

const sequenceDef: FgBlockDef = {
    type: "sequence",
    build: () => ({
        signalIn: [{ name: "in", targets: [] }],
        signalOut: [
            { name: "out1", targets: [] },
            { name: "out2", targets: [] },
        ],
    }),
    execute: (block, ctx, env) => {
        activateSignal(ctx, env, block, "out1");
        activateSignal(ctx, env, block, "out2");
    },
};

function recordDef(log: string[]): FgBlockDef {
    return {
        type: "record",
        build: () => ({ signalIn: [{ name: "in", targets: [] }] }),
        execute: (block) => {
            log.push(block.config?.label as string);
        },
    };
}

const branchDef: FgBlockDef = {
    type: "branch",
    build: () => ({
        dataIn: [{ name: "condition", type: FgType.Boolean }],
        signalIn: [{ name: "in", targets: [] }],
        signalOut: [
            { name: "true", targets: [] },
            { name: "false", targets: [] },
        ],
    }),
    execute: (block, ctx, env) => {
        const cond = getDataValue(ctx, env, block, "condition");
        activateSignal(ctx, env, block, cond ? "true" : "false");
    },
};

// ─────────────────────────────────────────────────────────────────────────────

describe("flow-graph data edges (PULL)", () => {
    it("recomputes on every pull — no memoization of producer output", async () => {
        const producer = mkBlock({ id: "g", type: "getVar", config: { name: "x" }, dataOut: [{ name: "value", type: FgType.Number }] });
        const consumer = mkBlock({
            id: "c",
            type: "passthrough",
            dataIn: [{ name: "in", type: FgType.Number, source: { blockId: "g", socket: "value" } }],
        });
        const graph = mkGraph([producer, consumer], { x: { type: FgType.Number, value: 0 } });
        const rt = await createFgRuntime(graph, { defs: { getVar: getVarDef, passthrough: passthroughDef } });

        rt.context.userVariables.x = 5;
        expect(getDataValue(rt.context, rt.env, consumer, "in")).toBe(5);

        rt.context.userVariables.x = 9;
        expect(getDataValue(rt.context, rt.env, consumer, "in")).toBe(9);
    });

    it("falls back to the socket default when unwired", async () => {
        const consumer = mkBlock({ id: "c", type: "passthrough", dataIn: [{ name: "in", type: FgType.Number, defaultValue: 42 }] });
        const graph = mkGraph([consumer]);
        const rt = await createFgRuntime(graph, { defs: { passthrough: passthroughDef } });
        expect(getDataValue(rt.context, rt.env, consumer, "in")).toBe(42);
    });

    it("breaks accidental data cycles via the resolving guard (returns default, no hang)", async () => {
        const a = mkBlock({
            id: "A",
            type: "passthrough",
            dataIn: [{ name: "in", type: FgType.Number, source: { blockId: "B", socket: "value" } }],
            dataOut: [{ name: "value", type: FgType.Number }],
        });
        const b = mkBlock({
            id: "B",
            type: "passthrough",
            dataIn: [{ name: "in", type: FgType.Number, source: { blockId: "A", socket: "value" } }],
            dataOut: [{ name: "value", type: FgType.Number }],
        });
        const graph = mkGraph([a, b]);
        const rt = await createFgRuntime(graph, { defs: { passthrough: passthroughDef } });
        expect(getDataValue(rt.context, rt.env, a, "in")).toBe(0);
    });
});

describe("flow-graph signal edges (PUSH)", () => {
    it("fires sequence outputs in declared order", async () => {
        const log: string[] = [];
        const start = mkBlock({ id: "s", type: "start", event: FgEventType.Start, signalOut: [{ name: "out", targets: [{ blockId: "seq", socket: "in" }] }] });
        const seq = mkBlock({
            id: "seq",
            type: "sequence",
            signalIn: [{ name: "in", targets: [] }],
            signalOut: [
                { name: "out1", targets: [{ blockId: "a", socket: "in" }] },
                { name: "out2", targets: [{ blockId: "b", socket: "in" }] },
            ],
        });
        const a = mkBlock({ id: "a", type: "record", config: { label: "A" }, signalIn: [{ name: "in", targets: [] }] });
        const b = mkBlock({ id: "b", type: "record", config: { label: "B" }, signalIn: [{ name: "in", targets: [] }] });
        const graph = mkGraph([start, seq, a, b]);
        const rt = await createFgRuntime(graph, { defs: { start: startDef, sequence: sequenceDef, record: recordDef(log) } });

        startFlowGraph(rt);
        expect(log).toEqual(["A", "B"]);
    });

    it("branch routes to the active output only", async () => {
        const log: string[] = [];
        const start = mkBlock({ id: "s", type: "start", event: FgEventType.Start, signalOut: [{ name: "out", targets: [{ blockId: "br", socket: "in" }] }] });
        const br = mkBlock({
            id: "br",
            type: "branch",
            dataIn: [{ name: "condition", type: FgType.Boolean, defaultValue: true }],
            signalIn: [{ name: "in", targets: [] }],
            signalOut: [
                { name: "true", targets: [{ blockId: "a", socket: "in" }] },
                { name: "false", targets: [{ blockId: "b", socket: "in" }] },
            ],
        });
        const a = mkBlock({ id: "a", type: "record", config: { label: "TRUE" }, signalIn: [{ name: "in", targets: [] }] });
        const b = mkBlock({ id: "b", type: "record", config: { label: "FALSE" }, signalIn: [{ name: "in", targets: [] }] });
        const graph = mkGraph([start, br, a, b]);
        const rt = await createFgRuntime(graph, { defs: { start: startDef, branch: branchDef, record: recordDef(log) } });

        startFlowGraph(rt);
        expect(log).toEqual(["TRUE"]);
    });
});

describe("flow-graph async pending tasks", () => {
    /** A delay that counts down `durationMs` then fires `done`. Dedupes re-entry. */
    function delayDef(): FgBlockDef {
        return {
            type: "delay",
            build: () => ({
                dataIn: [{ name: "duration", type: FgType.Number }],
                signalIn: [{ name: "in", targets: [] }],
                signalOut: [{ name: "done", targets: [] }],
            }),
            execute: (block, ctx, env) => {
                // dedupe: ignore re-entry while a task is already live
                if (ctx.pending.some((t) => t.blockId === block.id && !t.canceled && !t.done)) {
                    return;
                }
                const duration = (getDataValue(ctx, env, block, "duration") as number) ?? 0;
                addPending(ctx, block, { remainingMs: duration });
            },
            onTick: (block, ctx, env, deltaMs, task) => {
                task.state.remainingMs = (task.state.remainingMs as number) - deltaMs;
                if ((task.state.remainingMs as number) <= 0) {
                    task.done = true;
                    activateSignal(ctx, env, block, "done");
                }
            },
            cancelPending: (block, ctx) => cancelPendingForBlock(ctx, block),
        };
    }

    it("counts down across frames and fires done exactly once", async () => {
        const log: string[] = [];
        const start = mkBlock({ id: "s", type: "start", event: FgEventType.Start, signalOut: [{ name: "out", targets: [{ blockId: "d", socket: "in" }] }] });
        const d = mkBlock({
            id: "d",
            type: "delay",
            dataIn: [{ name: "duration", type: FgType.Number, defaultValue: 100 }],
            signalIn: [{ name: "in", targets: [] }],
            signalOut: [{ name: "done", targets: [{ blockId: "r", socket: "in" }] }],
        });
        const r = mkBlock({ id: "r", type: "record", config: { label: "DONE" }, signalIn: [{ name: "in", targets: [] }] });
        const graph = mkGraph([start, d, r]);
        const rt = await createFgRuntime(graph, { defs: { start: startDef, delay: delayDef(), record: recordDef(log) } });

        startFlowGraph(rt);
        expect(rt.context.pending.length).toBe(1);
        expect(log).toEqual([]);

        tickFlowGraph(rt, 60);
        expect(log).toEqual([]); // 40ms left

        tickFlowGraph(rt, 60);
        expect(log).toEqual(["DONE"]); // fired
        expect(rt.context.pending.length).toBe(0); // compacted out
    });

    it("dedupes re-entry — a second trigger does not add a second task", async () => {
        const d = mkBlock({
            id: "d",
            type: "delay",
            dataIn: [{ name: "duration", type: FgType.Number, defaultValue: 100 }],
            signalIn: [{ name: "in", targets: [] }],
            signalOut: [{ name: "done", targets: [] }],
        });
        const graph = mkGraph([d]);
        const rt = await createFgRuntime(graph, { defs: { delay: delayDef() } });

        const def = rt.env.defs.delay!;
        def.execute!(d, rt.context, rt.env, "in");
        def.execute!(d, rt.context, rt.env, "in");
        expect(rt.context.pending.length).toBe(1);
    });

    it("is cancellation-safe: a task canceled mid-loop never fires", async () => {
        const log: string[] = [];
        // canceller's onTick cancels the target block once it elapses.
        const cancellerDef: FgBlockDef = {
            type: "canceller",
            build: () => ({ signalIn: [{ name: "in", targets: [] }] }),
            execute: (block, ctx) => addPending(ctx, block, { remainingMs: 60 }),
            onTick: (block, ctx, env, deltaMs, task) => {
                task.state.remainingMs = (task.state.remainingMs as number) - deltaMs;
                if ((task.state.remainingMs as number) <= 0) {
                    task.done = true;
                    const targetId = block.config?.cancelId as string;
                    const target = env.graph.blocks[env.graph.byId[targetId]!]!;
                    cancelPendingForBlock(ctx, target);
                }
            },
        };
        const victimDef: FgBlockDef = {
            type: "victim",
            build: () => ({ signalIn: [{ name: "in", targets: [] }], signalOut: [{ name: "done", targets: [] }] }),
            execute: (block, ctx) => addPending(ctx, block, { remainingMs: 60 }),
            onTick: (_block, _ctx, _env, deltaMs, task) => {
                task.state.remainingMs = (task.state.remainingMs as number) - deltaMs;
                if ((task.state.remainingMs as number) <= 0) {
                    task.done = true;
                    log.push("VICTIM_FIRED");
                }
            },
        };
        const canceller = mkBlock({ id: "C", type: "canceller", config: { cancelId: "V" }, signalIn: [{ name: "in", targets: [] }] });
        const victim = mkBlock({ id: "V", type: "victim", signalIn: [{ name: "in", targets: [] }], signalOut: [{ name: "done", targets: [] }] });
        const graph = mkGraph([canceller, victim]);
        const rt = await createFgRuntime(graph, { defs: { canceller: cancellerDef, victim: victimDef } });

        // Seed both tasks (C is first in pending so it ticks first and cancels V).
        cancellerDef.execute!(canceller, rt.context, rt.env, "in");
        victimDef.execute!(victim, rt.context, rt.env, "in");
        expect(rt.context.pending.length).toBe(2);

        tickFlowGraph(rt, 60);
        expect(log).toEqual([]); // victim was canceled before its turn
        expect(rt.context.pending.length).toBe(0);
    });

    it("does not retro-tick a task added during the same frame's loop", async () => {
        let addedTask: FgPendingTask | null = null;
        const adderDef: FgBlockDef = {
            type: "adder",
            build: () => ({}),
            execute: (block, ctx) => addPending(ctx, block, { ticks: 0 }),
            onTick: (block, ctx, _env, _deltaMs, task) => {
                task.state.ticks = (task.state.ticks as number) + 1;
                task.done = true;
                if (!addedTask) {
                    addedTask = addPending(ctx, block, { ticks: 0 });
                }
            },
        };
        const adder = mkBlock({ id: "A", type: "adder" });
        const rt = await createFgRuntime(mkGraph([adder]), { defs: { adder: adderDef } });
        adderDef.execute!(adder, rt.context, rt.env, "in");

        tickFlowGraph(rt, 16);
        // The task added mid-loop must NOT have ticked this frame.
        expect((addedTask! as FgPendingTask).state.ticks).toBe(0);
    });
});

describe("flow-graph events", () => {
    it("delivers a custom event sent during the onStart cascade (receiver subscribed first)", async () => {
        const log: string[] = [];
        const sendDef: FgBlockDef = {
            type: "send",
            build: () => ({ signalIn: [{ name: "in", targets: [] }] }),
            execute: (block, _ctx, env) => pumpFgEvent(env.events, FgEventType.CustomEvent, { eventName: block.config?.eventName }),
        };
        const receiveDef: FgBlockDef = {
            type: "receive",
            build: () => ({ event: FgEventType.CustomEvent, signalOut: [{ name: "out", targets: [] }] }),
            execute: (block, ctx, env) => {
                const payload = ctx.executionVariables[`${block.id}:lastEvent`] as { eventName?: string } | undefined;
                if (payload?.eventName === block.config?.eventName) {
                    activateSignal(ctx, env, block, "out");
                }
            },
        };
        const start = mkBlock({ id: "s", type: "start", event: FgEventType.Start, signalOut: [{ name: "out", targets: [{ blockId: "snd", socket: "in" }] }] });
        const snd = mkBlock({ id: "snd", type: "send", config: { eventName: "ping" }, signalIn: [{ name: "in", targets: [] }] });
        const rcv = mkBlock({
            id: "rcv",
            type: "receive",
            event: FgEventType.CustomEvent,
            config: { eventName: "ping" },
            signalOut: [{ name: "out", targets: [{ blockId: "r", socket: "in" }] }],
        });
        const r = mkBlock({ id: "r", type: "record", config: { label: "GOT_PING" }, signalIn: [{ name: "in", targets: [] }] });
        const graph = mkGraph([start, snd, rcv, r]);
        const rt = await createFgRuntime(graph, { defs: { start: startDef, send: sendDef, receive: receiveDef, record: recordDef(log) } });

        startFlowGraph(rt);
        expect(log).toEqual(["GOT_PING"]);
    });

    it("pumps a tick event each frame", async () => {
        const log: string[] = [];
        const onTickEventDef: FgBlockDef = {
            type: "onTick",
            build: () => ({ event: FgEventType.Tick, signalOut: [{ name: "out", targets: [] }] }),
            execute: (block, ctx) => {
                const payload = ctx.executionVariables[`${block.id}:lastEvent`] as { deltaMs?: number };
                log.push(`tick:${payload.deltaMs}`);
            },
        };
        const t = mkBlock({ id: "t", type: "onTick", event: FgEventType.Tick, signalOut: [{ name: "out", targets: [] }] });
        const rt = await createFgRuntime(mkGraph([t]), { defs: { onTick: onTickEventDef } });

        startFlowGraph(rt);
        tickFlowGraph(rt, 16);
        tickFlowGraph(rt, 32);
        expect(log).toEqual(["tick:16", "tick:32"]);
    });

    it("disposeFlowGraph detaches listeners and clears state", async () => {
        const log: string[] = [];
        const onTickEventDef: FgBlockDef = {
            type: "onTick",
            build: () => ({ event: FgEventType.Tick }),
            execute: (block) => log.push(block.id),
        };
        const t = mkBlock({ id: "t", type: "onTick", event: FgEventType.Tick });
        const rt = await createFgRuntime(mkGraph([t]), { defs: { onTick: onTickEventDef } });

        startFlowGraph(rt);
        tickFlowGraph(rt, 16);
        expect(log.length).toBe(1);

        disposeFlowGraph(rt);
        // Pumping the bus directly after dispose must not reach the detached listener.
        pumpFgEvent(rt.env.events, FgEventType.Tick, { deltaMs: 16 });
        expect(log.length).toBe(1);
        expect(rt.started).toBe(false);
    });

    it("seeds userVariables from graph variables", async () => {
        const graph = mkGraph([], { score: { type: FgType.Number, value: 7 }, name: { type: FgType.String, value: "hi" as FgValue } });
        const rt = await createFgRuntime(graph, {});
        expect(rt.context.userVariables.score).toBe(7);
        expect(rt.context.userVariables.name).toBe("hi");
    });
});

describe("flow-graph env resolution", () => {
    it("fails loudly on an unsupported block type", async () => {
        const graph = mkGraph([mkBlock({ id: "x", type: "DoesNotExist" })]);
        await expect(createFgRuntime(graph, {})).rejects.toThrow(/unsupported block type/);
    });
});
