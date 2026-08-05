import type { Vec3 } from "../../../math/types.js";
import type { NpeBlockEvaluator } from "../npe-build.js";

/** `UpdateDirectionBlock` — copy the evaluated velocity into the base direction columns. */
export const updateDirectionBlock: NpeBlockEvaluator = {
    build(block, ctx) {
        if (!ctx.isConnected(block, "direction")) {
            return;
        }
        const buffer = ctx.state.buffer!;
        const directionGetter = ctx.input(block, "direction");
        ctx.state.system!.updateSteps.push((i) => {
            const direction = directionGetter(i) as Vec3;
            buffer.dirX[i] = direction.x;
            buffer.dirY[i] = direction.y;
            buffer.dirZ[i] = direction.z;
        });
    },
};
