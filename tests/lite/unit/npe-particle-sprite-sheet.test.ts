import { describe, expect, it } from "vitest";
import { SCENE268_NPE_JSON as animations2Graph } from "../../../lab/lite/src/shared/scene268-npe";
import animations2States from "./fixtures/sprite-sheet-states.json";
import animations1Graph from "./fixtures/sprite-sheet-random-npe.json";
import animations1States from "./fixtures/sprite-sheet-random-states.json";
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
    cellIndex: number;
}

type StatesFixture = { N: number; count: number; particles: BjsParticle[] };

function withoutSpriteSetup(graph: unknown): unknown {
    const source = structuredClone(graph) as {
        blocks: Array<{
            customType: string;
            inputs: Array<{ name: string; targetBlockId?: number; targetConnectionName?: string }>;
        }>;
    };
    const setup = source.blocks.find((block) => block.customType === "BABYLON.SetupSpriteSheetBlock")!;
    const update = source.blocks.find((block) => block.customType === "BABYLON.BasicSpriteUpdateBlock")!;
    const setupParticle = setup.inputs.find((input) => input.name === "particle")!;
    const updateParticle = update.inputs.find((input) => input.name === "particle")!;
    updateParticle.targetBlockId = setupParticle.targetBlockId;
    updateParticle.targetConnectionName = setupParticle.targetConnectionName;
    return source;
}

/**
 * CPU determinism test for the sprite-sheet animation blocks (`SetupSpriteSheetBlock` +
 * `BasicSpriteUpdateBlock`), converted from the classic "Particles - Animations" systems. Two variants:
 *   • Animations 2 (#CBXIIX#0): `spriteCellChangeSpeed = 30`, deterministic start cell.
 *   • Animations 1 (#K9LJUG#0): `spriteRandomStartCell` — each particle draws a lazy `random() * lifeTime`
 *     cell offset on its first update, so this also proves the random-draw order matches Babylon.js.
 * For each, builds the graph, seeds `Math.random` like the oracle, steps the simulation, and asserts every
 * particle's motion matches the ground truth to 1e-6 and its integer animation `cellIndex` matches exactly.
 */
const CASES: { name: string; graph: unknown; truth: StatesFixture }[] = [
    { name: "Animations 2 (change speed 30)", graph: animations2Graph, truth: animations2States as StatesFixture },
    { name: "Animations 1 (random start cell)", graph: animations1Graph, truth: animations1States as StatesFixture },
];

describe("NPE sprite-sheet animation — deterministic parity with Babylon.js", () => {
    it("rejects BasicSpriteUpdateBlock without SetupSpriteSheetBlock", async () => {
        const graph = parseNodeParticleSource(withoutSpriteSetup(animations2Graph));
        await expect(buildNodeParticleSet({} as EngineContext, {} as SceneContext, graph)).rejects.toThrow("BasicSpriteUpdateBlock requires SetupSpriteSheetBlock");
    });

    for (const testCase of CASES) {
        it(`${testCase.name} reproduces Babylon.js states (incl. cellIndex) after ${testCase.truth.N} steps`, async () => {
            const graph = parseNodeParticleSource(testCase.graph);
            const set = await buildNodeParticleSet({} as EngineContext, {} as SceneContext, graph, { emitter: { x: 0, y: 0, z: 0 } });
            const system = set.systems[0]!;
            expect(system).toBeTruthy();
            expect(system._spriteSheet, "sprite sheet configured by SetupSpriteSheetBlock").not.toBeNull();

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

            // Particles recycle slots over the run, so sort both sides by id before comparing.
            const truthParticles = testCase.truth.particles.slice().sort((a, b) => a.id - b.id);

            const tol = 1e-6;
            for (let i = 0; i < truthParticles.length; i++) {
                const b = truthParticles[i]!;
                const l = lite[i]!;
                expect(Math.abs(l.position.x - b.position[0]), `${testCase.name} particle ${i} position.x`).toBeLessThan(tol);
                expect(Math.abs(l.position.y - b.position[1]), `${testCase.name} particle ${i} position.y`).toBeLessThan(tol);
                expect(Math.abs(l.position.z - b.position[2]), `${testCase.name} particle ${i} position.z`).toBeLessThan(tol);
                expect(Math.abs(l.size - b.size), `${testCase.name} particle ${i} size`).toBeLessThan(tol);
                expect(Math.abs(l.age - b.age), `${testCase.name} particle ${i} age`).toBeLessThan(tol);
                // The animation-sheet cell index is an integer; it must match exactly.
                expect(l.cellIndex, `${testCase.name} particle ${i} cellIndex`).toBe(b.cellIndex);
            }
        });
    }
});
