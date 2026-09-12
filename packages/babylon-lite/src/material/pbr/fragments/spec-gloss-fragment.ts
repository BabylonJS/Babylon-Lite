import type { PbrExt } from "../pbr-flags.js";
import type { PbrMaterialProps } from "../pbr-material.js";
import { PBR_HAS_SPEC_GLOSS, PBR_HAS_METALLIC_REFLECTANCE_MAP, PBR_HAS_REFLECTANCE_MAP, PBR2_HAS_REFLECTANCE_FACTORS } from "../pbr-flag-bits.js";
import { wgsl } from "../../../shader/wgsl.js";

// Formerly unused cotangent-normal bit; normal mode is derived from mesh attributes.
const PBR_HAS_SPEC_GLOSS_FACTORS = 1 << 9;

/** Factor-only and textured SG share one linear RGB/glossiness uniform. */
export const pbrExt: PbrExt = {
    id: "base-spec-gloss",
    phase: "fragment",
    detect(mat) {
        return { f: (mat as PbrMaterialProps)._specularGlossiness ? PBR_HAS_SPEC_GLOSS_FACTORS : 0, f2: 0 };
    },
    frag(ctx) {
        if (!(ctx._features & PBR_HAS_SPEC_GLOSS_FACTORS)) {
            return null;
        }
        const hasReflectance = (ctx._features & (PBR_HAS_METALLIC_REFLECTANCE_MAP | PBR_HAS_REFLECTANCE_MAP)) !== 0 || (ctx._features2 & PBR2_HAS_REFLECTANCE_FACTORS) !== 0;
        return {
            _id: "base-spec-gloss",
            // The composer reinserts this initializer before ready MF modifiers.
            _dependencies: hasReflectance ? ["base-f0"] : undefined,
            _uboFields: [{ _name: "specularGlossiness", _type: "vec4<f32>" }],
            _fragmentSlots: {
                MF: wgsl`
let sg=${ctx._features & PBR_HAS_SPEC_GLOSS ? wgsl`specGloss*` : ""}material.specularGlossiness;
roughness=clamp(1.0-sg.a,0.0,1.0);
metallic=0.0;
colorF0=sg.rgb;
colorF90=vec3<f32>(1.0);
surfaceAlbedo=baseColor*(1.0-max(colorF0.r,max(colorF0.g,colorF0.b)));`,
            },
        };
    },
    writeUbo(data, mat, offsets) {
        const offset = offsets.get("specularGlossiness");
        if (offset === undefined) {
            return;
        }
        const factor = (mat as PbrMaterialProps)._specularGlossiness;
        const i = offset / 4;
        data[i] = factor?.[0] ?? 1;
        data[i + 1] = factor?.[1] ?? 1;
        data[i + 2] = factor?.[2] ?? 1;
        data[i + 3] = factor?.[3] ?? 1;
    },
};
