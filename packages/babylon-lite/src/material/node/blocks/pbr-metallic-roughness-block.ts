import type { BlockEmitter, NodeBlock, NodeBuildState, NodeEmitContext, Stage } from "../node-types.js";
import { MAX_LIGHTS } from "../../../light/types.js";

const HELPER_KEY_PREFIX = "nme_pbr_mr";
const SHADOW_FACTORS_ONE = `array<f32, ${MAX_LIGHTS}>(${new Array(MAX_LIGHTS).fill("1.0").join(", ")})`;

function resolveOptional(block: NodeBlock, inputName: string, fallback: string, target: "vec3f" | "f32", stage: Stage, state: NodeBuildState, ctx: NodeEmitContext): string {
    const input = block.inputs.get(inputName);
    if (input?.source) {
        return ctx.cast(ctx.resolve(block, inputName, stage, state), target).expr;
    }
    return fallback;
}

export const emitter: BlockEmitter = {
    className: "PBRMetallicRoughnessBlock",
    stage: "fragment",
    emit(block, outputName, stage, state, ctx) {
        if (
            (block.serialized as { enableSpecularAntiAliasing?: boolean }).enableSpecularAntiAliasing === true ||
            block.inputs.get("clearcoat")?.source ||
            block.inputs.get("sheen")?.source ||
            block.inputs.get("subsurface")?.source ||
            block.inputs.get("anisotropy")?.source ||
            block.inputs.get("iridescence")?.source
        ) {
            throw new Error("NodeMaterial: PBR-MR core emitter cannot emit optional PBR feature code");
        }
        const reflectionConnected = !!block.inputs.get("reflection")?.source;
        if (reflectionConnected) {
            state.usesEnv = true;
            ctx.resolve(block, "reflection", stage, state);
        }
        const helperKey = `${HELPER_KEY_PREFIX}_${reflectionConnected ? "env" : "noenv"}_nocc_ccF0_nosh_norefr_noss_noani_noShAS___noaa`;
        if (!state.pbrMrHelperRequests.some((request) => request.key === helperKey)) {
            state.pbrMrHelperRequests.push({
                key: helperKey,
                useEnv: reflectionConnected,
                useClearcoat: false,
                useSheen: false,
                useRefraction: false,
                useSubsurface: false,
                useAnisotropy: false,
                useIridescence: false,
                useShAlbedoScaling: false,
                useCcBump: false,
                useCcTint: false,
                useSpecularAA: false,
                remapClearcoatF0: false,
            });
        }
        state.usesLightsUbo = true;

        const memoKey = `_pbrmr_${block.id}_call`;
        let callVar: string;
        const existing = state.fragment.memo.get(memoKey);
        if (existing) {
            callVar = existing.expr;
        } else {
            const wp = resolveOptional(block, "worldPosition", "v3(0.0)", "vec3f", stage, state, ctx);
            const gn = resolveOptional(block, "worldNormal", "v3(0.0, 1.0, 0.0)", "vec3f", stage, state, ctx);
            const perturbed = block.inputs.get("perturbedNormal");
            const wn = perturbed?.source ? ctx.cast(ctx.resolve(block, "perturbedNormal", stage, state), "vec3f").expr : gn;
            const cp = resolveOptional(block, "cameraPosition", "_NME_CAMERA_POS_", "vec3f", stage, state, ctx);
            const bc = resolveOptional(block, "baseColor", "v3(1.0)", "vec3f", stage, state, ctx);
            const me = resolveOptional(block, "metallic", "0.0", "f32", stage, state, ctx);
            const ro = resolveOptional(block, "roughness", "0.5", "f32", stage, state, ctx);
            const ao = resolveOptional(block, "ambientOcc", "1.0", "f32", stage, state, ctx);
            const baseIorExpr = resolveOptional(block, "indexOfRefraction", "1.5", "f32", stage, state, ctx);
            const sf = state.shadowLights.length > 0 ? `nme_computeShadowFactors(in)` : SHADOW_FACTORS_ONE;
            callVar = `_pbrR${ctx.temp(state, "pbr")}`;
            state.fragment.body.push(
                `let ${callVar} = nme_pbr_mr_compute(${wp}, ${gn}, ${wn}, ${cp}, ${bc}, ${me}, ${ro}, ${ao}, 0.0, 0.0, 1.5, v3(0.5, 0.5, 1.0), v2(0.0), v3(1.0), 1.0, 0.0, 0.0, v3(1.0), 0.0, ${baseIorExpr}, 0.0, 1.5, 1.0, v3(1.0), 0.0, 0.0, v3(1.0), 0.0, v2(1.0, 0.0), v2(0.0), ${sf});`
            );
            state.fragment.memo.set(memoKey, { expr: callVar, type: "vec4f" });
        }

        switch (outputName) {
            case "lighting":
                return { expr: `${callVar}.lighting`, type: "vec3f" };
            case "diffuseDir":
                return { expr: `${callVar}.diffuseDir`, type: "vec3f" };
            case "specularDir":
                return { expr: `${callVar}.specularDir`, type: "vec3f" };
            case "diffuseInd":
                return { expr: `${callVar}.diffuseInd`, type: "vec3f" };
            case "specularInd":
                return { expr: `${callVar}.specularInd`, type: "vec3f" };
            case "shadow":
                return { expr: `${callVar}.shadow`, type: "f32" };
            case "alpha": {
                const cfg = block.serialized as { useSpecularOverAlpha?: boolean; useRadianceOverAlpha?: boolean };
                const useOverAlpha = cfg.useSpecularOverAlpha === true || cfg.useRadianceOverAlpha === true;
                const op = block.inputs.get("opacity");
                const baseAlpha = op?.source ? ctx.cast(ctx.resolve(block, "opacity", stage, state), "f32").expr : "1.0";
                if (useOverAlpha) {
                    return { expr: `clamp(${baseAlpha} + ${callVar}.lumOverAlpha * ${callVar}.lumOverAlpha, 0.0, 1.0)`, type: "f32" };
                }
                return { expr: baseAlpha, type: "f32" };
            }
            case "ambientClr":
            case "clearcoatDir":
            case "clearcoatInd":
            case "sheenDir":
            case "sheenInd":
            case "refraction":
                return { expr: `v3(0.0)`, type: "vec3f" };
            default:
                return { expr: `${callVar}.lighting`, type: "vec3f" };
        }
    },
};
