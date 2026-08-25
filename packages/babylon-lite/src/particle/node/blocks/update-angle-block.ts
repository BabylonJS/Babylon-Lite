import type { NpeBlockEvaluator } from "../npe-build.js";

/** `UpdateAngleBlock` — write the evaluated rotation into the angle column. */
export const updateAngleBlock: NpeBlockEvaluator = {
    build(block, ctx) {
        if (!ctx.isConnected(block, "angle")) {
            return;
        }
        const angleGetter = ctx.input(block, "angle");
        const angle = ctx.state.buffer!.angle;
        ctx.state.system!.updateSteps.push((i) => {
            angle[i] = angleGetter(i) as number;
        });
    },
};
