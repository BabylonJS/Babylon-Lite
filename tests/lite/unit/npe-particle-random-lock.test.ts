import { describe, expect, it } from "vitest";
import { SCENE262_NPE_JSON } from "../../../lab/lite/src/shared/scene262-npe";
import { animateParticleSystem, startParticleSystem, stopParticleSystem } from "../../../packages/babylon-lite/src/index";
import { buildNodeParticleGraph } from "./particle-test-utils";

/**
 * Regression guard for the `ParticleRandomBlock` `OncePerParticle` (lockMode 3) cache. Particle ids are
 * monotonic, so caching one draw per id in a system-wide map would grow unbounded. SoA stores one id,
 * validity, and value column per block; each column is fixed at buffer capacity and a recycled slot's new
 * id invalidates its previous draw.
 */
describe("ParticleRandomBlock OncePerParticle lock", () => {
    it("keeps cache storage bounded by buffer capacity while slots recycle", async () => {
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

        const system = await buildNodeParticleGraph(json, { emitter: { x: 0, y: 0, z: 0 } });
        const buffer = system.buffer;

        const previousRandom = Math.random;
        let seed = 1;
        Math.random = () => {
            const x = Math.sin(seed++) * 10000;
            return x - Math.floor(x);
        };
        try {
            startParticleSystem(system);
            // Step well past the particle lifetime so many particles spawn and compacted slots are reused.
            for (let i = 0; i < 300; i++) {
                animateParticleSystem(system, 1);
            }

            expect(buffer._nextId).toBeGreaterThan(buffer.alive);
            const cacheColumns = [...buffer._columns.entries()].filter(([name]) => /^random\.\d+\.(id|valid|value0)$/.test(name));
            expect(cacheColumns).toHaveLength(onceBlocks * 3);
            for (const [, values] of cacheColumns) {
                expect(values.length).toBe(buffer.capacity);
            }
            const validColumns = cacheColumns.filter(([name]) => name.endsWith(".valid"));
            for (const [, valid] of validColumns) {
                for (let index = 0; index < buffer.alive; index++) {
                    expect(valid[index], `live slot ${index}`).toBe(1);
                }
            }

            const issuedIds = buffer._nextId;
            stopParticleSystem(system);
            for (let i = 0; i < 1000 && buffer.alive > 0; i++) {
                animateParticleSystem(system, 1);
            }
            expect(buffer.alive).toBe(0);
            expect(buffer._nextId).toBe(issuedIds);
            for (const [, values] of cacheColumns) {
                expect(values.length).toBe(buffer.capacity);
            }
        } finally {
            Math.random = previousRandom;
        }
    });
});
