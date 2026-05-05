/** LightBlock — classic Blinn-Phong lighting.
 *
 *  Inputs: worldPosition, worldNormal, cameraPosition, glossiness, glossPower
 *  (optional), diffuseColor, specularColor.
 *  Outputs: diffuseOutput (vec3), specularOutput (vec3), shadow (f32).
 *
 *  The actual math lives in `_lighting-helper.ts` and is injected into the
 *  fragment helper map. The pipeline builder is responsible for binding the
 *  scene's Lights UBO under `nmeLights` / `nmeLightsCount` at group/binding
 *  slots reserved for NME.
 */

import type { BlockEmitter, NodeExpr } from "../node-types.js";
import { NME_LIGHTING_HELPER_KEY, NME_LIGHTING_HELPER_WGSL } from "./_lighting-helper.js";
import { MAX_LIGHTS } from "../../../light/types.js";

const SHADOW_FACTORS_ONE = `array<f32, ${MAX_LIGHTS}>(${new Array(MAX_LIGHTS).fill("1.0").join(", ")})`;

function resolveOptional(
    block: Parameters<BlockEmitter["emit"]>[0],
    inputName: string,
    fallback: string,
    stage: Parameters<BlockEmitter["emit"]>[2],
    state: Parameters<BlockEmitter["emit"]>[3],
    ctx: Parameters<BlockEmitter["emit"]>[4],
    target: "vec3f" | "f32"
): string {
    const input = block.inputs.get(inputName);
    if (input?.source) {
        return ctx.cast(ctx.resolve(block, inputName, stage, state), target).expr;
    }
    return fallback;
}

export const emitter: BlockEmitter = {
    className: "LightBlock",
    stage: "fragment",
    emit(block, outputName, stage, state, ctx) {
        // Inject helper + mark the lights UBO as required.
        state.fragment.helpers.set(NME_LIGHTING_HELPER_KEY, NME_LIGHTING_HELPER_WGSL);
        state.usesLightsUbo = true;

        const memoKey = `_light_${block.id}_call`;
        const callExpr = state.fragment.memo.get(memoKey);
        let callVar: string;
        if (!callExpr) {
            const wp = resolveOptional(block, "worldPosition", "vec3<f32>(0.0)", stage, state, ctx, "vec3f");
            const wn = resolveOptional(block, "worldNormal", "vec3<f32>(0.0, 1.0, 0.0)", stage, state, ctx, "vec3f");
            const cp = resolveOptional(block, "cameraPosition", "_NME_CAMERA_POS_", stage, state, ctx, "vec3f");
            const dc = resolveOptional(block, "diffuseColor", "vec3<f32>(1.0)", stage, state, ctx, "vec3f");
            const sc = resolveOptional(block, "specularColor", "vec3<f32>(1.0)", stage, state, ctx, "vec3f");
            const gl = resolveOptional(block, "glossiness", "1.0", stage, state, ctx, "f32");
            // BJS multiplies glossiness * glossPower; default glossPower is 1024 when unconnected.
            const gp = resolveOptional(block, "glossPower", "1024.0", stage, state, ctx, "f32");
            const sf = state.shadowLights.length > 0 ? `nme_computeShadowFactors(in)` : SHADOW_FACTORS_ONE;
            callVar = `_lt${ctx.temp(state, "light")}`;
            state.fragment.body.push(`let ${callVar} = nme_computeLighting(${wp}, ${wn}, ${cp}, ${dc}, ${sc}, (${gl}) * (${gp}), ${sf});`);
            state.fragment.memo.set(memoKey, { expr: callVar, type: "vec4f" });
        } else {
            callVar = callExpr.expr;
        }

        const out: Record<string, NodeExpr> = {
            diffuseOutput: { expr: `${callVar}.diffuse`, type: "vec3f" },
            specularOutput: { expr: `${callVar}.specular`, type: "vec3f" },
            shadow: { expr: `${callVar}.shadow`, type: "f32" },
        };
        return out[outputName] ?? { expr: `${callVar}.diffuse`, type: "vec3f" };
    },
};
