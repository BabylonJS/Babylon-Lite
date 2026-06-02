/**
 * Metallic Reflectance Fragment
 *
 * Advanced F0 computation with metallicReflectanceTexture and/or reflectanceTexture.
 * Only bundled when a scene uses these textures.
 *
 * Provides: UBO fields (occlusionStrength, metallicF0Factor, specularWeight, metallicReflectanceColor),
 * conditional texture bindings, F0 computation, and occlusion handling.
 */

import type { ShaderFragment, BindingDecl } from "../../../shader/fragment-types.js";
import type { PbrMaterialProps } from "../pbr-material.js";
import type { PbrExt } from "../pbr-flags.js";
import { PBR_HAS_METALLIC_REFLECTANCE_MAP, PBR_HAS_REFLECTANCE_MAP, PBR_HAS_USE_ALPHA_ONLY_MR, PBR2_HAS_REFLECTANCE_FACTORS, PBR2_HAS_UV2 } from "../pbr-flag-bits.js";

// WebGPU shader stage constants
const STAGE_FRAGMENT = 0x2;

/** Write the reflectance-extension material-UBO slice
 *  (occlusionStrength, metallicF0Factor, specularWeight, metallicReflectanceColor).
 *  Gated by the presence of the `occlusionStrength` field in the UBO spec,
 *  which is added only when a metallic-reflectance or reflectance texture
 *  is in use. */
export function writeReflectanceUBO(data: Float32Array, material: PbrMaterialProps, offsets: ReadonlyMap<string, number>): void {
    if (!offsets.has("occlusionStrength")) {
        return;
    }
    const off = offsets.get("occlusionStrength")! / 4;
    data[off] = material.occlusionStrength ?? 1.0;
    data[off + 1] = material.metallicF0Factor ?? 1.0;
    data[off + 2] = material.specularWeight ?? material.metallicF0Factor ?? 1.0;
    const mrc = material.metallicReflectanceColor;
    data[off + 4] = mrc ? mrc[0]! : 1.0;
    data[off + 5] = mrc ? mrc[1]! : 1.0;
    data[off + 6] = mrc ? mrc[2]! : 1.0;
}

/**
 * Create a metallic reflectance fragment.
 * @param hasMetallicReflectanceMap - Whether the material has a metallicReflectanceTexture.
 * @param hasReflectanceMap - Whether the material has a reflectanceTexture.
 * @param useAlphaOnlyMR - Whether to use only the alpha channel from the metallic reflectance map.
 */
export function createReflectanceFragment(
    hasMetallicReflectanceMap: boolean,
    hasReflectanceMap: boolean,
    useAlphaOnlyMR: boolean,
    hasOcclusionUv2: boolean = false
): ShaderFragment {
    const bindings: BindingDecl[] = [];
    if (hasMetallicReflectanceMap) {
        bindings.push(
            { _name: "metallicReflectanceMap", _type: { _kind: "texture", _textureType: "texture_2d<f32>" }, _visibility: STAGE_FRAGMENT },
            { _name: "metallicReflectanceMapSampler", _type: { _kind: "sampler", _samplerType: "sampler" }, _visibility: STAGE_FRAGMENT }
        );
    }
    if (hasReflectanceMap) {
        bindings.push(
            { _name: "reflectanceMap", _type: { _kind: "texture", _textureType: "texture_2d<f32>" }, _visibility: STAGE_FRAGMENT },
            { _name: "reflectanceMapSampler", _type: { _kind: "sampler", _samplerType: "sampler" }, _visibility: STAGE_FRAGMENT }
        );
    }

    // Build F0 computation code
    let f0Code = `var mrFactors = vec4<f32>(material.metallicReflectanceColor, material.metallicF0Factor);
var specularWeight = material.specularWeight;`;
    if (hasReflectanceMap) {
        f0Code += `
{ let rSample = textureSample(reflectanceMap, reflectanceMapSampler, input.uv);
  let rLinear = pow(rSample.rgb, vec3<f32>(2.2));
  mrFactors = vec4<f32>(mrFactors.rgb * rLinear, mrFactors.a); }`;
    }
    if (hasMetallicReflectanceMap) {
        if (!useAlphaOnlyMR) {
            f0Code += `
{ let mrSample = textureSample(metallicReflectanceMap, metallicReflectanceMapSampler, input.uv);
  let mrLinear = pow(mrSample.rgb, vec3<f32>(2.2));
  mrFactors = vec4<f32>(mrFactors.rgb * mrLinear, mrFactors.a * mrSample.a);
  specularWeight *= mrSample.a; }`;
        } else {
            f0Code += `
{ let mrSample = textureSample(metallicReflectanceMap, metallicReflectanceMapSampler, input.uv);
  mrFactors = vec4<f32>(mrFactors.rgb, mrFactors.a * mrSample.a);
  specularWeight *= mrSample.a; }`;
        }
    }
    f0Code += `
let dielectricF0 = material.reflectance * mrFactors.a;
let surfaceReflectivityColor = mrFactors.rgb;
let dielectricColorF0 = vec3<f32>(dielectricF0) * surfaceReflectivityColor;
let metallicColorF0 = baseColor;
var colorF0 = mix(dielectricColorF0, metallicColorF0, metallic);
let colorF90 = vec3<f32>(mix(specularWeight, 1.0, metallic));
let surfaceAlbedo = baseColor * (vec3<f32>(1.0) - vec3<f32>(dielectricF0) * surfaceReflectivityColor) * (1.0 - metallic);`;

    return {
        _id: "reflectance",

        _uboFields: [
            { _name: "occlusionStrength", _type: "f32" },
            { _name: "metallicF0Factor", _type: "f32" },
            { _name: "specularWeight", _type: "f32" },
            { _name: "_mrPad1", _type: "f32" },
            { _name: "metallicReflectanceColor", _type: "vec3<f32>" },
            { _name: "_mrPad2", _type: "f32" },
        ],

        _bindings: bindings,

        _fragmentSlots: {
            MF: f0Code,
            AT: hasOcclusionUv2
                ? `let occlusion = mix(1.0, textureSample(occlusionTexture, occlusionSampler_, input.uv2).r, material.occlusionStrength);`
                : `let occlusion = mix(1.0, orm.r, material.occlusionStrength);`,
        },
    };
}

