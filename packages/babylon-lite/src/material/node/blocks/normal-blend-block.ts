import type { BlockEmitter, NodeExpr } from "../node-types.js";

function emitBlend(
    block: Parameters<BlockEmitter["emit"]>[0],
    stage: Parameters<BlockEmitter["emit"]>[2],
    state: Parameters<BlockEmitter["emit"]>[3],
    ctx: Parameters<BlockEmitter["emit"]>[4]
): NodeExpr {
    const stageState = stage === "vertex" ? state.vertex : state.fragment;
    const memoKey = `_normalBlend_${block.id}`;
    const existing = stageState.memo.get(memoKey);
    if (existing) {
        return existing;
    }

    const n0 = ctx.cast(ctx.resolve(block, "normalMap0", stage, state), "vec3f").expr;
    const n1 = ctx.cast(ctx.resolve(block, "normalMap1", stage, state), "vec3f").expr;
    const out = `_nb${ctx.temp(state, "normalBlend")}`;
    stageState.body.push(`let ${out}_stepR = step(0.5, (${n0}).r);`);
    stageState.body.push(`let ${out}_stepG = step(0.5, (${n0}).g);`);
    stageState.body.push(
        `let ${out} = vec3<f32>((1.0 - ${out}_stepR) * (${n0}).r * (${n1}).r * 2.0 + ${out}_stepR * (1.0 - (1.0 - (${n0}).r) * (1.0 - (${n1}).r) * 2.0), (1.0 - ${out}_stepG) * (${n0}).g * (${n1}).g * 2.0 + ${out}_stepG * (1.0 - (1.0 - (${n0}).g) * (1.0 - (${n1}).g) * 2.0), (${n0}).b * (${n1}).b);`
    );
    const result = { expr: out, type: "vec3f" } as const;
    stageState.memo.set(memoKey, result);
    return result;
}

export const emitter: BlockEmitter = {
    className: "NormalBlendBlock",
    emit(block, _outputName, stage, state, ctx) {
        return emitBlend(block, stage, state, ctx);
    },
};
