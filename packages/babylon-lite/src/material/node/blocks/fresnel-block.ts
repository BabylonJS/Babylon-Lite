import type { BlockEmitter } from "../node-types.js";

const HELPER = `fn nme_computeFresnelTerm(viewDirection: vec3<f32>, worldNormal: vec3<f32>, bias: f32, power: f32) -> f32 {
    let fresnelTerm = pow(bias + abs(dot(viewDirection, worldNormal)), power);
    return clamp(fresnelTerm, 0.0, 1.0);
}`;

export const emitter: BlockEmitter = {
    className: "FresnelBlock",
    emit(block, _outputName, stage, state, ctx) {
        const worldNormal = ctx.cast(ctx.resolve(block, "worldNormal", stage, state), "vec3f").expr;
        const viewDirection = ctx.cast(ctx.resolve(block, "viewDirection", stage, state), "vec3f").expr;
        const bias = ctx.cast(ctx.resolve(block, "bias", stage, state), "f32").expr;
        const power = ctx.cast(ctx.resolve(block, "power", stage, state), "f32").expr;
        const stageState = stage === "vertex" ? state.vertex : state.fragment;
        stageState.helpers.set("nme_computeFresnelTerm", HELPER);
        return { expr: `nme_computeFresnelTerm(${viewDirection}, ${worldNormal}, ${bias}, ${power})`, type: "f32" };
    },
};
