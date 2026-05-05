import type { BlockEmitter, NodeExpr } from "../node-types.js";

const HELPER_KEY = "nme_heightToNormal";
const HELPER_WGSL = `
fn nme_heightToNormal(height: f32, position: vec3<f32>, tangent: vec3<f32>, normal: vec3<f32>, generateInWorldSpace: bool, normalizeNormal: bool, normalizeTangent: bool) -> vec4<f32> {
    let norm = select(normal, normalize(normal), normalizeNormal);
    let tgt = select(tangent, normalize(tangent), normalizeTangent);
    let worlddX = dpdx(position);
    let worlddY = dpdy(position);
    let crossX = cross(norm, worlddX);
    let crossY = cross(worlddY, norm);
    let d = abs(dot(crossY, worlddX));
    var inToNormal = (((height + dpdx(height)) - height) * crossY + ((height + dpdy(height)) - height) * crossX) * sign(d);
    inToNormal.y = -inToNormal.y;
    var result = normalize(d * norm - inToNormal);
    if (!generateInWorldSpace) {
        let biTangent = cross(norm, tgt);
        let tbn = mat3x3<f32>(tgt, biTangent, norm);
        result = tbn * result;
        result = result * vec3<f32>(0.5) + vec3<f32>(0.5);
    }
    return vec4<f32>(result, 0.0);
}
`;

function boolLiteral(value: unknown, fallback: boolean): string {
    return (typeof value === "boolean" ? value : fallback) ? "true" : "false";
}

function emitHeightNormal(
    block: Parameters<BlockEmitter["emit"]>[0],
    stage: Parameters<BlockEmitter["emit"]>[2],
    state: Parameters<BlockEmitter["emit"]>[3],
    ctx: Parameters<BlockEmitter["emit"]>[4]
): NodeExpr {
    const stageState = stage === "vertex" ? state.vertex : state.fragment;
    const memoKey = `_heightToNormal_${block.id}`;
    const existing = stageState.memo.get(memoKey);
    if (existing) {
        return existing;
    }

    state.fragment.helpers.set(HELPER_KEY, HELPER_WGSL);
    const height = ctx.cast(ctx.resolve(block, "input", stage, state), "f32").expr;
    const pos = ctx.cast(ctx.resolve(block, "worldPosition", stage, state), "vec3f").expr;
    const normal = ctx.cast(ctx.resolve(block, "worldNormal", stage, state), "vec3f").expr;
    const tangentInput = block.inputs.get("worldTangent");
    const generateInWorldSpace = block.serialized.generateInWorldSpace === true;
    if (!generateInWorldSpace && !tangentInput?.source) {
        throw new Error(`NodeMaterial: HeightToNormalBlock "${block.name}" requires worldTangent when generateInWorldSpace is false`);
    }
    const tangent = tangentInput?.source ? ctx.cast(ctx.resolve(block, "worldTangent", stage, state), "vec3f").expr : "vec3<f32>(0.0)";
    const out = `_hn${ctx.temp(state, "heightNormal")}`;
    stageState.body.push(
        `let ${out} = nme_heightToNormal(${height}, ${pos}, ${tangent}, ${normal}, ${boolLiteral(block.serialized.generateInWorldSpace, false)}, ${boolLiteral(block.serialized.automaticNormalizationNormal, true)}, ${boolLiteral(block.serialized.automaticNormalizationTangent, true)});`
    );
    const result = { expr: out, type: "vec4f" } as const;
    stageState.memo.set(memoKey, result);
    return result;
}

export const emitter: BlockEmitter = {
    className: "HeightToNormalBlock",
    stage: "fragment",
    emit(block, outputName, stage, state, ctx) {
        const value = emitHeightNormal(block, stage, state, ctx);
        if (outputName === "xyz") {
            return { expr: `${value.expr}.xyz`, type: "vec3f" };
        }
        return value;
    },
};
