import type { BlockEmitter } from "../node-types.js";

const OUTPUT_FN: Record<string, string> = {
    dx: "dpdx",
    dy: "dpdy",
};

export const emitter: BlockEmitter = {
    className: "DerivativeBlock",
    stage: "fragment",
    emit(block, outputName, stage, state, ctx) {
        const fn = OUTPUT_FN[outputName];
        if (!fn) {
            throw new Error(`NodeMaterial: DerivativeBlock output "${outputName}" is not supported`);
        }
        const input = ctx.resolve(block, "input", stage, state);
        return { expr: `${fn}(${input.expr})`, type: input.type };
    },
};
