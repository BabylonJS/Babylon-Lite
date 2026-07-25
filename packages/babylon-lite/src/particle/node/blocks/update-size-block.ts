import type { NpeBlockEvaluator } from "../npe-build.js";

/** `UpdateSizeBlock` — write the evaluated size input into the size column each step. */
export const updateSizeBlock: NpeBlockEvaluator = {
    build(block, ctx) {
        const system = ctx.state.system!;
        const buffer = ctx.state.buffer!;
        if (!ctx.isConnected(block, "size")) {
            return;
        }
        const sizeGetter = ctx.input(block, "size");
        const size = buffer.size;
        system.updateSteps.push((i) => {
            size[i] = sizeGetter(i) as number;
        });
    },
};
