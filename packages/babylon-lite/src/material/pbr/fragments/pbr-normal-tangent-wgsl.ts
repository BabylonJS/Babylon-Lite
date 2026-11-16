/** Tangent-space normal-map WGSL (mesh provides a TANGENT attribute) — dynamically imported.
 *
 *  Loaded by pbr-renderable only when a mesh in the group pairs a normal texture with
 *  vertex tangents, so PBR scenes without normal maps bundle none of it.
 */
import { wgsl } from "../../../shader/wgsl.js";

/** Vertex-stage tangent frame, written to the worldTangent/worldBitangent varyings. */
export function tangentFrameVertex(normVar: string): string {
    return wgsl`let N_local=normalize(${normVar});
let T_local=normalize(tangent.xyz);
let B_local=cross(N_local,T_local)*tangent.w;
out.worldTangent=(finalWorld*vec4<f32>(T_local,0.0)).xyz;
out.worldBitangent=(finalWorld*vec4<f32>(B_local,0.0)).xyz;`;
}

/** Fragment-stage normal perturbation through the interpolated TBN frame. */
export function tangentNormalFragment(normalUV: string, normalScaleMod: string, normalRef: string): string {
    return wgsl`let normalMapRaw=textureSample(normalTexture,normalSampler_,${normalUV}).rgb*2.0-1.0;
${normalScaleMod}let normalMapNorm=normalize(${normalRef});
var N_geom=normalize(input.worldNormal);
let TBN=mat3x3<f32>(input.worldTangent,input.worldBitangent,input.worldNormal);
var N=normalize(TBN*normalMapNorm);`;
}
