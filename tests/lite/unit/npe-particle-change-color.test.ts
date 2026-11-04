import { describe, expect, it } from "vitest";
import graphSource from "./fixtures/change-color-npe.json";
import groundTruth from "./fixtures/change-color-states.json";
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
 * CPU determinism test for the "Change - Color" NPE graph (playground #AUPMMB#0): a ParticleSystem with two
 * color gradients — addColorGradient(0, red) and addColorGradient(1, green) — converted to NPE. Exercises
 * the ParticleGradientBlock + ParticleGradientValueBlock driving UpdateColorBlock, so the per-frame color is
 * a Color4 gradient evaluated at the age/lifetime ratio (proving the gradient machinery generalizes from the
 * scalar size gradient of scene264 to Color4). Asserts every particle's state matches the committed Babylon.js
 * ground truth.
 */
describe("NPE particle simulation (Change - Color) — deterministic parity with Babylon.js", () => {
    it(`reproduces Babylon.js particle states after ${truth.N} deterministic steps`, async () => {
        const system = await simulateNodeParticleGraph(graphSource, truth.N, { emitter: { x: 0, y: 0, z: 0 } });
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
