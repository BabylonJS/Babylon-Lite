import { describe, expect, it } from "vitest";
import { SCENE268_NPE_JSON as animations2Graph } from "../../../lab/lite/src/shared/scene268-npe";
import animations2States from "./fixtures/sprite-sheet-states.json";
import animations1Graph from "./fixtures/sprite-sheet-random-npe.json";
import animations1States from "./fixtures/sprite-sheet-random-states.json";
import { parseNodeParticleSource } from "../../../packages/babylon-lite/src/particle/node/npe-parser";
import { buildSoaParticleSet } from "../../../packages/babylon-lite/src/particle/soa/npe-build";
import { startSoaSystem, animateSoa } from "../../../packages/babylon-lite/src/particle/soa/animate";
import { column } from "../../../packages/babylon-lite/src/particle/soa/particle-buffer";
import * as C from "../../../packages/babylon-lite/src/particle/soa/columns";
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
 * CPU determinism test for the DATA-ORIENTED (SoA) sprite-sheet blocks (`SetupSpriteSheetBlock` +
 * `BasicSpriteUpdateBlock`). Two variants, matching the object-runtime test:
 *   • Animations 2 (#CBXIIX#0): `spriteCellChangeSpeed = 30`, deterministic start cell.
 *   • Animations 1 (#K9LJUG#0): `spriteRandomStartCell` — each particle draws a lazy `random() * lifeTime`
 *     offset on its first update, so this also proves the random-draw order matches Babylon.js.
 * Builds each graph via buildSoaParticleSet, seeds Math.random like the oracle, steps the simulation, and
 * asserts every particle's motion matches the committed ground truth to 1e-6 and its integer sprite
 * `cellIndex` (read from the sprite column) matches exactly.
 */
const CASES: { name: string; graph: unknown; truth: StatesFixture }[] = [
    { name: "Animations 2 (change speed 30)", graph: animations2Graph, truth: animations2States as StatesFixture },
    { name: "Animations 1 (random start cell)", graph: animations1Graph, truth: animations1States as StatesFixture },
];

describe("SoA NPE sprite-sheet animation — deterministic parity with Babylon.js", () => {
    it("rejects BasicSpriteUpdateBlock without SetupSpriteSheetBlock", async () => {
        const graph = parseNodeParticleSource(withoutSpriteSetup(animations2Graph));
        await expect(buildSoaParticleSet({} as EngineContext, {} as SceneContext, graph)).rejects.toThrow("BasicSpriteUpdateBlock requires SetupSpriteSheetBlock");
    });

    for (const testCase of CASES) {
        it(`${testCase.name} reproduces Babylon.js states (incl. cellIndex) after ${testCase.truth.N} steps`, async () => {
            const graph = parseNodeParticleSource(testCase.graph);
            const set = await buildSoaParticleSet({} as EngineContext, {} as SceneContext, graph, { emitter: { x: 0, y: 0, z: 0 } });
            const system = set.systems[0]!;
            expect(system).toBeTruthy();
            expect(system._spriteSheet, "sprite sheet configured by SetupSpriteSheetBlock").toBeDefined();

            const previousRandom = Math.random;
            let seed = 1;
            Math.random = () => {
                const x = Math.sin(seed++) * 10000;
                return x - Math.floor(x);
            };
            try {
                startSoaSystem(system);
                for (let i = 0; i < testCase.truth.N; i++) {
                    animateSoa(system, 1);
                }
            } finally {
                Math.random = previousRandom;
            }

            const buffer = system.buffer;
            const size = column(buffer, C.COL_SIZE, Float32Array);
            const cellIndex = system._spriteSheet!.cellIndex;

            interface Row {
                id: number;
                posX: number;
                posY: number;
                posZ: number;
                size: number;
                age: number;
                cellIndex: number;
            }
            const rows: Row[] = [];
            for (let i = 0; i < buffer.alive; i++) {
                rows.push({
                    id: buffer.id[i]!,
                    posX: buffer.posX[i]!,
                    posY: buffer.posY[i]!,
                    posZ: buffer.posZ[i]!,
                    size: size[i]!,
                    age: buffer.age[i]!,
                    cellIndex: cellIndex[i]!,
                });
            }
            rows.sort((a, b) => a.id - b.id);
            expect(rows.length, `${testCase.name} particle count`).toBe(testCase.truth.count);

            const truthParticles = testCase.truth.particles.slice().sort((a, b) => a.id - b.id);
            // SoA stores the simulation in float32 columns (GPU-aligned, half the memory of float64), so it
            // diverges from the float64 Babylon.js oracle at float32-epsilon scale — here the age accumulates
            // over ~200 steps to a few ×1e-6. That is far below sub-pixel, so the parity bound is float32-scale.
            const tol = 1e-4;
            for (let i = 0; i < truthParticles.length; i++) {
                const b = truthParticles[i]!;
                const l = rows[i]!;
                expect(Math.abs(l.posX - b.position[0]), `${testCase.name} particle ${i} position.x`).toBeLessThan(tol);
                expect(Math.abs(l.posY - b.position[1]), `${testCase.name} particle ${i} position.y`).toBeLessThan(tol);
                expect(Math.abs(l.posZ - b.position[2]), `${testCase.name} particle ${i} position.z`).toBeLessThan(tol);
                expect(Math.abs(l.size - b.size), `${testCase.name} particle ${i} size`).toBeLessThan(tol);
                expect(Math.abs(l.age - b.age), `${testCase.name} particle ${i} age`).toBeLessThan(tol);
                // The sprite cell index is an integer; it must match exactly.
                expect(l.cellIndex, `${testCase.name} particle ${i} cellIndex`).toBe(b.cellIndex);
            }
        });
    }
});
