/** PBR shader composer factory — extracts the per-feature-set shader composition
 *  from pbr-renderable.ts. All dynamic dependencies (ACES, anisotropy, shadow,
 *  multi-light, template-ext, thin-instance) are passed in via a deps object,
 *  already resolved by the caller. Nothing is snapshotted at module load. */

import type { ShaderFragment, ComposedShader } from "../../shader/fragment-types.js";
import type { PbrShadowLightSlot } from "./fragments/pbr-shadow-fragment.js";
import { composeShader } from "../../shader/shader-composer.js";
import { createPbrTemplate } from "./pbr-template.js";
import type { MeshVbLayout } from "../../mesh/mesh.js";
import {
    PBR_HAS_NORMAL_MAP,
    PBR_HAS_ALPHA_BLEND,
    PBR2_HAS_UV_TRANSFORM,
    PBR2_HAS_REFLECTANCE_FACTORS,
    PBR2_HAS_UV2,
    PBR2_HAS_BASE_COLOR_FACTOR,
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
    PBR2_ESM_SHADOW_OUTPUT,
    PBR2_NO_COLOR_OUTPUT,
} from "./pbr-flag-bits.js";
import { _getPbrExts, type _PbrFragCtx } from "./pbr-flags.js";
import {
    MSH_HAS_TANGENTS,
    MSH_HAS_MORPH_TARGETS,
    MSH_RECEIVE_SHADOWS,
    MSH_HAS_THIN_INSTANCES,
    MSH_HAS_INSTANCE_COLOR,
    MSH_HAS_VERTEX_COLOR,
    MSH_HAS_UV2,
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
    _singleLightType?: string,
    _esmShadowDepthCode?: string,
    _vbStrides?: MeshVbLayout,
    _vbKey?: string
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

    return function composePbr(
        features: number,
        features2: number = 0,
        meshFeatures = 0,
        sceneFeatures = 0,
        lightMode: PbrLightMode = 0,
        singleLightType = "",
        _esmShadowDepthCode = "",
        vbStrides?: MeshVbLayout,
        vbKey = ""
    ): ComposedShader {
        const ckey = `${features}:${features2}:${meshFeatures}:${sceneFeatures}:${lightMode}:${singleLightType}${vbKey}`;
        const cached = cache.get(ckey);
        if (cached) {
            return cached;
        }

        const has = (bit: number) => (features & bit) !== 0;
        const hasMesh = (bit: number) => (meshFeatures & bit) !== 0;
        const hasScene = (bit: number) => (sceneFeatures & bit) !== 0;
        const hasNormal = has(PBR_HAS_NORMAL_MAP) && hasMesh(MSH_HAS_TANGENTS);
        const hasCotangent = has(PBR_HAS_NORMAL_MAP) && !hasMesh(MSH_HAS_TANGENTS);
        const _hasAnyNormal = hasNormal || hasCotangent;
        const _hasReflectanceExt = has(PBR_HAS_METALLIC_REFLECTANCE_MAP | PBR_HAS_REFLECTANCE_MAP) || (features2 & PBR2_HAS_REFLECTANCE_FACTORS) !== 0;
        const _hasIbl = hasScene(PBR_HAS_ENV);
        const _hasMorph = hasMesh(MSH_HAS_MORPH_TARGETS);
        const hasShadow = hasMesh(MSH_RECEIVE_SHADOWS);
        const _hasAnisotropy = has(PBR_HAS_ANISOTROPY);
        const _hasEmissiveColor = has(PBR_HAS_EMISSIVE_COLOR);
        const _hasEmissiveTexture = has(PBR_HAS_EMISSIVE);
        const hasTI = hasMesh(MSH_HAS_THIN_INSTANCES);

        const _hasUvTransform = (features2 & PBR2_HAS_UV_TRANSFORM) !== 0;
        const _hasVertexColor = hasMesh(MSH_HAS_VERTEX_COLOR);
        const _hasUv2 = (features2 & PBR2_HAS_UV2) !== 0 && hasMesh(MSH_HAS_UV2);
        const needsExt = _hasUvTransform || _hasVertexColor || _hasUv2;
        const _hasSpecularAA = has(PBR_HAS_SPECULAR_AA);
        const _ext =
            needsExt && _createPbrTemplateExt
                ? _createPbrTemplateExt({
                      _hasUvTransform,
                      _hasVertexColor,
                      _hasUv2,
                      _hasOcclusionUv2: _hasUv2,
                      _hasAnyNormal,
                      _hasEmissiveTexture,
                      _hasSpecGloss: has(PBR_HAS_SPEC_GLOSS),
                  })
                : undefined;

        const template = createPbrTemplate({
            _hasSingleLight: lightMode === 1,
            _hasMultiLight: lightMode === 2,
            _singleLightWGSL,
            _singleLightBlock: lightMode === 1 && _getSingleLightBlock ? _getSingleLightBlock(singleLightType) : "",
            _multiLightWGSL,
            _multiLightLoop,
            _normalMode: hasNormal ? "tangent" : hasCotangent ? "cotangent" : "none",
            _hasEmissiveTexture,
            _hasSpecGloss: has(PBR_HAS_SPEC_GLOSS),
            _hasDoubleSided: has(PBR_HAS_DOUBLE_SIDED),
            _hasTonemap: hasScene(PBR_HAS_TONEMAP),
            _acesHelpers: _acesHelpers,
            _acesTonemapCall: _acesTonemapCall,
            _hasAlphaBlend: has(PBR_HAS_ALPHA_BLEND),
            _hasSpecularAA,
            _hasGammaAlbedo: has(PBR_HAS_GAMMA_ALBEDO),
            _hasBaseColorFactor: (features2 & PBR2_HAS_BASE_COLOR_FACTOR) !== 0,
            _hasMorph,
            _hasOcclusion: has(PBR_HAS_OCCLUSION) && !_hasReflectanceExt,
            _hasEmissiveColor,
            _hasReflectanceExt,
            _hasIbl,
            _hasAnisotropy,
            _anisoBrdfFunctions: _hasAnisotropy && _anisoExt ? _anisoExt.ANISO_BRDF_FUNCTIONS : "",
            _anisoTBBlock: _hasAnisotropy && _anisoExt ? _anisoExt.makeAnisotropyTBBlock(hasNormal) : "",
            _ext,
            _noColorOutput: (features2 & PBR2_NO_COLOR_OUTPUT) !== 0,
            _esmShadowOutput: (features2 & PBR2_ESM_SHADOW_OUTPUT) !== 0,
            _esmShadowDepthCode,
            _vbStrides: vbStrides,
        });

        const frags: ShaderFragment[] = [];
        const fragCtx: _PbrFragCtx = {
            _features: features,
            _features2: features2,
            _meshFeatures: meshFeatures,
            _hasIbl: _hasIbl,
            _hasAnyNormal,
            _hasSpecularAA,
            _anisoBentNormalCode: _hasAnisotropy && _anisoExt ? _anisoExt.ANISO_BENT_NORMAL : "",
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
            frags.push(_createThinInstanceFragment(hasMesh(MSH_HAS_INSTANCE_COLOR)));
        }

        const composed = composeShader(template, frags);
        cache.set(ckey, composed);
        return composed;
    };
}
