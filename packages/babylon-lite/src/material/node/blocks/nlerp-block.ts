import type { BlockEmitter } from "../node-types.js";
import { widerType } from "./_math-factory.js";

export const emitter: BlockEmitter = {
    className: "NLerpBlock",
    emit(block, _outputName, stage, state, ctx) {
        const left = ctx.resolve(block, "left", stage, state);
        const right = ctx.resolve(block, "right", stage, state);
        const gradient = ctx.resolve(block, "gradient", stage, state);
        const t = widerType(left.type, right.type);
        if (t === "f32") {
            throw new Error("NodeMaterial: NLerpBlock requires a vector left/right input; Babylon.js emits normalize(mix(...)) for this block");
        }
        const lc = ctx.cast(left, t).expr;
        const rc = ctx.cast(right, t).expr;
        const gc = ctx.cast(gradient, t).expr;
        return { expr: `normalize(mix(${lc}, ${rc}, ${gc}))`, type: t };
    },
};
