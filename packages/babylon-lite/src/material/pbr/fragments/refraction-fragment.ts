/**
 * Refraction Fragment — KHR_materials_transmission + _volume + _ior + _specular.
 *
 * Ports the BJS `pbrBlockSubSurface.fx` refraction path:
 *   1. Snell refraction with IOR-scaled alphaG
 *      `refractionAlphaG = mix(alphaG, 0, clamp(ior*3-2, 0, 1))`
 *   2. LOD from refractionAlphaG via BJS `getLodFromAlphaG` formula
 *      `log2(textureSize * refractionAlphaG) * lodScale`
 *   3. Beer-Lambert volume absorption (KHR_materials_volume):
 *      `volumeAlbedo = -log(tintColor) / atDistance`
 *      `refractionTransmittance = intensity * exp(-volumeAlbedo * thickness)`
 *   4. Energy conservation:
 *      `finalRefraction = envRefraction * refractionTransmittance * (1 - specEnvReflectance)`
 *   5. Composition:
 *      `finalIrradiance *= (1 - refractionIntensity)`
 *      `directDiffuse *= (1 - refractionIntensity)`
 *      `color = finalIrradiance + finalRadianceScaled + finalSpecularScaled
 *             + directDiffuse + finalRefraction + emissive`
 *
 * V2 env-only: samples the IBL specular cube along the refracted direction.
 * V3 (future) will sample an opaque-scene RTT for true behind-the-glass rendering.
 * Maps BJS `SubSurfaceConfiguration.refraction`.
 */

import type { ShaderFragment } from "../../../shader/fragment-types.js";
import type { PbrMaterialProps, SubSurfaceProps } from "../pbr-material.js";
import type { PbrExt } from "../pbr-flags.js";
import { PBR2_HAS_REFRACTION, PBR2_HAS_VOLUME } from "../pbr-flags.js";

// `dependencies: ["ibl"]` guarantees the IBL fragment's AI slot has already run,
// so the following symbols are in scope when this slot executes:
//   finalIrradiance, finalRadianceScaled, finalSpecularScaled, directDiffuse,
//   emissive, specularEnvironmentReflectance, N, V, NdotV, NdotVUnclamped,
//   alphaG, roughness, iblTexture, iblSampler, cubemapDim, maxLod, rotateY(), scene.envRotationY.
function makeRefractionMod(hasVolume: boolean): string {
    // Beer-Lambert: exp(-sigma_a * d) where sigma_a = -ln(tint)/atDistance.
    // `volumeParams.rgb` is pre-baked to ln(tint)/atDistance on the CPU side; the
    // shader multiplies by thickness and exp. Matches BJS cocaLambertVec3 ∘ computeColorAtDistanceInMedia.
    const absorptionLine = hasVolume ? `let absorption = exp(material.volumeParams.rgb * material.refractionParams.z);` : `let absorption = vec3<f32>(1.0);`;

    return `{
let refrIntensity = material.refractionParams.x;
let refrOpacity = 1.0 - refrIntensity;
let ior = max(material.refractionParams.y, 1.001);
let etaRatio = 1.0 / ior;
let refrDir_raw = refract(-V, N, etaRatio);
let refrDir = rotateY(refrDir_raw, scene.envRotationY);

// BJS: refractionAlphaG = mix(alphaG, 0, clamp(ior*3-2, 0, 1))
// At IOR=1.0 → alphaG (no microfacet refraction change)
// At IOR≥1.5 → 0 (perfect refraction, sharp)
let refrAlphaG = mix(alphaG, 0.0, clamp(ior * 3.0 - 2.0, 0.0, 1.0));
// BJS getLodFromAlphaG:  log2(textureSize * alphaG) * lodGenerationScale
let refrSpecLod = log2(cubemapDim * refrAlphaG) * scene.vImageInfos.z;
let refrLodClamped = clamp(refrSpecLod, 0.0, maxLod);
let envRefraction = textureSampleLevel(iblTexture, iblSampler, refrDir, refrLodClamped).rgb * material.environmentIntensity;

${absorptionLine}
let refractionTransmittance = refrIntensity * absorption;
let finalRefraction = envRefraction * refractionTransmittance * (vec3<f32>(1.0) - specularEnvironmentReflectance);

// BJS composition: refractionOpacity modulates finalIrradiance + finalDiffuse only.
// finalSpecular/finalRadiance are NOT attenuated (surface specular survives through glass).
color = finalIrradiance * refrOpacity
      + finalRadianceScaled
      + finalSpecularScaled
      + directDiffuse * refrOpacity
      + finalRefraction
      + emissive;
}`;
}

