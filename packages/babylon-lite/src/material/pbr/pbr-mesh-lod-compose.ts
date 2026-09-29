/** PBR MeshLoD shader composition — the storage-fetch vertex + PBR/unlit fragment
 *  WGSL for coarse indirect rendering.
 *
 *  The vertex stage reads a 16-byte draw-vertex record, fetches the 24-byte packed
 *  vertex (position `f32x3`, octahedral `snorm16x2` normal, `f16x2` UV, reserved)
 *  from the raw geometry arena, and transforms it by the instance's world/normal
 *  matrices — no vertex/index buffers are bound. The fragment stage reuses the
 *  guaranteed opaque metallic-roughness PBR behaviour (SH irradiance IBL + direct
 *  lights from the scene lights UBO) or the unlit path. All MeshLoD WGSL lives here
 *  under `material/pbr`; the generic renderer never sees it. */

import { SCENE_UBO_WGSL } from "../../shader/scene-uniforms.js";
import { MULTI_LIGHT_STRUCTS, COMPUTE_PBR_LIGHT } from "./fragments/multilight-wgsl.js";
import { MAX_LIGHTS } from "../../light/types.js";

/** Detected features for the guaranteed opaque metallic-roughness subset. */
export interface MeshLoDShaderFeatures {
    readonly hasNormalMap: boolean;
    readonly hasEmissiveTexture: boolean;
    readonly doubleSided: boolean;
    readonly unlit: boolean;
}

/** Stable pipeline cache key for a feature set. */
export function meshLoDShaderKey(f: MeshLoDShaderFeatures): string {
    return `${f.hasNormalMap ? "n" : ""}${f.hasEmissiveTexture ? "e" : ""}${f.doubleSided ? "d" : ""}${f.unlit ? "u" : ""}`;
}

const COMMON_DECLS = `struct MeshLoDMaterial {
baseColorFactor: vec4<f32>,
emissive: vec4<f32>,
mrp: vec4<f32>,
lighting: vec4<f32>,
misc: vec4<f32>,
};
@group(1) @binding(0) var<uniform> material: MeshLoDMaterial;
@group(1) @binding(1) var baseColorTexture: texture_2d<f32>;
@group(1) @binding(2) var baseColorSampler: sampler;
@group(1) @binding(3) var normalTexture: texture_2d<f32>;
@group(1) @binding(4) var normalSampler_: sampler;
@group(1) @binding(5) var ormTexture: texture_2d<f32>;
@group(1) @binding(6) var ormSampler: sampler;
@group(1) @binding(7) var emissiveTexture: texture_2d<f32>;
@group(1) @binding(8) var emissiveSampler: sampler;
struct DrawVertex { data: vec4<u32> };
struct InstanceRecord { world: mat4x4<f32>, n0: vec4<f32>, n1: vec4<f32>, n2: vec4<f32>, pad: vec4<f32> };
@group(1) @binding(9) var<storage, read> arena: array<u32>;
@group(1) @binding(10) var<storage, read> drawVertices: array<DrawVertex>;
@group(1) @binding(11) var<storage, read> instances: array<InstanceRecord>;
struct VOut {
@builtin(position) clipPos: vec4<f32>,
@location(0) worldPos: vec3<f32>,
@location(1) worldNormal: vec3<f32>,
@location(2) uv: vec2<f32>,
@location(3) @interpolate(flat) clusterId: u32,
@location(4) @interpolate(flat) dbgAttr: u32,
};`;

