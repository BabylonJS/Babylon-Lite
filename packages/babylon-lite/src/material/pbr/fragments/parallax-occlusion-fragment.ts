import type { ShaderFragment } from "../../../shader/fragment-types.js";
import type { PbrExt } from "../pbr-flags.js";
import { PBR2_ESM_SHADOW_OUTPUT, PBR2_NO_COLOR_OUTPUT } from "../pbr-flag-bits.js";
import type { PbrMaterialProps } from "../pbr-material.js";
import { MSH_FLAT_NORMAL } from "../../mesh-features.js";
import { _getParallaxHeightTexture, _PARALLAX_UBO_FIELDS, _writeParallaxUniforms } from "../../parallax/parallax-occlusion.js";
import { _PARALLAX_WGSL } from "../../parallax/parallax-occlusion-wgsl.js";
import { _patchParallaxShader } from "../../parallax/parallax-occlusion-shader.js";

// Material bank bit 5; fog uses bit 5 in the separate sceneFeatures bank.
const PBR_HAS_PARALLAX_OCCLUSION = 1 << 5;
const CASTER_FLAGS = PBR2_NO_COLOR_OUTPUT | PBR2_ESM_SHADOW_OUTPUT;
const STAGE_FRAGMENT = 0x2;
const SURFACE_TEXTURES = [
    "baseColorTexture",
    "ormTexture",
    "normalTexture",
    "emissiveTexture",
    "specGlossTexture",
    "occlusionTexture",
    "lmTexture",
    "ccIntensityTexture",
    "ccRoughnessTexture",
    "ccNormalTexture",
    "sheenTexture_",
    "sheenRoughTexture_",
    "reflectanceMap",
    "metallicReflectanceMap",
    "anisotropyTexture_",
    "iridescenceTexture",
    "iridescenceThicknessTexture",
    "thicknessTexture_",
    "refractionMapTexture",
    "translucencyColorTexture_",
    "translucencyIntensityTexture_",
];

/** @internal Opt-in PBR parallax extension; no registration at module load. */
export const pbrParallaxOcclusionExt: PbrExt = {
    id: "parallax-occlusion",
    phase: "fragment",
    detect(material) {
        const props = (material as PbrMaterialProps)._parallaxOcclusion;
        return { f: props && (props.heightScale ?? 0.05) !== 0 ? PBR_HAS_PARALLAX_OCCLUSION : 0, f2: 0 };
    },
    frag(ctx): ShaderFragment | null {
        if (!(ctx._features & PBR_HAS_PARALLAX_OCCLUSION) || ctx._features2 & CASTER_FLAGS) {
            return null;
        }
        return {
            _id: "parallax-occlusion",
            _uboFields: _PARALLAX_UBO_FIELDS,
            _bindings: [
                { _name: "parallaxHeightTexture", _type: { _kind: "texture", _textureType: "texture_2d<f32>" }, _visibility: STAGE_FRAGMENT },
                { _name: "parallaxHeightSampler", _type: { _kind: "sampler", _samplerType: "sampler" }, _visibility: STAGE_FRAGMENT },
            ],
            _helperFunctions: _PARALLAX_WGSL,
            _pc: (composed) =>
                _patchParallaxShader(composed, {
                    _position: "input.worldPos",
                    _normal: ctx._meshFeatures & MSH_FLAT_NORMAL ? "cross(dpdx(input.worldPos),dpdy(input.worldPos))" : "input.worldNormal",
                    _uv: "input.uv",
                    _uniform: "material",
                    _surfaceTextures: SURFACE_TEXTURES,
                }),
        };
    },
    writeUbo(data, material, offsets) {
        // Every registered extension sees every PBR UBO write; skip the offset lookup for non-POM materials.
        const props = (material as PbrMaterialProps)._parallaxOcclusion;
        if (!props) {
            return;
        }
        const height = offsets.get("parallaxHeight");
        if (height === undefined) {
            return;
        }
        _writeParallaxUniforms(data, props, height / 4, offsets.get("parallaxSampling")! / 4, offsets.get("parallaxUVm")! / 4, offsets.get("parallaxUVt")! / 4);
    },
    bind(ctx, entries, binding) {
        if (!(ctx._features & PBR_HAS_PARALLAX_OCCLUSION) || ctx._features2 & CASTER_FLAGS) {
            return binding;
        }
        const props = (ctx._material as PbrMaterialProps)._parallaxOcclusion;
        if (!props) {
            throw new Error("PBR parallax settings changed after compilation; rebuild the material before rendering.");
        }
        entries.push({ binding: binding++, resource: props.heightTexture.view }, { binding: binding++, resource: props.heightTexture.sampler });
        return binding;
    },
    textures(material, out) {
        const height = _getParallaxHeightTexture(material as PbrMaterialProps);
        if (height) {
            out.push(height);
        }
    },
};
