/** PBR shader composer factory — extracts the per-feature-set shader composition
 *  from pbr-renderable.ts. All dynamic dependencies (ACES, anisotropy, shadow,
 *  multi-light, template-ext, thin-instance) are passed in via a deps object,
 *  already resolved by the caller. Nothing is snapshotted at module load. */

import type { ShaderFragment, ComposedShader } from "../../shader/fragment-types.js";
import type { PbrShadowLightSlot } from "./fragments/pbr-shadow-fragment.js";
import { composeShader } from "../../shader/shader-composer.js";
import { createPbrTemplate } from "./pbr-template.js";
import {
    PBR_HAS_NORMAL_MAP,
    PBR_HAS_ALPHA_BLEND,
    PBR2_HAS_UV_TRANSFORM,
    PBR2_HAS_REFLECTANCE_FACTORS,
    PBR2_HAS_VERTEX_COLOR,
    PBR2_HAS_UV2,
    PBR_HAS_METALLIC_REFLECTANCE_MAP,
    PBR_HAS_REFLECTANCE_MAP,
    PBR_HAS_SPECULAR_AA,
    PBR_HAS_EMISSIVE_COLOR,
    PBR_HAS_GAMMA_ALBEDO,
    PBR_HAS_RECEIVE_SHADOWS,
    PBR_HAS_THIN_INSTANCES,
    PBR_HAS_INSTANCE_COLOR,
} from "./pbr-pipeline.js";
import {
    _getPbrExts,
    PBR_HAS_EMISSIVE,
    PBR_HAS_ENV,
    PBR_HAS_TONEMAP,
    PBR_HAS_MORPH_TARGETS,
    PBR_HAS_SPEC_GLOSS,
    PBR_HAS_DOUBLE_SIDED,
    PBR_HAS_COTANGENT_NORMAL,
    PBR_HAS_OCCLUSION,
    PBR_HAS_ANISOTROPY,
    PBR_HAS_SKYBOX,
    type PbrFragCtx,
} from "./pbr-flags.js";

export interface PbrComposerDeps {
    readonly singleLightWGSL: string;
    readonly getSingleLightBlock: ((type: string) => string) | null;
    readonly multiLightWGSL: string;
    readonly multiLightLoop: string;
    readonly acesHelpers: string;
    readonly acesTonemapCall: string;
    readonly createPbrTemplateExt: typeof import("./pbr-template-ext.js").createPbrTemplateExt | null;
    readonly anisoExt: typeof import("./fragments/anisotropy-fragment.js") | null;
    readonly iblSkyboxCalc: string;
    readonly createPbrShadowFragment: ((slots: PbrShadowLightSlot[]) => ShaderFragment) | null;
    readonly shadowLights: readonly { readonly lightIndex: number; readonly shadowType: import("./fragments/pbr-shadow-fragment.js").PbrShadowLightSlot["shadowType"] }[];
    readonly createThinInstanceFragment: ((hasColor: boolean) => ShaderFragment) | null;
}

export type PbrLightMode = 0 | 1 | 2;
export type PbrComposeFn = (features: number, features2?: number, lightMode?: PbrLightMode, singleLightType?: string) => ComposedShader;

