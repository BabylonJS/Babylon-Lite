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

import { wgsl } from "../../../shader/wgsl.js";
import { _rightHanded } from "#coordinate-system";

// A right-handed build negates the lookup Z, like Babylon.js's REFLECTIONMAP_OPPOSITEZ on its skybox coordinates.
// The `wgsl` tag minifies only the template's static text, so both interpolated variants are written minified.
export const IBL_SKYBOX_CALCULATION = wgsl`let R=${_rightHanded ? "(input.worldPos-scene.vEyePosition.xyz)*vec3<f32>(1.0,1.0,-1.0)" : "input.worldPos-scene.vEyePosition.xyz"};
let maxLod = f32(textureNumLevels(iblTexture) - 1);
let cubemapDim = f32(textureDimensions(iblTexture).x);
let skyboxAlphaG = max(roughness * roughness, 0.000001);
var specLod = log2(cubemapDim * skyboxAlphaG) * scene.vImageInfos.z;
var environmentRadiance = textureSampleLevel(iblTexture, iblSampler, R, clamp(specLod, 0.0, maxLod)).rgb * material.environmentIntensity;
let finalSpecularScaled = vec3<f32>(0.0);
let finalRadianceScaled = environmentRadiance;
color = finalRadianceScaled + emissive;`;
