import { randomRange } from "../../../math/random-range.js";
import type { Vec3 } from "../../../math/types.js";
import { finishLocalPosition } from "../npe-local-position.js";
import type { NpeBlockEvaluator } from "../npe-build.js";

/** Emitter-local `ConeShapeBlock`. */
export const coneShapeLocalBlock: NpeBlockEvaluator = {
    build(block, ctx) {
        const system = ctx.state.system!;
        const buffer = ctx.state.buffer!;
        const emitterWorldMatrix = ctx.state.emitterWorldMatrix;
        const emitterX = ctx.state.emitter.x;
        const emitterY = ctx.state.emitter.y;
        const emitterZ = ctx.state.emitter.z;
        const emitFromSpawnPointOnly = block.serialized.emitFromSpawnPointOnly === true;
        const radiusGetter = ctx.input(block, "radius", () => 1);
        const angleGetter = ctx.input(block, "angle", () => Math.PI);
        const radiusRangeGetter = ctx.input(block, "radiusRange", () => 1);
        const heightRangeGetter = ctx.input(block, "heightRange", () => 1);
        const randomizerGetter = ctx.input(block, "directionRandomizer", () => 0);
        const direction1Getter = ctx.input(block, "direction1", () => ({ x: 0, y: 1, z: 0 }));
        const direction2Getter = ctx.input(block, "direction2", () => ({ x: 0, y: 1, z: 0 }));
        const explicit = ctx.isConnected(block, "direction1") && ctx.isConnected(block, "direction2");
        let birthX = 0;
        let birthY = 0;
        let birthZ = 0;
        const scratch: Vec3 = { x: 0, y: 0, z: 0 };
        system.createPosition = (i) => {
            const radius = radiusGetter(i) as number;
            const coneAngle = angleGetter(i) as number;
            const radiusRange = radiusRangeGetter(i) as number;
            const heightRange = heightRangeGetter(i) as number;
            let heightFactor: number;
            if (emitFromSpawnPointOnly) {
                heightFactor = 0.0001;
            } else {
                heightFactor = randomRange(0, heightRange);
                heightFactor = 1 - heightFactor * heightFactor;
            }
            const sampleRadius = (radius - randomRange(0, radius * radiusRange)) * heightFactor;
            const azimuth = randomRange(0, Math.PI * 2);
            birthX = sampleRadius * Math.sin(azimuth);
            birthZ = sampleRadius * Math.cos(azimuth);
            birthY = heightFactor * (coneAngle !== 0 ? radius / Math.tan(coneAngle / 2) : 1);
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
                x = birthX - emitterX;
                y = birthY - emitterY;
                z = birthZ - emitterZ;
                let length = Math.sqrt(x * x + y * y + z * z);
                if (length !== 0 && length !== 1) {
                    x /= length;
                    y /= length;
                    z /= length;
                }
                const randomizer = randomizerGetter(i) as number;
                x += randomRange(0, randomizer);
                y += randomRange(0, randomizer);
                z += randomRange(0, randomizer);
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
