/** PBR shader composer factory — extracts the per-feature-set shader composition
 *  from pbr-renderable.ts. All dynamic dependencies (ACES, anisotropy, shadow,
 *  multi-light, template-ext, thin-instance) are passed in via a deps object,
 *  already resolved by the caller. Nothing is snapshotted at module load. */

import type { ShaderFragment, ComposedShader } from "../../shader/fragment-types.js";
import type { PbrShadowLightSlot } from "./fragments/pbr-shadow-fragment.js";
import { _pbrFeatureKey, _pbrShaderVariantKey } from "./pbr-material.js";
import { composeShader } from "../../shader/shader-composer.js";
import { createPbrTemplate } from "./pbr-template.js";
import {
    PBR_HAS_NORMAL_MAP,
    PBR_HAS_ALPHA_BLEND,
    PBR2_HAS_UV_TRANSFORM,
    PBR2_HAS_REFLECTANCE_FACTORS,
    PBR2_HAS_UV2,
    PBR_HAS_METALLIC_REFLECTANCE_MAP,
    PBR_HAS_REFLECTANCE_MAP,
    PBR_HAS_SPECULAR_AA,
    PBR_HAS_EMISSIVE_COLOR,
    PBR_HAS_GAMMA_ALBEDO,
    PBR_HAS_ANISOTROPY,
    PBR_HAS_DOUBLE_SIDED,
    PBR_HAS_EMISSIVE,
    PBR_HAS_ENV,
    PBR_HAS_TONEMAP,
    PBR_HAS_SPEC_GLOSS,
    PBR_HAS_OCCLUSION,
    PBR_HAS_SKYBOX,
} from "./pbr-flag-bits.js";
import { _getPbrExts, type _PbrFragCtx } from "./pbr-flags.js";
import {
    MESH_HAS_TANGENTS,
    MESH_HAS_MORPH_TARGETS,
    MESH_RECEIVE_SHADOWS,
    MESH_HAS_THIN_INSTANCES,
    MESH_HAS_INSTANCE_COLOR,
    MESH_HAS_VERTEX_COLOR,
    MESH_HAS_UV2,
} from "../mesh-features.js";

interface PbrComposerDeps {
    readonly _singleLightWGSL: string;
    readonly _getSingleLightBlock: ((type: string) => string) | null;
    readonly _multiLightWGSL: string;
    readonly _multiLightLoop: string;
    readonly _acesHelpers: string;
    readonly _acesTonemapCall: string;
    readonly _createPbrTemplateExt: typeof import("./pbr-template-ext.js").createPbrTemplateExt | null;
    readonly _anisoExt: typeof import("./fragments/anisotropy-fragment.js") | null;
    readonly _iblSkyboxCalc: string;
    readonly _createPbrShadowFragment: ((slots: PbrShadowLightSlot[]) => ShaderFragment) | null;
    readonly _shadowLights: readonly { readonly lightIndex: number; readonly shadowType: import("./fragments/pbr-shadow-fragment.js").PbrShadowLightSlot["shadowType"] }[];
    readonly _createThinInstanceFragment: ((hasColor: boolean) => ShaderFragment) | null;
}

export type PbrLightMode = 0 | 1 | 2;
type PbrComposeFn = (
    _features: number,
    _features2?: number,
    _meshFeatures?: number,
    _sceneFeatures?: number,
    _lightMode?: PbrLightMode,
    _singleLightType?: string
) => ComposedShader;

