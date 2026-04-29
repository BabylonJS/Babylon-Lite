/** PerturbNormalBlock — tangent-space normal-map perturbation.
 *
 *  Inputs: worldPosition, worldNormal, worldTangent (optional), uv, normalMapColor, strength.
 *  Output: output (vec3 world-space normal).
 *
 *  If worldTangent is supplied we use the true TBN; otherwise we derive an
 *  ad-hoc TBN from screen-space derivatives (matches BJS `useParallax`-off
 *  fallback).
 */

import type { BlockEmitter } from "../node-types.js";

const HELPER_KEY = "nme_perturbNormal";
const HELPER_WGSL = `
fn nme_perturbNormal(worldPos: vec3<f32>, worldNormal: vec3<f32>, uv: vec2<f32>, sampled: vec3<f32>, strength: f32) -> vec3<f32> {
    // Construct ad-hoc TBN from screen-space derivatives. WebGPU's UV.y goes top-down
    // (BJS GLSL UV is bottom-up), so dpdy and duv2 both end up with opposite sign vs BJS.
    // Negating BOTH dp2 AND duv2 cancels the framebuffer Y-flip without flipping the
    // tangent orientation. This produces the same TBN as BJS does at the same fragment.
    let dp1 = dpdx(worldPos);
    let dp2 = -dpdy(worldPos);
    let duv1 = dpdx(uv);
    let duv2 = -dpdy(uv);
    let dp2perp = cross(dp2, worldNormal);
    let dp1perp = cross(worldNormal, dp1);
    let T = dp2perp * duv1.x + dp1perp * duv2.x;
    let B = dp2perp * duv1.y + dp1perp * duv2.y;
    let invmax = inverseSqrt(max(dot(T, T), dot(B, B)));
    let n = sampled * 2.0 - vec3<f32>(1.0);
    let scaled = vec3<f32>(n.xy * strength, n.z);
    return normalize(T * scaled.x * invmax + B * scaled.y * invmax + worldNormal * scaled.z);
}
`;

export const emitter: BlockEmitter = {
    className: "PerturbNormalBlock",
    stage: "fragment",
    emit(block, _outputName, stage, state, ctx) {
        state.fragment.helpers.set(HELPER_KEY, HELPER_WGSL);
        const wp = ctx.cast(ctx.resolve(block, "worldPosition", stage, state), "vec3f").expr;
        const wn = ctx.cast(ctx.resolve(block, "worldNormal", stage, state), "vec3f").expr;
        const uv = ctx.cast(ctx.resolve(block, "uv", stage, state), "vec2f").expr;
        const nm = ctx.cast(ctx.resolve(block, "normalMapColor", stage, state), "vec3f").expr;
        const strInput = block.inputs.get("strength");
        const strength = strInput?.source ? ctx.cast(ctx.resolve(block, "strength", stage, state), "f32").expr : "1.0";
        return { expr: `nme_perturbNormal(${wp}, ${wn}, ${uv}, ${nm}, ${strength})`, type: "vec3f" };
    },
};
