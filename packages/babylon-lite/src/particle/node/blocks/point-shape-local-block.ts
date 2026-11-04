import { randomRange } from "../../../math/random-range.js";
import type { Vec3 } from "../../../math/types.js";
import { finishLocalPosition } from "../npe-local-position.js";
import type { NpeBlockEvaluator } from "../npe-build.js";

/** Emitter-local `PointShapeBlock`. */
export const pointShapeLocalBlock: NpeBlockEvaluator = {
    build(block, ctx) {
        const system = ctx.state.system!;
        const buffer = ctx.state.buffer!;
        const emitterWorldMatrix = ctx.state.emitterWorldMatrix;
        const direction1Getter = ctx.input(block, "direction1", () => ({ x: 0, y: 1, z: 0 }));
        const direction2Getter = ctx.input(block, "direction2", () => ({ x: 0, y: 1, z: 0 }));
        const scratch: Vec3 = { x: 0, y: 0, z: 0 };
        system.createPosition = (i) => {
            buffer.posX[i] = 0;
            buffer.posY[i] = 0;
            buffer.posZ[i] = 0;
            finishLocalPosition(system, buffer, i, emitterWorldMatrix, scratch);
        };
        system.createDirection = (i) => {
            const direction1 = direction1Getter(i) as Vec3;
            const minX = direction1.x;
            const minY = direction1.y;
            const minZ = direction1.z;
            const direction2 = direction2Getter(i) as Vec3;
            buffer.dirX[i] = randomRange(minX, direction2.x);
            buffer.dirY[i] = randomRange(minY, direction2.y);
            buffer.dirZ[i] = randomRange(minZ, direction2.z);
        };
    },
};