/**
 * Create a refraction fragment.
 * @param hasVolume Whether KHR_materials_volume data is present (Beer-Lambert absorption).
 */
export function createRefractionFragment(hasVolume: boolean): ShaderFragment {
    const uboFields: { name: string; type: "vec4<f32>" }[] = [{ name: "refractionParams", type: "vec4<f32>" as const }];
    if (hasVolume) {
        uboFields.push({ name: "volumeParams", type: "vec4<f32>" as const });
    }
    return {
        id: "refraction",
        // Must run after IBL so finalIrradiance/finalRadianceScaled/finalSpecularScaled
        // are in scope. The IBL AI slot also produces `cubemapDim` + `maxLod` + `rotateY`.
        dependencies: ["ibl"],
        uboFields,
        fragmentSlots: { AI: makeRefractionMod(hasVolume) },
    };
}

/** Write refraction UBO data. */
function writeRefractionUBO(data: Float32Array, mat: PbrMaterialProps, offsets: ReadonlyMap<string, number>): void {
    const ss = mat.subsurface as SubSurfaceProps | undefined;
    const refr = ss?.refraction;
    if (!refr) {
        return;
    }
    const off = offsets.get("refractionParams");
    if (off === undefined) {
        return;
    }
    const o = off / 4;
    data[o] = refr.intensity ?? 0;
    data[o + 1] = refr.indexOfRefraction ?? 1.5;
    // Thickness (distance light travels through medium). Use the thickness max; falls back to 1.
    const thick = ss!.thickness;
    data[o + 2] = thick?.max ?? 1.0;
    data[o + 3] = refr.useThicknessAsDepth ? 1.0 : 0.0;

    // Volume (Beer-Lambert) — pre-bake ln(tint)/attenuationDistance so the fragment can do exp(x * thickness).
    const vOff = offsets.get("volumeParams");
    if (vOff !== undefined) {
        const vo = vOff / 4;
        const tint = ss!.tint?.color ?? [1, 1, 1];
        const dist = Math.max(ss!.tint?.atDistance ?? 1, 0.0001);
        // log(0) is -Infinity; clamp tiny values to avoid NaN.
        data[vo] = Math.log(Math.max(tint[0]!, 1e-6)) / dist;
        data[vo + 1] = Math.log(Math.max(tint[1]!, 1e-6)) / dist;
        data[vo + 2] = Math.log(Math.max(tint[2]!, 1e-6)) / dist;
        data[vo + 3] = 0;
    }
}

export const refractionExt: PbrExt = {
    id: "refraction",
    phase: "fragment",
    detect(mat) {
        const m = mat as PbrMaterialProps;
        const ss = m.subsurface as SubSurfaceProps | undefined;
        const refr = ss?.refraction;
        if (!refr || (refr.intensity ?? 0) <= 0) {
            return { f: 0, f2: 0 };
        }
        let f2 = PBR2_HAS_REFRACTION;
        if (ss!.tint?.atDistance !== undefined) {
            f2 |= PBR2_HAS_VOLUME;
        }
        return { f: 0, f2 };
    },
    frag(ctx) {
        if (!(ctx.features2 & PBR2_HAS_REFRACTION)) {
            return null;
        }
        return createRefractionFragment((ctx.features2 & PBR2_HAS_VOLUME) !== 0);
    },
    writeUbo(data, mat, offsets) {
        if (offsets.has("refractionParams")) {
            writeRefractionUBO(data, mat as PbrMaterialProps, offsets);
        }
    },
};
