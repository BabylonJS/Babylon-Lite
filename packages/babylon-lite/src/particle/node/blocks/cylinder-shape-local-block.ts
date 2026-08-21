import { randomRange } from "../../../math/random-range.js";
import { transformNormalToRef } from "../../../math/mat4-transform.js";
import { mat4Invert } from "../../../math/mat4-invert.js";
import { mat4Identity } from "../../../math/mat4-identity.js";
import type { Vec3 } from "../../../math/types.js";
import { finishLocalPosition } from "../npe-local-position.js";
import type { NpeBlockEvaluator } from "../npe-build.js";

/** Emitter-local `CylinderShapeBlock`. */
export const cylinderShapeLocalBlock: NpeBlockEvaluator = {
    build(block, ctx) {
        const state = ctx.state;
        const system = state.system!;
        const buffer = state.buffer!;
        const emitterWorldMatrix = state.emitterWorldMatrix;
        const emitter = state.emitter;
        const radiusGetter = ctx.input(block, "radius", () => 1);
        const heightGetter = ctx.input(block, "height", () => 1);
        const radiusRangeGetter = ctx.input(block, "radiusRange", () => 1);
        const randomizerGetter = ctx.input(block, "directionRandomizer", () => 0);
        const direction1Getter = ctx.input(block, "direction1", () => ({ x: 0, y: 1, z: 0 }));
        const direction2Getter = ctx.input(block, "direction2", () => ({ x: 0, y: 1, z: 0 }));
        const explicit = ctx.isConnected(block, "direction1") && ctx.isConnected(block, "direction2");
        const emitterInverseWorldMatrix = explicit ? null : (mat4Invert(emitterWorldMatrix) ?? mat4Identity());
        if (emitterInverseWorldMatrix) {
            (state.emitterInverseWorldMatrices ??= []).push({ source: emitterWorldMatrix, inverse: emitterInverseWorldMatrix });
        }
        const scratch: Vec3 = { x: 0, y: 0, z: 0 };
        let birthX = 0;
        let birthY = 0;
        let birthZ = 0;
        system.createPosition = (i) => {
            const height = heightGetter(i) as number;
            const radiusRange = radiusRangeGetter(i) as number;
            const radius = radiusGetter(i) as number;
            birthY = randomRange(-height / 2, height / 2);
            const angle = randomRange(0, 2 * Math.PI);
            const sampleRadius = Math.sqrt(randomRange((1 - radiusRange) * (1 - radiusRange), 1)) * radius;
            birthX = sampleRadius * Math.cos(angle);
            birthZ = sampleRadius * Math.sin(angle);
            buffer.posX[i] = birthX;
            buffer.posY[i] = birthY;
            buffer.posZ[i] = birthZ;
            finishLocalPosition(system, buffer, i, emitterWorldMatrix, scratch);
            birthX = scratch.x;
            birthY = scratch.y;
            birthZ = scratch.z;
        };
        system.createDirection = (i) => {
            let x: number;
            let y: number;
            let z: number;
            if (explicit) {
                const direction1 = direction1Getter(i) as Vec3;
                const minX = direction1.x;
                const minY = direction1.y;
                const minZ = direction1.z;
                const direction2 = direction2Getter(i) as Vec3;
                x = randomRange(minX, direction2.x);
                y = randomRange(minY, direction2.y);
                z = randomRange(minZ, direction2.z);
            } else {
                x = birthX - emitter.x;
                y = birthY - emitter.y;
                z = birthZ - emitter.z;
                let length = Math.sqrt(x * x + y * y + z * z);
                if (length !== 0 && length !== 1) {
                    x /= length;
                    y /= length;
                    z /= length;
                }
                transformNormalToRef(x, y, z, emitterInverseWorldMatrix!, scratch);
                const randomizer = randomizerGetter(i) as number;
                y = randomRange(-randomizer / 2, randomizer / 2);
                let azimuth = Math.atan2(scratch.x, scratch.z);
                azimuth += randomRange(-Math.PI / 2, Math.PI / 2) * randomizer;
                x = Math.sin(azimuth);
                z = Math.cos(azimuth);
                length = Math.sqrt(x * x + y * y + z * z);
                if (length !== 0 && length !== 1) {
                    x /= length;
                    y /= length;
                    z /= length;
                }
            }
            buffer.dirX[i] = x;
            buffer.dirY[i] = y;
            buffer.dirZ[i] = z;
        };
    },
};
