import { describe, expect, it } from "vitest";
import graphSource from "./fixtures/change-speed-limit-npe.json";
import groundTruth from "./fixtures/change-speed-limit-states.json";
import { parseNodeParticleSource } from "../../../packages/babylon-lite/src/particle/node/npe-parser";
import { buildNodeParticleSet } from "../../../packages/babylon-lite/src/particle/node/npe-build";
import { animateParticleSystem, startParticleSystem } from "../../../packages/babylon-lite/src/particle/particle-system";
import { column } from "../../../packages/babylon-lite/src/particle/particle-buffer";
import * as C from "../../../packages/babylon-lite/src/particle/particle-columns";
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

describe("NPE particle simulation (Change - Speed Limit) — deterministic parity with Babylon.js", () => {
    it(`reproduces Babylon.js particle states after ${truth.N} deterministic steps`, async () => {
        const graph = parseNodeParticleSource(graphSource);
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
            for (let step = 0; step < truth.N; step++) {
                animateParticleSystem(system, 1);
            }
        } finally {
            Math.random = previousRandom;
        }

        const buffer = system.buffer;
        const size = column(buffer, C.COL_SIZE, Float32Array);
        const scaleX = column(buffer, C.COL_SCALE_X, Float32Array);
        const scaleY = column(buffer, C.COL_SCALE_Y, Float32Array);
        const angle = column(buffer, C.COL_ANGLE, Float32Array);
        const colorR = column(buffer, C.COL_COLOR_R, Float32Array);
        const colorG = column(buffer, C.COL_COLOR_G, Float32Array);
        const colorB = column(buffer, C.COL_COLOR_B, Float32Array);
        const colorA = column(buffer, C.COL_COLOR_A, Float32Array);
        const indices = Array.from({ length: buffer.alive }, (_, i) => i).sort((left, right) => buffer.id[left]! - buffer.id[right]!);
        expect(indices).toHaveLength(truth.count);

        const tolerance = 1e-4;
        for (let i = 0; i < truth.particles.length; i++) {
            const index = indices[i]!;
            const particle = truth.particles[i]!;
            expect(buffer.id[index], `particle ${i} id`).toBe(particle.id);
            expect(Math.abs(buffer.posX[index]! - particle.position[0]), `particle ${i} position.x`).toBeLessThan(tolerance);
            expect(Math.abs(buffer.posY[index]! - particle.position[1]), `particle ${i} position.y`).toBeLessThan(tolerance);
            expect(Math.abs(buffer.posZ[index]! - particle.position[2]), `particle ${i} position.z`).toBeLessThan(tolerance);
            expect(Math.abs(buffer.dirX[index]! - particle.direction[0]), `particle ${i} direction.x`).toBeLessThan(tolerance);
            expect(Math.abs(buffer.dirY[index]! - particle.direction[1]), `particle ${i} direction.y`).toBeLessThan(tolerance);
            expect(Math.abs(buffer.dirZ[index]! - particle.direction[2]), `particle ${i} direction.z`).toBeLessThan(tolerance);
            expect(Math.abs(colorR[index]! - particle.color[0]), `particle ${i} color.r`).toBeLessThan(tolerance);
            expect(Math.abs(colorG[index]! - particle.color[1]), `particle ${i} color.g`).toBeLessThan(tolerance);
            expect(Math.abs(colorB[index]! - particle.color[2]), `particle ${i} color.b`).toBeLessThan(tolerance);
            expect(Math.abs(colorA[index]! - particle.color[3]), `particle ${i} color.a`).toBeLessThan(tolerance);
            expect(Math.abs(size[index]! - particle.size), `particle ${i} size`).toBeLessThan(tolerance);
            expect(Math.abs(scaleX[index]! - particle.scale[0]), `particle ${i} scale.x`).toBeLessThan(tolerance);
            expect(Math.abs(scaleY[index]! - particle.scale[1]), `particle ${i} scale.y`).toBeLessThan(tolerance);
            expect(Math.abs(angle[index]! - particle.angle), `particle ${i} angle`).toBeLessThan(tolerance);
            expect(Math.abs(buffer.age[index]! - particle.age), `particle ${i} age`).toBeLessThan(tolerance);
            expect(Math.abs(buffer.lifeTime[index]! - particle.lifeTime), `particle ${i} lifetime`).toBeLessThan(tolerance);
        }
    });
});
