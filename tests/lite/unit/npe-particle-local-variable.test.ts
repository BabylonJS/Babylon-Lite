import { describe, expect, it } from "vitest";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { mat4Identity } from "../../../packages/babylon-lite/src/math/mat4-identity";
import { mat4Translation } from "../../../packages/babylon-lite/src/math/mat4-translation";
import type { Color4, Vec2, Vec3 } from "../../../packages/babylon-lite/src/math/types";
import { buildNodeParticleSet, type NpeBuildContext, type NpeBuildState } from "../../../packages/babylon-lite/src/particle/node/npe-build";
import { withNodeParticleEmitterProvider } from "../../../packages/babylon-lite/src/particle/node/npe-emitter-provider";
import { normalizeNodeParticleGraph } from "../../../packages/babylon-lite/src/particle/node/npe-graph-plumbing";
import { parseNodeParticleSource } from "../../../packages/babylon-lite/src/particle/node/npe-parser";
import { loadValueBlockEvaluator } from "../../../packages/babylon-lite/src/particle/node/npe-registry-extra-values";
import type { ParsedParticleBlock } from "../../../packages/babylon-lite/src/particle/node/npe-types";
import type { NpeGetter, NpeValue } from "../../../packages/babylon-lite/src/particle/node/npe-value";
import { killParticle, spawnParticle } from "../../../packages/babylon-lite/src/particle/particle-buffer";
import { animateParticleSystem, createParticleSystem, startParticleSystem, stopParticleSystem } from "../../../packages/babylon-lite/src/particle/particle-system";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene";

function createBuildState(capacity: number): NpeBuildState {
    const system = createParticleSystem(capacity);
    return {
        system,
        buffer: system.buffer,
        capacity,
        emitter: { x: 0, y: 0, z: 0 },
        emitterWorldMatrix: mat4Identity(),
        isLocal: false,
        scene: {} as SceneContext,
    };
}

async function buildLocalGetter(state: NpeBuildState, blockId: number, scope: unknown, draw: NpeGetter): Promise<NpeGetter> {
    const block: ParsedParticleBlock = {
        id: blockId,
        className: "ParticleLocalVariableBlock",
        name: "local",
        inputs: [{ name: "input", targetBlockId: 1, targetConnectionName: "output" }],
        serialized: scope === undefined ? {} : { scope },
    };
    let output: NpeGetter | undefined;
    const context: NpeBuildContext = {
        state,
        engine: {} as EngineContext,
        input: () => draw,
        isConnected: () => true,
        setOutput: (_blockId, _name, getter) => {
            output = getter;
        },
        addBuildPromise: () => undefined,
    };
    (await loadValueBlockEvaluator(block.className)).build(block, context);
    return output!;
}

function loopLifecycleGraph(systemCount = 1): object {
    const blocks: Array<Record<string, unknown>> = [
        { customType: "BABYLON.ParticleInputBlock", id: 1, systemSource: 3, inputs: [] },
        {
            customType: "BABYLON.ParticleConverterBlock",
            id: 2,
            inputs: [{ name: "xyz", targetBlockId: 1, targetConnectionName: "output" }],
        },
        {
            customType: "BABYLON.ParticleLocalVariableBlock",
            id: 3,
            scope: 1,
            inputs: [{ name: "input", targetBlockId: 2, targetConnectionName: "x" }],
        },
        { customType: "BABYLON.ParticleInputBlock", id: 4, type: 0x0002, value: 100, inputs: [] },
        {
            customType: "BABYLON.CreateParticleBlock",
            id: 5,
            inputs: [
                { name: "lifeTime", targetBlockId: 4, targetConnectionName: "output" },
                { name: "size", targetBlockId: 3, targetConnectionName: "output" },
            ],
        },
        {
            customType: "BABYLON.UpdateSizeBlock",
            id: 6,
            inputs: [
                { name: "particle", targetBlockId: 5, targetConnectionName: "particle" },
                { name: "size", targetBlockId: 3, targetConnectionName: "output" },
            ],
        },
    ];
    for (let index = 0; index < systemCount; index++) {
        blocks.push({
            customType: "BABYLON.SystemBlock",
            id: 10 + index,
            capacity: 32,
            updateSpeed: 1,
            inputs: [
                { name: "particle", targetBlockId: 6, targetConnectionName: "output" },
                { name: "emitRate", targetBlockId: 3, targetConnectionName: "output" },
            ],
        });
    }
    return { blocks };
}

