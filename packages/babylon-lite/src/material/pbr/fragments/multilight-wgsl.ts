/** Multi-light WGSL helpers for PBR template.
 *  Separated into its own module so non-shadow PBR scenes don't pay the bundle cost. */

export const MULTI_LIGHT_STRUCTS = `
struct LightEntry {
vLightData: vec4<f32>,
vLightDiffuse: vec4<f32>,
vLightSpecular: vec4<f32>,
vLightDirection: vec4<f32>,
};
struct lightsUniforms {
count: u32, _p0: u32, _p1: u32, _p2: u32,
lights: array<LightEntry, 4>,
};
`;

export const COMPUTE_PBR_LIGHT = `
struct PbrLightResult { L: vec3<f32>, NdotL: f32, atten: f32, color: vec3<f32>, isHemi: bool };
fn computePbrLight(entry: LightEntry, N: vec3<f32>, worldPos: vec3<f32>) -> PbrLightResult {
var r: PbrLightResult;
let t = u32(entry.vLightData.w);
r.isHemi = t == 3u;
if (t == 3u) {
r.L = normalize(entry.vLightData.xyz);
r.NdotL = dot(N, r.L) * 0.5 + 0.5;
r.atten = 1.0;
r.color = mix(entry.vLightDirection.xyz, entry.vLightDiffuse.rgb, r.NdotL);
return r;
}
if (t == 1u) {
r.L = normalize(-entry.vLightData.xyz);
r.atten = 1.0;
} else {
let toLight = entry.vLightData.xyz - worldPos;
let dist = length(toLight);
r.L = toLight / max(dist, 0.0001);
r.atten = max(0.0, 1.0 - dist / entry.vLightDiffuse.a);
if (t == 2u) {
let c = max(0.0, dot(entry.vLightDirection.xyz, -r.L));
if (c >= entry.vLightDirection.w) { r.atten *= max(0.0, pow(c, entry.vLightSpecular.a)); }
else { r.atten = 0.0; }
}
}
r.NdotL = max(dot(N, r.L), 0.0);
r.color = entry.vLightDiffuse.rgb;
return r;
}
`;

/** The multi-light direct lighting loop WGSL block for the PBR template.
 *  Contains slot markers AD and BL for fragment injection. */
export const MULTI_LIGHT_LOOP = `var directDiffuse = vec3<f32>(0.0);
var directSpecular = vec3<f32>(0.0);
var shadowFactors = array<f32, 4>(1.0, 1.0, 1.0, 1.0);
/*AD*/
let lc = min(lights.count, 4u);
for (var li = 0u; li < lc; li++) {
let entry = lights.lights[li];
let pl = computePbrLight(entry, N, input.worldPos);
let sf = shadowFactors[li];
if (pl.isHemi) {
directDiffuse += pl.color * surfaceAlbedo * mesh.directIntensity * sf;
} else {
directDiffuse += surfaceAlbedo * (1.0 / PI) * pl.NdotL * pl.color * pl.atten * mesh.directIntensity * sf;
}
let specNdotL = max(dot(N, pl.L), 0.0);
if (specNdotL > 0.0 && pl.atten > 0.0) {
let H = normalize(V + pl.L);
let NdotH = clamp(dot(N, H), 0.0000001, 1.0);
let VdotH = saturate(dot(V, H));
let D = distributionGGX(NdotH, alphaG);
let G = geometrySmithGGX(specNdotL, NdotV, alphaG);
let coloredFresnel = fresnelSchlick(VdotH, colorF0, colorF90);
directSpecular += coloredFresnel * D * G * specNdotL * pl.color * pl.atten * mesh.directIntensity * sf;
}
}
/*BL*/`;
