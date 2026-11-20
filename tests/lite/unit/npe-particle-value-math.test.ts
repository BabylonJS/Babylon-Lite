import { describe, expect, it } from "vitest";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene";
import { buildNodeParticleSet, type NpeBlockEvaluator, type NpeBuildContext } from "../../../packages/babylon-lite/src/particle/node/npe-build";
import { parseNodeParticleSource } from "../../../packages/babylon-lite/src/particle/node/npe-parser";
import type { NpeGetter, NpeValue } from "../../../packages/babylon-lite/src/particle/node/npe-value";
import type { ParsedParticleBlock } from "../../../packages/babylon-lite/src/particle/node/npe-types";
import type { Vec3 } from "../../../packages/babylon-lite/src/math/types";
import { npeBlock as clampBlock } from "../../../packages/babylon-lite/src/particle/node/blocks/particle-clamp-block";
import { npeBlock as mathBlock } from "../../../packages/babylon-lite/src/particle/node/blocks/particle-math-block";
import { npeBlock as nlerpBlock } from "../../../packages/babylon-lite/src/particle/node/blocks/particle-nlerp-block";
import { npeBlock as smoothStepBlock } from "../../../packages/babylon-lite/src/particle/node/blocks/particle-smooth-step-block";
import { npeBlock as stepBlock } from "../../../packages/babylon-lite/src/particle/node/blocks/particle-step-block";
import { npeBlock as trigonometryBlock } from "../../../packages/babylon-lite/src/particle/node/blocks/particle-trigonometry-block";
import { npeBlock as vectorMathBlock } from "../../../packages/babylon-lite/src/particle/node/blocks/particle-vector-math-block";

const TYPE_INT = 0x0001;
const TYPE_FLOAT = 0x0002;
const SINK_ID = 999;

type GraphBlock = Record<string, unknown>;

interface BuiltBlock {
    output: NpeGetter | undefined;
    isInt: boolean;
}

/** Build one block against a mock context whose connected inputs are `inputs` and whose `Int` inputs are `intInputs`. */
function buildWithMock(evaluator: NpeBlockEvaluator, serialized: Record<string, unknown>, inputs: Record<string, NpeGetter>, intInputs: readonly string[] = []): BuiltBlock {
    const block = { id: 1, className: "Block", name: "block", serialized, inputs: [] } as unknown as ParsedParticleBlock;
    const built: BuiltBlock = { output: undefined, isInt: false };
    const ctx = {
        input: (_block: ParsedParticleBlock, name: string, fallback?: NpeGetter): NpeGetter => inputs[name] ?? fallback ?? (() => null as unknown as NpeValue),
        isConnected: (_block: ParsedParticleBlock, name: string): boolean => name in inputs,
        isInt: (_block: ParsedParticleBlock, name: string): boolean => intInputs.includes(name),
        setOutput: (_blockId: number, _name: string, getter: NpeGetter, isInt?: boolean): void => {
            built.output = getter;
            built.isInt = isInt === true;
        },
    } as unknown as NpeBuildContext;
    void evaluator.build(block, ctx);
    return built;
}

const constant =
    (value: NpeValue): NpeGetter =>
    () =>
        value;

function input(id: number, type: number, value: unknown): GraphBlock {
    return { customType: "BABYLON.ParticleInputBlock", id, type, value, inputs: [] };
}

function connect(name: string, targetBlockId: number): Record<string, unknown> {
    return { name, targetBlockId, targetConnectionName: "output" };
}

/** Build a graph whose SystemBlock reads `targetStopDuration` from block `sourceId`, returning the evaluated scalar. */
async function evaluateScalar(blocks: GraphBlock[], sourceId: number): Promise<number> {
    const source = { blocks: [...blocks, { customType: "BABYLON.SystemBlock", id: SINK_ID, inputs: [connect("targetStopDuration", sourceId)] }] };
    const set = await buildNodeParticleSet({} as EngineContext, {} as SceneContext, parseNodeParticleSource(source));
    return set.systems[0]!.targetStopDuration;
}

