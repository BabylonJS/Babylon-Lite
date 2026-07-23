import { column } from "../../particle-buffer.js";
import { COL_SIZE } from "../../particle-columns.js";
import type { NpeBlockEvaluator } from "../npe-build.js";

/** `UpdateSizeBlock` — write the evaluated size input into the on-demand size column each step. */
export const updateSizeBlock: NpeBlockEvaluator = {
    build(block, ctx) {
        const system = ctx.state.system!;
        const buffer = ctx.state.buffer!;
        if (!ctx.isConnected(block, "size")) {
            return;
        }
        const sizeGetter = ctx.input(block, "size");
        const size = column(buffer, COL_SIZE, Float32Array);
        system.updateSteps.push((i) => {
            size[i] = sizeGetter(i) as number;
        });
    },
};
