import { describe, expect, it } from "vitest";
import {
    AIMING_GRAVITY,
    AIMING_SEGMENTS,
    AIMING_SPEED,
    AIMING_WIDTH,
    CHARGE_PARTICLES,
    computeAimingPath,
    CONFETTI_PARTICLES,
    SCORE_PARTICLES,
    updateAimingEffect,
    updatePlayroomEffects,
} from "../../../lab/lite/src/demos/playroom/effects.js";
import type { PlayroomEffects } from "../../../lab/lite/src/demos/playroom/effects.js";
import type { ArcRotateCamera, BillboardSpriteInit, FacingBillboardSpriteSystem } from "../../../packages/babylon-lite/src/index.js";

function makeSpriteSystem(): FacingBillboardSpriteSystem {
    return {
        count: 0,
        _capacity: 2,
        _instanceData: new Float32Array(32),
        _savedSize: new Float32Array(4),
        _anchor: new Float64Array(6),
        _dirtyMin: 0,
        _dirtyMax: 0,
        _version: 0,
        atlas: { frames: [] },
    } as unknown as FacingBillboardSpriteSystem;
}

describe("The Playroom source effects", () => {
    it("builds the smoothed-camera ballistic ribbon equation and source width", () => {
        const angle = 0.35;
        const paths = computeAimingPath(angle);
        const intercept = (2 * AIMING_SPEED ** 2 * Math.cos(angle) ** 2 * Math.tan(angle)) / AIMING_GRAVITY;
        expect(paths[0]).toHaveLength(AIMING_SEGMENTS + 1);
        expect(paths[1]).toHaveLength(AIMING_SEGMENTS + 1);
        expect(paths[0]![AIMING_SEGMENTS]!.x).toBeCloseTo(intercept, 6);
        expect(paths[0]![AIMING_SEGMENTS]!.y).toBeCloseTo(0, 6);
        expect(paths[1]![7]!.z - paths[0]![7]!.z).toBeCloseTo(AIMING_WIDTH, 6);
    });

    it("uses smoothed yaw and pitch for the curve but the unsmoothed camera direction for its launch offset", () => {
        const positionBuffer = {} as GPUBuffer;
        const uvBuffer = {} as GPUBuffer;
        const writes: Array<{ buffer: GPUBuffer; values: number[] }> = [];
        const aimingPositions = new Float32Array((AIMING_SEGMENTS + 1) * 2 * 3);
        const effects = {
            engine: {
                _device: {
                    queue: {
                        writeBuffer: (buffer: GPUBuffer, _offset: number, data: GPUAllowSharedBufferSource, dataOffset = 0, size?: number) => {
                            const source = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
                            const bytes = source.slice(dataOffset, dataOffset + (size ?? source.byteLength - dataOffset));
                            writes.push({ buffer, values: Array.from(new Float32Array(bytes.buffer)) });
                        },
                    },
                },
            },
            aiming: {
                visible: false,
                position: {
                    set(x: number, y: number, z: number): void {
                        this.x = x;
                        this.y = y;
                        this.z = z;
                    },
                    x: 0,
                    y: 0,
                    z: 0,
                },
                rotation: { y: 0 },
                _gpu: { positionBuffer, uvBuffer },
            },
            aimingPositions,
            aimingPitch: 0,
            aimingYaw: 0,
            aimingUvsReady: false,
        } as unknown as PlayroomEffects;
        const camera = { alpha: -1.25, beta: 1.2 } as ArcRotateCamera;
        const origin = { x: 0.2, y: 1.1, z: -0.4 };
        const targetPitch = camera.beta - Math.PI * 0.25;
        const targetYaw = -camera.alpha + Math.PI;

        updateAimingEffect(effects, origin, camera, true);

        expect(effects.aiming.visible).toBe(true);
        expect(effects.aimingPitch).toBeCloseTo(targetPitch * 0.1, 7);
        expect(effects.aimingYaw).toBeCloseTo(targetYaw * 0.1, 7);
        expect(effects.aiming.rotation.y).toBeCloseTo(targetYaw * 0.1, 7);
        expect(effects.aiming.position.x).toBeCloseTo(origin.x - Math.cos(camera.alpha) * Math.cos(targetPitch) * 0.5, 7);
        expect(effects.aiming.position.y).toBe(origin.y);
        expect(effects.aiming.position.z).toBeCloseTo(origin.z - Math.sin(camera.alpha) * Math.cos(targetPitch) * 0.5, 7);
        expect(aimingPositions[2]).toBeCloseTo(-AIMING_WIDTH * 0.5, 7);
        expect(aimingPositions[AIMING_SEGMENTS * 3]!).toBeGreaterThan(0);
        expect(aimingPositions[AIMING_SEGMENTS * 3 + 1]).toBeCloseTo(0, 6);
        expect(effects.aimingUvsReady).toBe(true);
        expect(writes).toHaveLength(2);
        expect(writes[0]!.buffer).toBe(uvBuffer);
        expect(writes[0]!.values.slice(0, 4)).toEqual([0, 0, expect.any(Number), 0]);
        expect(writes[0]!.values[2]).toBeGreaterThan(0);
        expect(writes[0]!.values.slice(-2)).toEqual([1, 1]);
        expect(writes[1]!.buffer).toBe(positionBuffer);
    });

    it("retains the source particle capacities, timings, rates, colors, and gravity", () => {
        expect(SCORE_PARTICLES).toMatchObject({ capacity: 2000, size: 0.2, lifeMin: 1, lifeMax: 1.2, updateSpeed: 0.005 });
        expect(CHARGE_PARTICLES).toMatchObject({ capacity: 2000, emitRate: 50, emitterRadius: 0.2, lifeMin: 0.1, lifeMax: 0.5 });
        expect(CHARGE_PARTICLES.color1).toEqual([0x97 / 255, 1, 0xf0 / 255, 1]);
        expect(CONFETTI_PARTICLES).toMatchObject({
            capacity: 2000,
            manualEmitCount: 200,
            emitRate: 200,
            emitDurationMs: 100,
            size: 0.2,
            life: 9000,
            radius: 1.6,
            angle: Math.PI / 2,
            gravity: -3.81,
        });
    });

    it("rewrites one stable sprite descriptor while preserving particle geometry and storage", () => {
        const scoreSystem = makeSpriteSystem();
        const chargeSystem = makeSpriteSystem();
        const confettiSystem = makeSpriteSystem();
        const spriteScratch: BillboardSpriteInit = {
            position: [99, 99, 99],
            sizeWorld: [99, 99],
            color: [0, 0, 0, 0],
            rotation: 99,
        };
        const effects = {
            aimingTimeSeconds: 0,
            aimingTimeInput: undefined,
            chargeActive: false,
            chargeCarry: 0,
            chargePoint: { x: 0, y: 0, z: 0 },
            confettiEmitUntil: 0,
            confettiCarry: 0,
            confettiPoint: { x: 0, y: 0, z: 0 },
            scoreParticles: [
                {
                    x: 1,
                    y: 2,
                    z: 3,
                    vx: 0,
                    vy: 0,
                    vz: 0,
                    age: 0,
                    life: 1,
                    size: 0.2,
                    rotation: 0.4,
                    angularSpeed: 0,
                    color: [1, 1, 1, 1],
                    kind: "score",
                },
            ],
            chargeParticles: [],
            confettiParticles: [],
            scoreSystem,
            chargeSystem,
            confettiSystem,
            spriteScratch,
        } as unknown as PlayroomEffects;
        const position = spriteScratch.position;
        const size = spriteScratch.sizeWorld;
        const color = spriteScratch.color;
        const instanceData = scoreSystem._instanceData;

        updatePlayroomEffects(effects, 1000 / 60, 0);

        expect(spriteScratch.position).toBe(position);
        expect(spriteScratch.sizeWorld).toBe(size);
        expect(spriteScratch.color).toBe(color);
        expect(spriteScratch.position).toEqual([1, expect.any(Number), 3]);
        expect(spriteScratch.sizeWorld).toEqual([0.2, 0.2]);
        expect(spriteScratch.color).toEqual(effects.scoreParticles[0]!.color);
        expect(spriteScratch.rotation).toBe(0.4);
        expect(scoreSystem.count).toBe(1);
        expect(Array.from(scoreSystem._instanceData.slice(0, 5))).toEqual([
            spriteScratch.position[0],
            expect.closeTo(spriteScratch.position[1]),
            spriteScratch.position[2],
            Math.fround(0.2),
            Math.fround(0.2),
        ]);

        effects.scoreParticles[0]!.x = 4;
        updatePlayroomEffects(effects, 1000 / 60, 1);
        expect(scoreSystem._instanceData).toBe(instanceData);
        expect(spriteScratch.position).toBe(position);
        expect(spriteScratch.position[0]).toBe(4);
        expect(scoreSystem.count).toBe(1);
        expect(effects.scoreParticles).toHaveLength(1);
    });
});
