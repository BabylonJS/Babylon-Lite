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
import { startParticleSystem, stopParticleSystem, animateParticleSystem } from "../../../packages/babylon-lite/src/particle/particle-system";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene";
import type { Mat4 } from "../../../packages/babylon-lite/src/math/types";
import { transformCoordinatesToRef, transformNormalToRef } from "../../../packages/babylon-lite/src/math/mat4-transform";
import { buildNodeParticleGraph, simulateNodeParticleGraph, snapshotParticles } from "./particle-test-utils";

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

function seedRandom(): () => void {
    const previousRandom = Math.random;
    let seed = 1;
    Math.random = () => {
        const x = Math.sin(seed++) * 10000;
        return x - Math.floor(x);
    };
    return () => {
        Math.random = previousRandom;
    };
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

async function expectTransformedLocalMatchesIdentity(source: unknown, steps: number, emitterWorldMatrix: Mat4, worldOrientedBirthDirection: boolean): Promise<void> {
    const localSource = makeLocal(source);
    const identitySystem = await simulateNodeParticleGraph(localSource, steps, { emitter: { x: 0, y: 0, z: 0 } });
    const transformedSystem = await simulateNodeParticleGraph(localSource, steps, { emitterWorldMatrix });
    const identity = snapshotParticles(identitySystem);
    const transformed = snapshotParticles(transformedSystem);
    expect(transformed).toHaveLength(identity.length);

    const expectedPosition = { x: 0, y: 0, z: 0 };
    const expectedDirection = { x: 0, y: 0, z: 0 };
    const transformedIndices = new Map<number, number>();
    for (let index = 0; index < transformedSystem.buffer.alive; index++) {
        transformedIndices.set(transformedSystem.buffer.id[index]!, index);
    }
    const transformedLocalX = transformedSystem.buffer._columns.get("localPosition.x")!;
    const transformedLocalY = transformedSystem.buffer._columns.get("localPosition.y")!;
    const transformedLocalZ = transformedSystem.buffer._columns.get("localPosition.z")!;
    const tolerance = 1e-4;
    for (let index = 0; index < identity.length; index++) {
        const localParticle = identity[index]!;
        const worldParticle = transformed[index]!;
        if (worldOrientedBirthDirection) {
            const transformedIndex = transformedIndices.get(worldParticle.id)!;
            transformCoordinatesToRef(
                transformedLocalX[transformedIndex]!,
                transformedLocalY[transformedIndex]!,
                transformedLocalZ[transformedIndex]!,
                emitterWorldMatrix,
                expectedPosition
            );
        } else {
            transformCoordinatesToRef(localParticle.position.x, localParticle.position.y, localParticle.position.z, emitterWorldMatrix, expectedPosition);
            expectedDirection.x = localParticle.direction.x;
            expectedDirection.y = localParticle.direction.y;
            expectedDirection.z = localParticle.direction.z;
        }
        expect(worldParticle.id).toBe(localParticle.id);
        expect(Math.abs(worldParticle.position.x - expectedPosition.x)).toBeLessThan(tolerance);
        expect(Math.abs(worldParticle.position.y - expectedPosition.y)).toBeLessThan(tolerance);
        expect(Math.abs(worldParticle.position.z - expectedPosition.z)).toBeLessThan(tolerance);
        if (worldOrientedBirthDirection) {
            transformNormalToRef(localParticle.direction.x, localParticle.direction.y, localParticle.direction.z, emitterWorldMatrix, expectedDirection);
            expect(Math.abs(worldParticle.direction.x - expectedDirection.x)).toBeLessThan(tolerance);
            expect(Math.abs(worldParticle.direction.y - expectedDirection.y)).toBeLessThan(tolerance);
            expect(Math.abs(worldParticle.direction.z - expectedDirection.z)).toBeLessThan(tolerance);
        } else {
            expect(Math.abs(worldParticle.direction.x - expectedDirection.x)).toBeLessThan(tolerance);
            expect(Math.abs(worldParticle.direction.y - expectedDirection.y)).toBeLessThan(tolerance);
            expect(Math.abs(worldParticle.direction.z - expectedDirection.z)).toBeLessThan(tolerance);
        }
        expect(worldParticle.color).toEqual(localParticle.color);
        expect(worldParticle.size).toBe(localParticle.size);
        expect(worldParticle.scale).toEqual(localParticle.scale);
        expect(worldParticle.angle).toBe(localParticle.angle);
        expect(worldParticle.age).toBe(localParticle.age);
        expect(worldParticle.lifeTime).toBe(localParticle.lifeTime);
    }
}

describe("NPE emitter shapes — deterministic parity with Babylon.js", () => {
    for (const testCase of CASES) {
        it(`${testCase.name} reproduces Babylon.js states after ${testCase.truth.N} steps`, async () => {
            const graph = parseNodeParticleSource(testCase.graph);
            const emitterWorldMatrix = testCase.truth.emitterMatrix ? (new Float32Array(testCase.truth.emitterMatrix) as unknown as Mat4) : undefined;
            const set = await buildNodeParticleSet({} as EngineContext, {} as SceneContext, graph, {
                emitter: { x: 0, y: 0, z: 0 },
                emitterWorldMatrix,
            });
            const system = set.systems[0]!;
            expect(system.buffer._columns.has("localPosition.x"), `${testCase.name} local-position allocation`).toBe(testCase.local === true);
            expect(system.buffer._columns.has("localPosition.y"), `${testCase.name} local-position allocation`).toBe(testCase.local === true);
            expect(system.buffer._columns.has("localPosition.z"), `${testCase.name} local-position allocation`).toBe(testCase.local === true);

            const restoreRandom = seedRandom();
            try {
                startParticleSystem(system);
                for (let i = 0; i < testCase.truth.N; i++) {
                    animateParticleSystem(system, 1);
                }
            } finally {
                restoreRandom();
            }

            const buffer = system.buffer;
            const size = buffer.size;
            const scaleX = buffer.scaleX;
            const scaleY = buffer.scaleY;
            const angle = buffer.angle;
            const colorR = buffer.colorR;
            const colorG = buffer.colorG;
            const colorB = buffer.colorB;
            const colorA = buffer.colorA;
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

        const graph = parseNodeParticleSource(source);
        const set = await buildNodeParticleSet({} as EngineContext, {} as SceneContext, graph, { emitter: { x: 0, y: 0, z: 0 } });
        const system = set.systems[0]!;
        expect(system.createColor).toBeNull();

        const restoreRandom = seedRandom();
        try {
            startParticleSystem(system);
            animateParticleSystem(system, 1);
        } finally {
            restoreRandom();
        }

        expect(system.buffer.alive).toBe(1);
        expect(system.buffer.colorR[0]).toBeLessThan(1);
        expect(system.buffer.colorG[0]).toBeGreaterThanOrEqual(0);
        expect(system.buffer.colorB[0]).toBeGreaterThanOrEqual(0);
        expect(system.buffer.colorA[0]).toBeCloseTo(1);
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

        const system = await buildNodeParticleGraph(source, { emitter: { x: 0, y: 0, z: 0 } });
        const draws = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
        let drawIndex = 0;
        const previousRandom = Math.random;
        Math.random = () => draws[drawIndex++]!;
        try {
            system.createDirection!(0);
        } finally {
            Math.random = previousRandom;
        }

        const between = (min: number, max: number, ratio: number): number => min + ratio * (max - min);
        const first = [between(-2, 2, draws[0]!), between(-1, 3, draws[1]!), between(0, 4, draws[2]!)];
        const second = [between(-2, 2, draws[3]!), between(-1, 3, draws[4]!), between(0, 4, draws[5]!)];
        expect(drawIndex).toBe(9);
        expect(system.buffer.dirX[0]).toBeCloseTo(between(first[0]!, second[0]!, draws[6]!), 6);
        expect(system.buffer.dirY[0]).toBeCloseTo(between(first[1]!, second[1]!, draws[7]!), 6);
        expect(system.buffer.dirZ[0]).toBeCloseTo(between(first[2]!, second[2]!, draws[8]!), 6);
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

        const system = await buildNodeParticleGraph(source, { emitterWorldMatrix });
        const previousRandom = Math.random;
        let seed = 1;
        Math.random = () => {
            const value = Math.sin(seed++) * 10000;
            return value - Math.floor(value);
        };
        try {
            system.buffer.id[0] = 7;
            system.createPosition!(0);
            system.createDirection!(0);
        } finally {
            Math.random = previousRandom;
        }

        expect(system.buffer._columns.get("localPosition.valid")![0]).toBe(1);
        expect(system.buffer._columns.get("localPosition.id")![0]).toBe(7);
        expect(system.buffer.dirX[0]).toBeCloseTo(system.buffer.posX[0]!, 6);
        expect(system.buffer.dirY[0]).toBeCloseTo(system.buffer.posY[0]!, 6);
        expect(system.buffer.dirZ[0]).toBeCloseTo(system.buffer.posZ[0]!, 6);
    });

    it("rejects source 24 when position creation reads it before the local seed", async () => {
        const source = structuredClone(directedSphereGraph) as RawGraph;
        const shape = source.blocks.find((block) => block.customType === "BABYLON.SphereShapeBlock")!;
        const localPosition = source.blocks.find((block) => block.customType === "BABYLON.ParticleInputBlock" && block.contextualValue === 24)!;
        const radius = shape.inputs!.find((input) => input.name === "radius")!;
        radius.targetBlockId = localPosition.id;
        radius.targetConnectionName = "output";

        const set = await buildNodeParticleSet({} as EngineContext, {} as SceneContext, parseNodeParticleSource(source));
        const system = set.systems[0]!;
        system.emitRate = 1000;
        const restoreRandom = seedRandom();
        try {
            startParticleSystem(system);
            expect(() => animateParticleSystem(system, 1)).toThrow("LocalPositionUpdated read before local shape position creation");
        } finally {
            restoreRandom();
        }
    });

    it("rejects source 24 on a non-local particle system during build", async () => {
        const source = structuredClone(directedSphereGraph) as RawGraph;
        const system = source.blocks.find((block) => block.customType === "BABYLON.SystemBlock")!;
        system.isLocal = false;

        await expect(buildNodeParticleSet({} as EngineContext, {} as SceneContext, parseNodeParticleSource(source))).rejects.toThrow(
            "LocalPositionUpdated requires SystemBlock.isLocal"
        );
    });

    it("leaves InitialDirection at zero for mesh-normal emission", async () => {
        const source = structuredClone(meshGraph) as RawGraph;
        const systemBlock = source.blocks.find((block) => block.customType === "BABYLON.SystemBlock")!;
        const shape = source.blocks.find((block) => block.customType === "BABYLON.MeshShapeBlock")!;
        const nextId = Math.max(...source.blocks.map((block) => block.id)) + 1;
        const particleInput = systemBlock.inputs!.find((input) => input.name === "particle")!;
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

        const system = await simulateNodeParticleGraph(source, 20, { emitter: { x: 0, y: 0, z: 0 } });
        // Update final-frame births once without creating replacements so UpdateDirection reads InitialDirection.
        stopParticleSystem(system);
        animateParticleSystem(system, 1);
        for (const particle of snapshotParticles(system)) {
            expect(particle.direction.x).toBe(0);
            expect(particle.direction.y).toBe(0);
            expect(particle.direction.z).toBe(0);
        }
    });

    it.each([
        ["box", SCENE262_NPE_JSON, false],
        ["point", pointGraph, false],
        ["sphere", SCENE263_NPE_JSON, true],
        ["cone", coneGraph, true],
        ["cylinder", cylinderGraph, false],
        ["mesh", meshGraph, false],
    ])("matches transformed local-space %s emission", async (_name, source, worldOrientedBirthDirection) => {
        const emitterWorldMatrix = new Float32Array((rotatedStates as EmitterFixture).emitterMatrix!) as unknown as Mat4;
        await expectTransformedLocalMatchesIdentity(source, 40, emitterWorldMatrix, worldOrientedBirthDirection);
    });
});
