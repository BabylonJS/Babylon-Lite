import { describe, expect, it } from "vitest";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { Color4, Vec2, Vec3 } from "../../../packages/babylon-lite/src/math/types";
import { buildNodeParticleSet, type NpeBuildContext } from "../../../packages/babylon-lite/src/particle/node/npe-build";
import { normalizeNodeParticleGraph } from "../../../packages/babylon-lite/src/particle/node/npe-graph-plumbing";
import { parseNodeParticleSource } from "../../../packages/babylon-lite/src/particle/node/npe-parser";
import { loadValueBlockEvaluator } from "../../../packages/babylon-lite/src/particle/node/npe-registry-extra-values";
import { loadPhase4ValueBlockEvaluator } from "../../../packages/babylon-lite/src/particle/node/npe-registry-phase4-values";
import type { ParsedParticleBlock, ParsedParticleInput } from "../../../packages/babylon-lite/src/particle/node/npe-types";
import type { NpeGetter, NpeValue } from "../../../packages/babylon-lite/src/particle/node/npe-value";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene";

interface GetterOptions {
    readonly inputs: Record<string, NpeGetter>;
    readonly inputTypes?: Record<string, string>;
}

async function buildGetter(className: string, serialized: Record<string, unknown>, options: GetterOptions): Promise<NpeGetter> {
    const inputs: ParsedParticleInput[] = Object.keys(options.inputs).map((name, index) => ({
        name,
        targetBlockId: index + 100,
        targetConnectionName: "output",
        valueType: options.inputTypes?.[name],
    }));
    const block: ParsedParticleBlock = { id: 7, className, name: className, inputs, serialized };
    let output: NpeGetter | undefined;
    const context = {
        input(_block: ParsedParticleBlock, name: string, fallback?: NpeGetter): NpeGetter {
            return options.inputs[name] ?? fallback ?? (() => null as unknown as NpeValue);
        },
        isConnected(_block: ParsedParticleBlock, name: string): boolean {
            return name in options.inputs;
        },
        setOutput(_blockId: number, name: string, getter: NpeGetter): void {
            if (name === "output") {
                output = getter;
            }
        },
    } as unknown as NpeBuildContext;

    const evaluator = (await loadPhase4ValueBlockEvaluator(block)) ?? (await loadValueBlockEvaluator(className));
    evaluator.build(block, context);
    return output!;
}

function scalarGraph(className: string, blockFields: Record<string, unknown>, inputValues: Record<string, { type: number; value: number }>): object {
    const blocks: Array<Record<string, unknown>> = [];
    const inputs: Array<Record<string, unknown>> = [];
    let inputId = 1;
    for (const [name, input] of Object.entries(inputValues)) {
        blocks.push({ customType: "BABYLON.ParticleInputBlock", id: inputId, type: input.type, value: input.value, inputs: [] });
        inputs.push({ name, targetBlockId: inputId, targetConnectionName: "output" });
        inputId++;
    }
    blocks.push({ customType: `BABYLON.${className}`, id: 10, ...blockFields, inputs });
    blocks.push({
        customType: "BABYLON.SystemBlock",
        id: 20,
        inputs: [{ name: "emitRate", targetBlockId: 10, targetConnectionName: "output" }],
    });
    return { blocks };
}

async function evaluateParsedGraph(source: object): Promise<number> {
    const graph = await normalizeNodeParticleGraph(parseNodeParticleSource(source));
    const set = await buildNodeParticleSet({} as EngineContext, {} as SceneContext, graph);
    return set.systems[0]!._emitRateGetter!();
}

function withNumberMathConsumer(blocks: Array<Record<string, unknown>>, producerId = 10): object {
    return {
        blocks: [
            ...blocks,
            { customType: "BABYLON.ParticleInputBlock", id: 90, type: 2, value: -1, inputs: [] },
            {
                customType: "BABYLON.ParticleNumberMathBlock",
                id: 91,
                operation: 1,
                inputs: [
                    { name: "left", targetBlockId: producerId, targetConnectionName: "output" },
                    { name: "right", targetBlockId: 90, targetConnectionName: "output" },
                ],
            },
            {
                customType: "BABYLON.SystemBlock",
                id: 92,
                inputs: [{ name: "emitRate", targetBlockId: 91, targetConnectionName: "output" }],
            },
        ],
    };
}

