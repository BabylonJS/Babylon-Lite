import type { BlockEmitter } from "../node-types.js";
import { formatFloat } from "./_math-factory.js";
import { WGSL } from "../node-types.js";

export const emitter: BlockEmitter = {
    className: "ClampBlock",
    emit(block, _outputName, stage, state, ctx) {
        const value = ctx.resolve(block, "value", stage, state);
        const minRaw = block.serialized.minimum;
        const maxRaw = block.serialized.maximum;
        const minScalar = typeof minRaw === "number" ? formatFloat(minRaw) : "0.0";
        const maxScalar = typeof maxRaw === "number" ? formatFloat(maxRaw) : "1.0";
        // WGSL clamp requires all three args to have matching types. Promote
        // scalar bounds to the value's vector type when needed.
        if (value.type === "f32") {
            return { expr: `clamp(${value.expr}, ${minScalar}, ${maxScalar})`, type: value.type };
        }
        const t = WGSL[value.type];
        return { expr: `clamp(${value.expr}, ${t}(${minScalar}), ${t}(${maxScalar}))`, type: value.type };
    },
};
