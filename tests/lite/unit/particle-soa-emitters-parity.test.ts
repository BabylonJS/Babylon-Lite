import { describe, expect, it } from "vitest";
import pointGraph from "./fixtures/emitter-point-npe.json";
import pointStates from "./fixtures/emitter-point-states.json";
import coneGraph from "./fixtures/emitter-cone-npe.json";
import coneStates from "./fixtures/emitter-cone-states.json";
import cylinderGraph from "./fixtures/emitter-cylinder-npe.json";
import cylinderStates from "./fixtures/emitter-cylinder-states.json";
import meshGraph from "./fixtures/emitter-mesh-npe.json";
import meshStates from "./fixtures/emitter-mesh-states.json";
import directedSphereGraph from "./fixtures/emitter-directed-sphere-npe.json";
import directedSphereStates from "./fixtures/emitter-directed-sphere-states.json";
import hemisphereGraph from "./fixtures/emitter-hemisphere-npe.json";
import hemisphereStates from "./fixtures/emitter-hemisphere-states.json";
import directedCylinderGraph from "./fixtures/emitter-directed-cylinder-npe.json";
import directedCylinderStates from "./fixtures/emitter-directed-cylinder-states.json";
import directedConeGraph from "./fixtures/emitter-directed-cone-npe.json";
import directedConeStates from "./fixtures/emitter-directed-cone-states.json";
import rotatedGraph from "./fixtures/emitter-cylinder-rotated-npe.json";
import rotatedStates from "./fixtures/emitter-cylinder-rotated-states.json";
import { SCENE262_NPE_JSON } from "../../../lab/lite/src/shared/scene262-npe";
import { SCENE263_NPE_JSON } from "../../../lab/lite/src/shared/scene263-npe";
import { parseNodeParticleSource } from "../../../packages/babylon-lite/src/particle/node/npe-parser";
import { buildNodeParticleSet } from "../../../packages/babylon-lite/src/particle/node/npe-build";
import { startParticleSystem, animateParticleSystem } from "../../../packages/babylon-lite/src/particle/particle-system";
import { buildSoaParticleSet } from "../../../packages/babylon-lite/src/particle/soa/npe-build";
import { startSoaSystem, animateSoa } from "../../../packages/babylon-lite/src/particle/soa/animate";
import { column } from "../../../packages/babylon-lite/src/particle/soa/particle-buffer";
import * as C from "../../../packages/babylon-lite/src/particle/soa/columns";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene";
import type { Mat4 } from "../../../packages/babylon-lite/src/math/types";
import { mat4Identity } from "../../../packages/babylon-lite/src/math/mat4-identity";
import { transformCoordinatesToRef } from "../../../packages/babylon-lite/src/math/mat4-transform";

