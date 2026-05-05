import type { BlockEmitter } from "../node-types.js";

export const emitter: BlockEmitter = {
    className: "CrossBlock",
    emit(block, _outputName, stage, state, ctx) {
        const left = ctx.cast(ctx.resolve(block, "left", stage, state), "vec3f").expr;
        const right = ctx.cast(ctx.resolve(block, "right", stage, state), "vec3f").expr;
        return { expr: `cross(${left}, ${right})`, type: "vec3f" };
    },
};
