/**
 * Skybox-mode IBL calculation (camera→fragment cubemap direction). Kept in a
 * separate module so scenes that don't use PBR skyboxMode don't pay the
 * ~1 KB string cost in their bundle. Dynamic-imported by pbr-renderable.ts
 * when PBR_HAS_SKYBOX is set.
 *
 * Matches BJS's disableLighting skybox-material path, where
 * MIX_IBL_RADIANCE_WITH_IRRADIANCE is not defined and the skybox uses the
 * sampled prefiltered radiance directly.
 */

export const IBL_SKYBOX_CALCULATION = `let R = input.worldPos - scene.vEyePosition.xyz;
let maxLod = f32(textureNumLevels(iblTexture) - 1);
let cubemapDim = f32(textureDimensions(iblTexture).x);
let skyboxAlphaG = max(roughness * roughness, 0.000001);
var specLod = log2(cubemapDim * skyboxAlphaG) * scene.vImageInfos.z;
var environmentRadiance = textureSampleLevel(iblTexture, iblSampler, R, clamp(specLod, 0.0, maxLod)).rgb * material.environmentIntensity;
let finalSpecularScaled = vec3<f32>(0.0);
let finalRadianceScaled = environmentRadiance;
color = finalRadianceScaled + emissive;`;