describe("ParticleLocalVariableBlock", () => {
    it("keeps Particle snapshots through A-B-A reads and invalidates a reused slot by id", async () => {
        const system = createParticleSystem(2);
        const block: ParsedParticleBlock = {
            id: 12,
            className: "ParticleLocalVariableBlock",
            name: "local",
            inputs: [{ name: "input", targetBlockId: 1, targetConnectionName: "output" }],
            serialized: { scope: 0 },
        };
        let evaluations = 0;
        let output: NpeGetter | undefined;
        const context: NpeBuildContext = {
            state: {
                system,
                buffer: system.buffer,
                capacity: system.buffer.capacity,
                emitter: { x: 0, y: 0, z: 0 },
                emitterWorldMatrix: mat4Identity(),
                isLocal: false,
                scene: {} as SceneContext,
            },
            engine: {} as EngineContext,
            input: () => () => ++evaluations,
            isConnected: () => true,
            setOutput: (_blockId, _name, getter) => {
                output = getter;
            },
            addBuildPromise: () => undefined,
        };
        const evaluator = await loadValueBlockEvaluator(block.className);
        evaluator.build(block, context);

        system.buffer.id[0] = 0;
        system.buffer.id[1] = 7;
        expect(output!(0)).toBe(1);
        expect(output!(1)).toBe(2);
        expect(output!(0)).toBe(1);
        expect(evaluations).toBe(2);

        system.buffer.id[1] = 8;
        expect(output!(1)).toBe(3);
        expect(output!(1)).toBe(3);
        expect(evaluations).toBe(3);
    });

    it("commits re-entrant Particle reads to their requested slots", async () => {
        const state = createBuildState(2);
        const buffer = state.buffer!;
        buffer.id[0] = 10;
        buffer.id[1] = 20;
        let evaluations = 0;
        const getters: NpeGetter[] = [];
        const getter = await buildLocalGetter(state, 13, 0, (index) => {
            evaluations++;
            if (index === 0) {
                expect(getters[0]!(1)).toBe(202);
                return 101;
            }
            return 202;
        });
        getters.push(getter);

        expect(getter(0)).toBe(101);
        expect(getter(0)).toBe(101);
        expect(getter(1)).toBe(202);
        expect(evaluations).toBe(2);
        expect(Array.from(buffer._columns.get("local.13.id")!)).toEqual([10, 20]);
        expect(Array.from(buffer._columns.get("local.13.valid")!)).toEqual([1, 1]);
    });

    it("prepares a provider before advancing the shared Loop epoch", async () => {
        const graph = await normalizeNodeParticleGraph(
            parseNodeParticleSource({
                blocks: [
                    { customType: "BABYLON.ParticleInputBlock", id: 1, systemSource: 3, inputs: [] },
                    {
                        customType: "BABYLON.ParticleConverterBlock",
                        id: 2,
                        inputs: [{ name: "xyz", targetBlockId: 1, targetConnectionName: "output" }],
                    },
                    {
                        customType: "BABYLON.ParticleLocalVariableBlock",
                        id: 3,
                        scope: 1,
                        inputs: [{ name: "input", targetBlockId: 2, targetConnectionName: "x" }],
                    },
                    { customType: "BABYLON.ParticleInputBlock", id: 4, type: 0x0002, value: 100, inputs: [] },
                    {
                        customType: "BABYLON.CreateParticleBlock",
                        id: 5,
                        inputs: [{ name: "lifeTime", targetBlockId: 4, targetConnectionName: "output" }],
                    },
                    {
                        customType: "BABYLON.SystemBlock",
                        id: 6,
                        capacity: 16,
                        updateSpeed: 1,
                        inputs: [
                            { name: "particle", targetBlockId: 5, targetConnectionName: "particle" },
                            { name: "emitRate", targetBlockId: 3, targetConnectionName: "output" },
                        ],
                    },
                ],
            })
        );
        let providerCalls = 0;
        const set = await buildNodeParticleSet(
            {} as EngineContext,
            {} as SceneContext,
            graph,
            withNodeParticleEmitterProvider(() => mat4Translation(++providerCalls, 0, 0))
        );
        const system = set.systems[0]!;

        expect(providerCalls).toBe(1);
        startParticleSystem(system);
        animateParticleSystem(system, 1);
        expect(providerCalls).toBe(2);
        expect(system.buffer.alive).toBe(2);

        animateParticleSystem(system, 1);
        expect(providerCalls).toBe(3);
        expect(system.buffer.alive).toBe(5);
    });

    it("moves Particle snapshots with swap-remove and invalidates stale tail data", async () => {
        const state = createBuildState(3);
        const buffer = state.buffer!;
        let evaluations = 0;
        const getter = await buildLocalGetter(state, 20, 0, (index) => ++evaluations * 10 + buffer.id[index]!);
        const first = spawnParticle(buffer);
        const second = spawnParticle(buffer);
        const third = spawnParticle(buffer);

        expect([getter(first), getter(second), getter(third)]).toEqual([10, 21, 32]);
        killParticle(buffer, first);
        expect(buffer.id[0]).toBe(2);
        expect(getter(0)).toBe(32);
        expect(evaluations).toBe(3);

        const reusedTail = spawnParticle(buffer);
        expect(reusedTail).toBe(2);
        expect(buffer.id[reusedTail]).toBe(3);
        expect(getter(reusedTail)).toBe(43);
        expect(getter(reusedTail)).toBe(43);
        expect(evaluations).toBe(4);
    });

    it.each([
        ["scalar", 3.5, 3.5],
        ["Vector2", { x: 1, y: 2 }, { x: 1, y: 2 }],
        ["Vector3", { x: 1, y: 2, z: 3 }, { x: 1, y: 2, z: 3 }],
        ["Color4", { r: 1, g: 2, b: 3, a: 4 }, { r: 1, g: 2, b: 3, a: 4 }],
    ] as const)("copies and caches %s values from volatile input scratch", async (_name, source, expected) => {
        const state = createBuildState(1);
        const buffer = state.buffer!;
        buffer.id[0] = 9;
        let evaluations = 0;
        const getter = await buildLocalGetter(state, 21, 0, () => {
            evaluations++;
            return source as NpeValue;
        });
        const first = getter(0);
        if (typeof source === "object") {
            for (const key of Object.keys(source) as Array<keyof typeof source>) {
                (source as Record<string, number>)[key as string] = 99;
            }
        }

        expect(first).toMatchObject(typeof expected === "object" ? expected : {});
        expect(getter(0)).toMatchObject(typeof expected === "object" ? expected : {});
        if (typeof expected === "number") {
            expect(first).toBe(expected);
            expect(getter(0)).toBe(expected);
        }
        expect(evaluations).toBe(1);
    });

    it("returns the selected runtime shape without larger-shape discriminator properties", async () => {
        const vector2State = createBuildState(1);
        const vector3State = createBuildState(1);
        const colorState = createBuildState(1);
        const vector2 = (await buildLocalGetter(vector2State, 22, 0, () => ({ x: 1, y: 2 })))(0) as Vec2;
        const vector3 = (await buildLocalGetter(vector3State, 23, 0, () => ({ x: 1, y: 2, z: 3 })))(0) as Vec3;
        const color = (await buildLocalGetter(colorState, 24, 0, () => ({ r: 1, g: 2, b: 3, a: 4 })))(0) as Color4;

        expect("r" in vector2).toBe(false);
        expect("z" in vector2).toBe(false);
        expect("r" in vector3).toBe(false);
        expect("z" in vector3).toBe(true);
        expect("r" in color).toBe(true);
    });

    it.each([null, "bad", {}, { x: 1, y: "bad" }, { x: 1, y: 2, z: "bad" }, { r: 1, g: 2, b: 3, a: "bad", x: 1, y: 2, z: 3 }])(
        "rejects malformed values atomically without falling through selected shapes",
        async (malformed) => {
            const state = createBuildState(1);
            const buffer = state.buffer!;
            buffer.id[0] = 5;
            const getter = await buildLocalGetter(state, 25, 0, () => malformed as unknown as NpeValue);

            expect(() => getter(0)).toThrow("NodeParticle: ParticleLocalVariableBlock 25 received an unsupported value");
            expect(buffer._columns.get("local.25.valid")![0]).toBe(0);
            expect(buffer._columns.get("local.25.id")![0]).toBe(0);
            for (let component = 0; component < 4; component++) {
                expect(buffer._columns.get(`local.25.value${component}`)![0]).toBe(0);
            }
        }
    );

    it("rejects a runtime shape change without replacing the prior snapshot", async () => {
        const state = createBuildState(1);
        const buffer = state.buffer!;
        let value: NpeValue = 7;
        const getter = await buildLocalGetter(state, 26, 0, () => value);
        buffer.id[0] = 0;
        expect(getter(0)).toBe(7);

        buffer.id[0] = 1;
        value = { x: 2, y: 3 };
        expect(() => getter(0)).toThrow("NodeParticle: ParticleLocalVariableBlock 26 changed value type");
        expect(buffer._columns.get("local.26.valid")![0]).toBe(1);
        expect(buffer._columns.get("local.26.id")![0]).toBe(0);
        expect(buffer._columns.get("local.26.value0")![0]).toBe(7);
    });

    it("allocates exactly six Particle columns at 37 bytes per capacity slot", async () => {
        const state = createBuildState(4);
        await buildLocalGetter(state, 27, 0, () => Number.NaN);
        const columns = state.buffer!._columns;

        expect([...columns.keys()]).toEqual(["local.27.id", "local.27.valid", "local.27.value0", "local.27.value1", "local.27.value2", "local.27.value3"]);
        expect(columns.get("local.27.id")).toBeInstanceOf(Uint32Array);
        expect(columns.get("local.27.valid")).toBeInstanceOf(Uint8Array);
        for (let component = 0; component < 4; component++) {
            expect(columns.get(`local.27.value${component}`)).toBeInstanceOf(Float64Array);
        }
        expect([...columns.values()].reduce((bytes, column) => bytes + column.byteLength, 0)).toBe(4 * 37);
    });

    it("shares one Loop epoch across blocks and evaluates each block once per epoch", async () => {
        const state = createBuildState(1);
        let firstReads = 0;
        let secondReads = 0;
        const first = await buildLocalGetter(state, 30, 1, () => ++firstReads);
        const second = await buildLocalGetter(state, 31, 1, () => ++secondReads * 10);

        expect(first(0)).toBe(1);
        expect(first(0)).toBe(1);
        expect(second(0)).toBe(10);
        expect(state._localVariableLoopEpoch?.value).toBe(0);
        state.system!._prepareFrame!();
        expect(state._localVariableLoopEpoch?.value).toBe(1);
        expect(first(0)).toBe(2);
        expect(second(0)).toBe(20);
        expect(second(0)).toBe(20);
        expect([firstReads, secondReads]).toEqual([2, 2]);
    });

    it("advances Loop only for started calls, including zero ratio and stopped drain calls", async () => {
        const state = createBuildState(1);
        const system = state.system!;
        system.emitRate = 0;
        let reads = 0;
        const getter = await buildLocalGetter(state, 32, undefined, () => ++reads);

        expect(getter(0)).toBe(1);
        animateParticleSystem(system, 1);
        expect(getter(0)).toBe(1);
        startParticleSystem(system);
        animateParticleSystem(system, 0);
        expect(getter(0)).toBe(2);
        stopParticleSystem(system);
        animateParticleSystem(system, 1);
        expect(getter(0)).toBe(3);
        startParticleSystem(system);
        expect(getter(0)).toBe(3);
        animateParticleSystem(system, 1);
        expect(getter(0)).toBe(4);
        expect(reads).toBe(4);
    });

    it("uses one Loop snapshot for dynamic emit rate, existing updates, and births", async () => {
        let providerCalls = 0;
        const graph = await normalizeNodeParticleGraph(parseNodeParticleSource(loopLifecycleGraph()));
        const set = await buildNodeParticleSet(
            {} as EngineContext,
            {} as SceneContext,
            graph,
            withNodeParticleEmitterProvider(() => mat4Translation(++providerCalls, 0, 0))
        );
        const system = set.systems[0]!;

        startParticleSystem(system);
        animateParticleSystem(system, 1);
        expect(system.buffer.alive).toBe(2);
        expect(Array.from(system.buffer.size.subarray(0, 2))).toEqual([2, 2]);
        animateParticleSystem(system, 1);
        expect(system.buffer.alive).toBe(5);
        expect(Array.from(system.buffer.size.subarray(0, 5))).toEqual([3, 3, 3, 3, 3]);
        expect(system.buffer._columns.size).toBe(0);
    });

    it("keeps Loop snapshots independent across systems and builds", async () => {
        let providerCalls = 0;
        const graph = await normalizeNodeParticleGraph(parseNodeParticleSource(loopLifecycleGraph(2)));
        const options = withNodeParticleEmitterProvider(() => mat4Translation(++providerCalls, 0, 0));
        const firstBuild = await buildNodeParticleSet({} as EngineContext, {} as SceneContext, graph, options);
        const secondBuild = await buildNodeParticleSet({} as EngineContext, {} as SceneContext, graph, options);
        const systems = [...firstBuild.systems, ...secondBuild.systems];

        for (const system of systems) {
            startParticleSystem(system);
            animateParticleSystem(system, 1);
        }
        expect(systems.map((system) => system.buffer.alive)).toEqual([2, 3, 4, 5]);
        expect(systems.every((system) => system.buffer._columns.size === 0)).toBe(true);
    });

    it("does not advance Loop or simulation when an earlier provider callback throws", async () => {
        let providerCalls = 0;
        let shouldThrow = false;
        const options = withNodeParticleEmitterProvider(() => {
            providerCalls++;
            if (shouldThrow) {
                throw new Error("provider failed");
            }
            return mat4Translation(providerCalls, 0, 0);
        });
        const setupEmitter = options._setupEmitter!;
        let buildState: NpeBuildState | undefined;
        options._setupEmitter = (state) => {
            setupEmitter(state);
            buildState = state;
        };
        const graph = await normalizeNodeParticleGraph(parseNodeParticleSource(loopLifecycleGraph()));
        const set = await buildNodeParticleSet({} as EngineContext, {} as SceneContext, graph, options);
        const system = set.systems[0]!;
        startParticleSystem(system);

        shouldThrow = true;
        expect(() => animateParticleSystem(system, 1)).toThrow("provider failed");
        expect(buildState!._localVariableLoopEpoch?.value).toBe(0);
        expect(system._actualFrame).toBe(0);
        expect(system.buffer.alive).toBe(0);

        shouldThrow = false;
        animateParticleSystem(system, 1);
        expect(buildState!._localVariableLoopEpoch?.value).toBe(1);
        expect(system.buffer.alive).toBe(3);
    });

    it("allocates no optional columns or frame callback for systems without LocalVariable", () => {
        const system = createParticleSystem(4);
        expect(system.buffer._columns.size).toBe(0);
        expect(system._prepareFrame).toBeUndefined();
    });
});
