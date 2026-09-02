import { wgsl } from "../../../shader/wgsl.js";

export const CLUSTERED_LIGHT_STRUCTS = wgsl`
struct clusteredLightParamsUniforms {
tileCountX: u32,
tileCountY: u32,
zSlices: u32,
lightCount: u32,
sliceScale: f32,
sliceBias: f32,
dataTextureWidth: u32,
batchCount: u32,
};
fn clusteredTexel(index:u32)->vec2<u32>{return vec2<u32>(index%clusteredLightParams.dataTextureWidth,index/clusteredLightParams.dataTextureWidth);}
`;

/** Direct-lighting loop over a clustered light set.
 *
 *  Point-only and point+spot variants share the body generator, while the spot
 *  cone string remains tree-shakable from point-only bundles.
 *
 *  Layout (rgba32float, `stride` texels per light):
 *    +0  position.xyz, range
 *    +1  diffuse.rgb, intensity
 *    +2  direction.xyz, cosHalfAngle   (spot containers only; `w < 0` means point)
 *
 *  Falloff matches Babylon.js' glTF mode (`useGLTFLightFalloff`), which is what
 *  `ClusteredLightContainer` is compared against: `computeDistanceLightFalloff_GLTF`
 *  for range and `computeDirectionalLightFalloff_GLTF` for the cone. The cone's
 *  `lightAngleScale` / `lightAngleOffset` are derived from `cosHalfAngle` in the
 *  shader instead of being uploaded, which is exact for BJS' default inner angle of 0. */
function clusteredLightBlock(stride: string, cone: string): string {
    return wgsl`
{
let clip=scene.viewProjection*vec4<f32>(input.worldPos,1.0);
let ndc=clip.xyz/clip.w;
let tx=clamp(u32((ndc.x*0.5+0.5)*f32(clusteredLightParams.tileCountX)),0u,clusteredLightParams.tileCountX-1u);
let ty=clamp(u32((0.5-ndc.y*0.5)*f32(clusteredLightParams.tileCountY)),0u,clusteredLightParams.tileCountY-1u);
let viewPos=scene.view*vec4<f32>(input.worldPos,1.0);
let tzi=clamp(i32(log(max(viewPos.z,0.0001))*clusteredLightParams.sliceScale+clusteredLightParams.sliceBias),0,i32(clusteredLightParams.zSlices)-1);
let slice=textureLoad(clusteredCells,clusteredTexel(u32(tzi)),0);
let directRoughnessCluster=max(roughness,AA_factor_x);
let directAlphaGCluster=directRoughnessCluster*directRoughnessCluster+0.0005;
if(slice.x<=slice.y){
let firstLight=slice.x;
let lastLight=min(slice.y,clusteredLightParams.lightCount-1u);
let firstBatch=firstLight/32u;
let lastBatch=lastLight/32u;
for(var batch=firstBatch;batch<=lastBatch;batch++){
let batchOffset=batch*32u;
let tileMaskIndex=(tx*clusteredLightParams.tileCountY+ty)*clusteredLightParams.batchCount+batch;
var mask=textureLoad(clusteredIndices,clusteredTexel(tileMaskIndex),0).x;
let maskOffset=max(firstLight,batchOffset)-batchOffset;
let maskWidth=min(lastLight-batchOffset+1u,32u);
mask=extractBits(mask,maskOffset,maskWidth);
while(mask!=0u){
let trailing=firstTrailingBit(mask);
mask^=1u<<trailing;
let li=batchOffset+maskOffset+trailing;
let lightTexel=li*${stride};
let positionRange=textureLoad(clusteredLights,clusteredTexel(lightTexel),0);
let colorIntensity=textureLoad(clusteredLights,clusteredTexel(lightTexel+1u),0);
let toLight=positionRange.xyz-input.worldPos;
let d2=dot(toLight,toLight);
let dist=sqrt(d2);
let range=max(positionRange.w,0.0001);
if(dist<range){
let Lc=toLight/max(dist,0.0001);
let NdotLc=max(dot(N,Lc),0.0);
let range2=max(range*range,0.0000001);
let falloffFactor=d2/range2;
var rangeAtt=1.0/max(d2,0.0000001);
var smoothRange=saturate(1.0-falloffFactor*falloffFactor);
smoothRange*=smoothRange;
rangeAtt*=smoothRange;
${cone}let lightRadiance=colorIntensity.rgb*colorIntensity.a*rangeAtt*material.directIntensity;
directDiffuse+=surfaceAlbedo*(1.0/PI)*NdotLc*lightRadiance;
if(NdotLc>0.0){
let Hc=normalize(V+Lc);
let NdotHc=clamp(dot(N,Hc),0.0000001,1.0);
let VdotHc=saturate(dot(V,Hc));
let Dc=distributionGGX(NdotHc,directAlphaGCluster);
let Gc=geometrySmithGGX(NdotLc,NdotV,directAlphaGCluster);
let Fc=fresnelSchlick(VdotHc,colorF0,colorF90);
directSpecular+=Fc*Dc*Gc*NdotLc*lightRadiance;
}
}
}
}
}
}
`;
}

/** @internal Point-only clustered shader. */
export function _clusteredPointLightBlock(): string {
    return clusteredLightBlock("2u", "");
}

/** @internal Point+spot clustered shader with smooth cone falloff. */
export function _clusteredSpotLightBlock(): string {
    return clusteredLightBlock(
        "3u",
        wgsl`let dirCone=textureLoad(clusteredLights,clusteredTexel(lightTexel+2u),0);
if(dirCone.w>=0.0){
let cd=dot(-dirCone.xyz,Lc);
let coneAtt=saturate((cd-dirCone.w)/max(1.0-dirCone.w,0.001));
rangeAtt*=coneAtt*coneAtt;
}
`
    );
}