const VERTEX_MAIN = `fn octSign(x: f32) -> f32 { return select(-1.0, 1.0, x >= 0.0); }
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VOut {
let rec = drawVertices[vi].data;
let base = rec.x;
let instId = rec.z;
let w0 = arena[base];
let w1 = arena[base + 1u];
let w2 = arena[base + 2u];
let w3 = arena[base + 3u];
let w4 = arena[base + 4u];
let pos = vec3<f32>(bitcast<f32>(w0), bitcast<f32>(w1), bitcast<f32>(w2));
let oct = unpack2x16snorm(w3);
var nx = oct.x;
var ny = oct.y;
let nz = 1.0 - abs(nx) - abs(ny);
if (nz < 0.0) {
let tx = (1.0 - abs(ny)) * octSign(nx);
let ty = (1.0 - abs(nx)) * octSign(ny);
nx = tx;
ny = ty;
}
let nrm = normalize(vec3<f32>(nx, ny, nz));
let uv = unpack2x16float(w4);
let inst = instances[instId];
let world4 = inst.world * vec4<f32>(pos, 1.0);
var out: VOut;
out.worldPos = world4.xyz;
out.clipPos = scene.viewProjection * world4;
let nmat = mat3x3<f32>(inst.n0.xyz, inst.n1.xyz, inst.n2.xyz);
out.worldNormal = nmat * nrm;
out.uv = uv;
out.clusterId = rec.y;
out.dbgAttr = rec.w;
return out;
}`;

// Debug-view fragment output (architecture §15.5). `material.misc.y` selects the
// mode (see pbr-mesh-lod-debug.ts::meshLoDDebugModeCode); the per-cluster attribute
// arrives in the flat `dbgAttr` draw-vertex word. Keep these palettes in sync with
// the demo legend. Observational only — never affects selection/residency/demand.
const DEBUG_HELPERS = `fn mlodHash(x: u32) -> u32 {
var h = (x + 1u) * 2654435761u;
h = h ^ (h >> 15u);
h = h * 2246822519u;
h = h ^ (h >> 13u);
return h;
}
fn mlodHashColor(id: u32) -> vec3<f32> {
let h = mlodHash(id);
let c = vec3<f32>(f32(h & 255u), f32((h >> 8u) & 255u), f32((h >> 16u) & 255u)) / 255.0;
return mix(vec3<f32>(0.18), vec3<f32>(1.0), c);
}
fn mlodDepthColor(depth: u32) -> vec3<f32> {
let t = clamp(f32(depth) / 11.0, 0.0, 1.0);
return vec3<f32>(t, 1.0 - abs(t - 0.5) * 2.0, 1.0 - t);
}
fn mlodResidencyColor(code: u32) -> vec3<f32> {
if (code == 1u) { return vec3<f32>(0.20, 0.90, 0.35); }
if (code == 2u) { return vec3<f32>(0.95, 0.82, 0.20); }
if (code == 3u) { return vec3<f32>(0.95, 0.22, 0.20); }
return vec3<f32>(0.45, 0.45, 0.45);
}
fn mlodDebugColor(mode: u32, clusterId: u32, attr: u32) -> vec4<f32> {
if (mode == 1u) { return vec4<f32>(mlodHashColor(clusterId), 1.0); }
if (mode == 2u) { return vec4<f32>(mlodDepthColor(attr), 1.0); }
if (mode == 3u) { return vec4<f32>(mlodHashColor(attr), 1.0); }
if (mode == 4u) { return vec4<f32>(mlodResidencyColor(attr), 1.0); }
if (mode == 5u) {
if (attr == 1u) { return vec4<f32>(0.0, 0.85, 1.0, 1.0); }
if (attr == 2u) { return vec4<f32>(1.0, 0.55, 0.0, 1.0); }
return vec4<f32>(0.0, 0.0, 0.0, -1.0);
}
if (mode == 6u) {
let margin = bitcast<f32>(attr);
let visibility = clamp(margin * 4.0, 0.0, 1.0);
return vec4<f32>(mix(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 1.0, 0.0), visibility), 1.0);
}
return vec4<f32>(0.0, 0.0, 0.0, -1.0);
}`;

