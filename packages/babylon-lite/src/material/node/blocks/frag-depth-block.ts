/** FragDepthBlock — writes `@builtin(frag_depth)` from a depth scalar or worldPos/viewProjection pair. */

import type { BlockEmitter } from "../node-types.js";

export const emitter: BlockEmitter = {
    className: "FragDepthBlock",
    stage: "fragment",
    sideEffect: true,
    emit(block, _outputName, stage, state, ctx) {
        const memoKey = `${block.id}|fragDepth`;
        const existing = state.fragment.memo.get(memoKey);
        if (existing) {
            return existing;
        }
        state.usesFragDepth = true;
        const depthConn = block.inputs.get("depth");
        if (depthConn?.source) {
            const depth = ctx.cast(ctx.resolve(block, "depth", stage, state), "f32");
            state.fragment.body.push(`_NME_FRAG_DEPTH_ = ${depth.expr};`);
        } else if (block.inputs.get("worldPos")?.source && block.inputs.get("viewProjection")?.source) {
            const worldPos = ctx.cast(ctx.resolve(block, "worldPos", stage, state), "vec4f");
            const viewProjection = ctx.cast(ctx.resolve(block, "viewProjection", stage, state), "mat4f");
            const p = ctx.temp(state, "fragDepthP");
            state.fragment.body.push(`let ${p} = ${viewProjection.expr} * ${worldPos.expr};`);
            state.fragment.body.push(`_NME_FRAG_DEPTH_ = ${p}.z / ${p}.w;`);
        } else {
            throw new Error("NodeMaterial: FragDepthBlock requires `depth` or both `worldPos` and `viewProjection` inputs");
        }
        const result = { expr: "_NME_FRAG_DEPTH_", type: "f32" as const };
        state.fragment.memo.set(memoKey, result);
        return result;
    },
};
