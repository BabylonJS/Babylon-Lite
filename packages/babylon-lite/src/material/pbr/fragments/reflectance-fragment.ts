/**
 * Metallic Reflectance Fragment
 *
 * Advanced F0 computation with metallicReflectanceTexture and/or reflectanceTexture.
 * Only bundled when a scene uses these textures.
 *
 * Provides: UBO fields (occlusionStrength, metallicF0Factor, metallicReflectanceColor),
 * conditional texture bindings, F0 computation, and occlusion handling.
 */

import type { ShaderFragment, BindingDecl } from "../../../shader/fragment-types.js";
import type { PbrMaterialProps } from "../pbr-material.js";
import type { PbrExt } from "../pbr-flags.js";
import { PBR_HAS_METALLIC_REFLECTANCE_MAP, PBR_HAS_REFLECTANCE_MAP, PBR_HAS_USE_ALPHA_ONLY_MR } from "../pbr-flags.js";

// WebGPU shader stage constants
const STAGE_FRAGMENT = 0x2;

/** Write the reflectance-extension material-UBO slice
 *  (occlusionStrength, metallicF0Factor, metallicReflectanceColor).
 *  Gated by the presence of the `occlusionStrength` field in the UBO spec,
 *  which is added only when a metallic-reflectance or reflectance texture
 *  is in use. */
export function writeReflectanceUBO(data: Float32Array, material: PbrMaterialProps, offsets: ReadonlyMap<string, number>): void {
    if (!offsets.has("occlusionStrength")) {
        return;
    }
    if (material.metallicReflectanceTexture === undefined && material.reflectanceTexture === undefined) {
        return;
    }
    const off = offsets.get("occlusionStrength")! / 4;
    data[off] = material.occlusionStrength ?? 1.0;
    data[off + 1] = material.metallicF0Factor ?? 1.0;
    const mrc = material.metallicReflectanceColor;
    data[off + 4] = mrc ? mrc[0]! : 1.0;
    data[off + 5] = mrc ? mrc[1]! : 1.0;
    data[off + 6] = mrc ? mrc[2]! : 1.0;
}

/**
 * Create a metallic reflectance fragment.
 * @param hasMetallicReflectanceMap Whether the material has a metallicReflectanceTexture.
 * @param hasReflectanceMap Whether the material has a reflectanceTexture.
 * @param useAlphaOnlyMR Whether to use only the alpha channel from the metallic reflectance map.
 */
export function createReflectanceFragment(hasMetallicReflectanceMap: boolean, hasReflectanceMap: boolean, useAlphaOnlyMR: boolean): ShaderFragment {
    const bindings: BindingDecl[] = [];
    if (hasMetallicReflectanceMap) {
        bindings.push(
            { name: "metallicReflectanceMap", type: { kind: "texture", textureType: "texture_2d<f32>" }, visibility: STAGE_FRAGMENT },
            { name: "metallicReflectanceMapSampler", type: { kind: "sampler", samplerType: "sampler" }, visibility: STAGE_FRAGMENT }
        );
    }
    if (hasReflectanceMap) {
        bindings.push(
            { name: "reflectanceMap", type: { kind: "texture", textureType: "texture_2d<f32>" }, visibility: STAGE_FRAGMENT },
            { name: "reflectanceMapSampler", type: { kind: "sampler", samplerType: "sampler" }, visibility: STAGE_FRAGMENT }
        );
    }

    // Build F0 computation code
    let f0Code = `var mrFactors = vec4<f32>(material.metallicReflectanceColor, material.metallicF0Factor);`;
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
  mrFactors = vec4<f32>(mrFactors.rgb * mrLinear, mrFactors.a * mrSample.a); }`;
        } else {
            f0Code += `
{ let mrSample = textureSample(metallicReflectanceMap, metallicReflectanceMapSampler, input.uv);
  mrFactors = vec4<f32>(mrFactors.rgb, mrFactors.a * mrSample.a); }`;
        }
    }
    f0Code += `
let dielectricF0 = material.reflectance * mrFactors.a;
let surfaceReflectivityColor = mrFactors.rgb;
let dielectricColorF0 = vec3<f32>(dielectricF0) * surfaceReflectivityColor;
let metallicColorF0 = baseColor;
var colorF0 = mix(dielectricColorF0, metallicColorF0, metallic);
let colorF90 = vec3<f32>(mrFactors.a);
let surfaceAlbedo = baseColor * (vec3<f32>(1.0) - vec3<f32>(dielectricF0) * surfaceReflectivityColor) * (1.0 - metallic);`;

    return {
        id: "reflectance",

        // UBO fields are in the PBR template's baseMeshUboFields for byte-layout compat.

        bindings,

        fragmentSlots: {
            MF: f0Code,
            AT: `let occlusion = mix(1.0, orm.r, material.occlusionStrength);`,
        },
    };
}

/** Create the reflectance PBR extension (group 1, fragment phase). */
export const reflectanceExt: PbrExt = {
    id: "reflectance",
    phase: "fragment",
    detect(mat) {
        const m = mat as PbrMaterialProps;
        let f = 0;
        if (m.metallicReflectanceTexture) {
            f |= PBR_HAS_METALLIC_REFLECTANCE_MAP;
        }
        if (m.reflectanceTexture) {
            f |= PBR_HAS_REFLECTANCE_MAP;
        }
        if (f !== 0 && m.useOnlyMetallicFromMetallicReflectanceTexture) {
            f |= PBR_HAS_USE_ALPHA_ONLY_MR;
        }
        return { f, f2: 0 };
    },
    frag(ctx) {
        const hasMR = (ctx.features & PBR_HAS_METALLIC_REFLECTANCE_MAP) !== 0;
        const hasR = (ctx.features & PBR_HAS_REFLECTANCE_MAP) !== 0;
        if (!hasMR && !hasR) {
            return null;
        }
        return createReflectanceFragment(hasMR, hasR, (ctx.features & PBR_HAS_USE_ALPHA_ONLY_MR) !== 0);
    },
    writeUbo: writeReflectanceUBO as PbrExt["writeUbo"],
    bind(ctx, entries, b) {
        if ((ctx.features & (PBR_HAS_METALLIC_REFLECTANCE_MAP | PBR_HAS_REFLECTANCE_MAP)) === 0) {
            return b;
        }
        const m = ctx.material as PbrMaterialProps;
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
