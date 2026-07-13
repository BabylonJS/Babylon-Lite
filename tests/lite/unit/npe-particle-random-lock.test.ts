import { describe, expect, it } from "vitest";
import { SCENE262_NPE_JSON } from "../../../lab/lite/src/shared/scene262-npe";
import { parseNodeParticleSource } from "../../../packages/babylon-lite/src/particle/node/npe-parser";
import { buildNodeParticleSet } from "../../../packages/babylon-lite/src/particle/node/npe-build";
import { startParticleSystem, stopParticleSystem, animateParticleSystem } from "../../../packages/babylon-lite/src/particle/particle-system";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene";

/**
 * Regression guard for the `ParticleRandomBlock` `OncePerParticle` (lockMode 3) cache. Particle ids are
 * monotonic, so caching one draw per id in a system-wide map would grow unbounded. The fix stores the draw
 * on the particle (keyed by block id) and clears it on recycle, so it is pruned with the particle and the
 * cache stays bounded by the live pool — not by the number of ids ever issued.
 */
describe("ParticleRandomBlock OncePerParticle lock", () => {
    it("stores the draw on the particle and prunes it on recycle (no unbounded growth)", async () => {
        // Reuse the Scene 262 graph but switch its random block(s) to OncePerParticle (lockMode 3), the mode
        // whose per-particle cache the fix relocated onto the particle.
        const json = JSON.parse(JSON.stringify(SCENE262_NPE_JSON)) as { blocks: Array<Record<string, unknown>> };
        let onceBlocks = 0;
        for (const block of json.blocks) {
            if (block.customType === "BABYLON.ParticleRandomBlock") {
                block.lockMode = 3;
                onceBlocks++;
            }
        }
        expect(onceBlocks).toBeGreaterThan(0);

        const graph = parseNodeParticleSource(json);
        const set = await buildNodeParticleSet({} as EngineContext, {} as SceneContext, graph, { emitter: { x: 0, y: 0, z: 0 } });
        const system = set.systems[0]!;

        let seed = 1;
        Math.random = () => {
            const x = Math.sin(seed++) * 10000;
            return x - Math.floor(x);
        };

        startParticleSystem(system);
        // Step well past the particle lifetime so many particles spawn and are recycled (ids keep climbing).
        for (let i = 0; i < 300; i++) {
            animateParticleSystem(system, 1);
        }

        // Recycling occurred: far more ids were issued than there are live particles.
        expect(system._nextParticleId).toBeGreaterThan(system._particles.length);

        // Each live particle caches at most one value per OncePerParticle block — bounded by the graph, and
        // the cache is actually exercised (non-vacuous).
        let liveCached = 0;
        for (const particle of system._particles) {
            expect(particle._onceRandomValues?.size ?? 0, `live particle ${particle.id}`).toBeLessThanOrEqual(onceBlocks);
            liveCached += particle._onceRandomValues?.size ?? 0;
        }
        expect(liveCached).toBeGreaterThan(0);

        // Stop emitting and let every particle age out; each returns to the pool with its cache cleared.
        stopParticleSystem(system);
        for (let i = 0; i < 1000 && system._particles.length > 0; i++) {
            animateParticleSystem(system, 1);
        }
        expect(system._particles.length).toBe(0);
        expect(system._stock.length).toBeGreaterThan(0);
        for (const particle of system._stock) {
            expect(particle._onceRandomValues?.size ?? 0, `pooled particle ${particle.id}`).toBe(0);
        }

        // Far more ids were issued than there are pooled objects: nothing is retained per id.
        expect(system._nextParticleId).toBeGreaterThan(system._stock.length);
    });
});
