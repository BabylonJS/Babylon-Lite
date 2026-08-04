import { describe, expect, it } from "vitest";
import { SCENE264_NPE_JSON } from "../../../lab/lite/src/shared/scene264-npe";
import groundTruth from "./fixtures/change-size-states.json";
import { parseNodeParticleSource } from "../../../packages/babylon-lite/src/particle/node/npe-parser";
import { buildNodeParticleSet } from "../../../packages/babylon-lite/src/particle/node/npe-build";
import { startParticleSystem, stopParticleSystem, animateParticleSystem } from "../../../packages/babylon-lite/src/particle/particle-system";
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

describe("NPE particle simulation (Change - Size) — deterministic parity with Babylon.js", () => {
    it(`reproduces Babylon.js particle states after ${truth.N} deterministic steps`, async () => {
        const graph = parseNodeParticleSource(SCENE264_NPE_JSON);
        const set = await buildNodeParticleSet({} as EngineContext, {} as SceneContext, graph, { emitter: { x: 0, y: 0, z: 0 } });
        const system = set.systems[0]!;
        expect(system).toBeTruthy();

        const previousRandom = Math.random;
        let seed = 1;
        Math.random = () => {
            const x = Math.sin(seed++) * 10000;
            return x - Math.floor(x);
        };
        try {
            startParticleSystem(system);
            for (let i = 0; i < truth.N; i++) {
                animateParticleSystem(system, 1);
            }
        } finally {
            Math.random = previousRandom;
        }

        const buffer = system.buffer;
        const size = buffer.size;
        const scaleX = buffer.scaleX;
        const scaleY = buffer.scaleY;
        const angle = buffer.angle;
        const colorR = buffer.colorR;
        const colorG = buffer.colorG;
        const colorB = buffer.colorB;
        const colorA = buffer.colorA;
        const indices = Array.from({ length: buffer.alive }, (_, i) => i).sort((a, b) => buffer.id[a]! - buffer.id[b]!);
        expect(indices.length).toBe(truth.count);

        const tol = 1e-4;
        for (let i = 0; i < truth.particles.length; i++) {
            const expected = truth.particles[i]!;
            const index = indices[i]!;
            expect(buffer.id[index], `particle ${i} id`).toBe(expected.id);
            expect(Math.abs(buffer.posX[index]! - expected.position[0]), `particle ${i} position.x`).toBeLessThan(tol);
            expect(Math.abs(buffer.posY[index]! - expected.position[1]), `particle ${i} position.y`).toBeLessThan(tol);
            expect(Math.abs(buffer.posZ[index]! - expected.position[2]), `particle ${i} position.z`).toBeLessThan(tol);
            expect(Math.abs(buffer.dirX[index]! - expected.direction[0]), `particle ${i} direction.x`).toBeLessThan(tol);
            expect(Math.abs(buffer.dirY[index]! - expected.direction[1]), `particle ${i} direction.y`).toBeLessThan(tol);
            expect(Math.abs(buffer.dirZ[index]! - expected.direction[2]), `particle ${i} direction.z`).toBeLessThan(tol);
            expect(Math.abs(colorR[index]! - expected.color[0]), `particle ${i} color.r`).toBeLessThan(tol);
            expect(Math.abs(colorG[index]! - expected.color[1]), `particle ${i} color.g`).toBeLessThan(tol);
            expect(Math.abs(colorB[index]! - expected.color[2]), `particle ${i} color.b`).toBeLessThan(tol);
            expect(Math.abs(colorA[index]! - expected.color[3]), `particle ${i} color.a`).toBeLessThan(tol);
            expect(Math.abs(size[index]! - expected.size), `particle ${i} size`).toBeLessThan(tol);
            expect(Math.abs(scaleX[index]! - expected.scale[0]), `particle ${i} scale.x`).toBeLessThan(tol);
            expect(Math.abs(scaleY[index]! - expected.scale[1]), `particle ${i} scale.y`).toBeLessThan(tol);
            expect(Math.abs(angle[index]! - expected.angle), `particle ${i} angle`).toBeLessThan(tol);
            expect(Math.abs(buffer.age[index]! - expected.age), `particle ${i} age`).toBeLessThan(tol);
            expect(Math.abs(buffer.lifeTime[index]! - expected.lifeTime), `particle ${i} lifeTime`).toBeLessThan(tol);
        }
    });

    it("keeps OncePerParticle cache storage bounded when compacted slots are recycled", async () => {
        const graph = parseNodeParticleSource(SCENE264_NPE_JSON);
        const set = await buildNodeParticleSet({} as EngineContext, {} as SceneContext, graph, { emitter: { x: 0, y: 0, z: 0 } });
        const system = set.systems[0]!;
        const previousRandom = Math.random;
        let seed = 1;
        Math.random = () => {
            const x = Math.sin(seed++) * 10000;
            return x - Math.floor(x);
        };
        try {
            startParticleSystem(system);
            for (let i = 0; i < 300; i++) {
                animateParticleSystem(system, 1);
            }

            const buffer = system.buffer;
            expect(buffer._nextId).toBeGreaterThan(buffer.alive);
            const cacheColumns = [...buffer._columns.entries()].filter(([name]) => /^random\.\d+\.(id|valid|value\d+)$/.test(name));
            expect(cacheColumns.length).toBeGreaterThan(0);
            for (const [, cache] of cacheColumns) {
                expect(cache.length).toBe(buffer.capacity);
            }

            const issuedIds = buffer._nextId;
            stopParticleSystem(system);
            for (let i = 0; i < 1000 && buffer.alive > 0; i++) {
                animateParticleSystem(system, 1);
            }
            expect(buffer.alive).toBe(0);
            expect(buffer._nextId).toBe(issuedIds);
            for (const [, cache] of cacheColumns) {
                expect(cache.length).toBe(buffer.capacity);
            }
        } finally {
            Math.random = previousRandom;
        }
    });
});
