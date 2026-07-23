import { describe, expect, it } from "vitest";
import { SCENE264_NPE_JSON } from "../../../lab/lite/src/shared/scene264-npe";
import groundTruth from "./fixtures/change-size-states.json";
import { simulateNodeParticleGraph, snapshotParticles } from "./particle-test-utils";

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

const truth = groundTruth as { N: number; count: number; particles: BjsParticle[] };

/**
 * CPU determinism test for the "Change - Size" NPE graph (playground #L90MXS): a ParticleSystem with two
 * size gradients — addSizeGradient(0, 0.1, 0.3) and addSizeGradient(1, 1, 2) — converted to NPE. Exercises
 * the new ParticleGradientBlock, ParticleGradientValueBlock, and UpdateSizeBlock (the size is a per-frame
 * gradient evaluated at the age/lifetime ratio, with each stop a OncePerParticle random range). Asserts
 * every particle's state matches the committed Babylon.js ground truth.
 */
describe("NPE particle simulation (Change - Size) — deterministic parity with Babylon.js", () => {
    it(`reproduces Babylon.js particle states after ${truth.N} deterministic steps`, async () => {
        const system = await simulateNodeParticleGraph(SCENE264_NPE_JSON, truth.N, { emitter: { x: 0, y: 0, z: 0 } });
        const lite = snapshotParticles(system);
        expect(lite.length).toBe(truth.count);

        const tol = 1e-4;
        for (let i = 0; i < truth.particles.length; i++) {
            const b = truth.particles[i]!;
            const l = lite[i]!;
            expect(Math.abs(l.position.x - b.position[0]), `particle ${i} position.x`).toBeLessThan(tol);
            expect(Math.abs(l.position.y - b.position[1]), `particle ${i} position.y`).toBeLessThan(tol);
            expect(Math.abs(l.position.z - b.position[2]), `particle ${i} position.z`).toBeLessThan(tol);
            expect(Math.abs(l.direction.x - b.direction[0]), `particle ${i} direction.x`).toBeLessThan(tol);
            expect(Math.abs(l.direction.y - b.direction[1]), `particle ${i} direction.y`).toBeLessThan(tol);
            expect(Math.abs(l.direction.z - b.direction[2]), `particle ${i} direction.z`).toBeLessThan(tol);
            expect(Math.abs(l.color.r - b.color[0]), `particle ${i} color.r`).toBeLessThan(tol);
            expect(Math.abs(l.color.g - b.color[1]), `particle ${i} color.g`).toBeLessThan(tol);
            expect(Math.abs(l.color.b - b.color[2]), `particle ${i} color.b`).toBeLessThan(tol);
            expect(Math.abs(l.color.a - b.color[3]), `particle ${i} color.a`).toBeLessThan(tol);
            expect(Math.abs(l.size - b.size), `particle ${i} size`).toBeLessThan(tol);
            expect(Math.abs(l.scale.x - b.scale[0]), `particle ${i} scale.x`).toBeLessThan(tol);
            expect(Math.abs(l.scale.y - b.scale[1]), `particle ${i} scale.y`).toBeLessThan(tol);
            expect(Math.abs(l.angle - b.angle), `particle ${i} angle`).toBeLessThan(tol);
            expect(Math.abs(l.age - b.age), `particle ${i} age`).toBeLessThan(tol);
        }
    });
});
