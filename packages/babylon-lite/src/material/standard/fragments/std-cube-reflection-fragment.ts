/** Cube reflection fragment — dynamically imported for scenes with cube reflection textures. */
import type { ShaderFragment } from "../../../shader/fragment-types.js";
import type { StdExt } from "../standard-flags.js";
import { HAS_CUBE_REFLECTION } from "../standard-flags.js";

export function createStdCubeReflectionFragment(): ShaderFragment {
    return {
        _id: "std-cube-reflection",
        _bindings: [
            { _name: "cRT", _type: { _kind: "texture", _textureType: "texture_cube<f32>" }, _visibility: 0x2 },
            { _name: "cRS", _type: { _kind: "sampler", _samplerType: "sampler" }, _visibility: 0x2 },
        ],
        _fragmentSlots: {
            AD: `{let v=normalize(input.vp-scene.vEyePosition.xyz);reflectionColor=textureSample(cRT,cRS,reflect(v,normalW)).rgb*mat.rLvl;}`,
        },
    };
}

export const stdCubeReflectionExt: StdExt = {
    _id: "std-cube-reflection",
    _phase: "mesh",
    _feature: HAS_CUBE_REFLECTION,
    _frag: createStdCubeReflectionFragment,
    _bind(mat, entries, b) {
        const cube = mat.reflectionCubeTexture!;
        entries.push({ binding: b++, resource: cube.view });
        entries.push({ binding: b++, resource: cube.sampler });
        return b;
    },
    // Cube textures are tracked separately; no Texture2D[] contribution.
};
