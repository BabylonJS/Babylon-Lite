import type { BlockEmitter, NodeExpr, NodeValueType } from "../node-types.js";
import { widerType } from "./_math-factory.js";

function connectedOrDefault(
    block: Parameters<BlockEmitter["emit"]>[0],
    inputName: string,
    fallback: string,
    type: NodeValueType,
    stage: Parameters<BlockEmitter["emit"]>[2],
    state: Parameters<BlockEmitter["emit"]>[3],
    ctx: Parameters<BlockEmitter["emit"]>[4]
): NodeExpr {
    const input = block.inputs.get(inputName);
    if (input?.source) {
        return ctx.resolve(block, inputName, stage, state);
    }
    return { expr: fallback, type };
}

function conditionExpr(condition: number, a: string, b: string): string {
    switch (condition) {
        case 0:
            return `${a} == ${b}`;
        case 1:
            return `${a} != ${b}`;
        case 2:
            return `${a} < ${b}`;
        case 3:
            return `${a} > ${b}`;
        case 4:
            return `${a} <= ${b}`;
        case 5:
            return `${a} >= ${b}`;
        case 6:
            return `(((${a} + ${b}) - 2.0 * floor((${a} + ${b}) / 2.0)) > 0.0)`;
        case 7:
            return `(min(${a} + ${b}, 1.0) > 0.0)`;
        case 8:
            return `(${a} * ${b} > 0.0)`;
        default:
            throw new Error(`NodeMaterial: unknown ConditionalBlock condition ${condition}`);
    }
}

export const emitter: BlockEmitter = {
    className: "ConditionalBlock",
    emit(block, _outputName, stage, state, ctx) {
        const a = ctx.cast(ctx.resolve(block, "a", stage, state), "f32").expr;
        const b = ctx.cast(ctx.resolve(block, "b", stage, state), "f32").expr;
        const trueValue = connectedOrDefault(block, "true", "1.0", "f32", stage, state, ctx);
        const falseValue = connectedOrDefault(block, "false", "0.0", "f32", stage, state, ctx);
        const outputType = widerType(trueValue.type, falseValue.type);
        const t = ctx.cast(trueValue, outputType).expr;
        const f = ctx.cast(falseValue, outputType).expr;
        const rawCondition = block.serialized.condition;
        const condition = typeof rawCondition === "number" ? rawCondition : 2;
        return { expr: `select(${f}, ${t}, ${conditionExpr(condition, a, b)})`, type: outputType };
    },
};
