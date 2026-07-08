import { describe, expect, it } from "vitest";
import rotatedGraph from "./fixtures/emitter-cylinder-rotated-npe.json";
import rotatedStates from "./fixtures/emitter-cylinder-rotated-states.json";
import { parseNodeParticleSource } from "../../../packages/babylon-lite/src/particle/node/npe-parser";
import { buildNodeParticleSet } from "../../../packages/babylon-lite/src/particle/node/npe-build";
import { startParticleSystem, animateParticleSystem } from "../../../packages/babylon-lite/src/particle/particle-system";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene";
import type { Mat4 } from "../../../packages/babylon-lite/src/math/types";

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

const truth = rotatedStates as { N: number; count: number; emitterMatrix: number[]; particles: BjsParticle[] };

/**
 * Rotated-emitter parity test. The cylinder emitter exercises the full emitter world-matrix path: position
 * via `transformCoordinates`, and direction via the inverse-then-forward `transformNormal` (the azimuth is
 * measured in the emitter's local frame). Babylon.js ran this exact graph with a rotated + translated emitter
 * mesh; Lite feeds the identical world matrix and must reproduce every particle to 1e-6. This is the guard
 * that emitter rotation/scale — not just translation — matches Babylon.js.
 */
describe("NPE rotated emitter — deterministic parity with Babylon.js", () => {
    it(`cylinder with a rotated emitter reproduces Babylon.js states after ${truth.N} steps`, async () => {
        const graph = parseNodeParticleSource(rotatedGraph);
        const emitterWorldMatrix = new Float32Array(truth.emitterMatrix) as unknown as Mat4;
        const set = await buildNodeParticleSet({} as EngineContext, {} as SceneContext, graph, { emitterWorldMatrix });
        const system = set.systems[0]!;
        expect(system).toBeTruthy();

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

        const tol = 1e-6;
        for (let i = 0; i < truth.particles.length; i++) {
            const b = truth.particles[i]!;
            const l = lite[i]!;
            expect(Math.abs(l.position.x - b.position[0]), `particle ${i} position.x`).toBeLessThan(tol);
            expect(Math.abs(l.position.y - b.position[1]), `particle ${i} position.y`).toBeLessThan(tol);
            expect(Math.abs(l.position.z - b.position[2]), `particle ${i} position.z`).toBeLessThan(tol);
            expect(Math.abs(l.direction.x - b.direction[0]), `particle ${i} direction.x`).toBeLessThan(tol);
            expect(Math.abs(l.direction.y - b.direction[1]), `particle ${i} direction.y`).toBeLessThan(tol);
            expect(Math.abs(l.direction.z - b.direction[2]), `particle ${i} direction.z`).toBeLessThan(tol);
            expect(Math.abs(l.size - b.size), `particle ${i} size`).toBeLessThan(tol);
            expect(Math.abs(l.angle - b.angle), `particle ${i} angle`).toBeLessThan(tol);
            expect(Math.abs(l.age - b.age), `particle ${i} age`).toBeLessThan(tol);
        }
    });
});
