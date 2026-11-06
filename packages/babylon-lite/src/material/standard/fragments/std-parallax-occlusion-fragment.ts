import type { ShaderFragment } from "../../../shader/fragment-types.js";
import { ESM_SHADOW_OUTPUT, HAS_BUMP_TEXTURE, NO_COLOR_OUTPUT, type StdExt } from "../standard-flags.js";
import { createUniformBuffer } from "../../../resource/uniform-buffer.js";
import { _getStandardParallaxHeightTexture, _writeParallaxUniforms } from "../../parallax/parallax-occlusion.js";
import { _PARALLAX_WGSL } from "../../parallax/parallax-occlusion-wgsl.js";
import { _patchParallaxShader } from "../../parallax/parallax-occlusion-shader.js";
import { wgsl } from "../../../shader/wgsl.js";
import { writeStandardUvTransformData } from "../standard-pipeline.js";

const STD_HAS_PARALLAX_OCCLUSION = 1 << 31;
const CASTER_FLAGS = NO_COLOR_OUTPUT | ESM_SHADOW_OUTPUT;
const STAGE_FRAGMENT = 0x2;
const SURFACE_TEXTURES = ["dT", "eT", "bT", "sT", "aT", "lT", "oT"];

/** @internal Opt-in Standard parallax extension; no registration at module load. */
export const stdParallaxOcclusionExt: StdExt = {
    _id: "parallax-occlusion",
    _phase: "mesh",
    _feature: STD_HAS_PARALLAX_OCCLUSION,
    _detect: (material) => (_getStandardParallaxHeightTexture(material) ? STD_HAS_PARALLAX_OCCLUSION : 0),
    _frag(features): ShaderFragment {
        if (features & CASTER_FLAGS) {
            return { _id: "parallax-occlusion" };
        }
        return {
            _id: "parallax-occlusion",
            _varyings: [{ _name: "parallaxBaseUV", _type: "vec2<f32>" }],
            _vertexSlots: { VB: wgsl`out.parallaxBaseUV=uv;` },
            _bindings: [
                { _name: "parallaxParams", _type: { _kind: "uniform-buffer" }, _visibility: STAGE_FRAGMENT },
                { _name: "parallaxHeightTexture", _type: { _kind: "texture", _textureType: "texture_2d<f32>" }, _visibility: STAGE_FRAGMENT },
                { _name: "parallaxHeightSampler", _type: { _kind: "sampler", _samplerType: "sampler" }, _visibility: STAGE_FRAGMENT },
            ],
            _helperFunctions: wgsl`struct parallaxParamsUniforms {
parallaxHeight:vec4f,
parallaxSampling:vec4f,
parallaxUVm:vec4f,
parallaxUVt:vec4f,
}
${_PARALLAX_WGSL}`,
            _pc: (composed) =>
                _patchParallaxShader(composed, {
                    _position: "input.vp",
                    _normal: "input.vn",
                    _uv: "input.parallaxBaseUV",
                    _uniform: "parallaxParams",
                    _surfaceTextures: SURFACE_TEXTURES,
                    _standardBump: (features & HAS_BUMP_TEXTURE) !== 0,
                }),
        };
    },
    _bind(material, entries, binding, _mesh, scene, disposers) {
        if ((material._renderFeatures?.features ?? 0) & CASTER_FLAGS) {
            return binding;
        }
        if (!scene || !disposers) {
            throw new Error("Standard parallax binding requires the owning scene and resource disposers.");
        }
        const props = material._parallaxOcclusion;
        if (!props) {
            throw new Error("Standard parallax settings changed after compilation; rebuild the material before rendering.");
        }
        const data = new Float32Array(16);
        // Reuse the feature UBO's first vec4 as scratch for the surface's base transform.
        if (material._hasUvTx) {
            data[0] = material.uvScale[0];
            data[1] = material.uvScale[1];
            data[2] = material.uvOffset?.[0] ?? 0;
            data[3] = material.uvOffset?.[1] ?? 0;
        } else {
            writeStandardUvTransformData(data, material, props.heightTexture.invertY === true);
        }
        _writeParallaxUniforms(data, props, 0, 4, 8, 12, data, material._hasUvTx === true && props.heightTexture.invertY === true);
        const buffer = createUniformBuffer(scene.surface.engine, data);
        disposers.push(() => buffer.destroy());
        entries.push(
            { binding: binding++, resource: { buffer } },
            { binding: binding++, resource: props.heightTexture.view },
            { binding: binding++, resource: props.heightTexture.sampler }
        );
        return binding;
    },
    _textures(material, out) {
        const height = _getStandardParallaxHeightTexture(material);
        if (height) {
            out.push(height);
        }
    },
};
