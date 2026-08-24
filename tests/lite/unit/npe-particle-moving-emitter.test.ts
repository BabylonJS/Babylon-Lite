import { describe, expect, it } from "vitest";
import pointGraph from "./fixtures/emitter-point-npe.json";
import coneFixture from "./fixtures/emitter-cone-npe.json";
import cylinderFixture from "./fixtures/emitter-cylinder-npe.json";
import meshFixture from "./fixtures/emitter-mesh-npe.json";
import movingLocalGraph from "./fixtures/emitter-moving-local-npe.json";
import movingLocalStates from "./fixtures/emitter-moving-local-states.json";
import { SCENE262_NPE_JSON } from "../../../lab/lite/src/shared/scene262-npe";
import { SCENE263_NPE_JSON } from "../../../lab/lite/src/shared/scene263-npe";
import type { Mat4 } from "../../../packages/babylon-lite/src/math/types";
import { animateParticleSystem, startParticleSystem, stopParticleSystem, type ParticleSystem } from "../../../packages/babylon-lite/src/particle/particle-system";
import { createParticleBillboard } from "../../../packages/babylon-lite/src/particle/particle-billboard";
import { buildNodeParticleGraph, snapshotParticles } from "./particle-test-utils";
import { buildNodeParticleSet, type BuildNodeParticleOptions, type NodeParticleSet } from "../../../packages/babylon-lite/src/particle/node/npe-build";
import { buildNodeParticleSetWithBlendModes } from "../../../packages/babylon-lite/src/particle/node/npe-blend-modes";
import {
    buildNodeParticleSetWithEmitterProvider,
    enableNodeParticleEmitterProvider,
    type NodeParticleEmitterProvider,
} from "../../../packages/babylon-lite/src/particle/node/npe-emitter-provider";
import { buildNodeParticleSetWithFlowMaps } from "../../../packages/babylon-lite/src/particle/node/npe-flow-map";
import { buildNodeParticleSetWithNoiseTextures } from "../../../packages/babylon-lite/src/particle/node/npe-noise";
import { buildNodeParticleSetWithTextureUpdates } from "../../../packages/babylon-lite/src/particle/node/npe-texture-updates";
import { parseNodeParticleSetFromSnippet } from "../../../packages/babylon-lite/src/particle/node/node-particle";
import { parseNodeParticleSource } from "../../../packages/babylon-lite/src/particle/node/npe-parser";
import type { ParticleGraph } from "../../../packages/babylon-lite/src/particle/node/npe-types";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene";
import type { Texture2D } from "../../../packages/babylon-lite/src/texture/texture-2d";

interface OracleParticle {
    id: number;
    position: [number, number, number];
    direction: [number, number, number];
    color: [number, number, number, number];
    size: number;
    scale: [number, number];
    angle: number;
    age: number;
    lifeTime: number;
}

interface MovingEmitterOracle {
    N: number;
    matrices: number[][];
    particles: OracleParticle[];
}

const oracle = movingLocalStates as unknown as { translating: MovingEmitterOracle; rotating: MovingEmitterOracle };

interface RawInput {
    name: string;
    targetBlockId?: number;
    targetConnectionName?: string;
    valueType?: string;
    value?: unknown;
}

interface RawBlock {
    customType: string;
    id: number;
    inputs: RawInput[];
    isLocal?: boolean;
    contextualValue?: number;
    systemSource?: number;
}

interface RawGraph {
    blocks: RawBlock[];
}

type NodeParticleBuilder = (engine: EngineContext, scene: SceneContext, graph: ParticleGraph, options?: BuildNodeParticleOptions) => Promise<NodeParticleSet>;

async function buildNodeParticleGraphWithEmitterProvider(source: unknown, provider: NodeParticleEmitterProvider, options: BuildNodeParticleOptions = {}): Promise<ParticleSystem> {
    const set = await buildNodeParticleSet({} as EngineContext, {} as SceneContext, parseNodeParticleSource(source), options);
    await enableNodeParticleEmitterProvider(set, provider);
    return set.systems[0]!;
}

