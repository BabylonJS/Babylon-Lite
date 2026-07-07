import { describe, expect, it } from "vitest";
import graphSource from "./fixtures/change-lifetime-npe.json";
import groundTruth from "./fixtures/change-lifetime-states.json";
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

const truth = groundTruth as { N: number; count: number; particles: BjsParticle[] };

/**
 * CPU determinism test for the "Change - Lifetime" NPE graph (playground #LGZQU3#0): a ParticleSystem with
 * two lifetime gradients — addLifeTimeGradient(0, 1) and addLifeTimeGradient(1, 0) — and targetStopDuration
 * 8, converted to NPE. Unlike the per-frame Change tests (Size/Color/Speed update every step from the
 * particle's own age), Lifetime sets each particle's lifeTime ONCE at creation from the SYSTEM age ratio:
 * lifeTime = gradient(clamp01(actualFrame / targetStopDuration)), so particles emitted later in the system's
 * life get shorter lifetimes. This exercises the CreateParticleBlock.lifeTime input being fed by a
 * ParticleGradientBlock chain (evaluated fresh at each creation, reading the current actualFrame) — zero new
 * blocks. The playground's pre-warm is omitted (Lite has no pre-warm), which isolates the gradient mechanism;
 * the gradient is still exercised as actualFrame ramps over the run. Asserts every particle's state matches
 * the committed Babylon.js ground truth.
 */
describe("NPE particle simulation (Change - Lifetime) — deterministic parity with Babylon.js", () => {
    it(`reproduces Babylon.js particle states after ${truth.N} deterministic steps`, async () => {
        const graph = parseNodeParticleSource(graphSource);
        const set = await buildNodeParticleSet({} as EngineContext, {} as SceneContext, graph, { emitter: { x: 0, y: 0, z: 0 } });
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
        expect(lite.length).toBe(truth.count);

        // BJS recycles particle slots as they die, so the ground-truth `_particles` dump is not ordered by id.
        // Sort both sides by id before comparing (the lifetime ramps down, so early particles have expired).
        const truthSorted = truth.particles.slice().sort((a, b) => a.id - b.id);

        const tol = 1e-6;
        for (let i = 0; i < truthSorted.length; i++) {
            const b = truthSorted[i]!;
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
            expect(Math.abs(l.lifeTime - b.lifeTime), `particle ${i} lifeTime`).toBeLessThan(tol);
        }
    });
});
