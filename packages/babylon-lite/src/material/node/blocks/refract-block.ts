import type { BlockEmitter } from "../node-types.js";

export const emitter: BlockEmitter = {
    className: "RefractBlock",
    emit(block, _outputName, stage, state, ctx) {
        const incident = ctx.cast(ctx.resolve(block, "incident", stage, state), "vec3f").expr;
        const normal = ctx.cast(ctx.resolve(block, "normal", stage, state), "vec3f").expr;
        const ior = ctx.cast(ctx.resolve(block, "ior", stage, state), "f32").expr;
        return { expr: `refract(${incident}, ${normal}, ${ior})`, type: "vec3f" };
    },
};
