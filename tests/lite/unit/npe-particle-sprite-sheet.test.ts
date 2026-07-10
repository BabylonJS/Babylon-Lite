import { describe, expect, it } from "vitest";
import { SCENE265_NPE_JSON as spriteSheetGraph } from "../../../lab/lite/src/shared/scene265-npe";
import spriteSheetStates from "./fixtures/sprite-sheet-states.json";
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

/**
 * CPU determinism test for the sprite-sheet animation blocks (`SetupSpriteSheetBlock` +
 * `BasicSpriteUpdateBlock`), converted from the classic "Particles - Animations 2" system
 * (playground #CBXIIX#0 — `spriteCellChangeSpeed = 30`, cells 0..9, looped, deterministic start cell).
 * Builds the graph, seeds `Math.random` like the Babylon.js oracle, steps the simulation, and asserts
 * every particle's motion matches the committed Babylon.js ground truth to 1e-6 — and, crucially, that
 * each particle's animation-sheet `cellIndex` matches exactly (the cell-advance math in
 * `Particle.updateCellIndex`).
 */
describe("NPE sprite-sheet animation — deterministic parity with Babylon.js", () => {
    const truth = spriteSheetStates as StatesFixture;

    it(`reproduces Babylon.js states (incl. cellIndex) after ${truth.N} steps`, async () => {
        const graph = parseNodeParticleSource(spriteSheetGraph);
        const set = await buildNodeParticleSet({} as EngineContext, {} as SceneContext, graph, { emitter: { x: 0, y: 0, z: 0 } });
        const system = set.systems[0]!;
        expect(system).toBeTruthy();
        expect(system._isAnimationSheetEnabled, "animation sheet enabled by SetupSpriteSheetBlock").toBe(true);

        let seed = 1;
        Math.random = () => {
            const x = Math.sin(seed++) * 10000;
            return x - Math.floor(x);
        };

        startParticleSystem(system);
        for (let i = 0; i < truth.N; i++) {
            animateParticleSystem(system, 1);
        }

        const lite = system._particles.slice().sort((a, b) => a.id - b.id);
        expect(lite.length, "particle count").toBe(truth.count);

        // Particles recycle slots over the run, so sort both sides by id before comparing.
        const truthParticles = truth.particles.slice().sort((a, b) => a.id - b.id);

        const tol = 1e-6;
        for (let i = 0; i < truthParticles.length; i++) {
            const b = truthParticles[i]!;
            const l = lite[i]!;
            expect(Math.abs(l.position.x - b.position[0]), `particle ${i} position.x`).toBeLessThan(tol);
            expect(Math.abs(l.position.y - b.position[1]), `particle ${i} position.y`).toBeLessThan(tol);
            expect(Math.abs(l.position.z - b.position[2]), `particle ${i} position.z`).toBeLessThan(tol);
            expect(Math.abs(l.size - b.size), `particle ${i} size`).toBeLessThan(tol);
            expect(Math.abs(l.age - b.age), `particle ${i} age`).toBeLessThan(tol);
            // The animation-sheet cell index is an integer; it must match exactly.
            expect(l.cellIndex, `particle ${i} cellIndex`).toBe(b.cellIndex);
        }
    });
});