describe("NPE value and math blocks", () => {
    describe("per-component Clamp, Step and SmoothStep", () => {
        it.each<{ name: string; evaluator: NpeBlockEvaluator; inputs: Record<string, NpeGetter>; expected: NpeValue }>([
            { name: "Clamp scalar above the default max", evaluator: clampBlock, inputs: { value: constant(1.5) }, expected: 1 },
            { name: "Clamp scalar below the default min", evaluator: clampBlock, inputs: { value: constant(-0.5) }, expected: 0 },
            {
                name: "Clamp Color4 with connected bounds",
                evaluator: clampBlock,
                inputs: { value: constant({ r: 0, g: 0.4, b: 0.9, a: 1 }), min: constant(0.2), max: constant(0.6) },
                expected: { r: 0.2, g: 0.4, b: 0.6, a: 0.6 },
            },
            { name: "Step Vector3 with the default edge", evaluator: stepBlock, inputs: { value: constant({ x: -1, y: 0, z: 2 }) }, expected: { x: 0, y: 1, z: 1 } },
            { name: "Step Vector2 with a connected edge", evaluator: stepBlock, inputs: { value: constant({ x: 0.25, y: 0.75 }), edge: constant(0.5) }, expected: { x: 0, y: 1 } },
            { name: "SmoothStep scalar with the default edges", evaluator: smoothStepBlock, inputs: { value: constant(0.25) }, expected: 0.15625 },
            {
                name: "SmoothStep Color4 with connected edges",
                evaluator: smoothStepBlock,
                inputs: { value: constant({ r: -1, g: 1, b: 2, a: 3 }), edge0: constant(0), edge1: constant(2) },
                expected: { r: 0, g: 0.5, b: 1, a: 1 },
            },
        ])("$name", ({ evaluator, inputs, expected }) => {
            const { output } = buildWithMock(evaluator, {}, inputs);
            expect(output!(0)).toEqual(expected);
        });

        it.each([
            { name: "Clamp", evaluator: clampBlock },
            { name: "Step", evaluator: stepBlock },
            { name: "SmoothStep", evaluator: smoothStepBlock },
        ])("$name publishes no output when value is unconnected", ({ evaluator }) => {
            expect(buildWithMock(evaluator, {}, { min: constant(0), edge: constant(0), edge0: constant(0) }).output).toBeUndefined();
        });

        it("copies the value before a bound rewrites the shared upstream scratch", () => {
            const scratch: Vec3 = { x: 0, y: 0, z: 0 };
            const { output } = buildWithMock(
                clampBlock,
                {},
                {
                    value: () => Object.assign(scratch, { x: 5, y: -5, z: 0.5 }),
                    min: () => (Object.assign(scratch, { x: 0, y: 0, z: 0 }), 0),
                }
            );
            expect(output!(0)).toEqual({ x: 1, y: 0, z: 0.5 });
        });
    });

    describe("ParticleNLerpBlock", () => {
        it.each([
            { name: "lerps scalars without normalizing", left: 2, right: 4, gradient: 0.5, expected: 3 },
            { name: "normalizes Vector2", left: { x: 3, y: 0 }, right: { x: 0, y: 4 }, gradient: 0, expected: { x: 1, y: 0 } },
            { name: "normalizes Vector3", left: { x: 1, y: 0, z: 0 }, right: { x: 0, y: 1, z: 0 }, gradient: 0.5, expected: { x: Math.SQRT1_2, y: Math.SQRT1_2, z: 0 } },
            { name: "leaves a zero-length Vector3 unnormalized", left: { x: 1, y: 0, z: 0 }, right: { x: -1, y: 0, z: 0 }, gradient: 0.5, expected: { x: 0, y: 0, z: 0 } },
            {
                name: "normalizes Color4 over all four channels",
                left: { r: 2, g: 0, b: 0, a: 0 },
                right: { r: 0, g: 0, b: 0, a: 2 },
                gradient: 0.5,
                expected: { r: Math.SQRT1_2, g: 0, b: 0, a: Math.SQRT1_2 },
            },
        ])("$name", ({ left, right, gradient, expected }) => {
            const { output } = buildWithMock(nlerpBlock, {}, { left: constant(left), right: constant(right), gradient: constant(gradient) });
            const value = output!(0);
            if (typeof expected === "number") {
                expect(value).toBe(expected);
            } else {
                for (const [key, component] of Object.entries(expected)) {
                    expect((value as unknown as Record<string, number>)[key]).toBeCloseTo(component, 12);
                }
            }
        });

        it("defaults gradient to zero and requires both operands", () => {
            expect(buildWithMock(nlerpBlock, {}, { left: constant({ x: 0, y: 2 }), right: constant({ x: 5, y: 0 }) }).output!(0)).toEqual({ x: 0, y: 1 });
            expect(buildWithMock(nlerpBlock, {}, { left: constant(1) }).output).toBeUndefined();
        });

        it("reads left before right when both share an upstream scratch", () => {
            const scratch: Vec3 = { x: 0, y: 0, z: 0 };
            const { output } = buildWithMock(
                nlerpBlock,
                {},
                {
                    left: () => Object.assign(scratch, { x: 0, y: 3, z: 0 }),
                    right: () => Object.assign(scratch, { x: 4, y: 0, z: 0 }),
                    gradient: constant(0),
                }
            );
            expect(output!(0)).toEqual({ x: 0, y: 1, z: 0 });
        });
    });

    describe("ParticleTrigonometryBlock", () => {
        it.each([
            { operation: undefined, value: 0, expected: 1 },
            { operation: 2, value: -2, expected: 2 },
            { operation: 4, value: 3, expected: 8 },
            { operation: 7, value: 1.2, expected: 2 },
            { operation: 14, value: -3, expected: -1 },
            { operation: 15, value: 2, expected: -2 },
            { operation: 16, value: 0.25, expected: 0.75 },
            { operation: 17, value: 4, expected: 0.25 },
            { operation: 18, value: Math.PI, expected: 180 },
            { operation: 19, value: 180, expected: Math.PI },
            { operation: 20, value: -1.25, expected: -0.25 },
        ])("operation $operation maps $value to $expected", ({ operation, value, expected }) => {
            const { output } = buildWithMock(trigonometryBlock, operation === undefined ? {} : { operation }, { input: constant(value) });
            expect(output!(0)).toBeCloseTo(expected, 12);
        });

        it("maps every vector component and keeps the input typing", () => {
            const built = buildWithMock(trigonometryBlock, { operation: 6 }, { input: constant({ x: 1.5, y: -1.5, z: 2 }) }, ["input"]);
            expect(built.output!(0)).toEqual({ x: 1, y: -2, z: 2 });
            expect(built.isInt).toBe(true);
        });

        it("publishes no output for an unknown operation or an unconnected input", () => {
            expect(buildWithMock(trigonometryBlock, { operation: 21 }, { input: constant(1) }).output).toBeUndefined();
            expect(buildWithMock(trigonometryBlock, {}, {}).output).toBeUndefined();
        });
    });

    describe("ParticleVectorMathBlock", () => {
        it("evaluates Dot by default and Distance, copying left before right rewrites a shared scratch", () => {
            const scratch: Vec3 = { x: 0, y: 0, z: 0 };
            const inputs = { left: () => Object.assign(scratch, { x: 1, y: 2, z: 3 }), right: () => Object.assign(scratch, { x: 4, y: 6, z: 3 }) };
            const dot = buildWithMock(vectorMathBlock, {}, inputs);
            expect(dot.output!(0)).toBe(1 * 4 + 2 * 6 + 3 * 3);
            expect(dot.isInt).toBe(false);
            expect(buildWithMock(vectorMathBlock, { operation: 1 }, inputs).output!(0)).toBe(5);
        });

        it("publishes no output for an unknown operation or a missing operand", () => {
            expect(buildWithMock(vectorMathBlock, { operation: 2 }, { left: constant({ x: 0, y: 0, z: 0 }), right: constant({ x: 0, y: 0, z: 0 }) }).output).toBeUndefined();
            expect(buildWithMock(vectorMathBlock, {}, { left: constant({ x: 0, y: 0, z: 0 }) }).output).toBeUndefined();
        });
    });

    describe("ParticleNumberMathBlock", () => {
        it.each([
            { name: "Int left truncates Modulo", operation: undefined, left: input(1, TYPE_INT, 5.75), right: input(2, TYPE_FLOAT, 2), expected: 1 },
            { name: "Float left keeps the Modulo fraction with an Int right", operation: 0, left: input(1, TYPE_FLOAT, 5.75), right: input(2, TYPE_INT, 2), expected: 1.75 },
            { name: "Float Pow", operation: 1, left: input(1, TYPE_FLOAT, 2), right: input(2, TYPE_FLOAT, 0.5), expected: Math.SQRT2 },
            { name: "Int left truncates Pow", operation: 1, left: input(1, TYPE_INT, 6), right: input(2, TYPE_FLOAT, 0.5), expected: 2 },
        ])("$name", async ({ operation, left, right, expected }) => {
            const numberMath = {
                customType: "BABYLON.ParticleNumberMathBlock",
                id: 3,
                ...(operation === undefined ? {} : { operation }),
                inputs: [connect("left", 1), connect("right", 2)],
            };
            expect(await evaluateScalar([left, right, numberMath], 3)).toBe(expected);
        });

        it.each([
            { name: "a missing operand", operation: 0, inputs: [connect("left", 1)] },
            { name: "an unknown operation", operation: 2, inputs: [connect("left", 1), connect("right", 1)] },
        ])("leaves downstream inputs unresolved for $name", async ({ operation, inputs }) => {
            const numberMath = { customType: "BABYLON.ParticleNumberMathBlock", id: 3, operation, inputs };
            await expect(evaluateScalar([input(1, TYPE_FLOAT, 1), numberMath], 3)).rejects.toThrow("NodeParticle: unresolved connection SystemBlock.targetStopDuration");
        });
    });

    describe("Int typing", () => {
        // `pow(left, 0.5)` truncates only when `left` is typed Int, so the probe exposes the upstream typing.
        function intProbe(sourceId: number): GraphBlock[] {
            return [input(90, TYPE_FLOAT, 0.5), { customType: "BABYLON.ParticleNumberMathBlock", id: 91, operation: 1, inputs: [connect("left", sourceId), connect("right", 90)] }];
        }

        it.each([
            { name: "Int left truncates and stays Int with an Int right", left: input(1, TYPE_INT, 5), right: input(2, TYPE_INT, 2), operation: 3, value: 2, probe: 1 },
            {
                name: "Int left truncates but becomes Float with a Float right",
                left: input(1, TYPE_INT, 5),
                right: input(2, TYPE_FLOAT, 0.5),
                operation: 2,
                value: 2,
                probe: Math.SQRT2,
            },
            { name: "Float left neither truncates nor becomes Int", left: input(1, TYPE_FLOAT, 5), right: input(2, TYPE_INT, 2), operation: 3, value: 2.5, probe: Math.sqrt(2.5) },
        ])("ParticleMathBlock: $name", async ({ left, right, operation, value, probe }) => {
            const math = { customType: "BABYLON.ParticleMathBlock", id: 3, operation, inputs: [connect("left", 1), connect("right", 2)] };
            expect(await evaluateScalar([left, right, math], 3)).toBe(value);
            expect(await evaluateScalar([left, right, math, ...intProbe(3)], 91)).toBe(probe);
        });

        it("keeps an Int-left vector ParticleMathBlock result untruncated", () => {
            const { output } = buildWithMock(mathBlock, { operation: 2 }, { left: constant(2), right: constant({ x: 0.25, y: 0.75, z: 1.5 }) }, ["left"]);
            expect(output!(0)).toEqual({ x: 0.5, y: 1.5, z: 3 });
        });

        const int6 = input(1, TYPE_INT, 6);
        const float6 = input(1, TYPE_FLOAT, 6.5);
        it.each([
            { name: "ParticleFloatToIntBlock", blocks: [input(1, TYPE_FLOAT, 6.4), { customType: "BABYLON.ParticleFloatToIntBlock", id: 2, inputs: [connect("input", 1)] }] },
            {
                name: "ParticleClampBlock",
                blocks: [int6, input(5, TYPE_FLOAT, 10), { customType: "BABYLON.ParticleClampBlock", id: 2, inputs: [connect("value", 1), connect("max", 5)] }],
            },
            {
                name: "ParticleTrigonometryBlock",
                blocks: [input(1, TYPE_INT, -6), { customType: "BABYLON.ParticleTrigonometryBlock", id: 2, operation: 2, inputs: [connect("input", 1)] }],
            },
            {
                name: "ParticleNLerpBlock",
                blocks: [int6, input(5, TYPE_FLOAT, 2), { customType: "BABYLON.ParticleNLerpBlock", id: 2, inputs: [connect("left", 1), connect("right", 5)] }],
            },
            {
                name: "ParticleLerpBlock",
                blocks: [int6, input(5, TYPE_FLOAT, 100), { customType: "BABYLON.ParticleLerpBlock", id: 2, inputs: [connect("left", 1), connect("right", 5)] }],
            },
            { name: "ParticleConditionBlock", blocks: [int6, { customType: "BABYLON.ParticleConditionBlock", id: 2, inputs: [connect("ifTrue", 1)] }] },
            { name: "ParticleLocalVariableBlock", blocks: [int6, { customType: "BABYLON.ParticleLocalVariableBlock", id: 2, inputs: [connect("input", 1)] }] },
            {
                name: "ParticleRandomBlock",
                blocks: [int6, input(5, TYPE_FLOAT, 6), { customType: "BABYLON.ParticleRandomBlock", id: 2, inputs: [connect("min", 1), connect("max", 5)] }],
            },
            {
                name: "ParticleGradientBlock and ParticleGradientValueBlock",
                blocks: [
                    int6,
                    { customType: "BABYLON.ParticleGradientValueBlock", id: 5, inputs: [connect("value", 1)] },
                    { customType: "BABYLON.ParticleGradientBlock", id: 2, inputs: [connect("value0", 5)] },
                ],
            },
        ])("$name forwards Int typing", async ({ blocks }) => {
            expect(await evaluateScalar([...blocks, ...intProbe(2)], 91)).toBe(2);
        });

        it("keeps Float typing through a forwarder", async () => {
            const clamp = { customType: "BABYLON.ParticleClampBlock", id: 2, inputs: [connect("value", 1), connect("max", 5)] };
            expect(await evaluateScalar([float6, input(5, TYPE_FLOAT, 10), clamp, ...intProbe(2)], 91)).toBe(Math.sqrt(6.5));
        });
    });
});
