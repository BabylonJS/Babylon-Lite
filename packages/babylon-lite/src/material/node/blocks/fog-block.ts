/** FogBlock — standard Babylon fog blend.
 *
 *  Inputs: worldPosition, view (optional), input (color to blend), fogColor.
 *  Outputs: output (vec3 or vec4 matching `input`).
 *
 *  Scene-provided sentinels: `_NME_FOG_PARAMS_` (vec4: mode, density, start, end)
 *  and `_NME_CAMERA_POS_`. The pipeline builder wires these to the scene UBOs.
 */

import type { BlockEmitter } from "../node-types.js";

const FOG_HELPER_KEY = "nme_fog";
const FOG_HELPER_WGSL = `
fn nme_fogFactor(worldPos: vec3<f32>, cameraPos: vec3<f32>, fogParams: vec4<f32>) -> f32 {
    let dist = distance(worldPos, cameraPos);
    let mode = fogParams.x;
    let density = fogParams.y;
    let fstart = fogParams.z;
    let fend = fogParams.w;
    // mode: 1=EXP, 2=EXP2, 3=LINEAR
    if (mode < 1.5) {
        return clamp(exp(-dist * density), 0.0, 1.0);
    }
    if (mode < 2.5) {
        let d = dist * density;
        return clamp(exp(-d * d), 0.0, 1.0);
    }
    return clamp((fend - dist) / (fend - fstart), 0.0, 1.0);
}
`;

export const emitter: BlockEmitter = {
    className: "FogBlock",
    stage: "fragment",
    emit(block, _outputName, stage, state, ctx) {
        state.fragment.helpers.set(FOG_HELPER_KEY, FOG_HELPER_WGSL);
        const wp = ctx.cast(ctx.resolve(block, "worldPosition", stage, state), "vec3f").expr;
        const input = ctx.resolve(block, "input", stage, state);
        const fogColor = ctx.cast(ctx.resolve(block, "fogColor", stage, state), "vec3f").expr;
        const inType = input.type === "vec4f" ? "vec4f" : "vec3f";
        const inVec3 = ctx.cast(input, "vec3f").expr;
        const factor = `nme_fogFactor(${wp}, _NME_CAMERA_POS_, _NME_FOG_PARAMS_)`;
        const mixed = `mix(${fogColor}, ${inVec3}, ${factor})`;
        if (inType === "vec4f") {
            return { expr: `vec4<f32>(${mixed}, (${input.expr}).w)`, type: "vec4f" };
        }
        return { expr: mixed, type: "vec3f" };
    },
};
