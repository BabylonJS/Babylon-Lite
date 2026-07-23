import { describe, expect, it } from "vitest";
import groundTruth from "./fixtures/scene262-npe-size-states.json";
import { SCENE262_NPE_JSON } from "../../../lab/lite/src/shared/scene262-npe";
import { parseNodeParticleSource } from "../../../packages/babylon-lite/src/particle/node/npe-parser";
import { buildNodeParticleSet } from "../../../packages/babylon-lite/src/particle/node/npe-build";
import { startParticleSystem, animateParticleSystem } from "../../../packages/babylon-lite/src/particle/particle-system";
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

/**
 * CPU determinism test for the canonical Node Particle runtime. Builds the Scene 262 graph through
 * `buildNodeParticleSet`, seeds Math.random exactly like the Babylon.js oracle, steps the simulation, then
 * reads each particle's state from typed-array columns. Matching the committed ground truth verifies
 * per-particle Math.random consumption, creation-slot order, emission count, update steps, and swap removal.
 */
describe("NPE particle simulation (Size) — deterministic parity with Babylon.js", () => {
    it(`reproduces Babylon.js particle states after ${truth.N} deterministic steps`, async () => {
        const graph = parseNodeParticleSource(SCENE262_NPE_JSON);
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
        const size = column(buffer, C.COL_SIZE, Float32Array);
        const scaleX = column(buffer, C.COL_SCALE_X, Float32Array);
        const scaleY = column(buffer, C.COL_SCALE_Y, Float32Array);
        const angle = column(buffer, C.COL_ANGLE, Float32Array);
        const colR = column(buffer, C.COL_COLOR_R, Float32Array);
        const colG = column(buffer, C.COL_COLOR_G, Float32Array);
        const colB = column(buffer, C.COL_COLOR_B, Float32Array);
        const colA = column(buffer, C.COL_COLOR_A, Float32Array);

        interface Row {
            id: number;
            posX: number;
            posY: number;
            posZ: number;
            dirX: number;
            dirY: number;
            dirZ: number;
            r: number;
            g: number;
            b: number;
            a: number;
            size: number;
            sx: number;
            sy: number;
            angle: number;
            age: number;
        }
        const rows: Row[] = [];
        for (let i = 0; i < buffer.alive; i++) {
            rows.push({
                id: buffer.id[i]!,
                posX: buffer.posX[i]!,
                posY: buffer.posY[i]!,
                posZ: buffer.posZ[i]!,
                dirX: buffer.dirX[i]!,
                dirY: buffer.dirY[i]!,
                dirZ: buffer.dirZ[i]!,
                r: colR[i]!,
                g: colG[i]!,
                b: colB[i]!,
                a: colA[i]!,
                size: size[i]!,
                sx: scaleX[i]!,
                sy: scaleY[i]!,
                angle: angle[i]!,
                age: buffer.age[i]!,
            });
        }
        rows.sort((a, b) => a.id - b.id);
        expect(rows.length).toBe(truth.count);

        const tol = 1e-6;
        for (let i = 0; i < truth.particles.length; i++) {
            const b = truth.particles[i]!;
            const l = rows[i]!;
            expect(Math.abs(l.posX - b.position[0]), `particle ${i} position.x`).toBeLessThan(tol);
            expect(Math.abs(l.posY - b.position[1]), `particle ${i} position.y`).toBeLessThan(tol);
            expect(Math.abs(l.posZ - b.position[2]), `particle ${i} position.z`).toBeLessThan(tol);
            expect(Math.abs(l.dirX - b.direction[0]), `particle ${i} direction.x`).toBeLessThan(tol);
            expect(Math.abs(l.dirY - b.direction[1]), `particle ${i} direction.y`).toBeLessThan(tol);
            expect(Math.abs(l.dirZ - b.direction[2]), `particle ${i} direction.z`).toBeLessThan(tol);
            expect(Math.abs(l.r - b.color[0]), `particle ${i} color.r`).toBeLessThan(tol);
            expect(Math.abs(l.g - b.color[1]), `particle ${i} color.g`).toBeLessThan(tol);
            expect(Math.abs(l.b - b.color[2]), `particle ${i} color.b`).toBeLessThan(tol);
            expect(Math.abs(l.a - b.color[3]), `particle ${i} color.a`).toBeLessThan(tol);
            expect(Math.abs(l.size - b.size), `particle ${i} size`).toBeLessThan(tol);
            expect(Math.abs(l.sx - b.scale[0]), `particle ${i} scale.x`).toBeLessThan(tol);
            expect(Math.abs(l.sy - b.scale[1]), `particle ${i} scale.y`).toBeLessThan(tol);
            expect(Math.abs(l.angle - b.angle), `particle ${i} angle`).toBeLessThan(tol);
            expect(Math.abs(l.age - b.age), `particle ${i} age`).toBeLessThan(tol);
        }
    });
});
