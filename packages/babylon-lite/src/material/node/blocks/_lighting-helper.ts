/** Shared WGSL helper source for LightBlock.
 *
 *  This module exports just the `nme_computeLighting` function definition.
 *  The surrounding `LightEntry` / `lightsUniforms` struct decls and the
 *  `@group(1) @binding(N) var<uniform> nmeLights` declaration are injected
 *  by the pipeline builder (see node-pipeline.ts) once `state.usesLightsUbo`
 *  is true. Keeping them out of the helper lets a single `MAX_LIGHTS` value
 *  (at compile time) drive both the WGSL array length and the BGL entry size.
 */

import { MAX_LIGHTS } from "../../../light/types.js";

export const NME_LIGHTING_HELPER_KEY = "nme_lighting";

export const NME_LIGHTING_HELPER_WGSL = `struct NmeLightResult {
    diffuse: vec3<f32>,
    specular: vec3<f32>,
    shadow: f32,
};

fn nme_computeLighting(
    worldPos: vec3<f32>,
    worldNormal: vec3<f32>,
    cameraPos: vec3<f32>,
    diffuseColor: vec3<f32>,
    specularColor: vec3<f32>,
    glossiness: f32,
    shadowFactors: array<f32, ${MAX_LIGHTS}>
) -> NmeLightResult {
    var result: NmeLightResult;
    result.diffuse = vec3<f32>(0.0);
    result.specular = vec3<f32>(0.0);
    var aggShadow: f32 = 0.0;
    var numLights: f32 = 0.0;
    let viewDir = normalize(cameraPos - worldPos);
    let N = normalize(worldNormal);
     let lc = min(meshU.lc, ${MAX_LIGHTS}u);
     for (var i: u32 = 0u; i < lc; i = i + 1u) {
        let lightIndex = nli(i);
        let L = nmeLights.lights[lightIndex];
        let t = u32(L.vLightData.w);
        let sh = shadowFactors[lightIndex];
        var lv: vec3<f32>;
        var atten: f32 = 1.0;
        if (t == 3u) {
            // Hemispheric: ground/sky mix via half-lambert.
            let nl = 0.5 + 0.5 * dot(N, normalize(L.vLightData.xyz));
            let diff = mix(L.vLightDirection.xyz, L.vLightDiffuse.rgb, nl);
            result.diffuse = result.diffuse + diff * diffuseColor * sh;
            let H = normalize(viewDir + normalize(L.vLightData.xyz));
            let sf = pow(max(0.0, dot(N, H)), max(1.0, glossiness));
            result.specular = result.specular + sf * L.vLightSpecular.rgb * specularColor * sh;
            aggShadow = aggShadow + sh;
            numLights = numLights + 1.0;
            continue;
        }
        if (t == 1u) {
            // Directional: vLightData.xyz is the light's forward direction.
            lv = normalize(-L.vLightData.xyz);
        } else {
            // Point / Spot: vLightData.xyz is world-space position; range in vLightDiffuse.a.
            let d = L.vLightData.xyz - worldPos;
            atten = max(0.0, 1.0 - length(d) / L.vLightDiffuse.a);
            lv = normalize(d);
            if (t == 2u) {
                // Spot cone falloff (vLightDirection.xyz=dir, .w=cosHalfAngle; vLightSpecular.a=exp).
                let c = max(0.0, dot(L.vLightDirection.xyz, -lv));
                if (c >= L.vLightDirection.w) {
                    atten = atten * max(0.0, pow(c, L.vLightSpecular.a));
                } else {
                    atten = 0.0;
                }
            }
        }
        let NdotL = max(0.0, dot(N, lv));
        result.diffuse = result.diffuse + L.vLightDiffuse.rgb * diffuseColor * NdotL * atten * sh;
        let H = normalize(lv + viewDir);
        let NdotH = max(0.0, dot(N, H));
        let specFactor = pow(NdotH, max(1.0, glossiness));
        result.specular = result.specular + L.vLightSpecular.rgb * specularColor * specFactor * atten * sh;
        aggShadow = aggShadow + sh;
        numLights = numLights + 1.0;
    }
    if (numLights > 0.0) {
        result.shadow = aggShadow / numLights;
    } else {
        result.shadow = 1.0;
    }
    return result;
}
`;
