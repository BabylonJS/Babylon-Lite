/**
 * Skybox-mode IBL calculation (camera→fragment cubemap direction). Kept in a
 * separate module so scenes that don't use PBR skyboxMode don't pay the
 * ~1 KB string cost in their bundle. Dynamic-imported by pbr-renderable.ts
 * when PBR_HAS_SKYBOX is set.
 *
 * Matches BJS's MIX_IBL_RADIANCE_WITH_IRRADIANCE path: the sampled (prefiltered)
 * radiance is blended toward SH-evaluated irradiance by alphaG. This keeps the
 * skybox brightness aligned with BJS at low alphaG (smooth skybox materials)
 * without darkening it uniformly by `alphaG` (which would happen if we mixed
 * with zero).
 */

export const IBL_SKYBOX_CALCULATION = `let R_raw = -V;
let R = R_raw;
let N_env = N;
let brdf = textureSample(brdfLUT, brdfSampler_, vec2<f32>(NdotV, roughness));
let environmentBrdf = brdf.rgb;
let specularEnvironmentReflectance = (colorF90 - colorF0) * environmentBrdf.x + colorF0 * environmentBrdf.y;
let seo = clamp((NdotVUnclamped + occlusion) * (NdotVUnclamped + occlusion) - 1.0 + occlusion, 0.0, 1.0);
let eho = 1.0;
let colorSpecularEnvReflectance = specularEnvironmentReflectance * seo * eho;
let energyConservation = getEnergyConservationFactor(colorF0, max(environmentBrdf.y, 0.001));
let environmentIrradiance = (scene.vSphericalL00.rgb
  + scene.vSphericalL1_1.rgb * N_env.y + scene.vSphericalL10.rgb * N_env.z + scene.vSphericalL11.rgb * N_env.x
  + scene.vSphericalL2_2.rgb * (N_env.y * N_env.x) + scene.vSphericalL2_1.rgb * (N_env.y * N_env.z)
  + scene.vSphericalL20.rgb * (3.0 * N_env.z * N_env.z - 1.0) + scene.vSphericalL21.rgb * (N_env.z * N_env.x)
  + scene.vSphericalL22.rgb * (N_env.x * N_env.x - N_env.y * N_env.y)) * material.environmentIntensity * 0.05;
let maxLod = f32(textureNumLevels(iblTexture) - 1);
let cubemapDim = f32(textureDimensions(iblTexture).x);
var specLod = log2(cubemapDim * alphaG) * scene.vImageInfos.z;
var environmentRadiance = textureSampleLevel(iblTexture, iblSampler, R, clamp(specLod, 0.0, maxLod)).rgb * material.environmentIntensity;
environmentRadiance = mix(environmentRadiance, environmentIrradiance, alphaG);
let finalIrradiance = environmentIrradiance * surfaceAlbedo * occlusion;
let finalSpecularScaled = directSpecular * energyConservation;
let finalRadianceScaled = environmentRadiance * colorSpecularEnvReflectance * energyConservation;
color = finalIrradiance + finalRadianceScaled + finalSpecularScaled + directDiffuse + emissive;`;