const PBR_HELPERS = `const PI: f32 = 3.14159265358979323846;
fn saturate(x: f32) -> f32 { return clamp(x, 0.0, 1.0); }
fn distributionGGX(NdotH: f32, alphaG: f32) -> f32 {
let a2 = alphaG * alphaG;
let d = NdotH * NdotH * (a2 - 1.0) + 1.0;
return a2 / (PI * d * d);
}
fn geometrySmithGGX(NdotL: f32, NdotV: f32, alphaG: f32) -> f32 {
let a2 = alphaG * alphaG;
let gl = NdotL * sqrt(NdotV * (NdotV - a2 * NdotV) + a2);
let gv = NdotV * sqrt(NdotL * (NdotL - a2 * NdotL) + a2);
return 0.5 / (gl + gv + 1e-7);
}
fn fresnelSchlick(cosTheta: f32, F0: vec3<f32>, F90: vec3<f32>) -> vec3<f32> {
let t = 1.0 - cosTheta;
let t2 = t * t;
return F0 + (F90 - F0) * (t2 * t2 * t);
}
fn rotateY(v: vec3<f32>, angle: f32) -> vec3<f32> {
let c = cos(angle);
let s = sin(angle);
return vec3<f32>(v.x * c + v.z * s, v.y, -v.x * s + v.z * c);
}
fn shIrradiance(n: vec3<f32>) -> vec3<f32> {
return scene.vSphericalL00.rgb
+ scene.vSphericalL1_1.rgb * n.y + scene.vSphericalL10.rgb * n.z + scene.vSphericalL11.rgb * n.x
+ scene.vSphericalL2_2.rgb * (n.y * n.x) + scene.vSphericalL2_1.rgb * (n.y * n.z)
+ scene.vSphericalL20.rgb * (3.0 * n.z * n.z - 1.0) + scene.vSphericalL21.rgb * (n.z * n.x)
+ scene.vSphericalL22.rgb * (n.x * n.x - n.y * n.y);
}`;

function normalBlock(hasNormalMap: boolean): string {
    if (hasNormalMap) {
        return `let normalMap = textureSample(normalTexture, normalSampler_, input.uv).rgb * 2.0 - 1.0;
let scaledN = normalize(vec3<f32>(normalMap.xy * material.mrp.z, normalMap.z));
var Ngeom = normalize(input.worldNormal);
let dp1 = dpdx(input.worldPos);
let dp2 = dpdy(input.worldPos);
let duv1 = dpdx(input.uv);
let duv2 = dpdy(input.uv);
let dp2perp = cross(dp2, Ngeom);
let dp1perp = cross(Ngeom, dp1);
let Tt = dp2perp * duv1.x + dp1perp * duv2.x;
let Bt = -(dp2perp * duv1.y + dp1perp * duv2.y);
let invmax = inverseSqrt(max(dot(Tt, Tt), dot(Bt, Bt)) + 1e-7);
let TBN = mat3x3<f32>(Tt * invmax, Bt * invmax, Ngeom);
var N = normalize(TBN * scaledN);`;
    }
    return `var Ngeom = normalize(input.worldNormal);
var N = Ngeom;`;
}

