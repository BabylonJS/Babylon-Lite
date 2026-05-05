import type { BlockEmitter } from "../node-types.js";

export const emitter: BlockEmitter = {
    className: "DesaturateBlock",
    emit(block, _outputName, stage, state, ctx) {
        const color = ctx.cast(ctx.resolve(block, "color", stage, state), "vec3f").expr;
        const level = ctx.cast(ctx.resolve(block, "level", stage, state), "f32").expr;
        const minColor = `min(min((${color}).x, (${color}).y), (${color}).z)`;
        const maxColor = `max(max((${color}).x, (${color}).y), (${color}).z)`;
        const merge = `(0.5 * (${minColor} + ${maxColor}))`;
        return { expr: `mix(${color}, vec3<f32>(${merge}), ${level})`, type: "vec3f" };
    },
};
