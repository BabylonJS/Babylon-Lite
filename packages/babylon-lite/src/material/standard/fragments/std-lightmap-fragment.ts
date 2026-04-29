/** Standard Lightmap Fragment — additively blends lightmap into final color. */
import type { ShaderFragment } from "../../../shader/fragment-types.js";
import type { StandardMaterialProps } from "../standard-material.js";
import type { Texture2D } from "../../../texture/texture-2d.js";
import type { StdExt } from "../standard-flags.js";
import { HAS_LIGHTMAP_TEXTURE, LIGHTMAP_USES_UV2 } from "../standard-flags.js";

const STAGE_FRAGMENT = 0x2;

export function createStdLightmapFragment(usesUV2: boolean): ShaderFragment {
    const uv = usesUV2 ? "input.vUV2" : "input.vUV";
    return {
        id: "std-lightmap",
        bindings: [
            { name: "lightmapTex", type: { kind: "texture", textureType: "texture_2d<f32>" }, visibility: STAGE_FRAGMENT },
            { name: "lightmapSampler", type: { kind: "sampler", samplerType: "sampler" }, visibility: STAGE_FRAGMENT },
        ],
        fragmentSlots: {
            BC: `color = vec4<f32>(color.rgb + textureSample(lightmapTex, lightmapSampler, ${uv}).rgb * mat.lmLvl, color.a);`,
        },
    };
}

export const stdLightmapExt: StdExt = {
    id: "std-lightmap",
    phase: "mesh",
    feature: HAS_LIGHTMAP_TEXTURE,
    frag: (features) => createStdLightmapFragment((features & LIGHTMAP_USES_UV2) !== 0),
    bind(mat, entries, b) {
        const tex = mat.lightmapTexture!;
        entries.push({ binding: b++, resource: tex.texture.createView() });
        entries.push({ binding: b++, resource: tex.sampler });
        return b;
    },
    textures(mat: StandardMaterialProps, out: Texture2D[]): void {
        if (mat.lightmapTexture) {
            out.push(mat.lightmapTexture);
        }
    },
};
