import { describe, expect, it } from "vitest";
import { createSoaSystem, startSoaSystem, animateSoa } from "../../../packages/babylon-lite/src/particle/soa/animate";

/**
 * SPIKE validation for the data-oriented simulation loop. Hand-wires minimal create/update steps and
 * checks the emission count, per-particle update, lifetime clamp, and swap-remove recycling behave like the
 * object runtime's `animateParticleSystem` — the reusable foundation the block port will target.
 */
describe("SoA sim loop (spike)", () => {
    it("emits at the expected rate, integrates position, and recycles at lifetime", () => {
        const system = createSoaSystem(200);
        system.emitRate = 100;
        system.updateSpeed = 0.1; // scaledUpdateSpeed = 0.1 per animateSoa(system, 1)
        const b = system.buffer;
        system.createSteps = [
            (i) => {
                b.lifeTime[i] = 0.5;
            },
            (i) => {
                b.posX[i] = 0;
                b.posY[i] = 0;
                b.posZ[i] = 0;
            },
            (i) => {
                b.dirX[i] = 1;
                b.dirY[i] = 0;
                b.dirZ[i] = 0;
            },
        ];
        system.updateSteps = [
            (i) => {
                b.posX[i]! += b.dirX[i]! * system._scaledStep;
            },
        ];

        startSoaSystem(system);
        for (let k = 0; k < 12; k++) {
            animateSoa(system, 1);
        }

        // 10 born/step; lifetime 0.5 at step 0.1 => each cohort lives ~5 steps => steady state ~50 alive.
        expect(b.alive).toBeGreaterThanOrEqual(40);
        expect(b.alive).toBeLessThanOrEqual(60);
        let moved = 0;
        for (let i = 0; i < b.alive; i++) {
            expect(b.age[i]!).toBeLessThanOrEqual(b.lifeTime[i]! + 1e-9);
            // Particles born this step (created after the update phase) are still at the origin; any particle
            // that has been updated at least once must have advanced along +x.
            if (b.age[i]! > 0) {
                expect(b.posX[i]!).toBeGreaterThan(0);
                moved++;
            }
        }
        expect(moved).toBeGreaterThan(0);
    });

    it("clamps the dying step so age never exceeds lifeTime", () => {
        const system = createSoaSystem(20);
        system.emitRate = 10;
        system.updateSpeed = 0.3; // 0.3 does not divide 1.0 evenly -> exercises the clamp
        const b = system.buffer;
        system.createSteps = [
            (i) => {
                b.lifeTime[i] = 1;
            },
        ];

        startSoaSystem(system);
        for (let k = 0; k < 12; k++) {
            animateSoa(system, 1);
        }
        for (let i = 0; i < b.alive; i++) {
            expect(b.age[i]!).toBeLessThanOrEqual(1 + 1e-9);
        }
    });
});