/** Create a memoized shader composer for a given scene's resolved PBR deps. */
export function createPbrComposer(deps: PbrComposerDeps): PbrComposeFn {
    const cache = new Map<string, ComposedShader>();
    const {
        _singleLightWGSL,
        _getSingleLightBlock,
        _multiLightWGSL,
        _multiLightLoop,
        _acesHelpers,
        _acesTonemapCall,
        _createPbrTemplateExt,
        _anisoExt,
        _iblSkyboxCalc,
        _createPbrShadowFragment,
        _shadowLights,
        _createThinInstanceFragment,
    } = deps;

    return function composePbr(features: number, features2: number = 0, meshFeatures = 0, sceneFeatures = 0, lightMode: PbrLightMode = 0, singleLightType = ""): ComposedShader {
        const ckey = _pbrFeatureKey(features, features2, meshFeatures, sceneFeatures, _pbrShaderVariantKey(lightMode, singleLightType));
        const cached = cache.get(ckey);
        if (cached) {
            return cached;
        }

        const has = (bit: number) => (features & bit) !== 0;
        const hasMesh = (bit: number) => (meshFeatures & bit) !== 0;
        const hasScene = (bit: number) => (sceneFeatures & bit) !== 0;
        const hasNormal = has(PBR_HAS_NORMAL_MAP) && hasMesh(MESH_HAS_TANGENTS);
        const hasCotangent = has(PBR_HAS_NORMAL_MAP) && !hasMesh(MESH_HAS_TANGENTS);
        const hasReflExt = has(PBR_HAS_METALLIC_REFLECTANCE_MAP | PBR_HAS_REFLECTANCE_MAP) || (features2 & PBR2_HAS_REFLECTANCE_FACTORS) !== 0;
        const hasIbl = hasScene(PBR_HAS_ENV);
        const hasMorph = hasMesh(MESH_HAS_MORPH_TARGETS);
        const hasShadow = hasMesh(MESH_RECEIVE_SHADOWS);
        const hasAniso = has(PBR_HAS_ANISOTROPY);
        const hasEmCol = has(PBR_HAS_EMISSIVE_COLOR);
        const hasEmTex = has(PBR_HAS_EMISSIVE);
        const hasTI = hasMesh(MESH_HAS_THIN_INSTANCES);

        const hasUvTx = (features2 & PBR2_HAS_UV_TRANSFORM) !== 0;
        const hasVC = hasMesh(MESH_HAS_VERTEX_COLOR);
        const hasU2 = (features2 & PBR2_HAS_UV2) !== 0 && hasMesh(MESH_HAS_UV2);
        const needsExt = hasUvTx || hasVC || hasU2;
        const ext =
            needsExt && _createPbrTemplateExt
                ? _createPbrTemplateExt({
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
            singleLightWGSL: _singleLightWGSL,
            singleLightBlock: lightMode === 1 && _getSingleLightBlock ? _getSingleLightBlock(singleLightType) : "",
            multiLightWGSL: _multiLightWGSL,
            multiLightLoop: _multiLightLoop,
            normalMode: hasNormal ? "tangent" : hasCotangent ? "cotangent" : "none",
            hasEmissiveTexture: hasEmTex,
            hasSpecGloss: has(PBR_HAS_SPEC_GLOSS),
            hasDoubleSided: has(PBR_HAS_DOUBLE_SIDED),
            hasTonemap: hasScene(PBR_HAS_TONEMAP),
            acesHelpers: _acesHelpers,
            acesTonemapCall: _acesTonemapCall,
            hasAlphaBlend: has(PBR_HAS_ALPHA_BLEND),
            hasSpecularAA: has(PBR_HAS_SPECULAR_AA),
            hasGammaAlbedo: has(PBR_HAS_GAMMA_ALBEDO),
            hasMorph,
            hasOcclusion: has(PBR_HAS_OCCLUSION) && !hasReflExt,
            hasEmissiveColor: hasEmCol,
            hasReflectanceExt: hasReflExt,
            hasIbl,
            hasAnisotropy: hasAniso,
            anisoBrdfFunctions: hasAniso && _anisoExt ? _anisoExt.ANISO_BRDF_FUNCTIONS : "",
            anisoTBBlock: hasAniso && _anisoExt ? _anisoExt.makeAnisotropyTBBlock(hasNormal) : "",
            ext,
        });

        const frags: ShaderFragment[] = [];
        const hasAnyNormal = hasNormal || hasCotangent;
        const hasSpecularAAbit = has(PBR_HAS_SPECULAR_AA);
        const fragCtx: _PbrFragCtx = {
            _features: features,
            _features2: features2,
            _meshFeatures: meshFeatures,
            _hasIbl: hasIbl,
            _hasAnyNormal: hasAnyNormal,
            _hasSpecularAA: hasSpecularAAbit,
            _anisoBentNormalCode: hasAniso && _anisoExt ? _anisoExt.ANISO_BENT_NORMAL : "",
            _iblSkyboxCalc: has(PBR_HAS_SKYBOX) ? _iblSkyboxCalc : "",
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
        if (hasShadow && _createPbrShadowFragment) {
            const slots = _shadowLights.map((sl) => ({ lightIndex: sl.lightIndex, shadowType: sl.shadowType }));
            frags.push(_createPbrShadowFragment(slots));
        }
        if (hasTI && _createThinInstanceFragment) {
            frags.push(_createThinInstanceFragment(hasMesh(MESH_HAS_INSTANCE_COLOR)));
        }

        const composed = composeShader(template, frags);
        cache.set(ckey, composed);
        return composed;
    };
}