function emitterMatrix(x: number, y: number, z: number, rotationZ = 0, scaleX = 1, scaleY = 1, scaleZ = 1): Mat4 {
    const cosine = Math.cos(rotationZ);
    const sine = Math.sin(rotationZ);
    return new Float32Array([cosine * scaleX, sine * scaleX, 0, 0, -sine * scaleY, cosine * scaleY, 0, 0, 0, 0, scaleZ, 0, x, y, z, 1]) as unknown as Mat4;
}

function worldPointGraph(): RawGraph {
    const source = structuredClone(movingLocalGraph) as unknown as RawGraph;
    const system = source.blocks.find((block) => block.customType === "BABYLON.SystemBlock")!;
    const shape = source.blocks.find((block) => block.customType === "BABYLON.SphereShapeBlock")!;
    system.isLocal = false;
    const particle = system.inputs.find((input) => input.name === "particle")!;
    particle.targetBlockId = shape.id;
    particle.targetConnectionName = "output";
    shape.customType = "BABYLON.PointShapeBlock";
    return source;
}

function systemEmitterGraph(): RawGraph {
    const source = worldPointGraph();
    const system = source.blocks.find((block) => block.customType === "BABYLON.SystemBlock")!;
    const updatePosition = source.blocks.find((block) => block.customType === "BABYLON.UpdatePositionBlock")!;
    const emitterInput = source.blocks.find((block) => block.customType === "BABYLON.ParticleInputBlock")!;
    const particle = system.inputs.find((input) => input.name === "particle")!;
    particle.targetBlockId = updatePosition.id;
    particle.targetConnectionName = "output";
    emitterInput.contextualValue = 0;
    emitterInput.systemSource = 3;
    return source;
}

function worldCylinderGraph(): RawGraph {
    const source = worldPointGraph();
    const shape = source.blocks.find((block) => block.customType === "BABYLON.PointShapeBlock")!;
    shape.customType = "BABYLON.CylinderShapeBlock";
    return source;
}

function multiSystemGraph(): RawGraph {
    const first = worldPointGraph();
    const second = structuredClone(first);
    const offset = Math.max(...first.blocks.map((block) => block.id)) + 1;
    for (const block of second.blocks) {
        block.id += offset;
        for (const input of block.inputs) {
            if (input.targetBlockId !== undefined) {
                input.targetBlockId += offset;
            }
        }
    }
    return { blocks: [...first.blocks, ...second.blocks] };
}

function multiCylinderGraph(): RawGraph {
    const source = worldCylinderGraph();
    const system = source.blocks.find((block) => block.customType === "BABYLON.SystemBlock")!;
    const cylinder = source.blocks.find((block) => block.customType === "BABYLON.CylinderShapeBlock")!;
    const secondCylinder = structuredClone(cylinder);
    secondCylinder.id = Math.max(...source.blocks.map((block) => block.id)) + 1;
    source.blocks.push(secondCylinder);
    system.inputs.push({ name: "unusedShape", targetBlockId: secondCylinder.id, targetConnectionName: "output" });
    return source;
}

function localGraph(source: unknown): RawGraph {
    const local = structuredClone(source) as RawGraph;
    const system = local.blocks.find((block) => block.customType === "BABYLON.SystemBlock")!;
    const updatePosition = local.blocks.find((block) => block.customType === "BABYLON.UpdatePositionBlock")!;
    const nextId = Math.max(...local.blocks.map((block) => block.id)) + 1;
    system.isLocal = true;
    local.blocks.push({
        customType: "BABYLON.ParticleInputBlock",
        id: nextId,
        inputs: [],
        contextualValue: 24,
        systemSource: 0,
    });
    const position = updatePosition.inputs.find((input) => input.name === "position")!;
    position.targetBlockId = nextId;
    position.targetConnectionName = "output";
    return local;
}

function seedRandom(values?: readonly number[], offset = 0): () => void {
    const previousRandom = Math.random;
    let index = offset;
    let seed = 1;
    Math.random = values
        ? () => values[index++]!
        : () => {
              const value = Math.sin(seed++) * 10000;
              return value - Math.floor(value);
          };
    return () => {
        Math.random = previousRandom;
    };
}

