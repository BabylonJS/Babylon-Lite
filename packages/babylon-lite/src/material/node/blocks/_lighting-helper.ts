/** Shared WGSL helper source for LightBlock.
 *
 *  This constant is only pulled into a shader when LightBlock is used. The
 *  pipeline builder inspects `state.fragment.helpers` for the "nme_lighting"
 *  key and — when present — prepends the helper together with the scene's
 *  shared Lights UBO layout.
 *
 *  Sentinels expected in scope of the helper:
 *    - `nmeLightsCount : u32`
 *    - `nmeLights : array<LightData, N>` (LightData = direction, color, type, ...)
 *  These are provided by the pipeline builder at bind-group assembly time.
 */

export const NME_LIGHTING_HELPER_KEY = "nme_lighting";

export const NME_LIGHTING_HELPER_WGSL = `
struct NmeLightResult {
    diffuse: vec3<f32>,
    specular: vec3<f32>,
};

fn nme_computeLighting(
    worldPos: vec3<f32>,
    worldNormal: vec3<f32>,
    cameraPos: vec3<f32>,
    diffuseColor: vec3<f32>,
    specularColor: vec3<f32>,
    glossiness: f32
) -> NmeLightResult {
    var result: NmeLightResult;
    result.diffuse = vec3<f32>(0.0);
    result.specular = vec3<f32>(0.0);
    let viewDir = normalize(cameraPos - worldPos);
    let N = normalize(worldNormal);
    for (var i: u32 = 0u; i < nmeLightsCount; i = i + 1u) {
        let L = normalize(-nmeLights[i].direction.xyz);
        let NdotL = max(dot(N, L), 0.0);
        result.diffuse = result.diffuse + nmeLights[i].color.rgb * diffuseColor * NdotL;
        let H = normalize(L + viewDir);
        let NdotH = max(dot(N, H), 0.0);
        let specFactor = pow(NdotH, max(glossiness * 255.0, 1.0));
        result.specular = result.specular + nmeLights[i].color.rgb * specularColor * specFactor;
    }
    return result;
}
`;