interface ExpectedParticle {
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

interface EmitterFixture {
    N: number;
    count: number;
    particles: ExpectedParticle[];
    emitterMatrix?: number[];
}

const CASES: { name: string; graph: unknown; truth: EmitterFixture; local?: boolean }[] = [
    { name: "point", graph: pointGraph, truth: pointStates as EmitterFixture },
    { name: "cone", graph: coneGraph, truth: coneStates as EmitterFixture },
    { name: "cylinder", graph: cylinderGraph, truth: cylinderStates as EmitterFixture },
    { name: "mesh", graph: meshGraph, truth: meshStates as EmitterFixture },
    { name: "directed-sphere", graph: directedSphereGraph, truth: directedSphereStates as EmitterFixture, local: true },
    { name: "hemisphere", graph: hemisphereGraph, truth: hemisphereStates as EmitterFixture },
    { name: "directed-cylinder", graph: directedCylinderGraph, truth: directedCylinderStates as EmitterFixture, local: true },
    { name: "directed-cone", graph: directedConeGraph, truth: directedConeStates as EmitterFixture },
    { name: "rotated-cylinder", graph: rotatedGraph, truth: rotatedStates as EmitterFixture },
];

interface RawBlock {
    customType: string;
    id: number;
    inputs?: Array<{ name: string; targetBlockId?: number; targetConnectionName?: string }>;
    [key: string]: unknown;
}

interface RawGraph {
    blocks: RawBlock[];
}

function seedRandom(): () => number {
    let seed = 1;
    Math.random = () => {
        const x = Math.sin(seed++) * 10000;
        return x - Math.floor(x);
    };
    return () => seed - 1;
}

async function expectSoaMatchesObject(source: unknown, steps: number, emitterWorldMatrix?: Mat4): Promise<void> {
    const options = { emitter: { x: 0, y: 0, z: 0 }, emitterWorldMatrix };
    const objectGraph = parseNodeParticleSource(source);
    const objectSet = await buildNodeParticleSet({} as EngineContext, {} as SceneContext, objectGraph, options);
    const objectSystem = objectSet.systems[0]!;
    const objectRoot = objectGraph.blocks.get(objectGraph.systemBlockIds[0]!)!;
    if (objectRoot.serialized.isLocal === true) {
        // The compatibility object runtime omits ThinParticleSystem's generic `_CreateIsLocalData` queue
        // item. Restore it in the test oracle: save local position, transform render position, then restore
        // the saved local state before direction creation (which may read LocalPositionUpdated).
        const world = emitterWorldMatrix ?? mat4Identity();
        const createPosition = objectSystem._createPosition;
        const createDirection = objectSystem._createDirection;
        let localX = 0;
        let localY = 0;
        let localZ = 0;
        objectSystem._createPosition = (particle, system) => {
            createPosition?.(particle, system);
            localX = particle.position.x;
            localY = particle.position.y;
            localZ = particle.position.z;
            transformCoordinatesToRef(localX, localY, localZ, world, particle.position);
        };
        objectSystem._createDirection = (particle, system) => {
            particle._localPosition.x = localX;
            particle._localPosition.y = localY;
            particle._localPosition.z = localZ;
            createDirection?.(particle, system);
        };
    }
    const objectDrawCount = seedRandom();
    startParticleSystem(objectSystem);
    for (let i = 0; i < steps; i++) {
        animateParticleSystem(objectSystem, 1);
    }
    const expected = objectSystem._particles.slice().sort((a, b) => a.id - b.id);
    const expectedDraws = objectDrawCount();

    const soaSet = await buildSoaParticleSet({} as EngineContext, {} as SceneContext, parseNodeParticleSource(source), options);
    const soaSystem = soaSet.systems[0]!;
    const soaDrawCount = seedRandom();
    startSoaSystem(soaSystem);
    for (let i = 0; i < steps; i++) {
        animateSoa(soaSystem, 1);
    }

    const buffer = soaSystem.buffer;
    const colorR = column(buffer, C.COL_COLOR_R, Float32Array);
    const colorG = column(buffer, C.COL_COLOR_G, Float32Array);
    const colorB = column(buffer, C.COL_COLOR_B, Float32Array);
    const colorA = column(buffer, C.COL_COLOR_A, Float32Array);
    const size = column(buffer, C.COL_SIZE, Float32Array);
    const scaleX = column(buffer, C.COL_SCALE_X, Float32Array);
    const scaleY = column(buffer, C.COL_SCALE_Y, Float32Array);
    const angle = column(buffer, C.COL_ANGLE, Float32Array);
    const indices = Array.from({ length: buffer.alive }, (_, i) => i).sort((a, b) => buffer.id[a]! - buffer.id[b]!);
    expect(indices).toHaveLength(expected.length);
    expect(soaDrawCount()).toBe(expectedDraws);
    const tolerance = 1e-4;
    for (let i = 0; i < expected.length; i++) {
        const particle = expected[i]!;
        const index = indices[i]!;
        expect(buffer.id[index]).toBe(particle.id);
        expect(Math.abs(buffer.posX[index]! - particle.position.x)).toBeLessThan(tolerance);
        expect(Math.abs(buffer.posY[index]! - particle.position.y)).toBeLessThan(tolerance);
        expect(Math.abs(buffer.posZ[index]! - particle.position.z)).toBeLessThan(tolerance);
        expect(Math.abs(buffer.dirX[index]! - particle.direction.x)).toBeLessThan(tolerance);
        expect(Math.abs(buffer.dirY[index]! - particle.direction.y)).toBeLessThan(tolerance);
        expect(Math.abs(buffer.dirZ[index]! - particle.direction.z)).toBeLessThan(tolerance);
        expect(Math.abs(colorR[index]! - particle.color.r)).toBeLessThan(tolerance);
        expect(Math.abs(colorG[index]! - particle.color.g)).toBeLessThan(tolerance);
        expect(Math.abs(colorB[index]! - particle.color.b)).toBeLessThan(tolerance);
        expect(Math.abs(colorA[index]! - particle.color.a)).toBeLessThan(tolerance);
        expect(Math.abs(size[index]! - particle.size)).toBeLessThan(tolerance);
        expect(Math.abs(scaleX[index]! - particle.scale.x)).toBeLessThan(tolerance);
        expect(Math.abs(scaleY[index]! - particle.scale.y)).toBeLessThan(tolerance);
        expect(Math.abs(angle[index]! - particle.angle)).toBeLessThan(tolerance);
        expect(Math.abs(buffer.age[index]! - particle.age)).toBeLessThan(tolerance);
        expect(Math.abs(buffer.lifeTime[index]! - particle.lifeTime)).toBeLessThan(tolerance);
    }
}

function makeLocal(source: unknown): RawGraph {
    const local = structuredClone(source) as RawGraph;
    const system = local.blocks.find((block) => block.customType === "BABYLON.SystemBlock")!;
    const updatePosition = local.blocks.find((block) => block.customType === "BABYLON.UpdatePositionBlock")!;
    const nextId = Math.max(...local.blocks.map((block) => block.id)) + 1;
    system.isLocal = true;
    local.blocks.push({
        customType: "BABYLON.ParticleInputBlock",
        id: nextId,
        inputs: [],
        type: 8,
        contextualValue: 24,
        systemSource: 0,
        valueType: "BABYLON.Vector3",
    });
    const position = updatePosition.inputs!.find((input) => input.name === "position")!;
    position.targetBlockId = nextId;
    position.targetConnectionName = "output";
    return local;
}

describe("SoA NPE emitter shapes — deterministic parity with Babylon.js", () => {
    for (const testCase of CASES) {
        it(`${testCase.name} reproduces Babylon.js states after ${testCase.truth.N} steps`, async () => {
            const graph = parseNodeParticleSource(testCase.graph);
            const emitterWorldMatrix = testCase.truth.emitterMatrix ? (new Float32Array(testCase.truth.emitterMatrix) as unknown as Mat4) : undefined;
            const set = await buildSoaParticleSet({} as EngineContext, {} as SceneContext, graph, {
                emitter: { x: 0, y: 0, z: 0 },
                emitterWorldMatrix,
            });
            const system = set.systems[0]!;
            expect(system.buffer._columns.has("localPosition.x"), `${testCase.name} local-position allocation`).toBe(testCase.local === true);
            expect(system.buffer._columns.has("localPosition.y"), `${testCase.name} local-position allocation`).toBe(testCase.local === true);
            expect(system.buffer._columns.has("localPosition.z"), `${testCase.name} local-position allocation`).toBe(testCase.local === true);

            seedRandom();

            startSoaSystem(system);
            for (let i = 0; i < testCase.truth.N; i++) {
                animateSoa(system, 1);
            }

            const buffer = system.buffer;
            const size = column(buffer, C.COL_SIZE, Float32Array);
            const scaleX = column(buffer, C.COL_SCALE_X, Float32Array);
            const scaleY = column(buffer, C.COL_SCALE_Y, Float32Array);
            const angle = column(buffer, C.COL_ANGLE, Float32Array);
            const colorR = column(buffer, C.COL_COLOR_R, Float32Array);
            const colorG = column(buffer, C.COL_COLOR_G, Float32Array);
            const colorB = column(buffer, C.COL_COLOR_B, Float32Array);
            const colorA = column(buffer, C.COL_COLOR_A, Float32Array);
            const indices = Array.from({ length: buffer.alive }, (_, i) => i).sort((a, b) => buffer.id[a]! - buffer.id[b]!);
            const expected = testCase.truth.particles.slice().sort((a, b) => a.id - b.id);
            expect(indices.length, `${testCase.name} particle count`).toBe(testCase.truth.count);

            const tolerance = 1e-4;
            const idOffset = expected[0]!.id - buffer.id[indices[0]!]!;
            for (let i = 0; i < expected.length; i++) {
                const actualIndex = indices[i]!;
                const particle = expected[i]!;
                // Several oracle fixtures were captured in one Babylon.js process, whose particle IDs use
                // a process-global counter. A constant offset preserves the per-system birth/recycle order.
                expect(buffer.id[actualIndex]! + idOffset, `${testCase.name} particle ${i} id order`).toBe(particle.id);
                expect(Math.abs(buffer.posX[actualIndex]! - particle.position[0]), `${testCase.name} particle ${i} position.x`).toBeLessThan(tolerance);
                expect(Math.abs(buffer.posY[actualIndex]! - particle.position[1]), `${testCase.name} particle ${i} position.y`).toBeLessThan(tolerance);
                expect(Math.abs(buffer.posZ[actualIndex]! - particle.position[2]), `${testCase.name} particle ${i} position.z`).toBeLessThan(tolerance);
                expect(Math.abs(buffer.dirX[actualIndex]! - particle.direction[0]), `${testCase.name} particle ${i} direction.x`).toBeLessThan(tolerance);
                expect(Math.abs(buffer.dirY[actualIndex]! - particle.direction[1]), `${testCase.name} particle ${i} direction.y`).toBeLessThan(tolerance);
                expect(Math.abs(buffer.dirZ[actualIndex]! - particle.direction[2]), `${testCase.name} particle ${i} direction.z`).toBeLessThan(tolerance);
                expect(Math.abs(colorR[actualIndex]! - particle.color[0]), `${testCase.name} particle ${i} color.r`).toBeLessThan(tolerance);
                expect(Math.abs(colorG[actualIndex]! - particle.color[1]), `${testCase.name} particle ${i} color.g`).toBeLessThan(tolerance);
                expect(Math.abs(colorB[actualIndex]! - particle.color[2]), `${testCase.name} particle ${i} color.b`).toBeLessThan(tolerance);
                expect(Math.abs(colorA[actualIndex]! - particle.color[3]), `${testCase.name} particle ${i} color.a`).toBeLessThan(tolerance);
                expect(Math.abs(size[actualIndex]! - particle.size), `${testCase.name} particle ${i} size`).toBeLessThan(tolerance);
                expect(Math.abs(scaleX[actualIndex]! - particle.scale[0]), `${testCase.name} particle ${i} scale.x`).toBeLessThan(tolerance);
                expect(Math.abs(scaleY[actualIndex]! - particle.scale[1]), `${testCase.name} particle ${i} scale.y`).toBeLessThan(tolerance);
                expect(Math.abs(angle[actualIndex]! - particle.angle), `${testCase.name} particle ${i} angle`).toBeLessThan(tolerance);
                expect(Math.abs(buffer.age[actualIndex]! - particle.age), `${testCase.name} particle ${i} age`).toBeLessThan(tolerance);
                expect(Math.abs(buffer.lifeTime[actualIndex]! - particle.lifeTime), `${testCase.name} particle ${i} lifetime`).toBeLessThan(tolerance);
            }
        });
    }

    it("mesh vertex colors own the birth color when enabled", async () => {
        const source = structuredClone(meshGraph) as {
            blocks: Array<{
                customType: string;
                useMeshColorForColor?: boolean;
                cachedVertexData?: { positions?: number[]; colors?: number[] };
            }>;
        };
        const shape = source.blocks.find((block) => block.customType === "BABYLON.MeshShapeBlock")!;
        const vertexCount = shape.cachedVertexData!.positions!.length / 3;
        shape.cachedVertexData!.colors = Array.from({ length: vertexCount }, (_, i) => [i / vertexCount, (i % 3) / 2, (i % 5) / 4, 1]).flat();
        shape.useMeshColorForColor = true;

        await expectSoaMatchesObject(source, 20);

        const graph = parseNodeParticleSource(source);
        const set = await buildSoaParticleSet({} as EngineContext, {} as SceneContext, graph, { emitter: { x: 0, y: 0, z: 0 } });
        const system = set.systems[0]!;
        expect(system.createColor).toBeNull();

        seedRandom();
        startSoaSystem(system);
        animateSoa(system, 1);

        expect(system.buffer.alive).toBe(1);
        expect(column(system.buffer, C.COL_COLOR_A, Float32Array)[0]).toBeCloseTo(1);
    });

    it("copies a shared volatile direction bound before evaluating the second port", async () => {
        const source = structuredClone(pointGraph) as RawGraph;
        const shape = source.blocks.find((block) => block.customType === "BABYLON.PointShapeBlock")!;
        const nextId = Math.max(...source.blocks.map((block) => block.id)) + 1;
        source.blocks.push(
            {
                customType: "BABYLON.ParticleInputBlock",
                id: nextId,
                inputs: [],
                type: 8,
                contextualValue: 0,
                systemSource: 0,
                valueType: "BABYLON.Vector3",
                value: [-2, -1, 0],
            },
            {
                customType: "BABYLON.ParticleInputBlock",
                id: nextId + 1,
                inputs: [],
                type: 8,
                contextualValue: 0,
                systemSource: 0,
                valueType: "BABYLON.Vector3",
                value: [2, 3, 4],
            },
            {
                customType: "BABYLON.ParticleRandomBlock",
                id: nextId + 2,
                inputs: [
                    { name: "min", targetBlockId: nextId, targetConnectionName: "output" },
                    { name: "max", targetBlockId: nextId + 1, targetConnectionName: "output" },
                ],
                lockMode: 0,
            }
        );
        for (const name of ["direction1", "direction2"]) {
            const input = shape.inputs!.find((candidate) => candidate.name === name)!;
            input.targetBlockId = nextId + 2;
            input.targetConnectionName = "output";
        }

        await expectSoaMatchesObject(source, 8);
    });

    it("seeds source 24 correctly when it builds before the local shape", async () => {
        const source = structuredClone(directedSphereGraph) as RawGraph;
        const shape = source.blocks.find((block) => block.customType === "BABYLON.SphereShapeBlock")!;
        const localPosition = source.blocks.find((block) => block.customType === "BABYLON.ParticleInputBlock" && block.contextualValue === 24)!;
        for (const name of ["direction1", "direction2"]) {
            const input = shape.inputs!.find((candidate) => candidate.name === name)!;
            input.targetBlockId = localPosition.id;
            input.targetConnectionName = "output";
        }
        const emitterWorldMatrix = new Float32Array((rotatedStates as EmitterFixture).emitterMatrix!) as unknown as Mat4;

        await expectSoaMatchesObject(source, 40, emitterWorldMatrix);
    });

    it("rejects source 24 when position creation reads it before the local seed", async () => {
        const source = structuredClone(directedSphereGraph) as RawGraph;
        const shape = source.blocks.find((block) => block.customType === "BABYLON.SphereShapeBlock")!;
        const localPosition = source.blocks.find((block) => block.customType === "BABYLON.ParticleInputBlock" && block.contextualValue === 24)!;
        const radius = shape.inputs!.find((input) => input.name === "radius")!;
        radius.targetBlockId = localPosition.id;
        radius.targetConnectionName = "output";

        const set = await buildSoaParticleSet({} as EngineContext, {} as SceneContext, parseNodeParticleSource(source));
        const system = set.systems[0]!;
        system.emitRate = 1000;
        seedRandom();
        startSoaSystem(system);
        expect(() => animateSoa(system, 1)).toThrow("LocalPositionUpdated read before local shape position creation");
    });

    it("leaves InitialDirection at zero for mesh-normal emission", async () => {
        const source = structuredClone(meshGraph) as RawGraph;
        const system = source.blocks.find((block) => block.customType === "BABYLON.SystemBlock")!;
        const shape = source.blocks.find((block) => block.customType === "BABYLON.MeshShapeBlock")!;
        const nextId = Math.max(...source.blocks.map((block) => block.id)) + 1;
        const particleInput = system.inputs!.find((input) => input.name === "particle")!;
        const previousParticleBlockId = particleInput.targetBlockId!;
        const previousParticleOutput = particleInput.targetConnectionName!;
        source.blocks.push(
            {
                customType: "BABYLON.ParticleInputBlock",
                id: nextId,
                inputs: [],
                type: 8,
                contextualValue: 21,
                systemSource: 0,
                valueType: "BABYLON.Vector3",
            },
            {
                customType: "BABYLON.UpdateDirectionBlock",
                id: nextId + 1,
                inputs: [
                    { name: "particle", targetBlockId: previousParticleBlockId, targetConnectionName: previousParticleOutput },
                    { name: "direction", targetBlockId: nextId, targetConnectionName: "output" },
                ],
            }
        );
        particleInput.targetBlockId = nextId + 1;
        particleInput.targetConnectionName = "output";
        const directionInput = shape.inputs!.find((input) => input.name === "direction1")!;
        directionInput.targetBlockId = nextId;
        directionInput.targetConnectionName = "output";

        await expectSoaMatchesObject(source, 20);
    });

    it.each([
        ["box", SCENE262_NPE_JSON],
        ["point", pointGraph],
        ["sphere", SCENE263_NPE_JSON],
        ["cone", coneGraph],
        ["cylinder", cylinderGraph],
        ["mesh", meshGraph],
    ])("matches transformed local-space %s emission", async (_name, source) => {
        const emitterWorldMatrix = new Float32Array((rotatedStates as EmitterFixture).emitterMatrix!) as unknown as Mat4;
        await expectSoaMatchesObject(makeLocal(source), 40, emitterWorldMatrix);
    });
});
