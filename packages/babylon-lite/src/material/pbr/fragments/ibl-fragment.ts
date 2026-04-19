/**
 * IBL/Environment Fragment
 *
 * Adds image-based lighting via spherical harmonics irradiance + specular
 * cubemap. Only bundled when a scene loads an environment.
 *
 * Provides: scene UBO SH fields, BRDF LUT + IBL cube bindings,
 * horizon occlusion / energy conservation helpers, IBL calculation.
 */

import type { ShaderFragment } from "../../../shader/fragment-types.js";

// WebGPU shader stage constants
const STAGE_FRAGMENT = 0x2;

const IBL_HELPERS = `
fn environmentHorizonOcclusion(V: vec3<f32>, N: vec3<f32>, geoN: vec3<f32>) -> f32 {
let R = reflect(V, N);
let temp = saturate(1.0 + 1.1 * dot(R, geoN));
return temp * temp;
}
fn getEnergyConservationFactor(F0: vec3<f32>, brdfY: f32) -> vec3<f32> {
return 1.0 + F0 * (1.0 / brdfY - 1.0);
}
fn rotateY(v: vec3<f32>, angle: f32) -> vec3<f32> {
let c = cos(angle);
let s = sin(angle);
return vec3<f32>(v.x * c + v.z * s, v.y, -v.x * s + v.z * c);
}
`;

function makeIblCalculation(hasNormalMap: boolean, anisoBentNormalCode: string = "", skyboxCalculation: string = ""): string {
    // Skybox mode: caller passes pre-baked WGSL (from ibl-skybox-wgsl.ts) to avoid
    // bundling that ~1 KB string into scenes that don't use skyboxMode.
    if (skyboxCalculation) {
        return skyboxCalculation;
    }

    const ehoLine = hasNormalMap ? `let eho = environmentHorizonOcclusion(-V, N, N_geom);` : `let eho = 1.0;`;

    // Normal PBR: use reflected view or anisotropy bent normal.
    const reflectionDir = anisoBentNormalCode ? anisoBentNormalCode : `let R_raw = reflect(-V, N);`;

    const irradianceCode = `let environmentIrradiance = (scene.vSphericalL00
  + scene.vSphericalL1_1 * N_env.y + scene.vSphericalL10 * N_env.z + scene.vSphericalL11 * N_env.x
  + scene.vSphericalL2_2 * (N_env.y * N_env.x) + scene.vSphericalL2_1 * (N_env.y * N_env.z)
  + scene.vSphericalL20 * (3.0 * N_env.z * N_env.z - 1.0) + scene.vSphericalL21 * (N_env.z * N_env.x)
  + scene.vSphericalL22 * (N_env.x * N_env.x - N_env.y * N_env.y)) * material.environmentIntensity;`;

    return `${reflectionDir}
let R = rotateY(R_raw, scene.envRotationY);
let N_env = rotateY(N, scene.envRotationY);
let brdf = textureSample(brdfLUT, brdfSampler_, vec2<f32>(NdotV, roughness));
let environmentBrdf = brdf.rgb;
let specularEnvironmentReflectance = (colorF90 - colorF0) * environmentBrdf.x + colorF0 * environmentBrdf.y;
let seo = clamp((NdotVUnclamped + occlusion) * (NdotVUnclamped + occlusion) - 1.0 + occlusion, 0.0, 1.0);
${ehoLine}
let colorSpecularEnvReflectance = specularEnvironmentReflectance * seo * eho;
let energyConservation = getEnergyConservationFactor(colorF0, max(environmentBrdf.y, 0.001));
${irradianceCode}
let maxLod = f32(textureNumLevels(iblTexture) - 1);
let cubemapDim = f32(textureDimensions(iblTexture).x);
var specLod = log2(cubemapDim * alphaG) * scene.lodGenerationScale;
var environmentRadiance = textureSampleLevel(iblTexture, iblSampler, R, clamp(specLod, 0.0, maxLod)).rgb * material.environmentIntensity;
environmentRadiance = mix(environmentRadiance, environmentIrradiance, alphaG);
let finalIrradiance = environmentIrradiance * surfaceAlbedo * occlusion;
let finalSpecularScaled = directSpecular * energyConservation;
let finalRadianceScaled = environmentRadiance * colorSpecularEnvReflectance * energyConservation;
color = finalIrradiance + finalRadianceScaled + finalSpecularScaled + directDiffuse + emissive;`;
}

/**
 * Create an IBL/environment fragment.
 * @param hasNormalMap Whether the material uses a normal map (enables horizon occlusion).
 * @param anisoBentNormalCode WGSL code for anisotropic bent normal (empty string = standard reflection).
 * @param skyboxCalculation Pre-baked skybox-mode WGSL from ibl-skybox-wgsl.ts (empty string = normal PBR).
 */
export function createIblFragment(hasNormalMap: boolean, anisoBentNormalCode: string = "", skyboxCalculation: string = ""): ShaderFragment {
    return {
        id: "ibl",

        // SH coefficients are in the PBR template's baseSceneUboFields (not here)
        // to preserve fixed scene UBO layout compatibility.

        bindings: [
            { name: "brdfLUT", type: { kind: "texture", textureType: "texture_2d<f32>" }, visibility: STAGE_FRAGMENT },
            { name: "brdfSampler_", type: { kind: "sampler", samplerType: "sampler" }, visibility: STAGE_FRAGMENT },
            { name: "iblTexture", type: { kind: "texture", textureType: "texture_cube<f32>" }, visibility: STAGE_FRAGMENT },
            { name: "iblSampler", type: { kind: "sampler", samplerType: "sampler" }, visibility: STAGE_FRAGMENT },
        ],

        helperFunctions: IBL_HELPERS,

        fragmentSlots: {
            AI: makeIblCalculation(hasNormalMap, anisoBentNormalCode, skyboxCalculation),
            BA: `luminanceOverAlpha += dot(finalRadianceScaled, vec3<f32>(0.2126, 0.7152, 0.0722));`,
        },
    };
}

import type { PbrExt } from "../pbr-flags.js";
import { PBR_HAS_ENV } from "../pbr-flags.js";

export const iblExt: PbrExt = {
    id: "ibl",
    phase: "ibl",
    frag(ctx) {
        if (!(ctx.features & PBR_HAS_ENV)) {
            return null;
        }
        return createIblFragment(ctx.hasAnyNormal, ctx.anisoBentNormalCode ?? "", ctx.iblSkyboxCalc ?? "");
    },
    bind(ctx, entries, b) {
        if (!(ctx.features & PBR_HAS_ENV) || !ctx.env) {
            return b;
        }
        entries.push({ binding: b++, resource: ctx.env.brdfLutView });
        entries.push({ binding: b++, resource: ctx.env.brdfSampler });
        entries.push({ binding: b++, resource: ctx.env.specularCubeView });
        entries.push({ binding: b++, resource: ctx.env.cubeSampler });
        return b;
    },
};
