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
        // Inject helper + memoize call per-block.
        state.fragment.helpers.set(NME_LIGHTING_HELPER_KEY, NME_LIGHTING_HELPER_WGSL);

        const memoKey = `_light_${block.id}_call`;
        let callVar = state.fragment.helpers.get(memoKey);
        if (!callVar) {
            const wp = resolveOptional(block, "worldPosition", "vec3<f32>(0.0)", stage, state, ctx, "vec3f");
            const wn = resolveOptional(block, "worldNormal", "vec3<f32>(0.0, 1.0, 0.0)", stage, state, ctx, "vec3f");
            const cp = resolveOptional(block, "cameraPosition", "_NME_CAMERA_POS_", stage, state, ctx, "vec3f");
            const dc = resolveOptional(block, "diffuseColor", "vec3<f32>(1.0)", stage, state, ctx, "vec3f");
            const sc = resolveOptional(block, "specularColor", "vec3<f32>(1.0)", stage, state, ctx, "vec3f");
            const gl = resolveOptional(block, "glossiness", "0.5", stage, state, ctx, "f32");
            callVar = `_lt${ctx.temp(state, "light")}`;
            state.fragment.body.push(`let ${callVar} = nme_computeLighting(${wp}, ${wn}, ${cp}, ${dc}, ${sc}, ${gl});`);
            state.fragment.helpers.set(memoKey, callVar);
        }

        const out: Record<string, NodeExpr> = {
            diffuseOutput: { expr: `${callVar}.diffuse`, type: "vec3f" },
            specularOutput: { expr: `${callVar}.specular`, type: "vec3f" },
            shadow: { expr: "1.0", type: "f32" }, // placeholder until ShadowMapBlock lands
        };
        return out[outputName] ?? { expr: `${callVar}.diffuse`, type: "vec3f" };
    },
};
