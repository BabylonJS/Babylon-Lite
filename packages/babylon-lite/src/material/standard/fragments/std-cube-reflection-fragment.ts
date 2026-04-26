/** Cube reflection fragment — dynamically imported for scenes with cube reflection textures. */
import type { ShaderFragment } from "../../../shader/fragment-types.js";
import type { StdExt } from "../standard-pipeline.js";
import { HAS_CUBE_REFLECTION } from "../standard-pipeline.js";

export function createStdCubeReflectionFragment(): ShaderFragment {
    return {
        id: "std-cube-reflection",
        bindings: [
            { name: "cRT", type: { kind: "texture", textureType: "texture_cube<f32>" }, visibility: 0x2 },
            { name: "cRS", type: { kind: "sampler", samplerType: "sampler" }, visibility: 0x2 },
        ],
        fragmentSlots: {
            AD: `{let v=normalize(input.vPositionW-scene.vEyePosition.xyz);reflectionColor=textureSample(cRT,cRS,reflect(v,normalW)).rgb*mat.rLvl;}`,
        },
    };
}

export const stdCubeReflectionExt: StdExt = {
    id: "std-cube-reflection",
    phase: "mesh",
    feature: HAS_CUBE_REFLECTION,
    frag: createStdCubeReflectionFragment,
    bind(mat, entries, b) {
        const cube = mat.reflectionCubeTexture!;
        entries.push({ binding: b++, resource: cube.view });
        entries.push({ binding: b++, resource: cube.sampler });
        return b;
    },
    // Cube textures are tracked separately; no Texture2D[] contribution.
};
