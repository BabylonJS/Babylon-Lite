import { describe, expect, it, vi } from "vitest";

import type { AnimationGroup } from "../../../packages/babylon-lite/src/animation/animation-group";
import type { FgAccessor, FgBlock, FgBlockDef, FgGraph, FgValue, FgWiring } from "../../../packages/babylon-lite/src/flow-graph/index";
import {
    createFgRuntime,
    fgInt,
    fgMatrix2D,
    fgMatrix3D,
    isFgMatrix2D,
    isFgMatrix3D,
    FgEventType,
    FgType,
    getBlockDef,
    getDataValue,
    pumpFgEvent,
    startFlowGraph,
    tickFlowGraph,
} from "../../../packages/babylon-lite/src/flow-graph/index";

// ─── graph + runtime builder driven by the REAL registry ────────────────────

interface Edge {
    blockId: string;
    socket: string;
}
interface NodeSpec {
    id: string;
    type: string;
    config?: Record<string, unknown>;
    /** signal output socket name → wired targets */
    signalTargets?: Record<string, Edge[]>;
    /** data input socket name → wired source */
    dataSources?: Record<string, Edge>;
    /** data input socket name → literal fallback (when unwired) */
    dataDefaults?: Record<string, FgValue>;
}

/** Instantiate each node's shape from its def (resolved via the production
 *  `getBlockDef` registry, unless supplied in `defs`), then wire edges. */
async function buildGraph(specs: NodeSpec[], variables: FgGraph["variables"], defs: Record<string, FgBlockDef>): Promise<FgGraph> {
    const blocks: FgBlock[] = [];
    for (const spec of specs) {
        const def = defs[spec.type] ?? (await getBlockDef(spec.type)!());
        const shape = def.build(spec.config);
        blocks.push({
            id: spec.id,
            type: spec.type,
            config: spec.config,
            dataIn: (shape.dataIn ?? []).map((d) => ({
                name: d.name,
                type: d.type,
                source: spec.dataSources?.[d.name],
                defaultValue: spec.dataDefaults?.[d.name] ?? d.defaultValue,
            })),
            dataOut: shape.dataOut ?? [],
            signalIn: shape.signalIn ?? [],
            signalOut: (shape.signalOut ?? []).map((s) => ({ name: s.name, targets: spec.signalTargets?.[s.name] ?? [] })),
            event: shape.event,
        });
    }
    const byId: Record<string, number> = {};
    blocks.forEach((b, i) => (byId[b.id] = i));
    return { blocks, byId, variables };
}

/** Build a graph + runtime, threading test-only `defs` (e.g. the recorder) into
 *  BOTH shape instantiation and the runtime env so blocks under test still
 *  resolve via the production registry. */
async function makeRuntime(specs: NodeSpec[], opts: { variables?: FgGraph["variables"]; wiring?: FgWiring; defs?: Record<string, FgBlockDef> } = {}) {
    const defs = opts.defs ?? {};
    const graph = await buildGraph(specs, opts.variables ?? {}, defs);
    return createFgRuntime(graph, { ...(opts.wiring ?? {}), defs });
}

/** Test-only recorder: logs incoming signal label + the pulled `value` input.
 *  Passed via `defs` so blocks UNDER TEST still resolve via the registry. */
