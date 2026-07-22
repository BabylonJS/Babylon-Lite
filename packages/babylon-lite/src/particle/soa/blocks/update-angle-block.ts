import { column } from "../particle-buffer.js";
import { COL_ANGLE } from "../columns.js";
import type { SoaBlockEvaluator } from "../npe-build.js";

/** `UpdateAngleBlock` (SoA) — write the evaluated rotation into the on-demand angle column. */
export const updateAngleBlock: SoaBlockEvaluator = {
    build(block, ctx) {
        if (!ctx.isConnected(block, "angle")) {
            return;
        }
        const angleGetter = ctx.input(block, "angle");
        const angle = column(ctx.state.buffer!, COL_ANGLE, Float32Array);
        ctx.state.system!.updateSteps.push((i) => {
            angle[i] = angleGetter(i) as number;
        });
    },
};
