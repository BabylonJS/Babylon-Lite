import type { BlockEmitter, NodeBlock, NodeBuildState, NodeEmitContext, Stage } from "../node-types.js";
import { MAX_LIGHTS } from "../../../light/types.js";
import { buildPbrMrHelperFull } from "./pbr-mr-helper-full.js";

const HELPER_KEY_PREFIX = "nme_pbr_mr";
const SHADOW_FACTORS_ONE = `array<f32, ${MAX_LIGHTS}>(${/* @__PURE__ */ new Array(MAX_LIGHTS).fill("1.0").join(", ")})`;

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
        const reflectionConnected = !!block.inputs.get("reflection")?.source;
        if (reflectionConnected) {
            state.usesEnv = true;
            ctx.resolve(block, "reflection", stage, state);
        }
        const ccInputRef = block.inputs.get("clearcoat")?.source;
        let ccIntensityExpr = "0.0";
        let ccRoughnessExpr = "0.0";
        let ccIorExpr = "1.5";
        let ccBumpExpr = "v3(0.5, 0.5, 1.0)";
        let ccBumpUvExpr = "v2(0.0)";
        let useCcBump = false;
        let ccTintColorExpr = "v3(1.0)";
        let ccTintAtDistanceExpr = "1.0";
        let ccTintThicknessExpr = "0.0";
        let useCcTint = false;
        let useClearcoat = false;
        let remapClearcoatF0 = false;
        if (ccInputRef) {
            const ccBlock = ctx.graph.blocks.get(ccInputRef.blockId);
            if (ccBlock && ccBlock.className === "ClearCoatBlock") {
                useClearcoat = true;
                remapClearcoatF0 = (ccBlock.serialized as { remapF0OnInterfaceChange?: boolean }).remapF0OnInterfaceChange === true;
                state.usesClearcoat = true;
                ctx.resolveOutput(ccBlock, ccInputRef.outputName, stage, state);
                ccIntensityExpr = resolveOptional(ccBlock, "intensity", "1.0", "f32", stage, state, ctx);
                ccRoughnessExpr = resolveOptional(ccBlock, "roughness", "0.0", "f32", stage, state, ctx);
                ccIorExpr = resolveOptional(ccBlock, "indexOfRefraction", "1.5", "f32", stage, state, ctx);
                if (ccBlock.inputs.get("normalMapColor")?.source) {
                    useCcBump = true;
                    ccBumpExpr = resolveOptional(ccBlock, "normalMapColor", "v3(0.5, 0.5, 1.0)", "vec3f", stage, state, ctx);
                    const uvIn = ccBlock.inputs.get("uv");
                    if (uvIn?.source) {
                        const e = ctx.resolve(ccBlock, "uv", stage, state);
                        ccBumpUvExpr = e.type === "vec2f" ? e.expr : `(${e.expr}).xy`;
                    }
                }
                if (ccBlock.inputs.get("tintColor")?.source) {
                    useCcTint = true;
                    ccTintColorExpr = resolveOptional(ccBlock, "tintColor", "v3(1.0)", "vec3f", stage, state, ctx);
                    ccTintAtDistanceExpr = resolveOptional(ccBlock, "tintAtDistance", "1.0", "f32", stage, state, ctx);
                    ccTintThicknessExpr = resolveOptional(ccBlock, "tintThickness", "0.0", "f32", stage, state, ctx);
                }
            }
        }
        const shInputRef = block.inputs.get("sheen")?.source;
        let shIntensityExpr = "0.0";
        let shColorExpr = "v3(1.0)";
        let shRoughnessExpr = "0.0";
        let useSheen = false;
        let useShAlbedoScaling = false;
        if (shInputRef) {
            const shBlock = ctx.graph.blocks.get(shInputRef.blockId);
            if (shBlock && shBlock.className === "SheenBlock") {
                useSheen = true;
                state.usesSheen = true;
                useShAlbedoScaling = (shBlock.serialized as { albedoScaling?: boolean }).albedoScaling === true;
                ctx.resolveOutput(shBlock, shInputRef.outputName, stage, state);
                shIntensityExpr = resolveOptional(shBlock, "intensity", "1.0", "f32", stage, state, ctx);
                shColorExpr = resolveOptional(shBlock, "color", "v3(1.0)", "vec3f", stage, state, ctx);
                const shrIn = shBlock.inputs.get("roughness");
                shRoughnessExpr = shrIn?.source
                    ? resolveOptional(shBlock, "roughness", "0.0", "f32", stage, state, ctx)
                    : `clamp(${resolveOptional(block, "roughness", "0.5", "f32", stage, state, ctx)}, 0.0, 1.0)`;
            }
        }
        const ssInputRef = block.inputs.get("subsurface")?.source;
        let useSubsurface = false;
        let useRefraction = false;
        let ssTintColorExpr = "v3(1.0)";
        let ssThicknessExpr = "0.0";
        let ssTranslucencyIntensityExpr = "0.0";
        let ssDiffusionDistExpr = "v3(1.0)";
        let refrIntensityExpr = "0.0";
        let refrIorExpr = resolveOptional(block, "indexOfRefraction", "1.5", "f32", stage, state, ctx);
        let refrTintAtDistanceExpr = "1.0";
        if (ssInputRef) {
            const ssBlk = ctx.graph.blocks.get(ssInputRef.blockId);
            if (ssBlk && ssBlk.className === "SubSurfaceBlock") {
                useSubsurface = true;
                state.usesSubsurface = true;
                ctx.resolveOutput(ssBlk, ssInputRef.outputName, stage, state);
                ssTintColorExpr = resolveOptional(ssBlk, "tintColor", "v3(1.0)", "vec3f", stage, state, ctx);
                ssThicknessExpr = resolveOptional(ssBlk, "thickness", "0.0", "f32", stage, state, ctx);
                ssTranslucencyIntensityExpr = resolveOptional(ssBlk, "translucencyIntensity", "0.0", "f32", stage, state, ctx);
                ssDiffusionDistExpr = resolveOptional(ssBlk, "translucencyDiffusionDist", "v3(1.0)", "vec3f", stage, state, ctx);
                const refrInputRef = ssBlk.inputs.get("refraction")?.source;
                if (refrInputRef) {
                    const refrBlk = ctx.graph.blocks.get(refrInputRef.blockId);
                    if (refrBlk && refrBlk.className === "RefractionBlock") {
                        useRefraction = true;
                        ctx.resolveOutput(refrBlk, refrInputRef.outputName, stage, state);
                        refrIntensityExpr = resolveOptional(refrBlk, "intensity", "1.0", "f32", stage, state, ctx);
                        refrTintAtDistanceExpr = resolveOptional(refrBlk, "tintAtDistance", "1.0", "f32", stage, state, ctx);
                        const volIor = refrBlk.inputs.get("volumeIndexOfRefraction");
                        if (volIor?.source) {
                            refrIorExpr = resolveOptional(refrBlk, "volumeIndexOfRefraction", "1.5", "f32", stage, state, ctx);
                        }
                    }
                }
            }
        }
        const aniInputRef = block.inputs.get("anisotropy")?.source;
        let useAnisotropy = false;
        let anisoIntensityExpr = "0.0";
        let anisoDirectionExpr = "v2(1.0, 0.0)";
        let anisoUvExpr = "v2(0.0)";
        if (aniInputRef) {
            const aniBlk = ctx.graph.blocks.get(aniInputRef.blockId);
            if (aniBlk && aniBlk.className === "AnisotropyBlock") {
                useAnisotropy = true;
                state.usesAnisotropy = true;
                ctx.resolveOutput(aniBlk, aniInputRef.outputName, stage, state);
                anisoIntensityExpr = resolveOptional(aniBlk, "intensity", "0.0", "f32", stage, state, ctx);
                anisoDirectionExpr = resolveOptional(aniBlk, "direction", "v2(1.0, 0.0)", "vec3f", stage, state, ctx);
                const dirIn = aniBlk.inputs.get("direction");
                if (dirIn?.source) {
                    const e = ctx.resolve(aniBlk, "direction", stage, state);
                    anisoDirectionExpr = e.type === "vec2f" ? e.expr : `(${e.expr}).xy`;
                }
                const uvIn = aniBlk.inputs.get("uv");
                if (uvIn?.source) {
                    const e = ctx.resolve(aniBlk, "uv", stage, state);
                    anisoUvExpr = e.type === "vec2f" ? e.expr : `(${e.expr}).xy`;
                }
            }
        }
        const iriInputRef = block.inputs.get("iridescence")?.source;
        let useIridescence = false;
        let iriIntensityExpr = "1.0";
        let iriIorExpr = "1.3";
        let iriThicknessExpr = "400.0";
        if (iriInputRef) {
            const iriBlk = ctx.graph.blocks.get(iriInputRef.blockId);
            if (iriBlk && iriBlk.className === "IridescenceBlock") {
                useIridescence = true;
                state.usesIridescence = true;
                ctx.resolveOutput(iriBlk, iriInputRef.outputName, stage, state);
                iriIntensityExpr = resolveOptional(iriBlk, "intensity", "1.0", "f32", stage, state, ctx);
                iriIorExpr = resolveOptional(iriBlk, "indexOfRefraction", "1.3", "f32", stage, state, ctx);
                iriThicknessExpr = resolveOptional(iriBlk, "thickness", "400.0", "f32", stage, state, ctx);
            }
        }
        const useSpecularAA = (block.serialized as { enableSpecularAntiAliasing?: boolean }).enableSpecularAntiAliasing === true;
        const helperKey = `${HELPER_KEY_PREFIX}_${reflectionConnected ? "env" : "noenv"}_${useClearcoat ? "cc" : "nocc"}_${remapClearcoatF0 ? "ccF0R" : "ccF0"}_${useSheen ? "sh" : "nosh"}_${useRefraction ? "refr" : "norefr"}_${useSubsurface ? "ss" : "noss"}_${useAnisotropy ? "ani" : "noani"}_${useIridescence ? "iri" : "noiri"}_${useShAlbedoScaling ? "shAS" : "noShAS"}_${useCcBump ? "ccB" : ""}_${useCcTint ? "ccT" : ""}_${useSpecularAA ? "aa" : "noaa"}`;
        state.fragment.helpers.set(
            helperKey,
            buildPbrMrHelperFull({
                key: helperKey,
                useEnv: reflectionConnected,
                useClearcoat,
                useSheen,
                useRefraction,
                useSubsurface,
                useAnisotropy,
                useIridescence,
                useShAlbedoScaling,
                useCcBump,
                useCcTint,
                useSpecularAA,
                remapClearcoatF0,
            })
        );
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
                `let ${callVar} = nme_pbr_mr_compute(${wp}, ${gn}, ${wn}, ${cp}, ${bc}, ${me}, ${ro}, ${ao}, ${ccIntensityExpr}, ${ccRoughnessExpr}, ${ccIorExpr}, ${ccBumpExpr}, ${ccBumpUvExpr}, ${ccTintColorExpr}, ${ccTintAtDistanceExpr}, ${ccTintThicknessExpr}, ${shIntensityExpr}, ${shColorExpr}, ${shRoughnessExpr}, ${baseIorExpr}, ${refrIntensityExpr}, ${refrIorExpr}, ${refrTintAtDistanceExpr}, ${ssTintColorExpr}, ${ssThicknessExpr}, ${ssTranslucencyIntensityExpr}, ${ssDiffusionDistExpr}, ${anisoIntensityExpr}, ${anisoDirectionExpr}, ${anisoUvExpr}, ${iriIntensityExpr}, ${iriIorExpr}, ${iriThicknessExpr}, ${sf});`
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