const RECORD = "test/record";
function recorderDef(log: { label: string; value: FgValue }[]): FgBlockDef {
    return {
        type: RECORD,
        build: () => ({ signalIn: [{ name: "in", targets: [] }], dataIn: [{ name: "value", type: FgType.Any }] }),
        execute: (block, ctx, env) => log.push({ label: (block.config?.label as string) ?? "", value: getDataValue(ctx, env, block, "value") }),
    };
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe("flow-graph blocks — events", () => {
    it("SceneStart fires its out signal once on start", async () => {
        const log: { label: string; value: FgValue }[] = [];
        const rt = await makeRuntime(
            [
                { id: "start", type: "SceneReadyEvent", signalTargets: { out: [{ blockId: "rec", socket: "in" }] } },
                { id: "rec", type: RECORD, config: { label: "started" } },
            ],
            { defs: { [RECORD]: recorderDef(log) } }
        );
        startFlowGraph(rt);
        startFlowGraph(rt); // idempotent
        expect(log.map((e) => e.label)).toEqual(["started"]);
    });

    it("SceneTick accumulates timeSinceStart and exposes deltaTime", async () => {
        const log: { label: string; value: FgValue }[] = [];
        const rt = await makeRuntime(
            [
                { id: "tick", type: "SceneTickEvent", signalTargets: { out: [{ blockId: "rec", socket: "in" }] } },
                { id: "rec", type: RECORD, dataSources: { value: { blockId: "tick", socket: "timeSinceStart" } } },
            ],
            { defs: { [RECORD]: recorderDef(log) } }
        );
        startFlowGraph(rt);
        tickFlowGraph(rt, 1000); // +1s
        tickFlowGraph(rt, 500); // +0.5s
        expect(log.map((e) => e.value)).toEqual([1, 1.5]);
    });

    it("OnSelect fires only when its configured node is picked", async () => {
        const log: { label: string; value: FgValue }[] = [];
        const rt = await makeRuntime(
            [
                { id: "sel", type: "OnSelect", config: { nodeIndex: 14 }, signalTargets: { out: [{ blockId: "rec", socket: "in" }] } },
                { id: "rec", type: RECORD, dataSources: { value: { blockId: "sel", socket: "selectedNodeIndex" } } },
            ],
            { defs: { [RECORD]: recorderDef(log) } }
        );
        startFlowGraph(rt);
        pumpFgEvent(rt.env.events, FgEventType.Pointer, { nodeIndex: 99 });
        expect(log).toHaveLength(0); // wrong node — inert
        pumpFgEvent(rt.env.events, FgEventType.Pointer, { nodeIndex: 14 });
        expect(log).toHaveLength(1);
        expect(log[0]!.value).toEqual({ value: 14, __fgInt: true });
    });
});

describe("flow-graph blocks — control flow", () => {
    it("Branch routes to onTrue / onFalse by condition", async () => {
        for (const [cond, expected] of [
            [true, "T"],
            [false, "F"],
        ] as const) {
            const log: { label: string; value: FgValue }[] = [];
            const rt = await makeRuntime(
                [
                    { id: "start", type: "SceneReadyEvent", signalTargets: { out: [{ blockId: "br", socket: "in" }] } },
                    {
                        id: "br",
                        type: "Branch",
                        dataDefaults: { condition: cond },
                        signalTargets: { onTrue: [{ blockId: "t", socket: "in" }], onFalse: [{ blockId: "f", socket: "in" }] },
                    },
                    { id: "t", type: RECORD, config: { label: "T" } },
                    { id: "f", type: RECORD, config: { label: "F" } },
                ],
                { defs: { [RECORD]: recorderDef(log) } }
            );
            startFlowGraph(rt);
            expect(log.map((e) => e.label)).toEqual([expected]);
        }
    });

    it("Sequence fires out_0..out_N in order", async () => {
        const log: { label: string; value: FgValue }[] = [];
        const rt = await makeRuntime(
            [
                { id: "start", type: "SceneReadyEvent", signalTargets: { out: [{ blockId: "seq", socket: "in" }] } },
                {
                    id: "seq",
                    type: "Sequence",
                    config: { outputSignalCount: 3 },
                    signalTargets: {
                        out_0: [{ blockId: "a", socket: "in" }],
                        out_1: [{ blockId: "b", socket: "in" }],
                        out_2: [{ blockId: "c", socket: "in" }],
                    },
                },
                { id: "a", type: RECORD, config: { label: "0" } },
                { id: "b", type: RECORD, config: { label: "1" } },
                { id: "c", type: RECORD, config: { label: "2" } },
            ],
            { defs: { [RECORD]: recorderDef(log) } }
        );
        startFlowGraph(rt);
        expect(log.map((e) => e.label)).toEqual(["0", "1", "2"]);
    });
});

describe("flow-graph blocks — math/data", () => {
    it("Add sums numbers (pulled through to a recorder)", async () => {
        const log: { label: string; value: FgValue }[] = [];
        const rt = await makeRuntime(
            [
                { id: "start", type: "SceneReadyEvent", signalTargets: { out: [{ blockId: "rec", socket: "in" }] } },
                { id: "add", type: "Add", dataDefaults: { a: 1, b: 2 } },
                { id: "rec", type: RECORD, dataSources: { value: { blockId: "add", socket: "value" } } },
            ],
            { defs: { [RECORD]: recorderDef(log) } }
        );
        startFlowGraph(rt);
        expect(log[0]!.value).toBe(3);
    });

    it("Add is component-wise for vectors", async () => {
        const log: { label: string; value: FgValue }[] = [];
        const rt = await makeRuntime(
            [
                { id: "start", type: "SceneReadyEvent", signalTargets: { out: [{ blockId: "rec", socket: "in" }] } },
                { id: "add", type: "Add", dataDefaults: { a: { x: 1, y: 2, z: 3 }, b: { x: 4, y: 5, z: 6 } } },
                { id: "rec", type: RECORD, dataSources: { value: { blockId: "add", socket: "value" } } },
            ],
            { defs: { [RECORD]: recorderDef(log) } }
        );
        startFlowGraph(rt);
        expect(log[0]!.value).toEqual({ x: 5, y: 7, z: 9 });
    });

    it.each([
        ["Subtract", 7, 4, 3],
        ["Multiply", 6, 7, 42],
        ["Divide", 20, 5, 4],
        ["Modulo", 17, 5, 2],
    ])("%s computes a∘b on numbers", async (type, a, b, expected) => {
        const log: { label: string; value: FgValue }[] = [];
        const rt = await makeRuntime(
            [
                { id: "start", type: "SceneReadyEvent", signalTargets: { out: [{ blockId: "rec", socket: "in" }] } },
                { id: "op", type, dataDefaults: { a, b } },
                { id: "rec", type: RECORD, dataSources: { value: { blockId: "op", socket: "value" } } },
            ],
            { defs: { [RECORD]: recorderDef(log) } }
        );
        startFlowGraph(rt);
        expect(log[0]!.value).toBe(expected);
    });

    it("Subtract/Multiply are component-wise for vectors", async () => {
        const log: { label: string; value: FgValue }[] = [];
        const rt = await makeRuntime(
            [
                {
                    id: "start",
                    type: "SceneReadyEvent",
                    signalTargets: {
                        out: [
                            { blockId: "rs", socket: "in" },
                            { blockId: "rm", socket: "in" },
                        ],
                    },
                },
                { id: "sub", type: "Subtract", dataDefaults: { a: { x: 5, y: 7 }, b: { x: 1, y: 2 } } },
                { id: "mul", type: "Multiply", dataDefaults: { a: { x: 2, y: 3 }, b: { x: 4, y: 5 } } },
                { id: "rs", type: RECORD, config: { label: "sub" }, dataSources: { value: { blockId: "sub", socket: "value" } } },
                { id: "rm", type: RECORD, config: { label: "mul" }, dataSources: { value: { blockId: "mul", socket: "value" } } },
            ],
            { defs: { [RECORD]: recorderDef(log) } }
        );
        startFlowGraph(rt);
        expect(log.find((l) => l.label === "sub")!.value).toEqual({ x: 4, y: 5 });
        expect(log.find((l) => l.label === "mul")!.value).toEqual({ x: 8, y: 15 });
    });

    it.each([
        ["Abs", -3.5, 3.5],
        ["Floor", 3.9, 3],
    ])("%s is unary", async (type, a, expected) => {
        const log: { label: string; value: FgValue }[] = [];
        const rt = await makeRuntime(
            [
                { id: "start", type: "SceneReadyEvent", signalTargets: { out: [{ blockId: "rec", socket: "in" }] } },
                { id: "op", type, dataDefaults: { a } },
                { id: "rec", type: RECORD, dataSources: { value: { blockId: "op", socket: "value" } } },
            ],
            { defs: { [RECORD]: recorderDef(log) } }
        );
        startFlowGraph(rt);
        expect(log[0]!.value).toBe(expected);
    });

    it.each([
        [1, 2, true],
        [2, 2, false],
        [3, 2, false],
    ])("LessThan(%d, %d) → %s", async (a, b, expected) => {
        const log: { label: string; value: FgValue }[] = [];
        const rt = await makeRuntime(
            [
                { id: "start", type: "SceneReadyEvent", signalTargets: { out: [{ blockId: "rec", socket: "in" }] } },
                { id: "op", type: "LessThan", dataDefaults: { a, b } },
                { id: "rec", type: RECORD, dataSources: { value: { blockId: "op", socket: "value" } } },
            ],
            { defs: { [RECORD]: recorderDef(log) } }
        );
        startFlowGraph(rt);
        expect(log[0]!.value).toBe(expected);
    });

    it.each([
        [-5, -3, 7, -3],
        [10, -3, 7, 7],
        [4, -3, 7, 4],
    ])("Clamp(%d, %d, %d) → %d", async (a, b, c, expected) => {
        const log: { label: string; value: FgValue }[] = [];
        const rt = await makeRuntime(
            [
                { id: "start", type: "SceneReadyEvent", signalTargets: { out: [{ blockId: "rec", socket: "in" }] } },
                { id: "op", type: "Clamp", dataDefaults: { a, b, c } },
                { id: "rec", type: RECORD, dataSources: { value: { blockId: "op", socket: "value" } } },
            ],
            { defs: { [RECORD]: recorderDef(log) } }
        );
        startFlowGraph(rt);
        expect(log[0]!.value).toBe(expected);
    });

    it("CombineVector2 builds a Vec2 from two scalars", async () => {
        const log: { label: string; value: FgValue }[] = [];
        const rt = await makeRuntime(
            [
                { id: "start", type: "SceneReadyEvent", signalTargets: { out: [{ blockId: "rec", socket: "in" }] } },
                { id: "op", type: "CombineVector2", dataDefaults: { a: 0.8, b: 0.1 } },
                { id: "rec", type: RECORD, dataSources: { value: { blockId: "op", socket: "value" } } },
            ],
            { defs: { [RECORD]: recorderDef(log) } }
        );
        startFlowGraph(rt);
        expect(log[0]!.value).toEqual({ x: 0.8, y: 0.1 });
    });

    it("ExtractVector2 splits a Vec2 into x/y outputs", async () => {
        const log: { label: string; value: FgValue }[] = [];
        const rt = await makeRuntime(
            [
                {
                    id: "start",
                    type: "SceneReadyEvent",
                    signalTargets: {
                        out: [
                            { blockId: "rx", socket: "in" },
                            { blockId: "ry", socket: "in" },
                        ],
                    },
                },
                { id: "op", type: "ExtractVector2", dataDefaults: { a: { x: 3, y: 4 } } },
                { id: "rx", type: RECORD, config: { label: "x" }, dataSources: { value: { blockId: "op", socket: "x" } } },
                { id: "ry", type: RECORD, config: { label: "y" }, dataSources: { value: { blockId: "op", socket: "y" } } },
            ],
            { defs: { [RECORD]: recorderDef(log) } }
        );
        startFlowGraph(rt);
        expect(log.find((l) => l.label === "x")!.value).toBe(3);
        expect(log.find((l) => l.label === "y")!.value).toBe(4);
    });

    it("Get/SetVariable round-trips a live graph variable", async () => {
        const log: { label: string; value: FgValue }[] = [];
        const rt = await makeRuntime(
            [
                { id: "start", type: "SceneReadyEvent", signalTargets: { out: [{ blockId: "set", socket: "in" }] } },
                {
                    id: "set",
                    type: "SetVariable",
                    config: { variable: "score" },
                    dataDefaults: { value: 42 },
                    signalTargets: { out: [{ blockId: "rec", socket: "in" }] },
                },
                { id: "get", type: "GetVariable", config: { variable: "score" } },
                { id: "rec", type: RECORD, dataSources: { value: { blockId: "get", socket: "value" } } },
            ],
            { variables: { score: { type: FgType.Number, value: 0 } }, defs: { [RECORD]: recorderDef(log) } }
        );
        startFlowGraph(rt);
        expect(rt.context.userVariables.score).toBe(42);
        expect(log[0]!.value).toBe(42);
    });
});

describe("flow-graph blocks — math Phase 3", () => {
    /** Build start→op→recorder, fire start, return the value pulled off `outSocket`. */
    async function evalOp(type: string, dataDefaults: Record<string, FgValue>, opts: { config?: Record<string, unknown>; outSocket?: string } = {}): Promise<FgValue> {
        const log: { label: string; value: FgValue }[] = [];
        const rt = await makeRuntime(
            [
                { id: "start", type: "SceneReadyEvent", signalTargets: { out: [{ blockId: "rec", socket: "in" }] } },
                { id: "op", type, config: opts.config, dataDefaults },
                { id: "rec", type: RECORD, dataSources: { value: { blockId: "op", socket: opts.outSocket ?? "value" } } },
            ],
            { defs: { [RECORD]: recorderDef(log) } }
        );
        startFlowGraph(rt);
        return log[0]!.value;
    }

    it.each([
        ["Negation", -5, 5],
        ["Sign", -2, -1],
        ["Sign", 0, 0],
        ["Ceil", 3.2, 4],
        ["Round", 2.5, 3],
        ["Round", -2.5, -2],
        ["Trunc", -3.9, -3],
        ["Fraction", 3.25, 0.25],
        ["Saturate", 1.5, 1],
        ["Saturate", -0.5, 0],
        ["SquareRoot", 9, 3],
        ["CubeRoot", 27, 3],
        ["Exponential", 0, 1],
        ["Log2", 8, 3],
        ["Log10", 1000, 3],
    ])("%s(%d) → %d", async (type, a, expected) => {
        expect(await evalOp(type, { a })).toBeCloseTo(expected as number, 10);
    });

    it.each([
        ["Sin", 0, 0],
        ["Cos", 0, 1],
        ["Tan", 0, 0],
        ["Asin", 1, Math.PI / 2],
        ["Acos", 1, 0],
        ["Atan", 0, 0],
        ["Sinh", 0, 0],
        ["Cosh", 0, 1],
        ["Tanh", 0, 0],
        ["DegToRad", 180, Math.PI],
        ["RadToDeg", Math.PI, 180],
    ])("%s(%d) trig/conv", async (type, a, expected) => {
        expect(await evalOp(type, { a })).toBeCloseTo(expected as number, 10);
    });

    it.each([
        ["Min", 3, 5, 3],
        ["Max", 3, 5, 5],
        ["Power", 2, 10, 1024],
        ["Atan2", 1, 1, Math.PI / 4],
    ])("%s(%d, %d) → %d", async (type, a, b, expected) => {
        expect(await evalOp(type, { a, b })).toBeCloseTo(expected as number, 10);
    });

    it.each([
        ["Equality", 2, 2, true],
        ["Equality", 2, 3, false],
        ["LessThanOrEqual", 2, 2, true],
        ["LessThanOrEqual", 3, 2, false],
        ["GreaterThan", 3, 2, true],
        ["GreaterThan", 2, 2, false],
        ["GreaterThanOrEqual", 2, 2, true],
        ["GreaterThanOrEqual", 1, 2, false],
    ])("%s(%d, %d) → %s", async (type, a, b, expected) => {
        expect(await evalOp(type, { a, b })).toBe(expected);
    });

    it.each([
        ["IsNaN", NaN, true],
        ["IsNaN", 3, false],
        ["IsInfinity", Infinity, true],
        ["IsInfinity", 3, false],
    ])("%s(%d) → %s", async (type, a, expected) => {
        expect(await evalOp(type, { a })).toBe(expected);
    });

    it.each([
        ["BitwiseAnd", 6, 3, 2],
        ["BitwiseOr", 6, 1, 7],
        ["BitwiseXor", 6, 3, 5],
        ["BitwiseLeftShift", 1, 4, 16],
        ["BitwiseRightShift", 16, 2, 4],
    ])("%s(%d, %d) on numbers → %d", async (type, a, b, expected) => {
        const r = await evalOp(type, { a, b });
        expect(isFgIntResult(r) ? (r as { value: number }).value : r).toBe(expected);
    });

    it.each([
        ["LeadingZeros", 1, 31],
        ["TrailingZeros", 8, 3],
        ["OneBitsCounter", 7, 3],
        ["BitwiseNot", 0, -1],
    ])("%s(%d) on numbers → %d", async (type, a, expected) => {
        const r = await evalOp(type, { a });
        expect(isFgIntResult(r) ? (r as { value: number }).value : r).toBe(expected);
    });

    it("bitwise and/or/not dispatch booleans logically", async () => {
        expect(await evalOp("BitwiseAnd", { a: true, b: false })).toBe(false);
        expect(await evalOp("BitwiseOr", { a: true, b: false })).toBe(true);
        expect(await evalOp("BitwiseNot", { a: true })).toBe(false);
    });

    it("bitwise ops round-trip FlowGraphInteger", async () => {
        const r = await evalOp("BitwiseAnd", { a: fgInt(6), b: fgInt(3) });
        expect(isFgIntResult(r)).toBe(true);
        expect((r as { value: number }).value).toBe(2);
    });

    it.each(["Length", "Dot"] as const)("vector scalar op %s", async (type) => {
        if (type === "Length") {
            expect(await evalOp("Length", { a: { x: 3, y: 4, z: 0 } })).toBeCloseTo(5, 10);
        } else {
            expect(await evalOp("Dot", { a: { x: 1, y: 2, z: 3 }, b: { x: 4, y: 5, z: 6 } })).toBeCloseTo(32, 10);
        }
    });

    it("Normalize returns a unit vector", async () => {
        const r = (await evalOp("Normalize", { a: { x: 3, y: 4, z: 0 } })) as { x: number; y: number; z: number };
        expect(r.x).toBeCloseTo(0.6, 10);
        expect(r.y).toBeCloseTo(0.8, 10);
        expect(r.z).toBeCloseTo(0, 10);
    });

    it("Cross computes the right-handed cross product", async () => {
        expect(await evalOp("Cross", { a: { x: 1, y: 0, z: 0 }, b: { x: 0, y: 1, z: 0 } })).toEqual({ x: 0, y: 0, z: 1 });
    });

    it("Rotate2D rotates a Vec2 CCW by angle (b)", async () => {
        const r = (await evalOp("Rotate2D", { a: { x: 1, y: 0 }, b: Math.PI / 2 })) as { x: number; y: number };
        expect(r.x).toBeCloseTo(0, 10);
        expect(r.y).toBeCloseTo(1, 10);
    });

    it("Rotate3D by identity quaternion is a no-op", async () => {
        const r = (await evalOp("Rotate3D", { a: { x: 1, y: 2, z: 3 }, b: { x: 0, y: 0, z: 0, w: 1 } })) as { x: number; y: number; z: number };
        expect(r.x).toBeCloseTo(1, 10);
        expect(r.y).toBeCloseTo(2, 10);
        expect(r.z).toBeCloseTo(3, 10);
    });

    it("CombineVector3/4 build vectors from scalars", async () => {
        expect(await evalOp("CombineVector3", { a: 1, b: 2, c: 3 })).toEqual({ x: 1, y: 2, z: 3 });
        expect(await evalOp("CombineVector4", { a: 1, b: 2, c: 3, d: 4 })).toEqual({ x: 1, y: 2, z: 3, w: 4 });
    });

    it("ExtractVector3/4 split vectors into component sockets", async () => {
        expect(await evalOp("ExtractVector3", { a: { x: 7, y: 8, z: 9 } }, { outSocket: "z" })).toBe(9);
        expect(await evalOp("ExtractVector4", { a: { x: 7, y: 8, z: 9, w: 10 } }, { outSocket: "w" })).toBe(10);
    });

    it.each([
        ["E", Math.E],
        ["PI", Math.PI],
    ])("constant %s emits its value", async (type, expected) => {
        expect(await evalOp(type, {})).toBeCloseTo(expected as number, 12);
    });

    it("Inf and NaN constants", async () => {
        expect(await evalOp("Inf", {})).toBe(Infinity);
        expect(Number.isNaN(await evalOp("NaN", {}))).toBe(true);
    });

    it("MathInterpolation mixes a→b by t = (1-t)a + t·b", async () => {
        expect(await evalOp("MathInterpolation", { a: 0, b: 10, c: 0.25 })).toBeCloseTo(2.5, 10);
    });

    it("Conditional (select) picks onTrue/onFalse from condition", async () => {
        expect(await evalOp("Conditional", { condition: true, onTrue: 11, onFalse: 22 })).toBe(11);
        expect(await evalOp("Conditional", { condition: false, onTrue: 11, onFalse: 22 })).toBe(22);
    });

    it("DataSwitch selects the matching case, else default", async () => {
        const config = { cases: [0, 1, 2] };
        expect(await evalOp("DataSwitch", { case: 1, default: -1, in_0: 10, in_1: 20, in_2: 30 }, { config })).toBe(20);
        expect(await evalOp("DataSwitch", { case: 9, default: -1, in_0: 10, in_1: 20, in_2: 30 }, { config })).toBe(-1);
    });

    it.each([
        ["BooleanToFloat", true, 1],
        ["BooleanToInt", false, 0],
        ["FloatToBoolean", 0, false],
        ["FloatToBoolean", 2.5, true],
        ["IntToFloat", 5, 5],
    ])("conversion %s", async (type, a, expected) => {
        const r = await evalOp(type, { a });
        const v = isFgIntResult(r) ? (r as { value: number }).value : r;
        expect(v).toBe(expected);
    });
});

/** True when a value is a FlowGraphInteger box (re-wrapped by bitwise/int ops). */
function isFgIntResult(v: FgValue): boolean {
    return (
        typeof v === "object" &&
        v !== null &&
        "value" in (v as unknown as Record<string, unknown>) &&
        typeof (v as { value: unknown }).value === "number" &&
        !("x" in (v as unknown as Record<string, unknown>))
    );
}

describe("flow-graph blocks — property accessors", () => {
    function vec3Accessor(initial: { x: number; y: number; z: number }): { acc: FgAccessor; box: { v: FgValue } } {
        const box = { v: initial as FgValue };
        return {
            box,
            acc: {
                type: FgType.Vector3,
                get: () => box.v,
                set: (value) => {
                    box.v = value;
                },
            },
        };
    }

    it("SetProperty writes through a resolved accessor and fires out", async () => {
        const log: { label: string; value: FgValue }[] = [];
        const { acc, box } = vec3Accessor({ x: 0, y: 0, z: 0 });
        const rt = await makeRuntime(
            [
                { id: "start", type: "SceneReadyEvent", signalTargets: { out: [{ blockId: "set", socket: "in" }] } },
                {
                    id: "set",
                    type: "SetProperty",
                    config: { accessor: "/nodes/0/translation" },
                    dataDefaults: { value: { x: 1, y: 1, z: 1 } },
                    signalTargets: { out: [{ blockId: "rec", socket: "in" }] },
                },
                { id: "rec", type: RECORD, config: { label: "ok" } },
            ],
            { wiring: { accessors: { "/nodes/0/translation": acc } }, defs: { [RECORD]: recorderDef(log) } }
        );
        startFlowGraph(rt);
        expect(box.v).toEqual({ x: 1, y: 1, z: 1 });
        expect(log.map((e) => e.label)).toEqual(["ok"]);
    });

    it("SetProperty fires error when the accessor is missing", async () => {
        const log: { label: string; value: FgValue }[] = [];
        const rt = await makeRuntime(
            [
                { id: "start", type: "SceneReadyEvent", signalTargets: { out: [{ blockId: "set", socket: "in" }] } },
                {
                    id: "set",
                    type: "SetProperty",
                    config: { accessor: "/missing" },
                    dataDefaults: { value: 1 },
                    signalTargets: { error: [{ blockId: "rec", socket: "in" }] },
                },
                { id: "rec", type: RECORD, config: { label: "err" } },
            ],
            { defs: { [RECORD]: recorderDef(log) } }
        );
        startFlowGraph(rt);
        expect(log.map((e) => e.label)).toEqual(["err"]);
    });

    it("GetProperty reads through a resolved accessor", async () => {
        const log: { label: string; value: FgValue }[] = [];
        const { acc } = vec3Accessor({ x: 7, y: 8, z: 9 });
        const rt = await makeRuntime(
            [
                { id: "start", type: "SceneReadyEvent", signalTargets: { out: [{ blockId: "rec", socket: "in" }] } },
                { id: "get", type: "GetProperty", config: { accessor: "p" } },
                { id: "rec", type: RECORD, dataSources: { value: { blockId: "get", socket: "value" } } },
            ],
            { wiring: { accessors: { p: acc } }, defs: { [RECORD]: recorderDef(log) } }
        );
        startFlowGraph(rt);
        expect(log[0]!.value).toEqual({ x: 7, y: 8, z: 9 });
    });
});

describe("flow-graph blocks — animation", () => {
    function mockGroup(): AnimationGroup {
        return {
            name: "anim",
            duration: 1,
            isPlaying: false,
            currentTime: 0,
            targetedAnimations: [],
            speedRatio: 1,
            loopAnimation: false,
            weight: 1,
            _stopped: false,
        } as AnimationGroup;
    }

    it("PlayAnimation invokes the play capability and fires out, then done on end", async () => {
        const log: { label: string; value: FgValue }[] = [];
        const group = mockGroup();
        let endCb: (() => void) | undefined;
        const wiring: FgWiring = {
            animations: [group],
            caps: {
                playAnimation: vi.fn((g, opts) => {
                    g.isPlaying = true;
                    if (opts?.speed !== undefined) {
                        g.speedRatio = opts.speed;
                    }
                }),
                onAnimationEnd: (_g, cb) => {
                    endCb = cb;
                    return () => {
                        endCb = undefined;
                    };
                },
            },
        };
        const rt = await makeRuntime(
            [
                { id: "start", type: "SceneReadyEvent", signalTargets: { out: [{ blockId: "play", socket: "in" }] } },
                {
                    id: "play",
                    type: "PlayAnimation",
                    dataDefaults: { animation: 0, speed: 2 },
                    signalTargets: { out: [{ blockId: "o", socket: "in" }], done: [{ blockId: "d", socket: "in" }] },
                },
                { id: "o", type: RECORD, config: { label: "out" } },
                { id: "d", type: RECORD, config: { label: "done" } },
            ],
            { wiring, defs: { [RECORD]: recorderDef(log) } }
        );
        startFlowGraph(rt);
        expect(wiring.caps!.playAnimation).toHaveBeenCalledTimes(1);
        expect(group.speedRatio).toBe(2);
        expect(log.map((e) => e.label)).toEqual(["out"]);
        endCb?.(); // simulate the animation ending
        expect(log.map((e) => e.label)).toEqual(["out", "done"]);
    });

    it("StopAnimation invokes the stop capability", async () => {
        const group = mockGroup();
        const stop = vi.fn();
        const rt = await makeRuntime(
            [
                { id: "start", type: "SceneReadyEvent", signalTargets: { out: [{ blockId: "stop", socket: "in" }] } },
                { id: "stop", type: "StopAnimation", dataDefaults: { animation: 0 } },
            ],
            { wiring: { animations: [group], caps: { stopAnimation: stop } } }
        );
        startFlowGraph(rt);
        expect(stop).toHaveBeenCalledWith(group);
    });
});

describe("flow-graph blocks — matrix/quaternion", () => {
    /** Reuse the evalOp helper from Phase-3 tests. Same graph shape:
     *  start → op → recorder; returns the value at `outSocket`. */
    async function evalOp(type: string, dataDefaults: Record<string, FgValue>, opts: { config?: Record<string, unknown>; outSocket?: string } = {}): Promise<FgValue> {
        const log: { label: string; value: FgValue }[] = [];
        const rt = await makeRuntime(
            [
                { id: "start", type: "SceneReadyEvent", signalTargets: { out: [{ blockId: "rec", socket: "in" }] } },
                { id: "op", type, config: opts.config, dataDefaults },
                { id: "rec", type: RECORD, dataSources: { value: { blockId: "op", socket: opts.outSocket ?? "value" } } },
            ],
            { defs: { [RECORD]: recorderDef(log) } }
        );
        startFlowGraph(rt);
        return log[0]!.value;
    }

    // ─── TransformVector ──────────────────────────────────────────────────────

    it("TransformVector: Vec2 × Matrix2D (M·v)", async () => {
        // M (col-major) = [1,2,3,4] → [[1,3],[2,4]]
        // v = (5,6); M·v = (1*5+3*6, 2*5+4*6) = (23, 34)
        const m = fgMatrix2D([1, 2, 3, 4]);
        const r = (await evalOp("TransformVector", { a: { x: 5, y: 6 }, b: m })) as { x: number; y: number };
        expect(r.x).toBeCloseTo(23, 8);
        expect(r.y).toBeCloseTo(34, 8);
    });

    it("TransformVector: Vec3 × Matrix3D (M·v)", async () => {
        // Identity 3x3 → result = input
        const m = fgMatrix3D();
        const r = (await evalOp("TransformVector", { a: { x: 1, y: 2, z: 3 }, b: m })) as { x: number; y: number; z: number };
        expect(r.x).toBeCloseTo(1, 8);
        expect(r.y).toBeCloseTo(2, 8);
        expect(r.z).toBeCloseTo(3, 8);
    });

    // ─── MatrixMultiplication ─────────────────────────────────────────────────

    it("MatrixMultiplication: 2x2 col-major A×B", async () => {
        // A=[1,2,3,4] = [[1,3],[2,4]], B=[5,6,7,8] = [[5,7],[6,8]]
        // A×B[0][0] = 1*5+3*6=23, [1][0]=2*5+4*6=34, [0][1]=1*7+3*8=31, [1][1]=2*7+4*8=46
        const a = fgMatrix2D([1, 2, 3, 4]);
        const b = fgMatrix2D([5, 6, 7, 8]);
        const r = await evalOp("MatrixMultiplication", { a, b });
        expect(isFgMatrix2D(r)).toBe(true);
        if (isFgMatrix2D(r)) {
            expect(r.m[0]).toBeCloseTo(23, 8); // col0, row0
            expect(r.m[1]).toBeCloseTo(34, 8); // col0, row1
            expect(r.m[2]).toBeCloseTo(31, 8); // col1, row0
            expect(r.m[3]).toBeCloseTo(46, 8); // col1, row1
        }
    });

    it("MatrixMultiplication: identity × M = M (3x3)", async () => {
        const identity = fgMatrix3D();
        const m = fgMatrix3D([1, 2, 3, 4, 5, 6, 7, 8, 9]);
        const r = await evalOp("MatrixMultiplication", { a: identity, b: m });
        expect(isFgMatrix3D(r)).toBe(true);
        if (isFgMatrix3D(r)) {
            for (let i = 0; i < 9; i++) expect(r.m[i]).toBeCloseTo(m.m[i]!, 6);
        }
    });

    // ─── Determinant ──────────────────────────────────────────────────────────

    it("Determinant: 2x2 [1,2,3,4] = 1*4 - 2*3 = -2", async () => {
        const m = fgMatrix2D([1, 2, 3, 4]);
        expect(await evalOp("Determinant", { a: m })).toBeCloseTo(-2, 8);
    });

    it("Determinant: 3x3 identity = 1", async () => {
        expect(await evalOp("Determinant", { a: fgMatrix3D() })).toBeCloseTo(1, 8);
    });

    // ─── InvertMatrix ─────────────────────────────────────────────────────────

    it("InvertMatrix: M × inv(M) ≈ identity (2x2)", async () => {
        const m = fgMatrix2D([1, 2, 3, 4]);
        const inv = await evalOp("InvertMatrix", { a: m });
        expect(isFgMatrix2D(inv)).toBe(true);
        if (isFgMatrix2D(inv)) {
            // product M × inv should be identity
            const am = m.m,
                bm = inv.m;
            const c00 = am[0]! * bm[0]! + am[2]! * bm[1]!;
            const c11 = am[1]! * bm[2]! + am[3]! * bm[3]!;
            expect(c00).toBeCloseTo(1, 6);
            expect(c11).toBeCloseTo(1, 6);
        }
    });

    it("InvertMatrix: identity inverse is identity (3x3)", async () => {
        const inv = await evalOp("InvertMatrix", { a: fgMatrix3D() });
        expect(isFgMatrix3D(inv)).toBe(true);
        if (isFgMatrix3D(inv)) {
            expect(inv.m[0]).toBeCloseTo(1, 6);
            expect(inv.m[4]).toBeCloseTo(1, 6);
            expect(inv.m[8]).toBeCloseTo(1, 6);
        }
    });

    // ─── Transpose ───────────────────────────────────────────────────────────

    it("Transpose: 2x2 swaps off-diagonal", async () => {
        const m = fgMatrix2D([1, 2, 3, 4]); // col-major: [[1,3],[2,4]]
        const t = await evalOp("Transpose", { a: m });
        expect(isFgMatrix2D(t)).toBe(true);
        if (isFgMatrix2D(t)) {
            // transposed col-major = [1,3,2,4]
            expect(t.m[0]).toBeCloseTo(1, 8);
            expect(t.m[1]).toBeCloseTo(3, 8);
            expect(t.m[2]).toBeCloseTo(2, 8);
            expect(t.m[3]).toBeCloseTo(4, 8);
        }
    });

    // ─── CombineMatrix / ExtractMatrix round-trips ────────────────────────────

    it("CombineMatrix2D → ExtractMatrix2D round-trips 4 inputs", async () => {
        const inputs = [1, 2, 3, 4];
        const dataDefaults: Record<string, FgValue> = {};
        inputs.forEach((v, i) => (dataDefaults[`input_${i}`] = v));
        const combined = await evalOp("CombineMatrix2D", dataDefaults);
        expect(isFgMatrix2D(combined)).toBe(true);
        if (isFgMatrix2D(combined)) {
            for (let i = 0; i < 4; i++) {
                const e = await evalOp("ExtractMatrix2D", { input: combined }, { outSocket: `output_${i}` });
                expect(e).toBeCloseTo(inputs[i]!, 8);
            }
        }
    });

    it("CombineMatrix3D → ExtractMatrix3D round-trips 9 inputs", async () => {
        const inputs = [1, 2, 3, 4, 5, 6, 7, 8, 9];
        const dataDefaults: Record<string, FgValue> = {};
        inputs.forEach((v, i) => (dataDefaults[`input_${i}`] = v));
        const combined = await evalOp("CombineMatrix3D", dataDefaults);
        expect(isFgMatrix3D(combined)).toBe(true);
        if (isFgMatrix3D(combined)) {
            for (let i = 0; i < 9; i++) {
                const e = await evalOp("ExtractMatrix3D", { input: combined }, { outSocket: `output_${i}` });
                expect(e).toBeCloseTo(inputs[i]!, 8);
            }
        }
    });

    it("CombineMatrix (4x4) → ExtractMatrix round-trips 16 inputs", async () => {
        const inputs = Array.from({ length: 16 }, (_, i) => i + 1);
        const dataDefaults: Record<string, FgValue> = {};
        inputs.forEach((v, i) => (dataDefaults[`input_${i}`] = v));
        const combined = await evalOp("CombineMatrix", dataDefaults);
        expect(combined instanceof Float32Array).toBe(true);
        for (let i = 0; i < 16; i++) {
            const e = await evalOp("ExtractMatrix", { input: combined }, { outSocket: `output_${i}` });
            expect(e).toBeCloseTo(inputs[i]!, 8);
        }
    });

    // ─── MatrixCompose / MatrixDecompose ──────────────────────────────────────

    it("MatrixCompose then MatrixDecompose round-trips TRS", async () => {
        const pos = { x: 1, y: 2, z: 3 };
        const rot = { x: 0, y: 0, z: 0, w: 1 }; // identity quat
        const scl = { x: 2, y: 3, z: 4 };
        const mat = await evalOp("MatrixCompose", {
            position: pos,
            rotationQuaternion: rot,
            scaling: scl,
        });

        const posOut = (await evalOp("MatrixDecompose", { input: mat }, { outSocket: "position" })) as { x: number; y: number; z: number };
        const sclOut = (await evalOp("MatrixDecompose", { input: mat }, { outSocket: "scaling" })) as { x: number; y: number; z: number };
        const validOut = await evalOp("MatrixDecompose", { input: mat }, { outSocket: "isValid" });

        expect(posOut.x).toBeCloseTo(1, 5);
        expect(posOut.y).toBeCloseTo(2, 5);
        expect(posOut.z).toBeCloseTo(3, 5);
        expect(sclOut.x).toBeCloseTo(2, 5);
        expect(sclOut.y).toBeCloseTo(3, 5);
        expect(sclOut.z).toBeCloseTo(4, 5);
        expect(validOut).toBe(true);
    });

    it("MatrixDecompose returns isValid=false for non-TRS matrix", async () => {
        // A matrix with a bad bottom row ([1,0,0,1] instead of [0,0,0,1]).
        // In column-major 4x4, bottom row is at indices 3,7,11,15.
        const bad = new Float32Array(16);
        bad[0] = 1;
        bad[5] = 1;
        bad[10] = 1;
        bad[15] = 1; // identity base
        bad[3] = 1; // break bottom row: m[3] should be 0
        const validOut = await evalOp("MatrixDecompose", { input: bad as unknown as FgValue }, { outSocket: "isValid" });
        expect(validOut).toBe(false);
    });

    // ─── Quaternion ops ───────────────────────────────────────────────────────

    it("Conjugate: (-x,-y,-z,w)", async () => {
        const r = (await evalOp("Conjugate", { a: { x: 1, y: 2, z: 3, w: 4 } })) as { x: number; y: number; z: number; w: number };
        expect(r.x).toBeCloseTo(-1, 8);
        expect(r.y).toBeCloseTo(-2, 8);
        expect(r.z).toBeCloseTo(-3, 8);
        expect(r.w).toBeCloseTo(4, 8);
    });

    it("QuaternionFromAxisAngle: Y-axis 90° → known components", async () => {
        // axis=(0,1,0), angle=PI/2 → quat=(0, sin(PI/4), 0, cos(PI/4))
        const r = (await evalOp("QuaternionFromAxisAngle", {
            a: { x: 0, y: 1, z: 0 },
            b: Math.PI / 2,
        })) as { x: number; y: number; z: number; w: number };
        expect(r.x).toBeCloseTo(0, 8);
        expect(r.y).toBeCloseTo(Math.sin(Math.PI / 4), 8);
        expect(r.z).toBeCloseTo(0, 8);
        expect(r.w).toBeCloseTo(Math.cos(Math.PI / 4), 8);
    });

    it("AxisAngleFromQuaternion round-trips a known quaternion", async () => {
        // quat from Y-axis 90°
        const q = { x: 0, y: Math.sin(Math.PI / 4), z: 0, w: Math.cos(Math.PI / 4) };
        const axis = (await evalOp("AxisAngleFromQuaternion", { a: q }, { outSocket: "axis" })) as { x: number; y: number; z: number };
        const angle = (await evalOp("AxisAngleFromQuaternion", { a: q }, { outSocket: "angle" })) as number;
        const valid = await evalOp("AxisAngleFromQuaternion", { a: q }, { outSocket: "isValid" });
        expect(axis.x).toBeCloseTo(0, 5);
        expect(axis.y).toBeCloseTo(1, 5);
        expect(axis.z).toBeCloseTo(0, 5);
        expect(angle).toBeCloseTo(Math.PI / 2, 5);
        expect(valid).toBe(true);
    });

    it("AngleBetween: same quaternion → 0", async () => {
        const q = { x: 0, y: 0, z: 0, w: 1 };
        expect(await evalOp("AngleBetween", { a: q, b: q })).toBeCloseTo(0, 8);
    });

    it("AngleBetween: identity vs 180° rotation → PI", async () => {
        // 180° rotation around any axis: quat = (0,1,0,0) (Y-axis 180°)
        const q0 = { x: 0, y: 0, z: 0, w: 1 };
        const q180 = { x: 0, y: 1, z: 0, w: 0 };
        const result = await evalOp("AngleBetween", { a: q0, b: q180 });
        expect(result as number).toBeCloseTo(Math.PI, 5);
    });

    it("QuaternionFromDirections: (1,0,0) → (0,1,0) rotates 90° around Z", async () => {
        const a = { x: 1, y: 0, z: 0 };
        const b = { x: 0, y: 1, z: 0 };
        const r = (await evalOp("QuaternionFromDirections", { a, b })) as { x: number; y: number; z: number; w: number };
        // cross(a,b) = (0,0,1); angle = PI/2 → quat = (0,0,sin(PI/4),cos(PI/4))
        expect(r.x).toBeCloseTo(0, 5);
        expect(r.y).toBeCloseTo(0, 5);
        expect(r.z).toBeCloseTo(Math.sin(Math.PI / 4), 5);
        expect(r.w).toBeCloseTo(Math.cos(Math.PI / 4), 5);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3h — control-flow blocks
// ─────────────────────────────────────────────────────────────────────────────

describe("flow-graph blocks — control flow Phase 3h", () => {
    // ── Switch ────────────────────────────────────────────────────────────────

    it("Switch routes to matching out_<case> when case is known", async () => {
        for (const [sel, expected] of [
            [0, "zero"],
            [1, "one"],
            [99, "default"],
        ] as const) {
            const log: { label: string; value: FgValue }[] = [];
            const rt = await makeRuntime(
                [
                    { id: "start", type: "SceneReadyEvent", signalTargets: { out: [{ blockId: "sw", socket: "in" }] } },
                    {
                        id: "sw",
                        type: "Switch",
                        config: { cases: [0, 1] },
                        dataDefaults: { case: sel },
                        signalTargets: {
                            out_0: [{ blockId: "r0", socket: "in" }],
                            out_1: [{ blockId: "r1", socket: "in" }],
                            default: [{ blockId: "rd", socket: "in" }],
                        },
                    },
                    { id: "r0", type: RECORD, config: { label: "zero" } },
                    { id: "r1", type: RECORD, config: { label: "one" } },
                    { id: "rd", type: RECORD, config: { label: "default" } },
                ],
                { defs: { [RECORD]: recorderDef(log) } }
            );
            startFlowGraph(rt);
            expect(log.map((e) => e.label)).toEqual([expected]);
        }
    });

    it("Switch routes to default when no case matches", async () => {
        const log: { label: string; value: FgValue }[] = [];
        const rt = await makeRuntime(
            [
                { id: "start", type: "SceneReadyEvent", signalTargets: { out: [{ blockId: "sw", socket: "in" }] } },
                {
                    id: "sw",
                    type: "Switch",
                    config: { cases: [5, 10] },
                    dataDefaults: { case: 42 },
                    signalTargets: { default: [{ blockId: "rec", socket: "in" }] },
                },
                { id: "rec", type: RECORD, config: { label: "hit" } },
            ],
            { defs: { [RECORD]: recorderDef(log) } }
        );
        startFlowGraph(rt);
        expect(log.map((e) => e.label)).toEqual(["hit"]);
    });

    // ── ForLoop ───────────────────────────────────────────────────────────────

    it("ForLoop fires executionFlow for indices [start, end) exclusively", async () => {
        const log: { label: string; value: FgValue }[] = [];
        const rt = await makeRuntime(
            [
                { id: "start", type: "SceneReadyEvent", signalTargets: { out: [{ blockId: "fl", socket: "in" }] } },
                {
                    id: "fl",
                    type: "ForLoop",
                    dataDefaults: { startIndex: 2, endIndex: 5, step: 1 },
                    signalTargets: {
                        executionFlow: [{ blockId: "rec", socket: "in" }],
                        completed: [{ blockId: "done", socket: "in" }],
                    },
                },
                { id: "rec", type: RECORD, config: { label: "body" }, dataSources: { value: { blockId: "fl", socket: "index" } } },
                { id: "done", type: RECORD, config: { label: "done" } },
            ],
            { defs: { [RECORD]: recorderDef(log) } }
        );
        startFlowGraph(rt);
        // Indices 2, 3, 4 — end is EXCLUSIVE (BJS: i < endIndex); then "done" fires.
        expect(log.filter((e) => e.label === "body").map((e) => e.value)).toEqual([fgInt(2), fgInt(3), fgInt(4)]);
        expect(log.filter((e) => e.label === "done")).toHaveLength(1);
    });

    it("ForLoop fires completed immediately when startIndex >= endIndex", async () => {
        const log: { label: string; value: FgValue }[] = [];
        const rt = await makeRuntime(
            [
                { id: "start", type: "SceneReadyEvent", signalTargets: { out: [{ blockId: "fl", socket: "in" }] } },
                {
                    id: "fl",
                    type: "ForLoop",
                    dataDefaults: { startIndex: 3, endIndex: 3 },
                    signalTargets: {
                        executionFlow: [{ blockId: "body", socket: "in" }],
                        completed: [{ blockId: "done", socket: "in" }],
                    },
                },
                { id: "body", type: RECORD, config: { label: "body" } },
                { id: "done", type: RECORD, config: { label: "done" } },
            ],
            { defs: { [RECORD]: recorderDef(log) } }
        );
        startFlowGraph(rt);
        expect(log.map((e) => e.label)).toEqual(["done"]);
    });

    // ── WhileLoop ─────────────────────────────────────────────────────────────

    it("WhileLoop fires body N times then completed when condition goes false", async () => {
        const log: { label: string; value: FgValue }[] = [];
        let condVal = true;
        let callCount = 0;

        // Stateful recorder that flips the condition after 3 calls.
        const flipDef: FgBlockDef = {
            type: "test/flip",
            build: () => ({ signalIn: [{ name: "in", targets: [] }], dataIn: [{ name: "value", type: FgType.Any }] }),
            execute: (_block, _ctx, _env) => {
                callCount++;
                log.push({ label: "body", value: callCount as unknown as FgValue });
                if (callCount >= 3) condVal = false;
            },
        };
        const condDef: FgBlockDef = {
            type: "test/cond",
            build: () => ({ dataOut: [{ name: "value", type: FgType.Boolean }] }),
            updateOutputs: (_block, ctx, _env) => {
                ctx.connectionValues["cond:value"] = condVal;
            },
        };

        const rt = await makeRuntime(
            [
                { id: "start", type: "SceneReadyEvent", signalTargets: { out: [{ blockId: "wl", socket: "in" }] } },
                {
                    id: "wl",
                    type: "WhileLoop",
                    dataSources: { condition: { blockId: "cond", socket: "value" } },
                    signalTargets: {
                        executionFlow: [{ blockId: "flip", socket: "in" }],
                        completed: [{ blockId: "done", socket: "in" }],
                    },
                },
                { id: "cond", type: "test/cond" },
                { id: "flip", type: "test/flip" },
                { id: "done", type: RECORD, config: { label: "done" } },
            ],
            { defs: { [RECORD]: recorderDef(log), "test/flip": flipDef, "test/cond": condDef } }
        );
        startFlowGraph(rt);
        expect(log.filter((e) => e.label === "body")).toHaveLength(3);
        expect(log[log.length - 1]!.label).toBe("done");
    });

    // ── DoN ───────────────────────────────────────────────────────────────────

    it("DoN fires out only for the first N activations", async () => {
        const log: { label: string; value: FgValue }[] = [];
        const rt = await makeRuntime(
            [
                {
                    id: "start",
                    type: "SceneReadyEvent",
                    signalTargets: {
                        out: [
                            { blockId: "don", socket: "in" },
                            { blockId: "don", socket: "in" },
                            { blockId: "don", socket: "in" },
                            { blockId: "don", socket: "in" },
                        ],
                    },
                },
                {
                    id: "don",
                    type: "DoN",
                    dataDefaults: { maxExecutions: fgInt(3) },
                    signalTargets: { out: [{ blockId: "rec", socket: "in" }] },
                },
                { id: "rec", type: RECORD, config: { label: "fired" } },
            ],
            { defs: { [RECORD]: recorderDef(log) } }
        );
        startFlowGraph(rt);
        // 4 activations but max is 3 → only 3 should fire.
        expect(log.filter((e) => e.label === "fired")).toHaveLength(3);
    });

    it("DoN reset re-arms the block", async () => {
        const log: { label: string; value: FgValue }[] = [];
        const rt = await makeRuntime(
            [
                {
                    id: "start",
                    type: "SceneReadyEvent",
                    signalTargets: {
                        out: [
                            { blockId: "don", socket: "in" },
                            { blockId: "don", socket: "in" },
                            { blockId: "don", socket: "in" }, // exhausts N=2
                            { blockId: "don", socket: "reset" }, // resets
                            { blockId: "don", socket: "in" }, // fires again
                        ],
                    },
                },
                {
                    id: "don",
                    type: "DoN",
                    dataDefaults: { maxExecutions: fgInt(2) },
                    signalTargets: { out: [{ blockId: "rec", socket: "in" }] },
                },
                { id: "rec", type: RECORD, config: { label: "fired" } },
            ],
            { defs: { [RECORD]: recorderDef(log) } }
        );
        startFlowGraph(rt);
        // 3 activate before exhaustion (N=2 → 2 pass), then reset, then 1 more.
        expect(log.filter((e) => e.label === "fired")).toHaveLength(3);
    });

    // ── MultiGate ─────────────────────────────────────────────────────────────

    it("MultiGate cycles through outputs sequentially", async () => {
        const log: { label: string; value: FgValue }[] = [];
        const rt = await makeRuntime(
            [
                {
                    id: "start",
                    type: "SceneReadyEvent",
                    signalTargets: {
                        out: [
                            { blockId: "mg", socket: "in" },
                            { blockId: "mg", socket: "in" },
                            { blockId: "mg", socket: "in" },
                        ],
                    },
                },
                {
                    id: "mg",
                    type: "MultiGate",
                    config: { outputSignalCount: 3, isRandom: false, isLoop: false },
                    signalTargets: {
                        out_0: [{ blockId: "r0", socket: "in" }],
                        out_1: [{ blockId: "r1", socket: "in" }],
                        out_2: [{ blockId: "r2", socket: "in" }],
                    },
                },
                { id: "r0", type: RECORD, config: { label: "0" } },
                { id: "r1", type: RECORD, config: { label: "1" } },
                { id: "r2", type: RECORD, config: { label: "2" } },
            ],
            { defs: { [RECORD]: recorderDef(log) } }
        );
        startFlowGraph(rt);
        expect(log.map((e) => e.label)).toEqual(["0", "1", "2"]);
    });

    it("MultiGate with isLoop wraps around", async () => {
        const log: { label: string; value: FgValue }[] = [];
        const rt = await makeRuntime(
            [
                {
                    id: "start",
                    type: "SceneReadyEvent",
                    signalTargets: {
                        out: [
                            { blockId: "mg", socket: "in" },
                            { blockId: "mg", socket: "in" },
                            { blockId: "mg", socket: "in" },
                            { blockId: "mg", socket: "in" }, // wraps
                        ],
                    },
                },
                {
                    id: "mg",
                    type: "MultiGate",
                    config: { outputSignalCount: 2, isRandom: false, isLoop: true },
                    signalTargets: {
                        out_0: [{ blockId: "r0", socket: "in" }],
                        out_1: [{ blockId: "r1", socket: "in" }],
                    },
                },
                { id: "r0", type: RECORD, config: { label: "A" } },
                { id: "r1", type: RECORD, config: { label: "B" } },
            ],
            { defs: { [RECORD]: recorderDef(log) } }
        );
        startFlowGraph(rt);
        expect(log.map((e) => e.label)).toEqual(["A", "B", "A", "B"]);
    });

    it("MultiGate reset clears state", async () => {
        const log: { label: string; value: FgValue }[] = [];
        const rt = await makeRuntime(
            [
                {
                    id: "start",
                    type: "SceneReadyEvent",
                    signalTargets: {
                        out: [
                            { blockId: "mg", socket: "in" },
                            { blockId: "mg", socket: "in" }, // exhausts 2
                            { blockId: "mg", socket: "reset" },
                            { blockId: "mg", socket: "in" }, // starts over
                        ],
                    },
                },
                {
                    id: "mg",
                    type: "MultiGate",
                    config: { outputSignalCount: 2, isRandom: false, isLoop: false },
                    signalTargets: {
                        out_0: [{ blockId: "r0", socket: "in" }],
                        out_1: [{ blockId: "r1", socket: "in" }],
                    },
                },
                { id: "r0", type: RECORD, config: { label: "A" } },
                { id: "r1", type: RECORD, config: { label: "B" } },
            ],
            { defs: { [RECORD]: recorderDef(log) } }
        );
        startFlowGraph(rt);
        // First 2 activations → A, B (exhausted). After reset → A again.
        expect(log.map((e) => e.label)).toEqual(["A", "B", "A"]);
    });

    // ── WaitAll ───────────────────────────────────────────────────────────────

    it("WaitAll fires completed only after all inputs received", async () => {
        const log: { label: string; value: FgValue }[] = [];
        const rt = await makeRuntime(
            [
                {
                    id: "start",
                    type: "SceneReadyEvent",
                    signalTargets: {
                        out: [
                            { blockId: "wa", socket: "in_0" },
                            { blockId: "wa", socket: "in_1" }, // completes
                        ],
                    },
                },
                {
                    id: "wa",
                    type: "WaitAll",
                    config: { inputSignalCount: 2 },
                    signalTargets: {
                        out: [{ blockId: "partial", socket: "in" }],
                        completed: [{ blockId: "done", socket: "in" }],
                    },
                },
                { id: "partial", type: RECORD, config: { label: "partial" } },
                { id: "done", type: RECORD, config: { label: "done" } },
            ],
            { defs: { [RECORD]: recorderDef(log) } }
        );
        startFlowGraph(rt);
        // in_0 → "partial"; in_1 completes → "done"
        expect(log.map((e) => e.label)).toEqual(["partial", "done"]);
    });

    it("WaitAll reset clears received flags", async () => {
        const log: { label: string; value: FgValue }[] = [];
        const rt = await makeRuntime(
            [
                {
                    id: "start",
                    type: "SceneReadyEvent",
                    signalTargets: {
                        out: [
                            { blockId: "wa", socket: "in_0" }, // partial
                            { blockId: "wa", socket: "reset" }, // resets
                            { blockId: "wa", socket: "in_0" }, // partial again
                            { blockId: "wa", socket: "in_1" }, // now completes
                        ],
                    },
                },
                {
                    id: "wa",
                    type: "WaitAll",
                    config: { inputSignalCount: 2 },
                    signalTargets: {
                        out: [{ blockId: "partial", socket: "in" }],
                        completed: [{ blockId: "done", socket: "in" }],
                    },
                },
                { id: "partial", type: RECORD, config: { label: "partial" } },
                { id: "done", type: RECORD, config: { label: "done" } },
            ],
            { defs: { [RECORD]: recorderDef(log) } }
        );
        startFlowGraph(rt);
        // in_0 → partial; reset; in_0 → partial; in_1 → done
        expect(log.map((e) => e.label)).toEqual(["partial", "partial", "done"]);
    });

    // ── Throttle ──────────────────────────────────────────────────────────────

    it("Throttle passes first activation then suppresses until duration elapses", async () => {
        const log: { label: string; value: FgValue }[] = [];
        const rt = await makeRuntime(
            [
                { id: "start", type: "SceneReadyEvent", signalTargets: { out: [{ blockId: "th", socket: "in" }] } },
                {
                    id: "th",
                    type: "Throttle",
                    dataDefaults: { duration: 1 }, // 1 second
                    signalTargets: { out: [{ blockId: "rec", socket: "in" }] },
                },
                { id: "rec", type: RECORD, config: { label: "pass" } },
            ],
            { defs: { [RECORD]: recorderDef(log) } }
        );
        startFlowGraph(rt);
        // First activation should pass through.
        expect(log).toHaveLength(1);
        expect(log[0]!.label).toBe("pass");
    });

    it("Throttle suppresses re-activations during cooldown", async () => {
        const log: { label: string; value: FgValue }[] = [];

        const rt = await makeRuntime(
            [
                { id: "start", type: "SceneReadyEvent", signalTargets: { out: [{ blockId: "th", socket: "in" }] } },
                {
                    id: "th",
                    type: "Throttle",
                    dataDefaults: { duration: 1 }, // 1 second
                    signalTargets: { out: [{ blockId: "rec", socket: "in" }] },
                },
                { id: "rec", type: RECORD, config: { label: "pass" } },
            ],
            { defs: { [RECORD]: recorderDef(log) } }
        );
        startFlowGraph(rt);
        // First activation passes.
        expect(log).toHaveLength(1);

        // Re-fire during cooldown (500 ms elapsed, need 1000 ms).
        const thBlock = rt.env.graph.blocks.find((b) => b.type === "Throttle")!;
        rt.env.defs[thBlock.type]!.execute!(thBlock, rt.context, rt.env, "in");
        expect(log).toHaveLength(1); // still suppressed

        // Tick past the duration.
        tickFlowGraph(rt, 600);
        tickFlowGraph(rt, 600); // total 1200 ms > 1000 ms → cooldown done

        // Activate again — should pass.
        rt.env.defs[thBlock.type]!.execute!(thBlock, rt.context, rt.env, "in");
        expect(log).toHaveLength(2);
    });

    // ── SetDelay / CancelDelay ────────────────────────────────────────────────

    it("SetDelay fires done after duration via tickFlowGraph", async () => {
        const log: { label: string; value: FgValue }[] = [];
        const rt = await makeRuntime(
            [
                { id: "start", type: "SceneReadyEvent", signalTargets: { out: [{ blockId: "sd", socket: "in" }] } },
                {
                    id: "sd",
                    type: "SetDelay",
                    dataDefaults: { duration: 1 }, // 1 second
                    signalTargets: {
                        out: [{ blockId: "out", socket: "in" }],
                        done: [{ blockId: "done", socket: "in" }],
                    },
                },
                { id: "out", type: RECORD, config: { label: "out" } },
                { id: "done", type: RECORD, config: { label: "done" } },
            ],
            { defs: { [RECORD]: recorderDef(log) } }
        );
        startFlowGraph(rt);
        expect(log.map((e) => e.label)).toEqual(["out"]); // immediate

        tickFlowGraph(rt, 500); // 500 ms — not done yet
        expect(log.map((e) => e.label)).toEqual(["out"]);

        tickFlowGraph(rt, 600); // total 1100 ms > 1000 ms → done fires
        expect(log.map((e) => e.label)).toEqual(["out", "done"]);
    });

    it("CancelDelay prevents done from firing", async () => {
        const log: { label: string; value: FgValue }[] = [];
        const rt = await makeRuntime(
            [
                {
                    id: "start",
                    type: "SceneReadyEvent",
                    signalTargets: {
                        out: [
                            { blockId: "sd", socket: "in" }, // schedule delay
                            { blockId: "cd", socket: "in" }, // immediately cancel it
                        ],
                    },
                },
                {
                    id: "sd",
                    type: "SetDelay",
                    dataDefaults: { duration: 1 },
                    signalTargets: { done: [{ blockId: "done", socket: "in" }] },
                },
                {
                    id: "cd",
                    type: "CancelDelay",
                    // Wire the lastDelayIndex output of sd into delayIndex input of cd.
                    dataSources: { delayIndex: { blockId: "sd", socket: "lastDelayIndex" } },
                    signalTargets: { out: [{ blockId: "cancelled", socket: "in" }] },
                },
                { id: "done", type: RECORD, config: { label: "done" } },
                { id: "cancelled", type: RECORD, config: { label: "cancelled" } },
            ],
            { defs: { [RECORD]: recorderDef(log) } }
        );
        startFlowGraph(rt);
        tickFlowGraph(rt, 2000); // well past duration
        // done must NOT fire; cancelled must fire once.
        expect(log.filter((e) => e.label === "done")).toHaveLength(0);
        expect(log.filter((e) => e.label === "cancelled")).toHaveLength(1);
    });

    // ── Constant ──────────────────────────────────────────────────────────────

    it("Constant emits its configured value", async () => {
        const log: { label: string; value: FgValue }[] = [];
        const rt = await makeRuntime(
            [
                { id: "start", type: "SceneReadyEvent", signalTargets: { out: [{ blockId: "rec", socket: "in" }] } },
                { id: "const", type: "Constant", config: { value: 42 } },
                { id: "rec", type: RECORD, dataSources: { value: { blockId: "const", socket: "value" } } },
            ],
            { defs: { [RECORD]: recorderDef(log) } }
        );
        startFlowGraph(rt);
        expect(log[0]!.value).toBe(42);
    });

    it("Constant emits a vector value", async () => {
        const log: { label: string; value: FgValue }[] = [];
        const v = { x: 1, y: 2, z: 3 };
        const rt = await makeRuntime(
            [
                { id: "start", type: "SceneReadyEvent", signalTargets: { out: [{ blockId: "rec", socket: "in" }] } },
                { id: "const", type: "Constant", config: { value: v } },
                { id: "rec", type: RECORD, dataSources: { value: { blockId: "const", socket: "value" } } },
            ],
            { defs: { [RECORD]: recorderDef(log) } }
        );
        startFlowGraph(rt);
        expect(log[0]!.value).toEqual(v);
    });

    // ── DataSwitch (math/switch cases config) ────────────────────────────────

    it("DataSwitch selects in_<case> by selector value", async () => {
        for (const [sel, expected] of [
            [0, 100],
            [1, 200],
            [2, 999], // default
        ] as const) {
            const log: { label: string; value: FgValue }[] = [];
            const rt = await makeRuntime(
                [
                    { id: "start", type: "SceneReadyEvent", signalTargets: { out: [{ blockId: "rec", socket: "in" }] } },
                    {
                        id: "ds",
                        type: "DataSwitch",
                        config: { cases: [0, 1] },
                        dataDefaults: { case: sel, default: 999, in_0: 100, in_1: 200 },
                    },
                    { id: "rec", type: RECORD, dataSources: { value: { blockId: "ds", socket: "value" } } },
                ],
                { defs: { [RECORD]: recorderDef(log) } }
            );
            startFlowGraph(rt);
            expect(log[0]!.value).toBe(expected);
        }
    });
});

// ─── Phase 3i: custom events + value interpolation ────────────────────────────

describe("flow-graph blocks — events + interpolation Phase 3i", () => {
    // ── SendCustomEvent / ReceiveCustomEvent ─────────────────────────────────

    it("Send→Receive round-trip: matching eventId delivers named values", async () => {
        const log: { label: string; value: FgValue }[] = [];
        const rt = await makeRuntime(
            [
                // SceneStart fires SendCustomEvent with {score: 42}
                {
                    id: "start",
                    type: "SceneReadyEvent",
                    signalTargets: { out: [{ blockId: "send", socket: "in" }] },
                },
                {
                    id: "send",
                    type: "SendCustomEvent",
                    config: { eventId: "myEvent", valueNames: ["score"] },
                    dataDefaults: { score: 42 },
                    signalTargets: { out: [{ blockId: "recSent", socket: "in" }] },
                },
                // ReceiveCustomEvent (same eventId) wires to recorder
                {
                    id: "recv",
                    type: "ReceiveCustomEvent",
                    config: { eventId: "myEvent", valueNames: ["score"] },
                    signalTargets: { out: [{ blockId: "recRecv", socket: "in" }] },
                },
                { id: "recSent", type: RECORD, config: { label: "sent" } },
                {
                    id: "recRecv",
                    type: RECORD,
                    config: { label: "recv" },
                    dataSources: { value: { blockId: "recv", socket: "score" } },
                },
            ],
            { defs: { [RECORD]: recorderDef(log) } }
        );

        startFlowGraph(rt);

        // send fired "sent" + receive triggered "recv"
        expect(log.map((e) => e.label)).toContain("sent");
        expect(log.map((e) => e.label)).toContain("recv");

        const recvEntry = log.find((e) => e.label === "recv");
        expect(recvEntry?.value).toBe(42);
    });

    it("Send→Receive: non-matching eventId does NOT trigger receiver", async () => {
        const log: { label: string; value: FgValue }[] = [];
        const rt = await makeRuntime(
            [
                {
                    id: "start",
                    type: "SceneReadyEvent",
                    signalTargets: { out: [{ blockId: "send", socket: "in" }] },
                },
                {
                    id: "send",
                    type: "SendCustomEvent",
                    config: { eventId: "eventA", valueNames: ["x"] },
                    dataDefaults: { x: 7 },
                },
                // Receiver listens on a DIFFERENT eventId — must NOT fire.
                {
                    id: "recv",
                    type: "ReceiveCustomEvent",
                    config: { eventId: "eventB", valueNames: ["x"] },
                    signalTargets: { out: [{ blockId: "rec", socket: "in" }] },
                },
                { id: "rec", type: RECORD, config: { label: "fired" } },
            ],
            { defs: { [RECORD]: recorderDef(log) } }
        );

        startFlowGraph(rt);
        // No record should appear — mismatched eventId is filtered out.
        expect(log.filter((e) => e.label === "fired")).toHaveLength(0);
    });

    it("Send→Receive: matching receiver fires, mismatched receiver is silent", async () => {
        const log: { label: string; value: FgValue }[] = [];
        const rt = await makeRuntime(
            [
                {
                    id: "start",
                    type: "SceneReadyEvent",
                    signalTargets: { out: [{ blockId: "send", socket: "in" }] },
                },
                {
                    id: "send",
                    type: "SendCustomEvent",
                    config: { eventId: "ping", valueNames: [] },
                },
                {
                    id: "recvOk",
                    type: "ReceiveCustomEvent",
                    config: { eventId: "ping" },
                    signalTargets: { out: [{ blockId: "recOk", socket: "in" }] },
                },
                {
                    id: "recvNo",
                    type: "ReceiveCustomEvent",
                    config: { eventId: "pong" },
                    signalTargets: { out: [{ blockId: "recNo", socket: "in" }] },
                },
                { id: "recOk", type: RECORD, config: { label: "ok" } },
                { id: "recNo", type: RECORD, config: { label: "no" } },
            ],
            { defs: { [RECORD]: recorderDef(log) } }
        );

        startFlowGraph(rt);
        expect(log.filter((e) => e.label === "ok")).toHaveLength(1);
        expect(log.filter((e) => e.label === "no")).toHaveLength(0);
    });

    it("ReceiveCustomEvent fires both out and done signals", async () => {
        const log: { label: string; value: FgValue }[] = [];
        const rt = await makeRuntime(
            [
                {
                    id: "start",
                    type: "SceneReadyEvent",
                    signalTargets: { out: [{ blockId: "send", socket: "in" }] },
                },
                { id: "send", type: "SendCustomEvent", config: { eventId: "ev" } },
                {
                    id: "recv",
                    type: "ReceiveCustomEvent",
                    config: { eventId: "ev" },
                    signalTargets: {
                        out: [{ blockId: "recOut", socket: "in" }],
                        done: [{ blockId: "recDone", socket: "in" }],
                    },
                },
                { id: "recOut", type: RECORD, config: { label: "out" } },
                { id: "recDone", type: RECORD, config: { label: "done" } },
            ],
            { defs: { [RECORD]: recorderDef(log) } }
        );

        startFlowGraph(rt);
        expect(log.map((e) => e.label)).toContain("out");
        expect(log.map((e) => e.label)).toContain("done");
    });

    // ── ValueInterpolation ────────────────────────────────────────────────────

    it("ValueInterpolation: numeric lerp moves value toward target over ticks", async () => {
        const log: { label: string; value: FgValue }[] = [];
        const rt = await makeRuntime(
            [
                {
                    id: "start",
                    type: "SceneReadyEvent",
                    signalTargets: { out: [{ blockId: "interp", socket: "in" }] },
                },
                {
                    id: "interp",
                    type: "ValueInterpolation",
                    config: { type: "number" },
                    dataDefaults: { startValue: 0, endValue: 10, duration: 1 }, // 1 second
                    signalTargets: {
                        out: [{ blockId: "recOut", socket: "in" }],
                        done: [{ blockId: "recDone", socket: "in" }],
                    },
                },
                {
                    id: "recOut",
                    type: RECORD,
                    config: { label: "out" },
                    dataSources: { value: { blockId: "interp", socket: "value" } },
                },
                {
                    id: "recDone",
                    type: RECORD,
                    config: { label: "done" },
                    dataSources: { value: { blockId: "interp", socket: "value" } },
                },
            ],
            { defs: { [RECORD]: recorderDef(log) } }
        );

        startFlowGraph(rt);
        // out fires immediately — value should be at startValue (0)
        const outEntry = log.find((e) => e.label === "out");
        expect(outEntry).toBeDefined();
        expect(outEntry!.value).toBe(0);
        expect(log.find((e) => e.label === "done")).toBeUndefined();

        // Tick to 50% progress (500 ms of 1000 ms) → value ≈ 5
        tickFlowGraph(rt, 500);
        const interpBlock = rt.env.graph.blocks.find((b) => b.type === "ValueInterpolation")!;
        const midValue = rt.context.connectionValues[`${interpBlock.id}:value`] as number;
        expect(midValue).toBeGreaterThan(0);
        expect(midValue).toBeLessThan(10);
        expect(midValue).toBeCloseTo(5, 5);

        // Tick past duration → done fires, value snaps to 10
        tickFlowGraph(rt, 600); // total ~1100 ms exceeds the 1 s duration
        expect(log.find((e) => e.label === "done")).toBeDefined();
        expect(log.find((e) => e.label === "done")!.value).toBe(10);
    });

    it("ValueInterpolation: done fires exactly once even with extra ticks", async () => {
        const log: { label: string; value: FgValue }[] = [];
        const rt = await makeRuntime(
            [
                {
                    id: "start",
                    type: "SceneReadyEvent",
                    signalTargets: { out: [{ blockId: "interp", socket: "in" }] },
                },
                {
                    id: "interp",
                    type: "ValueInterpolation",
                    config: { type: "number" },
                    dataDefaults: { startValue: 0, endValue: 1, duration: 0.5 },
                    signalTargets: { done: [{ blockId: "recDone", socket: "in" }] },
                },
                { id: "recDone", type: RECORD, config: { label: "done" } },
            ],
            { defs: { [RECORD]: recorderDef(log) } }
        );

        startFlowGraph(rt);
        tickFlowGraph(rt, 1000); // well past 500 ms
        tickFlowGraph(rt, 1000);
        expect(log.filter((e) => e.label === "done")).toHaveLength(1);
    });

    it("ValueInterpolation: Vec3 lerp produces correct intermediate and final components", async () => {
        const log: { label: string; value: FgValue }[] = [];
        const rt = await makeRuntime(
            [
                {
                    id: "start",
                    type: "SceneReadyEvent",
                    signalTargets: { out: [{ blockId: "interp", socket: "in" }] },
                },
                {
                    id: "interp",
                    type: "ValueInterpolation",
                    config: { type: "Vector3" },
                    dataDefaults: {
                        startValue: { x: 0, y: 0, z: 0 },
                        endValue: { x: 10, y: 20, z: 30 },
                        duration: 1,
                    },
                    signalTargets: { done: [{ blockId: "recDone", socket: "in" }] },
                },
                {
                    id: "recDone",
                    type: RECORD,
                    config: { label: "done" },
                    dataSources: { value: { blockId: "interp", socket: "value" } },
                },
            ],
            { defs: { [RECORD]: recorderDef(log) } }
        );

        startFlowGraph(rt);
        // Advance to halfway point (500 ms of 1 s).
        tickFlowGraph(rt, 500);
        const interpBlock = rt.env.graph.blocks.find((b) => b.type === "ValueInterpolation")!;
        const mid = rt.context.connectionValues[`${interpBlock.id}:value`] as { x: number; y: number; z: number };
        expect(mid.x).toBeCloseTo(5, 5);
        expect(mid.y).toBeCloseTo(10, 5);
        expect(mid.z).toBeCloseTo(15, 5);

        // Tick past the end.
        tickFlowGraph(rt, 600);
        const done = log.find((e) => e.label === "done");
        expect(done?.value).toEqual({ x: 10, y: 20, z: 30 });
    });

    it("ValueInterpolation: zero duration snaps to endValue synchronously", async () => {
        const log: { label: string; value: FgValue }[] = [];
        const rt = await makeRuntime(
            [
                {
                    id: "start",
                    type: "SceneReadyEvent",
                    signalTargets: { out: [{ blockId: "interp", socket: "in" }] },
                },
                {
                    id: "interp",
                    type: "ValueInterpolation",
                    config: { type: "number" },
                    dataDefaults: { startValue: 0, endValue: 99, duration: 0 },
                    signalTargets: {
                        out: [{ blockId: "recOut", socket: "in" }],
                        done: [{ blockId: "recDone", socket: "in" }],
                    },
                },
                {
                    id: "recOut",
                    type: RECORD,
                    config: { label: "out" },
                    dataSources: { value: { blockId: "interp", socket: "value" } },
                },
                {
                    id: "recDone",
                    type: RECORD,
                    config: { label: "done" },
                    dataSources: { value: { blockId: "interp", socket: "value" } },
                },
            ],
            { defs: { [RECORD]: recorderDef(log) } }
        );

        startFlowGraph(rt);
        // Both out and done fire synchronously; value is already endValue.
        expect(log.map((e) => e.label)).toContain("out");
        expect(log.map((e) => e.label)).toContain("done");
        expect(log.find((e) => e.label === "done")?.value).toBe(99);
    });

    it("ValueInterpolation: re-triggering in cancels the previous run", async () => {
        const log: { label: string; value: FgValue }[] = [];
        const rt = await makeRuntime(
            [
                {
                    id: "start",
                    type: "SceneReadyEvent",
                    signalTargets: { out: [{ blockId: "interp", socket: "in" }] },
                },
                {
                    id: "interp",
                    type: "ValueInterpolation",
                    config: { type: "number" },
                    dataDefaults: { startValue: 0, endValue: 100, duration: 2 },
                    signalTargets: { done: [{ blockId: "recDone", socket: "in" }] },
                },
                {
                    id: "recDone",
                    type: RECORD,
                    config: { label: "done" },
                    dataSources: { value: { blockId: "interp", socket: "value" } },
                },
            ],
            { defs: { [RECORD]: recorderDef(log) } }
        );

        startFlowGraph(rt);
        tickFlowGraph(rt, 500); // half-way through first run

        // Re-trigger with different endValue / duration via direct mutation of the
        // socket defaults (the same technique used in the SetDelay cancel test).
        const interpBlock = rt.env.graph.blocks.find((b) => b.type === "ValueInterpolation")!;
        const endSock = interpBlock.dataIn.find((s) => s.name === "endValue")!;
        (endSock as { defaultValue?: FgValue }).defaultValue = 200;
        const durSock = interpBlock.dataIn.find((s) => s.name === "duration")!;
        (durSock as { defaultValue?: FgValue }).defaultValue = 0.5;
        rt.env.defs[interpBlock.type]!.execute!(interpBlock, rt.context, rt.env, "in");

        tickFlowGraph(rt, 600); // past the new 500 ms duration
        // done fires once for the second interpolation (first was canceled)
        expect(log.filter((e) => e.label === "done")).toHaveLength(1);
        expect(log.find((e) => e.label === "done")?.value).toBe(200);
    });
});
