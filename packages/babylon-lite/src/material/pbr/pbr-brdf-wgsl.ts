import { wgsl } from "../../shader/wgsl.js";

export const PBR_BRDF_WGSL = wgsl`
const PI:f32=3.14159265358979323846;
fn distributionGGX(NdotH:f32,alphaG:f32)->f32{
let a2=alphaG*alphaG;
let d=NdotH*NdotH*(a2-1.0)+1.0;
return a2/(PI*d*d);
}
fn geometrySmithGGX(NdotL:f32,NdotV:f32,alphaG:f32)->f32{
let a2=alphaG*alphaG;
let gl=NdotL*sqrt(NdotV*(NdotV-a2*NdotV)+a2);
let gv=NdotV*sqrt(NdotL*(NdotL-a2*NdotL)+a2);
return 0.5/(gl+gv);
}
fn fresnelSchlick(cosTheta:f32,F0:vec3<f32>,F90:vec3<f32>)->vec3<f32>{
let t=1.0-cosTheta;
let t2=t*t;
return F0+(F90-F0)*(t2*t2*t);
}
`;

export const PBR_ROUGHNESS_WGSL = wgsl`var alphaG=roughness*roughness+0.0005;
var AA_factor_x=0.0;
var AA_factor_y=0.0;`;

/** Direct lights use AA_factor_x before squaring; IBL uses the additive alpha-G bump. */
export const PBR_SPECULAR_AA_WGSL = wgsl`{let nDfdx_AA=dpdx(N);
let nDfdy_AA=dpdy(N);
let slopeSquare_AA=max(dot(nDfdx_AA,nDfdx_AA),dot(nDfdy_AA,nDfdy_AA));
AA_factor_x=pow(saturate(slopeSquare_AA),0.333);
AA_factor_y=sqrt(slopeSquare_AA)*0.75;
alphaG+=AA_factor_y;}`;