function litFragment(f: MeshLoDShaderFeatures): string {
    const entry = f.doubleSided
        ? `@fragment fn fs(input: VOut, @builtin(front_facing) frontFacing: bool) -> @location(0) vec4<f32> {`
        : `@fragment fn fs(input: VOut) -> @location(0) vec4<f32> {`;
    const flip = f.doubleSided ? `if (!frontFacing) { N = -N; Ngeom = -Ngeom; }` : ``;
    const emissiveTex = f.hasEmissiveTexture ? `emissive = emissive * textureSample(emissiveTexture, emissiveSampler, input.uv).rgb;` : ``;
    return `${entry}
let baseSample = textureSample(baseColorTexture, baseColorSampler, input.uv);
var albedo = baseSample.rgb * material.baseColorFactor.rgb;
${normalBlock(f.hasNormalMap)}
${flip}
let V = normalize(scene.vEyePosition.xyz - input.worldPos);
let NdotV = max(abs(dot(N, V)), 1e-4);
let orm = textureSample(ormTexture, ormSampler, input.uv);
let roughness = clamp(orm.g * material.mrp.y, 0.045, 1.0);
let metallic = clamp(orm.b * material.mrp.x, 0.0, 1.0);
let occlusion = 1.0 + material.mrp.w * (orm.r - 1.0);
let reflectance = material.lighting.z;
let colorF0 = mix(vec3<f32>(reflectance), albedo, metallic);
let colorF90 = vec3<f32>(1.0);
let surfaceAlbedo = albedo * (1.0 - reflectance) * (1.0 - metallic);
let alphaG = roughness * roughness + 0.0005;
let envN = rotateY(N, scene.envRotationY);
let irradiance = shIrradiance(envN) * material.lighting.x;
let diffuseIbl = irradiance * surfaceAlbedo * occlusion;
let R = rotateY(reflect(-V, N), scene.envRotationY);
let specFresnel = fresnelSchlick(NdotV, colorF0, colorF90);
let specIbl = shIrradiance(R) * specFresnel * occlusion * material.lighting.x * (1.0 - roughness);
var directDiffuse = vec3<f32>(0.0);
var directSpecular = vec3<f32>(0.0);
let lightCount = min(lights.count, ${MAX_LIGHTS}u);
for (var li = 0u; li < lightCount; li = li + 1u) {
let pl = computePbrLight(lights.lights[li], N, input.worldPos, material.misc.x);
if (pl.isHemi) {
directDiffuse = directDiffuse + pl.color * surfaceAlbedo * material.lighting.y;
} else {
directDiffuse = directDiffuse + surfaceAlbedo * (1.0 / PI) * pl.NdotL * pl.color * pl.atten * material.lighting.y;
if (pl.NdotL > 0.0 && pl.atten > 0.0) {
let H = normalize(V + pl.L);
let NdotH = clamp(dot(N, H), 1e-7, 1.0);
let VdotH = saturate(dot(V, H));
let D = distributionGGX(NdotH, alphaG);
let G = geometrySmithGGX(pl.NdotL, NdotV, alphaG);
let Fr = fresnelSchlick(VdotH, colorF0, colorF90);
directSpecular = directSpecular + Fr * D * G * pl.NdotL * pl.specColor * pl.atten * material.lighting.y;
}
}
}
var emissive = material.emissive.rgb;
${emissiveTex}
var color = diffuseIbl + specIbl + directDiffuse + directSpecular + emissive;
color = color * scene.vImageInfos.x;
if (scene.vImageInfos.w >= 1.0) { color = vec3<f32>(1.0) - exp(-color); }
// Debug-view override AFTER all texture sampling (textureSample requires uniform
// control flow, so the non-uniform per-fragment debug branch must come last).
let dbg = mlodDebugColor(u32(material.misc.y + 0.5), input.clusterId, input.dbgAttr);
if (dbg.a >= 0.0) { return vec4<f32>(dbg.rgb, 1.0); }
return vec4<f32>(color, 1.0);
}`;
}

function unlitFragment(): string {
    return `@fragment fn fs(input: VOut) -> @location(0) vec4<f32> {
let baseSample = textureSample(baseColorTexture, baseColorSampler, input.uv);
let color = baseSample.rgb * material.baseColorFactor.rgb;
let dbg = mlodDebugColor(u32(material.misc.y + 0.5), input.clusterId, input.dbgAttr);
if (dbg.a >= 0.0) { return vec4<f32>(dbg.rgb, 1.0); }
return vec4<f32>(color, 1.0);
}`;
}

/** Compose the full MeshLoD WGSL module (vertex `vs` + fragment `fs`) for a feature set. */
export function composeMeshLoDWgsl(f: MeshLoDShaderFeatures): string {
    const parts = [SCENE_UBO_WGSL, COMMON_DECLS, VERTEX_MAIN, DEBUG_HELPERS];
    if (f.unlit) {
        parts.push(unlitFragment());
    } else {
        parts.push(MULTI_LIGHT_STRUCTS(), `@group(0) @binding(1) var<uniform> lights: lightsUniforms;`, COMPUTE_PBR_LIGHT, PBR_HELPERS, litFragment(f));
    }
    return parts.join("\n");
}
