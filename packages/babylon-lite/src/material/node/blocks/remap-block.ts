import type { BlockEmitter } from "../node-types.js";
import { formatFloat } from "./_math-factory.js";

function resolveOrSerialized(
    block: Parameters<BlockEmitter["emit"]>[0],
    inputName: string,
    serializedKey: string,
    fallback: number,
    stage: Parameters<BlockEmitter["emit"]>[2],
    state: Parameters<BlockEmitter["emit"]>[3],
    ctx: Parameters<BlockEmitter["emit"]>[4]
): string {
    const input = block.inputs.get(inputName);
    if (input?.source) {
        return ctx.cast(ctx.resolve(block, inputName, stage, state), "f32").expr;
    }
    const raw = block.serialized[serializedKey];
    return formatFloat(typeof raw === "number" ? raw : fallback);
}

export const emitter: BlockEmitter = {
    className: "RemapBlock",
    emit(block, _outputName, stage, state, ctx) {
        const input = ctx.resolve(block, "input", stage, state);
        const sMin = resolveOrSerialized(block, "sourceMin", "sourceRange.x", -1, stage, state, ctx);
        const sMax = resolveOrSerialized(block, "sourceMax", "sourceRange.y", 1, stage, state, ctx);
        const tMin = resolveOrSerialized(block, "targetMin", "targetRange.x", 0, stage, state, ctx);
        const tMax = resolveOrSerialized(block, "targetMax", "targetRange.y", 1, stage, state, ctx);
        // t + (v - s0) * (t1 - t0) / (s1 - s0)
        return {
            expr: `(${tMin} + (${input.expr} - ${sMin}) * (${tMax} - ${tMin}) / (${sMax} - ${sMin}))`,
            type: input.type,
        };
    },
};