/** Create a memoized shader composer for a given scene's resolved PBR deps. */
export function createPbrComposer(deps: PbrComposerDeps): PbrComposeFn {
    const cache = new Map<string, ComposedShader>();
    const {
        singleLightWGSL,
        getSingleLightBlock,
        multiLightWGSL,
        multiLightLoop,
        acesHelpers,
        acesTonemapCall,
        createPbrTemplateExt,
        anisoExt,
        iblSkyboxCalc,
        createPbrShadowFragment,
        shadowLights,
        createThinInstanceFragment,
    } = deps;

    return function composePbr(features: number, features2: number = 0, lightMode: PbrLightMode = 0, singleLightType = ""): ComposedShader {
        const ckey = `${features}:${features2}:${lightMode}:${singleLightType}`;
        const cached = cache.get(ckey);
        if (cached) {
            return cached;
        }

        const has = (bit: number) => (features & bit) !== 0;
        const hasNormal = has(PBR_HAS_NORMAL_MAP);
        const hasCotangent = has(PBR_HAS_COTANGENT_NORMAL);
        const hasReflExt = has(PBR_HAS_METALLIC_REFLECTANCE_MAP | PBR_HAS_REFLECTANCE_MAP) || (features2 & PBR2_HAS_REFLECTANCE_FACTORS) !== 0;
        const hasIbl = has(PBR_HAS_ENV);
        const hasMorph = has(PBR_HAS_MORPH_TARGETS);
        const hasShadow = has(PBR_HAS_RECEIVE_SHADOWS);
        const hasAniso = has(PBR_HAS_ANISOTROPY);
        const hasEmCol = has(PBR_HAS_EMISSIVE_COLOR);
        const hasEmTex = has(PBR_HAS_EMISSIVE);
        const hasTI = has(PBR_HAS_THIN_INSTANCES);

        const hasUvTx = (features2 & PBR2_HAS_UV_TRANSFORM) !== 0;
        const hasVC = (features2 & PBR2_HAS_VERTEX_COLOR) !== 0;
        const hasU2 = (features2 & PBR2_HAS_UV2) !== 0;
        const needsExt = hasUvTx || hasVC || hasU2;
        const ext =
            needsExt && createPbrTemplateExt
                ? createPbrTemplateExt({
                      hasUvTransform: hasUvTx,
                      hasVertexColor: hasVC,
                      hasUv2: hasU2,
                      hasOcclusionUv2: hasU2,
                      hasAnyNormal: hasNormal || hasCotangent,
                      hasEmissiveTexture: hasEmTex,
                      hasSpecGloss: has(PBR_HAS_SPEC_GLOSS),
                  })
                : undefined;

        const template = createPbrTemplate({
            hasSingleLight: lightMode === 1,
            hasMultiLight: lightMode === 2,
            singleLightWGSL,
            singleLightBlock: lightMode === 1 && getSingleLightBlock ? getSingleLightBlock(singleLightType) : "",
            multiLightWGSL,
            multiLightLoop,
            normalMode: hasNormal ? "tangent" : hasCotangent ? "cotangent" : "none",
            hasEmissiveTexture: hasEmTex,
            hasSpecGloss: has(PBR_HAS_SPEC_GLOSS),
            hasDoubleSided: has(PBR_HAS_DOUBLE_SIDED),
            hasTonemap: has(PBR_HAS_TONEMAP),
            acesHelpers,
            acesTonemapCall,
            hasAlphaBlend: has(PBR_HAS_ALPHA_BLEND),
            hasSpecularAA: has(PBR_HAS_SPECULAR_AA),
            hasGammaAlbedo: has(PBR_HAS_GAMMA_ALBEDO),
            hasMorph,
            hasOcclusion: has(PBR_HAS_OCCLUSION) && !hasReflExt,
            hasEmissiveColor: hasEmCol,
            hasReflectanceExt: hasReflExt,
            hasIbl,
            hasAnisotropy: hasAniso,
            anisoBrdfFunctions: hasAniso && anisoExt ? anisoExt.ANISO_BRDF_FUNCTIONS : "",
            anisoTBBlock: hasAniso && anisoExt ? anisoExt.makeAnisotropyTBBlock(hasNormal) : "",
            ext,
        });

        const frags: ShaderFragment[] = [];
        const hasAnyNormal = hasNormal || hasCotangent;
        const hasSpecularAAbit = has(PBR_HAS_SPECULAR_AA);
        const fragCtx: PbrFragCtx = {
            features,
            features2,
            hasIbl,
            hasAnyNormal,
            hasSpecularAA: hasSpecularAAbit,
            anisoBentNormalCode: hasAniso && anisoExt ? anisoExt.ANISO_BENT_NORMAL : "",
            iblSkyboxCalc: has(PBR_HAS_SKYBOX) ? iblSkyboxCalc : "",
        };
        // Registration order defines iteration order; callers register in composer-matching order.
        for (const regExt of _getPbrExts().values()) {
            if (regExt.frag) {
                const fr = regExt.frag(fragCtx);
                if (fr) {
                    frags.push(fr);
                }
            }
        }
        if (hasShadow && createPbrShadowFragment) {
            const slots = shadowLights.map((sl) => ({ lightIndex: sl.lightIndex, shadowType: sl.shadowType }));
            frags.push(createPbrShadowFragment(slots));
        }
        if (hasTI && createThinInstanceFragment) {
            frags.push(createThinInstanceFragment(has(PBR_HAS_INSTANCE_COLOR)));
        }

        const composed = composeShader(template, frags);
        cache.set(ckey, composed);
        return composed;
    };
}