describe("Phase 4A NPE value math", () => {
    describe("ParticleNumberMathBlock", () => {
        it.each([
            [0, 5.5, 2, 1.5],
            [0, -5.5, 2, -1.5],
            [1, 2, 3, 8],
            [1, -1, 0.5, Number.NaN],
            [1, 0, -1, Number.POSITIVE_INFINITY],
        ])("evaluates operation %s with JavaScript numeric behavior", async (operation, left, right, expected) => {
            const output = await buildGetter("ParticleNumberMathBlock", { operation }, { inputs: { left: () => left, right: () => right } });
            expect(output(0)).toBe(expected);
        });

        it("defaults to modulo and preserves signed zero for Float", async () => {
            const output = await buildGetter("ParticleNumberMathBlock", {}, { inputs: { left: () => -4, right: () => 2 } });
            expect(Object.is(output(0), -0)).toBe(true);
        });

        it("coerces Int-left results to signed 32-bit values", async () => {
            const modulo = await buildGetter("ParticleNumberMathBlock", { operation: 0 }, { inputs: { left: () => 5.75, right: () => 2 }, inputTypes: { left: "int" } });
            const power = await buildGetter("ParticleNumberMathBlock", { operation: 1 }, { inputs: { left: () => 2, right: () => 31 }, inputTypes: { left: "int" } });
            expect(modulo(0)).toBe(1);
            expect(power(0)).toBe(-2147483648);
        });

        it("rejects disconnected inputs, non-scalars, and unknown operations deterministically", async () => {
            await expect(buildGetter("ParticleNumberMathBlock", {}, { inputs: { left: () => 1 } })).rejects.toThrow(
                'NodeParticle: ParticleNumberMathBlock 7 input "right" is not connected'
            );
            await expect(buildGetter("ParticleNumberMathBlock", { operation: 9 }, { inputs: { left: () => 1, right: () => 2 } })).rejects.toThrow(
                "NodeParticle: ParticleNumberMathBlock 7 has unsupported operation 9"
            );
            const output = await buildGetter("ParticleNumberMathBlock", {}, { inputs: { left: () => ({ x: 1, y: 2 }), right: () => 2 } });
            expect(() => output(0)).toThrow("NodeParticle: ParticleNumberMathBlock 7 received an unsupported value");
        });

        it("derives Int and Float behavior from parsed upstream metadata", async () => {
            expect(await evaluateParsedGraph(scalarGraph("ParticleNumberMathBlock", { operation: 0 }, { left: { type: 1, value: 5.75 }, right: { type: 1, value: 2 } }))).toBe(1);
            expect(await evaluateParsedGraph(scalarGraph("ParticleNumberMathBlock", { operation: 0 }, { left: { type: 2, value: 5.75 }, right: { type: 2, value: 2 } }))).toBe(
                1.75
            );
        });

        it("propagates the left type through chained NumberMath blocks", async () => {
            const source = scalarGraph("ParticleNumberMathBlock", { operation: 1 }, { left: { type: 1, value: 3 }, right: { type: 1, value: 2 } }) as {
                blocks: Array<Record<string, unknown>>;
            };
            source.blocks.splice(2, 0, {
                customType: "BABYLON.ParticleNumberMathBlock",
                id: 11,
                operation: 0,
                inputs: [
                    { name: "left", targetBlockId: 10, targetConnectionName: "output" },
                    { name: "right", targetBlockId: 2, targetConnectionName: "output" },
                ],
            });
            (source.blocks.at(-1)!.inputs as Array<Record<string, unknown>>)[0]!.targetBlockId = 11;
            expect(await evaluateParsedGraph(source)).toBe(1);
        });

        it.each([
            ["Clamp", "ParticleClampBlock", { value: { type: 1, value: 5.75 }, min: { type: 2, value: 0 }, max: { type: 2, value: 10 } }, 2, 1],
            ["Step", "ParticleStepBlock", { value: { type: 1, value: 5.75 }, edge: { type: 2, value: 0 } }, 0.6, 0],
        ])("propagates the left Int type through %s into a downstream NumberMath", async (_name, className, inputs, divisor, expected) => {
            const source = scalarGraph(className, {}, inputs) as { blocks: Array<Record<string, unknown>> };
            source.blocks.splice(source.blocks.length - 1, 0, {
                customType: "BABYLON.ParticleInputBlock",
                id: 50,
                type: 2,
                value: divisor,
                inputs: [],
            });
            source.blocks.splice(source.blocks.length - 1, 0, {
                customType: "BABYLON.ParticleNumberMathBlock",
                id: 60,
                operation: 0,
                inputs: [
                    { name: "left", targetBlockId: 10, targetConnectionName: "output" },
                    { name: "right", targetBlockId: 50, targetConnectionName: "output" },
                ],
            });
            (source.blocks.at(-1)!.inputs as Array<Record<string, unknown>>)[0]!.targetBlockId = 60;
            expect(await evaluateParsedGraph(source)).toBe(expected);
        });

        it.each([
            [
                "Condition",
                [
                    { customType: "BABYLON.ParticleInputBlock", id: 1, type: 2, value: 0, inputs: [] },
                    { customType: "BABYLON.ParticleInputBlock", id: 2, type: 1, value: 2, inputs: [] },
                    {
                        customType: "BABYLON.ParticleConditionBlock",
                        id: 10,
                        test: 0,
                        inputs: [
                            { name: "left", targetBlockId: 1, targetConnectionName: "output" },
                            { name: "right", targetBlockId: 1, targetConnectionName: "output" },
                            { name: "ifTrue", targetBlockId: 2, targetConnectionName: "output" },
                            { name: "ifFalse", targetBlockId: 2, targetConnectionName: "output" },
                        ],
                    },
                ],
            ],
            [
                "LocalVariable",
                [
                    { customType: "BABYLON.ParticleInputBlock", id: 1, type: 1, value: 2, inputs: [] },
                    {
                        customType: "BABYLON.ParticleLocalVariableBlock",
                        id: 10,
                        scope: 1,
                        inputs: [{ name: "input", targetBlockId: 1, targetConnectionName: "output" }],
                    },
                ],
            ],
            [
                "Random",
                [
                    { customType: "BABYLON.ParticleInputBlock", id: 1, type: 1, value: 2, inputs: [] },
                    {
                        customType: "BABYLON.ParticleRandomBlock",
                        id: 10,
                        lockMode: 0,
                        inputs: [
                            { name: "min", targetBlockId: 1, targetConnectionName: "output" },
                            { name: "max", targetBlockId: 1, targetConnectionName: "output" },
                        ],
                    },
                ],
            ],
            [
                "Math",
                [
                    { customType: "BABYLON.ParticleInputBlock", id: 1, type: 1, value: 1, inputs: [] },
                    { customType: "BABYLON.ParticleInputBlock", id: 2, type: 1, value: 1, inputs: [] },
                    {
                        customType: "BABYLON.ParticleMathBlock",
                        id: 10,
                        operation: 0,
                        inputs: [
                            { name: "left", targetBlockId: 1, targetConnectionName: "output" },
                            { name: "right", targetBlockId: 2, targetConnectionName: "output" },
                        ],
                    },
                ],
            ],
            [
                "Lerp",
                [
                    { customType: "BABYLON.ParticleInputBlock", id: 1, type: 1, value: 2, inputs: [] },
                    { customType: "BABYLON.ParticleInputBlock", id: 2, type: 2, value: 0.5, inputs: [] },
                    {
                        customType: "BABYLON.ParticleLerpBlock",
                        id: 10,
                        inputs: [
                            { name: "left", targetBlockId: 1, targetConnectionName: "output" },
                            { name: "right", targetBlockId: 1, targetConnectionName: "output" },
                            { name: "gradient", targetBlockId: 2, targetConnectionName: "output" },
                        ],
                    },
                ],
            ],
        ])("propagates Int through %s into NumberMath coercion", async (_name, blocks) => {
            expect(await evaluateParsedGraph(withNumberMathConsumer(blocks))).toBe(0);
        });

        it("preserves Float type through mixed Int and Float Math inputs", async () => {
            const source = withNumberMathConsumer([
                { customType: "BABYLON.ParticleInputBlock", id: 1, type: 1, value: 1, inputs: [] },
                { customType: "BABYLON.ParticleInputBlock", id: 2, type: 2, value: 1, inputs: [] },
                {
                    customType: "BABYLON.ParticleMathBlock",
                    id: 10,
                    operation: 0,
                    inputs: [
                        { name: "left", targetBlockId: 1, targetConnectionName: "output" },
                        { name: "right", targetBlockId: 2, targetConnectionName: "output" },
                    ],
                },
            ]);
            expect(await evaluateParsedGraph(source)).toBe(0.5);
        });

        it("observes ParticleMath Int coercion before downstream NumberMath", async () => {
            const source = withNumberMathConsumer([
                { customType: "BABYLON.ParticleInputBlock", id: 1, type: 1, value: 5, inputs: [] },
                { customType: "BABYLON.ParticleInputBlock", id: 2, type: 1, value: 2, inputs: [] },
                {
                    customType: "BABYLON.ParticleMathBlock",
                    id: 10,
                    operation: 3,
                    inputs: [
                        { name: "left", targetBlockId: 1, targetConnectionName: "output" },
                        { name: "right", targetBlockId: 2, targetConnectionName: "output" },
                    ],
                },
            ]);
            const blocks = (source as { blocks: Array<Record<string, unknown>> }).blocks;
            (blocks.find((block) => block.id === 90) as Record<string, unknown>).value = 2;
            expect(await evaluateParsedGraph(source)).toBe(4);
        });

        it("coerces direct and alias-safe ParticleMath Int results", async () => {
            expect(await evaluateParsedGraph(scalarGraph("ParticleMathBlock", { operation: 3 }, { left: { type: 1, value: 5 }, right: { type: 1, value: 2 } }))).toBe(2);

            const aliasSource = scalarGraph("ParticleMathBlock", { operation: 3 }, { left: { type: 1, value: 0 } }) as { blocks: Array<Record<string, unknown>> };
            const math = aliasSource.blocks.find((block) => block.id === 10)!;
            (math.inputs as Array<Record<string, unknown>>).push({ name: "right", targetBlockId: 1, targetConnectionName: "output" });
            expect(await evaluateParsedGraph(aliasSource)).toBe(0);
        });
    });

    describe("ParticleClampBlock", () => {
        it.each([
            ["scalar", 2, 0, 1, 1],
            ["Vector2", { x: -1, y: 2 } as Vec2, 0, 1, { x: 0, y: 1 }],
            ["Vector3", { x: -1, y: 0.5, z: 2 } as Vec3, 0, 1, { x: 0, y: 0.5, z: 1 }],
            ["Color4", { r: -1, g: 0.25, b: 2, a: 0.75 } as Color4, 0, 1, { r: 0, g: 0.25, b: 1, a: 0.75 }],
            ["reversed bounds", 0.5, 1, 0, 1],
            ["NaN", Number.NaN, 0, 1, Number.NaN],
            ["infinity", Number.POSITIVE_INFINITY, 0, 1, 1],
        ])("clamps %s", async (_name, value, min, max, expected) => {
            const output = await buildGetter("ParticleClampBlock", {}, { inputs: { value: () => value, min: () => min, max: () => max } });
            expect(output(0)).toEqual(expected);
        });

        it("uses zero/one defaults and reuses owned scratch for volatile vectors", async () => {
            const source: Vec3 = { x: -1, y: 0.5, z: 2 };
            const output = await buildGetter("ParticleClampBlock", {}, { inputs: { value: () => source } });
            const first = output(0);
            source.x = 0.25;
            source.y = 4;
            source.z = -2;
            const second = output(0);
            expect(second).toBe(first);
            expect(second).toEqual({ x: 0.25, y: 1, z: 0 });
        });

        it("snapshots shared source scratch before evaluating bounds", async () => {
            const shared: Vec3 = { x: -1, y: 0.5, z: 2 };
            const output = await buildGetter(
                "ParticleClampBlock",
                {},
                {
                    inputs: {
                        value: () => shared,
                        min: () => {
                            shared.x = 8;
                            shared.y = 8;
                            shared.z = 8;
                            return 0;
                        },
                        max: () => {
                            shared.x = 9;
                            shared.y = 9;
                            shared.z = 9;
                            return 1;
                        },
                    },
                }
            );
            expect(output(0)).toEqual({ x: 0, y: 0.5, z: 1 });
        });

        it("clamps negative zero to positive zero and reports malformed values", async () => {
            const output = await buildGetter("ParticleClampBlock", {}, { inputs: { value: () => -0 } });
            expect(Object.is(output(0), 0)).toBe(true);
            await expect(buildGetter("ParticleClampBlock", {}, { inputs: {} })).rejects.toThrow('NodeParticle: ParticleClampBlock 7 input "value" is not connected');
            const malformed = await buildGetter("ParticleClampBlock", {}, { inputs: { value: () => null as unknown as NpeValue } });
            expect(() => malformed(0)).toThrow("NodeParticle: ParticleClampBlock 7 received an unsupported value");
        });

        it("executes from a parsed graph with connected bounds", async () => {
            expect(
                await evaluateParsedGraph(scalarGraph("ParticleClampBlock", {}, { value: { type: 2, value: 4 }, min: { type: 2, value: -1 }, max: { type: 2, value: 2 } }))
            ).toBe(2);
        });
    });

    describe("ParticleStepBlock", () => {
        it.each([
            ["below", -1, 0, 0],
            ["equal", 0, 0, 1],
            ["above", 1, 0, 1],
            ["NaN", Number.NaN, 0, 1],
            ["negative infinity", Number.NEGATIVE_INFINITY, 0, 0],
            ["positive infinity", Number.POSITIVE_INFINITY, 0, 1],
            ["Vector2", { x: -1, y: 0 } as Vec2, 0, { x: 0, y: 1 }],
            ["Vector3", { x: -1, y: 0, z: 1 } as Vec3, 0, { x: 0, y: 1, z: 1 }],
            ["Color4", { r: -1, g: 0, b: 1, a: -2 } as Color4, 0, { r: 0, g: 1, b: 1, a: 0 }],
        ])("steps %s", async (_name, value, edge, expected) => {
            const output = await buildGetter("ParticleStepBlock", {}, { inputs: { value: () => value, edge: () => edge } });
            expect(output(0)).toEqual(expected);
        });

        it("defaults edge to zero and reuses owned scratch for volatile colors", async () => {
            const source: Color4 = { r: -1, g: 0, b: 1, a: 2 };
            const output = await buildGetter("ParticleStepBlock", {}, { inputs: { value: () => source } });
            const first = output(0);
            source.r = 3;
            source.g = -3;
            const second = output(0);
            expect(second).toBe(first);
            expect(second).toEqual({ r: 1, g: 0, b: 1, a: 1 });
        });

        it("snapshots shared source scratch before evaluating the edge", async () => {
            const shared: Color4 = { r: -1, g: 0, b: 1, a: -2 };
            const output = await buildGetter(
                "ParticleStepBlock",
                {},
                {
                    inputs: {
                        value: () => shared,
                        edge: () => {
                            shared.r = 9;
                            shared.g = 9;
                            shared.b = 9;
                            shared.a = 9;
                            return 0;
                        },
                    },
                }
            );
            expect(output(0)).toEqual({ r: 0, g: 1, b: 1, a: 0 });
        });

        it("reports disconnected and malformed values", async () => {
            await expect(buildGetter("ParticleStepBlock", {}, { inputs: {} })).rejects.toThrow('NodeParticle: ParticleStepBlock 7 input "value" is not connected');
            const malformed = await buildGetter("ParticleStepBlock", {}, { inputs: { value: () => null as unknown as NpeValue } });
            expect(() => malformed(0)).toThrow("NodeParticle: ParticleStepBlock 7 received an unsupported value");
        });

        it("executes from a parsed graph with a connected edge", async () => {
            expect(await evaluateParsedGraph(scalarGraph("ParticleStepBlock", {}, { value: { type: 2, value: 0.5 }, edge: { type: 2, value: 0.5 } }))).toBe(1);
        });
    });
});