/** Create the reflectance PBR extension (group 1, fragment phase). */
export const pbrExt: PbrExt = {
    id: "reflectance",
    phase: "fragment",
    detect(mat) {
        const m = mat as PbrMaterialProps;
        let f = 0;
        let f2 = 0;
        if (m.metallicReflectanceTexture) {
            f |= PBR_HAS_METALLIC_REFLECTANCE_MAP;
        }
        if (m.reflectanceTexture) {
            f |= PBR_HAS_REFLECTANCE_MAP;
        }
        if (f === 0) {
            const hasNonDefaultF0 = m.metallicF0Factor != null && Math.abs(m.metallicF0Factor - 1) > 1e-6;
            const mrc = m.metallicReflectanceColor;
            const hasNonDefaultColor = mrc != null && (mrc[0] !== 1 || mrc[1] !== 1 || mrc[2] !== 1);
            if (hasNonDefaultF0 || hasNonDefaultColor) {
                f2 |= PBR2_HAS_REFLECTANCE_FACTORS;
            }
        }
        if ((f !== 0 || f2 & PBR2_HAS_REFLECTANCE_FACTORS) && m.useOnlyMetallicFromMetallicReflectanceTexture) {
            f |= PBR_HAS_USE_ALPHA_ONLY_MR;
        }
        return { f, f2 };
    },
    frag(ctx) {
        const hasMR = (ctx._features & PBR_HAS_METALLIC_REFLECTANCE_MAP) !== 0;
        const hasR = (ctx._features & PBR_HAS_REFLECTANCE_MAP) !== 0;
        const hasFactors = (ctx._features2 & PBR2_HAS_REFLECTANCE_FACTORS) !== 0;
        if (!hasMR && !hasR && !hasFactors) {
            return null;
        }
        return createReflectanceFragment(hasMR, hasR, (ctx._features & PBR_HAS_USE_ALPHA_ONLY_MR) !== 0, (ctx._features2 & PBR2_HAS_UV2) !== 0);
    },
    writeUbo: writeReflectanceUBO as PbrExt["writeUbo"],
    bind(ctx, entries, b) {
        if ((ctx._features & (PBR_HAS_METALLIC_REFLECTANCE_MAP | PBR_HAS_REFLECTANCE_MAP)) === 0) {
            return b;
        }
        const m = ctx._material as PbrMaterialProps;
        if (m.metallicReflectanceTexture) {
            entries.push({ binding: b++, resource: m.metallicReflectanceTexture.view });
            entries.push({ binding: b++, resource: m.metallicReflectanceTexture.sampler });
        }
        if (m.reflectanceTexture) {
            entries.push({ binding: b++, resource: m.reflectanceTexture.view });
            entries.push({ binding: b++, resource: m.reflectanceTexture.sampler });
        }
        return b;
    },
    textures(mat, t) {
        const m = mat as PbrMaterialProps;
        if (m.metallicReflectanceTexture) {
            t.push(m.metallicReflectanceTexture);
        }
        if (m.reflectanceTexture) {
            t.push(m.reflectanceTexture);
        }
    },
};
