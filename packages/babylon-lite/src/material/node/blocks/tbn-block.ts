import type { BlockEmitter, NodeExpr } from "../node-types.js";

function emitTbnRows(
    block: Parameters<BlockEmitter["emit"]>[0],
    stage: Parameters<BlockEmitter["emit"]>[2],
    state: Parameters<BlockEmitter["emit"]>[3],
    ctx: Parameters<BlockEmitter["emit"]>[4]
): NodeExpr {
    const stageState = stage === "vertex" ? state.vertex : state.fragment;
    const memoKey = `_tbn_${block.id}`;
    const existing = stageState.memo.get(memoKey);
    if (existing) {
        return existing;
    }

    const normal = ctx.cast(ctx.resolve(block, "normal", stage, state), "vec3f").expr;
    const tangent = ctx.cast(ctx.resolve(block, "tangent", stage, state), "vec4f").expr;
    const world = ctx.cast(ctx.resolve(block, "world", stage, state), "mat4f").expr;
    const prefix = `_tbn${ctx.temp(state, "tbn")}`;
    stageState.body.push(`let ${prefix}_normal = normalize(${normal});`);
    stageState.body.push(`let ${prefix}_tangent = normalize((${tangent}).xyz);`);
    stageState.body.push(`let ${prefix}_bitangent = cross(${prefix}_normal, ${prefix}_tangent) * (${tangent}).w;`);
    stageState.body.push(
        `let ${prefix}_mat = mat3x3<f32>((${world})[0].xyz, (${world})[1].xyz, (${world})[2].xyz) * mat3x3<f32>(${prefix}_tangent, ${prefix}_bitangent, ${prefix}_normal);`
    );
    stageState.body.push(`let ${prefix}_rows = vec4<f32>(${prefix}_mat[0][0], ${prefix}_mat[1][1], ${prefix}_mat[2][2], 0.0);`);
    const result = { expr: `${prefix}_rows`, type: "vec4f" } as const;
    stageState.memo.set(memoKey, result);
    return result;
}

export const emitter: BlockEmitter = {
    className: "TBNBlock",
    stage: "fragment",
    emit(block, outputName, stage, state, ctx) {
        if (outputName === "TBN") {
            throw new Error("NodeMaterial: TBNBlock object output is not supported; use row0/row1/row2 outputs");
        }
        const rows = emitTbnRows(block, stage, state, ctx).expr;
        if (outputName === "row1") {
            return { expr: `vec3<f32>(0.0, (${rows}).y, 0.0)`, type: "vec3f" };
        }
        if (outputName === "row2") {
            return { expr: `vec3<f32>(0.0, 0.0, (${rows}).z)`, type: "vec3f" };
        }
        return { expr: `vec3<f32>((${rows}).x, 0.0, 0.0)`, type: "vec3f" };
    },
};
