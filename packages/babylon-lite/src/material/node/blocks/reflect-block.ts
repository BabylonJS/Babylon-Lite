import type { BlockEmitter } from "../node-types.js";

export const emitter: BlockEmitter = {
    className: "ReflectBlock",
    emit(block, _outputName, stage, state, ctx) {
        const incident = ctx.cast(ctx.resolve(block, "incident", stage, state), "vec3f").expr;
        const normal = ctx.cast(ctx.resolve(block, "normal", stage, state), "vec3f").expr;
        return { expr: `reflect(${incident}, ${normal})`, type: "vec3f" };
    },
};
