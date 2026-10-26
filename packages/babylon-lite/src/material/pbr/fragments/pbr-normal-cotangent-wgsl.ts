/** Cotangent-frame normal-map WGSL (mesh has no TANGENT attribute) — dynamically imported.
 *
 *  The tangent frame is rebuilt per fragment from screen-space derivatives. Loaded by
 *  pbr-renderable only when a mesh in the group pairs a normal texture with no vertex
 *  tangents, so PBR scenes without such meshes bundle none of it.
 */
import { wgsl } from "../../../shader/wgsl.js";

/** Fragment-stage normal perturbation through a derivative-based cotangent frame. */
export function cotangentNormalFragment(normalUV: string, normalScaleMod: string, normalRef: string): string {
    return wgsl`let normalMapSample=textureSample(normalTexture,normalSampler_,${normalUV}).rgb*2.0-1.0;
${normalScaleMod.replace(/normalMapRaw/g, "normalMapSample").replace(/scaledNormal/g, "scaledNormalCT")}var N_geom=normalize(input.worldNormal);
let dp1=dpdx(input.worldPos);
let dp2=dpdy(input.worldPos);
let duv1=dpdx(${normalUV});
let duv2=dpdy(${normalUV});
let dp2perp=cross(dp2,N_geom);
let dp1perp=cross(N_geom,dp1);
let tangent_ct=dp2perp*duv1.x+dp1perp*duv2.x;
let bitangent_ct=-(dp2perp*duv1.y+dp1perp*duv2.y);
let det=max(dot(tangent_ct,tangent_ct),dot(bitangent_ct,bitangent_ct));
let invmax=select(inverseSqrt(det),0.0,det==0.0);
let cotangentFrame=mat3x3<f32>(tangent_ct*invmax,bitangent_ct*invmax,N_geom);
var N=normalize(cotangentFrame*normalize(${normalRef}));`;
}
