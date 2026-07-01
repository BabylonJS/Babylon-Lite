import { describe, expect, it } from "vitest";
import pointGraph from "./fixtures/emitter-point-npe.json";
import pointStates from "./fixtures/emitter-point-states.json";
import coneGraph from "./fixtures/emitter-cone-npe.json";
import coneStates from "./fixtures/emitter-cone-states.json";
import cylinderGraph from "./fixtures/emitter-cylinder-npe.json";
import cylinderStates from "./fixtures/emitter-cylinder-states.json";
import meshGraph from "./fixtures/emitter-mesh-npe.json";
import meshStates from "./fixtures/emitter-mesh-states.json";
import { parseNodeParticleSource } from "../../../packages/babylon-lite/src/particle/node/npe-parser";
import { buildNodeParticleSet } from "../../../packages/babylon-lite/src/particle/node/npe-build";
import { startParticleSystem, animateParticleSystem } from "../../../packages/babylon-lite/src/particle/particle-system";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene";

interface BjsParticle {
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

type StatesFixture = { N: number; count: number; particles: BjsParticle[] };

const CASES: { name: string; graph: unknown; truth: StatesFixture }[] = [
    { name: "point", graph: pointGraph, truth: pointStates as StatesFixture },
    { name: "cone", graph: coneGraph, truth: coneStates as StatesFixture },
    { name: "cylinder", graph: cylinderGraph, truth: cylinderStates as StatesFixture },
    { name: "mesh", graph: meshGraph, truth: meshStates as StatesFixture },
];

/**
 * CPU determinism test for the emitter shape blocks (`PointShapeBlock`, `ConeShapeBlock`,
 * `CylinderShapeBlock`, `MeshShapeBlock`). For each emitter, builds the graph converted from the classic
 * `createXEmitter` system (the mesh graph carries baked `cachedVertexData`, as the NPE editor produces),
 * seeds Math.random like the Babylon.js oracle, steps the simulation, and asserts every particle's state
 * matches the committed Babylon.js ground truth to 1e-6 — proving the shape-specific position/direction
 * random-draw sequence matches BJS. (Box + Sphere are covered by Scenes 262/263.)
 */
describe("NPE emitter shapes — deterministic parity with Babylon.js", () => {
    for (const testCase of CASES) {
        it(`${testCase.name} emitter reproduces Babylon.js states after ${testCase.truth.N} steps`, async () => {
            const graph = parseNodeParticleSource(testCase.graph);
            const set = await buildNodeParticleSet({} as EngineContext, {} as SceneContext, graph, { emitter: { x: 0, y: 0, z: 0 } });
            const system = set.systems[0]!;
            expect(system).toBeTruthy();

            let seed = 1;
            Math.random = () => {
                const x = Math.sin(seed++) * 10000;
                return x - Math.floor(x);
            };

            startParticleSystem(system);
            for (let i = 0; i < testCase.truth.N; i++) {
                animateParticleSystem(system, 1);
            }

            const lite = system._particles.slice().sort((a, b) => a.id - b.id);
            expect(lite.length, `${testCase.name} particle count`).toBe(testCase.truth.count);

            const tol = 1e-6;
            for (let i = 0; i < testCase.truth.particles.length; i++) {
                const b = testCase.truth.particles[i]!;
                const l = lite[i]!;
                expect(Math.abs(l.position.x - b.position[0]), `${testCase.name} particle ${i} position.x`).toBeLessThan(tol);
                expect(Math.abs(l.position.y - b.position[1]), `${testCase.name} particle ${i} position.y`).toBeLessThan(tol);
                expect(Math.abs(l.position.z - b.position[2]), `${testCase.name} particle ${i} position.z`).toBeLessThan(tol);
                expect(Math.abs(l.direction.x - b.direction[0]), `${testCase.name} particle ${i} direction.x`).toBeLessThan(tol);
                expect(Math.abs(l.direction.y - b.direction[1]), `${testCase.name} particle ${i} direction.y`).toBeLessThan(tol);
                expect(Math.abs(l.direction.z - b.direction[2]), `${testCase.name} particle ${i} direction.z`).toBeLessThan(tol);
                expect(Math.abs(l.size - b.size), `${testCase.name} particle ${i} size`).toBeLessThan(tol);
                expect(Math.abs(l.angle - b.angle), `${testCase.name} particle ${i} angle`).toBeLessThan(tol);
                expect(Math.abs(l.age - b.age), `${testCase.name} particle ${i} age`).toBeLessThan(tol);
            }
        });
    }
});
