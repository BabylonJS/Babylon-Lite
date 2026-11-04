import type { Vec3 } from "../../../math/types.js";
import type { NpeBlockEvaluator } from "../npe-build.js";

/**
 * `UpdatePositionBlock` — each step, writes the particle position columns from the `position` input
 * (typically `currentPosition + scaledDirection`).
 */
export const updatePositionBlock: NpeBlockEvaluator = {
    build(block, ctx) {
        const system = ctx.state.system!;
        const buffer = ctx.state.buffer!;
        if (!ctx.isConnected(block, "position")) {
            return;
        }
        const positionGetter = ctx.input(block, "position");
        const posX = buffer.posX;
        const posY = buffer.posY;
        const posZ = buffer.posZ;

        system.updateSteps.push((i) => {
            const v = positionGetter(i) as Vec3;
            posX[i] = v.x;
            posY[i] = v.y;
            posZ[i] = v.z;
        });
    },
};