describe("NPE moving emitter transforms", () => {
    it.each([
        ["translating", oracle.translating],
        ["rotating", oracle.rotating],
    ] as const)("matches the Babylon.js %s isLocal emitter fixture", async (_name, fixture) => {
        let providerCalls = 0;
        const system = await buildNodeParticleGraphWithEmitterProvider(movingLocalGraph, () => {
            const matrixIndex = Math.max(0, providerCalls - 1);
            providerCalls++;
            return new Float32Array(fixture.matrices[matrixIndex]!) as unknown as Mat4;
        });

        const previousRandom = Math.random;
        let seed = 1;
        Math.random = () => {
            const value = Math.sin(seed++) * 10000;
            return value - Math.floor(value);
        };
        try {
            startParticleSystem(system);
            for (let step = 0; step < fixture.N; step++) {
                animateParticleSystem(system, 1);
            }
        } finally {
            Math.random = previousRandom;
        }

        const actual = snapshotParticles(system);
        expect(providerCalls).toBe(fixture.N + 1);
        expect(actual).toHaveLength(fixture.particles.length);
        const idOffset = fixture.particles[0]!.id - actual[0]!.id;
        const tolerance = 1e-4;
        for (let index = 0; index < fixture.particles.length; index++) {
            const expected = fixture.particles[index]!;
            const particle = actual[index]!;
            expect(particle.id + idOffset).toBe(expected.id);
            expect(Math.abs(particle.position.x - expected.position[0])).toBeLessThan(tolerance);
            expect(Math.abs(particle.position.y - expected.position[1])).toBeLessThan(tolerance);
            expect(Math.abs(particle.position.z - expected.position[2])).toBeLessThan(tolerance);
            expect(Math.abs(particle.direction.x - expected.direction[0])).toBeLessThan(tolerance);
            expect(Math.abs(particle.direction.y - expected.direction[1])).toBeLessThan(tolerance);
            expect(Math.abs(particle.direction.z - expected.direction[2])).toBeLessThan(tolerance);
            expect(particle.color).toEqual({ r: expected.color[0], g: expected.color[1], b: expected.color[2], a: expected.color[3] });
            expect(particle.size).toBe(expected.size);
            expect(particle.scale).toEqual({ x: expected.scale[0], y: expected.scale[1] });
            expect(particle.angle).toBe(expected.angle);
            expect(Math.abs(particle.age - expected.age)).toBeLessThan(tolerance);
            expect(particle.lifeTime).toBe(expected.lifeTime);
        }
    });

    it("refreshes a replacement provider matrix before each manual simulation step", async () => {
        let currentMatrix = emitterMatrix(1, 2, 3);
        let providerCalls = 0;
        const system = await buildNodeParticleGraphWithEmitterProvider(pointGraph, () => {
            providerCalls++;
            return currentMatrix;
        });

        startParticleSystem(system);
        animateParticleSystem(system, 1);
        currentMatrix = emitterMatrix(4, 5, 6, Math.PI / 2);
        animateParticleSystem(system, 1);

        expect(providerCalls).toBe(3);
        expect(system.buffer.alive).toBe(2);
        expect(system.buffer.posX[1]).toBeCloseTo(4);
        expect(system.buffer.posY[1]).toBeCloseTo(5);
        expect(system.buffer.posZ[1]).toBeCloseTo(6);
    });

    it("supports a provider that mutates and returns the same matrix", async () => {
        const matrix = emitterMatrix(0, 0, 0);
        const system = await buildNodeParticleGraphWithEmitterProvider(worldPointGraph(), () => matrix);

        startParticleSystem(system);
        animateParticleSystem(system, 1);
        (matrix as unknown as Float32Array).set(emitterMatrix(4, 5, 6, Math.PI / 2) as unknown as Float32Array);
        animateParticleSystem(system, 1);

        expect(system.buffer.posX[1]).toBeCloseTo(4);
        expect(system.buffer.posY[1]).toBeCloseTo(5);
        expect(system.buffer.posZ[1]).toBeCloseTo(6);
        expect(system.buffer.dirX[1]).toBeCloseTo(-1);
        expect(system.buffer.dirY[1]).toBeCloseTo(0);
        expect(system.buffer.dirZ[1]).toBeCloseTo(0);
    });

    it("refreshes contextual Emitter before existing-particle updates and births", async () => {
        let matrix = emitterMatrix(1, 2, 3);
        const system = await buildNodeParticleGraphWithEmitterProvider(systemEmitterGraph(), () => matrix);

        startParticleSystem(system);
        animateParticleSystem(system, 1);
        matrix = emitterMatrix(7, 8, 9);
        animateParticleSystem(system, 1);

        expect(system.buffer.alive).toBe(2);
        for (let index = 0; index < system.buffer.alive; index++) {
            expect(system.buffer.posX[index]).toBeCloseTo(7);
            expect(system.buffer.posY[index]).toBeCloseTo(8);
            expect(system.buffer.posZ[index]).toBeCloseTo(9);
        }
    });

    it("refreshes the implicit Cylinder inverse for a rotated non-uniform transform", async () => {
        const nextMatrix = emitterMatrix(3, -2, 5, Math.PI / 3, 2, 0.5, 1.5);
        let matrix = emitterMatrix(0, 0, 0);
        const live = await buildNodeParticleGraphWithEmitterProvider(worldCylinderGraph(), () => matrix);
        const staticallyTransformed = await buildNodeParticleGraph(worldCylinderGraph(), { emitterWorldMatrix: nextMatrix });
        const draws = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];

        let restoreRandom = seedRandom(draws);
        try {
            startParticleSystem(live);
            animateParticleSystem(live, 1);
            matrix = nextMatrix;
            animateParticleSystem(live, 1);
        } finally {
            restoreRandom();
        }

        restoreRandom = seedRandom(draws, 4);
        try {
            startParticleSystem(staticallyTransformed);
            animateParticleSystem(staticallyTransformed, 1);
        } finally {
            restoreRandom();
        }

        expect(live.buffer.posX[1]).toBeCloseTo(staticallyTransformed.buffer.posX[0]!, 6);
        expect(live.buffer.posY[1]).toBeCloseTo(staticallyTransformed.buffer.posY[0]!, 6);
        expect(live.buffer.posZ[1]).toBeCloseTo(staticallyTransformed.buffer.posZ[0]!, 6);
        expect(live.buffer.dirX[1]).toBeCloseTo(staticallyTransformed.buffer.dirX[0]!, 6);
        expect(live.buffer.dirY[1]).toBeCloseTo(staticallyTransformed.buffer.dirY[0]!, 6);
        expect(live.buffer.dirZ[1]).toBeCloseTo(staticallyTransformed.buffer.dirZ[0]!, 6);
    });

    it.each(
        [
            ["box", SCENE262_NPE_JSON],
            ["point", pointGraph],
            ["sphere", SCENE263_NPE_JSON],
            ["cone", coneFixture],
            ["cylinder", cylinderFixture],
            ["mesh", meshFixture],
        ].flatMap(([name, source]) => [
            [`${name} world`, source],
            [`${name} local`, localGraph(source)],
        ])
    )("routes refreshed state through %s emission", async (_name, source) => {
        let matrix = emitterMatrix(0, 0, 0);
        const transformed = emitterMatrix(3, -2, 5, Math.PI / 3, 1.5, 0.75, 2);
        const live = await buildNodeParticleGraphWithEmitterProvider(source, () => matrix);
        const staticallyTransformed = await buildNodeParticleGraph(source, { emitterWorldMatrix: transformed });
        matrix = transformed;

        let restoreRandom = seedRandom();
        try {
            startParticleSystem(live);
            animateParticleSystem(live, 1);
        } finally {
            restoreRandom();
        }
        restoreRandom = seedRandom();
        try {
            startParticleSystem(staticallyTransformed);
            animateParticleSystem(staticallyTransformed, 1);
        } finally {
            restoreRandom();
        }

        expect(staticallyTransformed._prepareFrame).toBeUndefined();
        expect(snapshotParticles(live)).toEqual(snapshotParticles(staticallyTransformed));
    });

    it.each([
        ["default", buildNodeParticleSet],
        ["flow-map", buildNodeParticleSetWithFlowMaps],
        ["noise", buildNodeParticleSetWithNoiseTextures],
        ["combined texture-update", buildNodeParticleSetWithTextureUpdates],
        ["blend-mode", buildNodeParticleSetWithBlendModes],
    ] as Array<[string, NodeParticleBuilder]>)("enables the provider on a set from the %s builder", async (_name, builder) => {
        let providerCalls = 0;
        const set = await builder({} as EngineContext, {} as SceneContext, parseNodeParticleSource(worldPointGraph()));
        const enabled = await enableNodeParticleEmitterProvider(set, () => {
            providerCalls++;
            return emitterMatrix(2, 3, 4);
        });
        const system = set.systems[0]!;
        startParticleSystem(system);
        animateParticleSystem(system, 1);

        expect(enabled).toBe(set);
        expect(providerCalls).toBe(2);
        expect(system.buffer.posX[0]).toBeCloseTo(2);
        expect(system.buffer.posY[0]).toBeCloseTo(3);
        expect(system.buffer.posZ[0]).toBeCloseTo(4);
    });

    it.each([
        ["default", buildNodeParticleSet],
        ["flow-map", buildNodeParticleSetWithFlowMaps],
        ["combined texture-update", buildNodeParticleSetWithTextureUpdates],
    ] as Array<[string, NodeParticleBuilder]>)("retains only emitter state from the %s builder", async (_name, builder) => {
        const set = await builder({} as EngineContext, {} as SceneContext, parseNodeParticleSource(worldPointGraph()));
        const emitterState = set.systems[0]!._emitter!;

        expect(Object.keys(emitterState).sort()).toEqual(["emitter", "emitterInverseWorldMatrices", "emitterWorldMatrix"]);
    });

    it("builds and enables through the convenience builder", async () => {
        const set = await buildNodeParticleSetWithEmitterProvider({} as EngineContext, {} as SceneContext, parseNodeParticleSource(worldPointGraph()), () =>
            emitterMatrix(2, 3, 4)
        );
        const system = set.systems[0]!;
        startParticleSystem(system);
        animateParticleSystem(system, 1);

        expect(system.buffer.posX[0]).toBeCloseTo(2);
        expect(system.buffer.posY[0]).toBeCloseTo(3);
        expect(system.buffer.posZ[0]).toBeCloseTo(4);
    });

    it("enables the provider on an inline snippet set", async () => {
        const set = await parseNodeParticleSetFromSnippet({} as EngineContext, {} as SceneContext, "ignored", { json: worldPointGraph() });
        await enableNodeParticleEmitterProvider(set, () => emitterMatrix(5, 6, 7));
        const system = set.systems[0]!;
        startParticleSystem(system);
        animateParticleSystem(system, 1);

        expect(system.buffer.posX[0]).toBeCloseTo(5);
        expect(system.buffer.posY[0]).toBeCloseTo(6);
        expect(system.buffer.posZ[0]).toBeCloseTo(7);
    });

    it("composes with exact blend-mode registration", async () => {
        const set = await buildNodeParticleSetWithBlendModes({} as EngineContext, {} as SceneContext, parseNodeParticleSource(worldPointGraph()));
        const system = set.systems[0]!;
        const registerBillboard = system._registerBillboard;
        await enableNodeParticleEmitterProvider(set, () => emitterMatrix(2, 3, 4));

        system.blendMode = 4;
        system.texture = {
            texture: {} as GPUTexture,
            view: {} as GPUTextureView,
            sampler: {} as GPUSampler,
            width: 1,
            height: 1,
        } satisfies Texture2D;
        const billboard = createParticleBillboard(system);
        system._registerBillboard!({ _disposables: [], _pickSources: [], _deferredBuilders: [] } as unknown as SceneContext, billboard);
        startParticleSystem(system);
        animateParticleSystem(system, 1);

        expect(system._registerBillboard).toBe(registerBillboard);
        expect(billboard.blendMode._key).toBe("p4");
        expect(billboard._customShader?._key).toBe("particle-multiply");
        expect(system.buffer.posX[0]).toBeCloseTo(2);
        expect(system.buffer.posY[0]).toBeCloseTo(3);
        expect(system.buffer.posZ[0]).toBeCloseTo(4);
    });

    it("does not sample the provider when animation returns before simulation", async () => {
        let providerCalls = 0;
        const system = await buildNodeParticleGraphWithEmitterProvider(worldPointGraph(), () => {
            providerCalls++;
            return emitterMatrix(0, 0, 0);
        });

        animateParticleSystem(system, 1);
        expect(providerCalls).toBe(1);
    });

    it("samples on stopped-but-started drain calls", async () => {
        let providerCalls = 0;
        const system = await buildNodeParticleGraphWithEmitterProvider(worldPointGraph(), () => emitterMatrix(++providerCalls, 0, 0));

        startParticleSystem(system);
        stopParticleSystem(system);
        animateParticleSystem(system, 1);

        expect(providerCalls).toBe(2);
        expect(system.buffer.alive).toBe(0);
    });

    it("uses one coherent provider snapshot per started call across a multi-system set", async () => {
        let providerCalls = 0;
        const set = await buildNodeParticleSet({} as EngineContext, {} as SceneContext, parseNodeParticleSource(multiSystemGraph()));
        await enableNodeParticleEmitterProvider(set, () => emitterMatrix(++providerCalls, 0, 0));
        const first = set.systems[0]!;
        const second = set.systems[1]!;

        startParticleSystem(first);
        startParticleSystem(second);
        animateParticleSystem(first, 1);
        animateParticleSystem(second, 1);

        expect(providerCalls).toBe(3);
        expect(first.buffer.posX[0]).toBeCloseTo(2);
        expect(second.buffer.posX[0]).toBeCloseTo(3);
        expect(first._emitter!.emitter.x).toBe(3);
        expect(second._emitter!.emitter.x).toBe(3);
    });

    it.each([
        ["default", buildNodeParticleSet],
        ["flow-map", buildNodeParticleSetWithFlowMaps],
        ["combined texture-update", buildNodeParticleSetWithTextureUpdates],
    ] as Array<[string, NodeParticleBuilder]>)("refreshes every implicit-cylinder inverse retained by the %s builder", async (_name, builder) => {
        const transformed = emitterMatrix(3, -2, 5, Math.PI / 3, 2, 0.5, 1.5);
        const set = await builder({} as EngineContext, {} as SceneContext, parseNodeParticleSource(multiCylinderGraph()));
        const system = set.systems[0]!;
        const inverseStates = system._emitter!.emitterInverseWorldMatrices!;
        const inverseReferences = inverseStates.map((state) => state.inverse);
        const initialInverseValues = inverseReferences.map((inverse) => Array.from(inverse));

        expect(inverseStates).toHaveLength(2);
        await enableNodeParticleEmitterProvider(set, () => transformed);

        expect(inverseStates[0]!.inverse).toBe(inverseReferences[0]);
        expect(inverseStates[1]!.inverse).toBe(inverseReferences[1]);
        expect(Array.from(inverseStates[0]!.inverse)).not.toEqual(initialInverseValues[0]);
        expect(Array.from(inverseStates[1]!.inverse)).not.toEqual(initialInverseValues[1]);
        expect(Array.from(inverseStates[1]!.inverse)).toEqual(Array.from(inverseStates[0]!.inverse));
    });

    it("lets an enabled provider replace the static matrix while preserving stable references", async () => {
        const staticMatrix = emitterMatrix(1, 2, 3);
        let providedMatrix = emitterMatrix(4, 5, 6);
        const set = await buildNodeParticleSet({} as EngineContext, {} as SceneContext, parseNodeParticleSource(worldPointGraph()), {
            emitterWorldMatrix: staticMatrix,
        });
        const system = set.systems[0]!;
        const emitterState = system._emitter!;
        const stableMatrix = emitterState.emitterWorldMatrix;
        const stableTranslation = emitterState.emitter;

        expect(stableTranslation).toEqual({ x: 1, y: 2, z: 3 });
        await enableNodeParticleEmitterProvider(set, () => providedMatrix);
        expect(emitterState.emitterWorldMatrix).toBe(stableMatrix);
        expect(emitterState.emitter).toBe(stableTranslation);
        expect(stableTranslation).toEqual({ x: 4, y: 5, z: 6 });

        providedMatrix = emitterMatrix(7, 8, 9);
        startParticleSystem(system);
        animateParticleSystem(system, 1);
        expect(stableTranslation).toEqual({ x: 7, y: 8, z: 9 });
    });

    it("atomically replaces the provider when the same set is enabled again", async () => {
        let firstCalls = 0;
        let secondCalls = 0;
        const set = await buildNodeParticleSet({} as EngineContext, {} as SceneContext, parseNodeParticleSource(worldPointGraph()));
        await enableNodeParticleEmitterProvider(set, () => {
            firstCalls++;
            return emitterMatrix(1, 0, 0);
        });

        const replacement = await enableNodeParticleEmitterProvider(set, () => {
            secondCalls++;
            return emitterMatrix(2, 0, 0);
        });
        const system = set.systems[0]!;
        startParticleSystem(system);
        animateParticleSystem(system, 1);

        expect(replacement).toBe(set);
        expect(firstCalls).toBe(1);
        expect(secondCalls).toBe(2);
        expect(system.buffer.posX[0]).toBeCloseTo(2);

        await expect(enableNodeParticleEmitterProvider(set, () => emitterMatrix(Number.NaN, 0, 0))).rejects.toThrow(
            "NodeParticle: emitter provider must return a finite 16-element matrix"
        );
        animateParticleSystem(system, 1);
        expect(secondCalls).toBe(3);
        expect(system.buffer.posX[1]).toBeCloseTo(2);
    });

    it("rejects an empty set before sampling the provider", async () => {
        let providerCalls = 0;
        await expect(
            enableNodeParticleEmitterProvider({ systems: [] } as unknown as NodeParticleSet, () => {
                providerCalls++;
                return emitterMatrix(1, 2, 3);
            })
        ).rejects.toThrow("NodeParticle: emitter provider requires a non-empty built set");

        expect(providerCalls).toBe(0);
    });

    it("rejects a partially enabled set without changing its provider handles or emitter states", async () => {
        let firstCalls = 0;
        let rejectedCalls = 0;
        const enabledSet = await buildNodeParticleSet({} as EngineContext, {} as SceneContext, parseNodeParticleSource(worldPointGraph()));
        const freshSet = await buildNodeParticleSet({} as EngineContext, {} as SceneContext, parseNodeParticleSource(worldPointGraph()));
        await enableNodeParticleEmitterProvider(enabledSet, () => {
            firstCalls++;
            return emitterMatrix(1, 0, 0);
        });
        const enabledSystem = enabledSet.systems[0]!;
        const freshSystem = freshSet.systems[0]!;
        const enabledHandle = enabledSystem._emitterProvider;
        const enabledMatrix = Array.from(enabledSystem._emitter!.emitterWorldMatrix);
        const freshMatrix = Array.from(freshSystem._emitter!.emitterWorldMatrix);
        const mixedSet = { systems: [enabledSystem, freshSystem] } as unknown as NodeParticleSet;

        await expect(
            enableNodeParticleEmitterProvider(mixedSet, () => {
                rejectedCalls++;
                return emitterMatrix(2, 0, 0);
            })
        ).rejects.toThrow("NodeParticle: emitter provider requires consistently enabled systems");

        expect(rejectedCalls).toBe(0);
        expect(enabledSystem._emitterProvider).toBe(enabledHandle);
        expect(freshSystem._emitterProvider).toBeUndefined();
        expect(Array.from(enabledSystem._emitter!.emitterWorldMatrix)).toEqual(enabledMatrix);
        expect(Array.from(freshSystem._emitter!.emitterWorldMatrix)).toEqual(freshMatrix);

        await enableNodeParticleEmitterProvider(enabledSet, () => emitterMatrix(3, 0, 0));
        startParticleSystem(enabledSystem);
        animateParticleSystem(enabledSystem, 1);
        expect(firstCalls).toBe(1);
        expect(enabledSystem.buffer.posX[0]).toBeCloseTo(3);
    });

    it("rejects systems with different provider handles without changing either provider", async () => {
        let firstCalls = 0;
        let secondCalls = 0;
        let rejectedCalls = 0;
        const firstSet = await buildNodeParticleSet({} as EngineContext, {} as SceneContext, parseNodeParticleSource(worldPointGraph()));
        const secondSet = await buildNodeParticleSet({} as EngineContext, {} as SceneContext, parseNodeParticleSource(worldPointGraph()));
        await enableNodeParticleEmitterProvider(firstSet, () => emitterMatrix(++firstCalls, 0, 0));
        await enableNodeParticleEmitterProvider(secondSet, () => emitterMatrix(10 + ++secondCalls, 0, 0));
        const firstSystem = firstSet.systems[0]!;
        const secondSystem = secondSet.systems[0]!;
        const firstHandle = firstSystem._emitterProvider;
        const secondHandle = secondSystem._emitterProvider;
        const firstPrepareFrame = firstSystem._prepareFrame;
        const secondPrepareFrame = secondSystem._prepareFrame;
        const firstMatrix = Array.from(firstSystem._emitter!.emitterWorldMatrix);
        const secondMatrix = Array.from(secondSystem._emitter!.emitterWorldMatrix);

        await expect(
            enableNodeParticleEmitterProvider({ systems: [firstSystem, secondSystem] } as unknown as NodeParticleSet, () => {
                rejectedCalls++;
                return emitterMatrix(100, 0, 0);
            })
        ).rejects.toThrow("NodeParticle: emitter provider requires consistently enabled systems");

        expect(rejectedCalls).toBe(0);
        expect(firstSystem._emitterProvider).toBe(firstHandle);
        expect(secondSystem._emitterProvider).toBe(secondHandle);
        expect(firstSystem._prepareFrame).toBe(firstPrepareFrame);
        expect(secondSystem._prepareFrame).toBe(secondPrepareFrame);
        expect(Array.from(firstSystem._emitter!.emitterWorldMatrix)).toEqual(firstMatrix);
        expect(Array.from(secondSystem._emitter!.emitterWorldMatrix)).toEqual(secondMatrix);
        startParticleSystem(firstSystem);
        startParticleSystem(secondSystem);
        animateParticleSystem(firstSystem, 1);
        animateParticleSystem(secondSystem, 1);
        expect(firstCalls).toBe(2);
        expect(secondCalls).toBe(2);
        expect(firstSystem.buffer.posX[0]).toBeCloseTo(2);
        expect(secondSystem.buffer.posX[0]).toBeCloseTo(12);
    });

    it("propagates provider errors without mutating matrix, translation, inverse, or simulation", async () => {
        const providerError = new Error("provider failed");
        const throwingSet = await buildNodeParticleSet({} as EngineContext, {} as SceneContext, parseNodeParticleSource(worldPointGraph()));
        await expect(
            enableNodeParticleEmitterProvider(throwingSet, () => {
                throw providerError;
            })
        ).rejects.toBe(providerError);

        const shortSet = await buildNodeParticleSet({} as EngineContext, {} as SceneContext, parseNodeParticleSource(worldPointGraph()));
        await expect(enableNodeParticleEmitterProvider(shortSet, () => new Float32Array(15) as unknown as Mat4)).rejects.toThrow(
            "NodeParticle: emitter provider must return a finite 16-element matrix"
        );

        let valid = true;
        const set = await buildNodeParticleSet({} as EngineContext, {} as SceneContext, parseNodeParticleSource(worldCylinderGraph()));
        await enableNodeParticleEmitterProvider(set, () => (valid ? emitterMatrix(2, 3, 4, Math.PI / 4, 2, 0.5, 1.5) : emitterMatrix(Number.NaN, 0, 0)));
        const system = set.systems[0]!;
        const emitterState = system._emitter!;
        const inverse = emitterState.emitterInverseWorldMatrices![0]!.inverse;
        const matrixBefore = Array.from(emitterState.emitterWorldMatrix);
        const translationBefore = { ...emitterState.emitter };
        const inverseBefore = Array.from(inverse);
        valid = false;
        startParticleSystem(system);

        expect(() => animateParticleSystem(system, 1)).toThrow("NodeParticle: emitter provider must return a finite 16-element matrix");
        expect(system.buffer.alive).toBe(0);
        expect(Array.from(emitterState.emitterWorldMatrix)).toEqual(matrixBefore);
        expect(emitterState.emitter).toEqual(translationBefore);
        expect(Array.from(inverse)).toEqual(inverseBefore);
    });
});
