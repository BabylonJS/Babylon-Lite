/** Rotate2dBlock — rotates a vec2 by angle radians around the origin. */

import type { BlockEmitter } from "../node-types.js";

export const emitter: BlockEmitter = {
    className: "Rotate2dBlock",
    emit(block, _outputName, stage, state, ctx) {
        const input = ctx.cast(ctx.resolve(block, "input", stage, state), "vec2f");
        const angle = ctx.cast(ctx.resolve(block, "angle", stage, state), "f32");
        return {
            expr: `vec2<f32>(cos(${angle.expr}) * (${input.expr}).x - sin(${angle.expr}) * (${input.expr}).y, sin(${angle.expr}) * (${input.expr}).x + cos(${angle.expr}) * (${input.expr}).y)`,
            type: "vec2f",
        };
    },
};
