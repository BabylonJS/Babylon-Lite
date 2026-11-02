import { wgsl, type WgslSource } from "../shader/wgsl.js";
import { SSAO_PARAMS_WGSL, ssaoDepthBindingWGSL, ssaoDepthNormalWGSL } from "./ssao-wgsl.js";

/** @internal Shared tap compatibility; `other` and `n` are unit view-space normals. */
function ssaoUpsampleCompatibilityWGSL(): WgslSource {
    return wgsl`fn compatibleTap(tap:vec3f,other:vec3f,point:vec3f,n:vec3f)->f32{
let cosine=dot(other,n);let agreement=clamp(cosine,0.0,1.0);
let delta=tap-point;
if(agreement<0.9){
// Connected concave faces share contact AO; silhouettes and depth gaps do not.
if(cosine<=-0.9){return 0.0;}
let epsilon=max(1e-4,point.z*1e-5);
if(dot(delta,n)<-epsilon||dot(delta,other)>epsilon){return 0.0;}
let view=normalize(-point);
let incidence=max(0.1,min(abs(dot(n,view)),abs(dot(other,view))));
let footprint=2.5*point.z*max(abs(ao.pixelViewSize.x),abs(ao.pixelViewSize.y))/incidence;
let limit=min(ao.radius*0.25,footprint);
return select(0.0,1.0,dot(delta,delta)<=limit*limit);
}
let allowance=max(1e-4,min(point.z*0.005,ao.radius*0.025))+0.5*length(delta)*length(other-n);
let a2=agreement*agreement;let a4=a2*a2;
return clamp(1.0-abs(dot(delta,n))/allowance,0.0,1.0)*(a4*a4);
}`;
}

/**
 * @internal Half-pipeline reconstruction. Tap depth/normal/visibility come from the reduced
 * inputs, which hold exactly the full-size samples at `min(2q+1,size-1)`; each 8x8 group
 * evaluates its 6x6 tap footprint once in workgroup memory instead of four times per pixel.
 */
export function ssaoHalfPipelineUpsampleWGSL(sourceNormals: boolean): WgslSource {
    return wgsl`${SSAO_PARAMS_WGSL}
${ssaoDepthBindingWGSL("depth", 1)}
@group(0) @binding(2) var normalInput:texture_2d<f32>;
@group(0) @binding(3) var sparseVisibility:texture_2d<f32>;
@group(0) @binding(4) var output:texture_storage_2d<rgba16float,write>;
@group(0) @binding(5) var sparseDepth:texture_2d<f32>;
@group(0) @binding(6) var sparseNormal:texture_2d<f32>;
override SOURCE_WORLD:u32=0u;
var<workgroup> tapPoint:array<vec4f,36>;
var<workgroup> tapNormal:array<vec3f,36>;
${
    sourceNormals
        ? wgsl``
        : wgsl`var<workgroup> aoTileDepth:array<f32,144>;
var<workgroup> aoTileOrigin:vec2i;
fn aoCachedDepth(p:vec2i)->f32{let q=aoClamp(p,ao.size)-aoTileOrigin;return aoTileDepth[q.y*12+q.x];}
${ssaoDepthNormalWGSL("aoCachedDepth")}`
}
${ssaoUpsampleCompatibilityWGSL()}
fn viewNormal(n:vec3f)->vec3f{if(SOURCE_WORLD!=0u){return normalize((ao.view*vec4f(n,0)).xyz);}return n;}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u,@builtin(workgroup_id) group:vec3u,@builtin(local_invocation_index) lane:u32){
let dims=textureDimensions(sparseVisibility);
let tapOrigin=vec2i(group.xy*4u)-vec2i(1);
if(lane<36u){
let q=aoClamp(tapOrigin+vec2i(i32(lane%6u),i32(lane/6u)),dims);
let d=textureLoad(sparseDepth,q,0).r;
var point=vec4f(0,0,0,-1);var n=vec3f(0,0,-1);
if(d!=0.0){
let p=aoClamp(q*2+vec2i(1),ao.size);
point=vec4f(aoPosition((vec2f(p)+0.5)*ao.invSize,ao.depthUnpack.x/(ao.depthUnpack.y-d)),textureLoad(sparseVisibility,q,0).r);
n=normalize(viewNormal(textureLoad(sparseNormal,q,0).xyz));
}
tapPoint[lane]=point;tapNormal[lane]=n;
}
${
    sourceNormals
        ? wgsl``
        : wgsl`let tileOrigin=vec2i(group.xy*8u)-vec2i(2);
if(lane==0u){aoTileOrigin=tileOrigin;}
for(var i=lane;i<144u;i+=64u){aoTileDepth[i]=aoRawDepth(tileOrigin+vec2i(i32(i%12u),i32(i/12u)));}`
}
workgroupBarrier();
if(any(id.xy>=ao.size)){return;}let p=vec2i(id.xy);var value=1.0;
let d=${sourceNormals ? "aoRawDepth(p)" : "aoCachedDepth(p)"};
if(d!=0.0){
let point=aoPosition((vec2f(p)+0.5)*ao.invSize,ao.depthUnpack.x/(ao.depthUnpack.y-d));
var grid=(vec2f(id.xy)-1.0)*0.5;
if(id.x==ao.size.x-1u&&(ao.size.x&1u)!=0u){grid.x=f32(dims.x-1u);}
if(id.y==ao.size.y-1u&&(ao.size.y&1u)!=0u){grid.y=f32(dims.y-1u);}
let base=vec2i(floor(grid));let f=fract(grid);var sum=0.0;var weights=0.0;
let n=${sourceNormals ? "normalize(viewNormal(textureLoad(normalInput,p,0).xyz))" : "aoDepthNormal(p)"};
for(var y=0;y<2;y++){for(var x=0;x<2;x++){
let t=base+vec2i(x,y)-tapOrigin;let i=t.y*6+t.x;let tap=tapPoint[i];
if(tap.w<0.0){continue;}
let w=select(1.0-f.x,f.x,x==1)*select(1.0-f.y,f.y,y==1)*compatibleTap(tap.xyz,tapNormal[i],point,n);
sum+=w*tap.w;weights+=w;
}}
if(weights<1e-6){let nearest=aoClamp(vec2i(round(grid)),dims);
for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){
let t=nearest+vec2i(x,y);let q=aoClamp(t,dims);let i=(t.y-tapOrigin.y)*6+t.x-tapOrigin.x;let tap=tapPoint[i];
if(tap.w<0.0){continue;}
let delta=vec2f(q)-grid;let w=compatibleTap(tap.xyz,tapNormal[i],point,n)/(1.0+dot(delta,delta));
sum+=w*tap.w;weights+=w;
}}}
if(weights>=1e-6){value=clamp(sum/weights,0.0,1.0);}
}
textureStore(output,p,vec4f(value,value,value,1));
}`;
}

/** @internal Joint bilateral reconstruction from actual full-size receiver samples. */
export function ssaoHalfUpsampleWGSL(kind: "depth" | "float", sharedNormals = false): WgslSource {
    const depth = sharedNormals ? "aoCachedDepth" : "aoRawDepth";
    return wgsl`${SSAO_PARAMS_WGSL}
${ssaoDepthBindingWGSL(kind, 1)}
@group(0) @binding(2) var normalInput:texture_2d<f32>;
@group(0) @binding(3) var sparseVisibility:texture_2d<f32>;
@group(0) @binding(4) var output:texture_storage_2d<rgba16float,write>;
override SOURCE_NORMALS:u32=1u;
override SOURCE_WORLD:u32=0u;
${
    sharedNormals
        ? wgsl`var<workgroup> aoTileDepth:array<f32,289>;
var<workgroup> aoTileNormals:array<vec3f,169>;
var<workgroup> aoTileOrigin:vec2i;
fn aoCachedDepth(p:vec2i)->f32{
let q=aoClamp(p,ao.size)-aoTileOrigin;return aoTileDepth[q.y*17+q.x];
}`
        : wgsl``
}
fn sourceZ(p:vec2i)->f32{return ao.depthUnpack.x/(ao.depthUnpack.y-${depth}(p));}
fn position(p:vec2i)->vec3f{return aoPosition((vec2f(p)+0.5)*ao.invSize,sourceZ(p));}
${ssaoDepthNormalWGSL(depth)}
fn normal(p:vec2i)->vec3f{
if(SOURCE_NORMALS!=0u){let n=textureLoad(normalInput,p,0).xyz;
if(SOURCE_WORLD!=0u){return normalize((ao.view*vec4f(n,0)).xyz);}return n;}
${sharedNormals ? wgsl`let q=p-aoTileOrigin-vec2i(2);return aoTileNormals[q.y*13+q.x];` : wgsl`return aoDepthNormal(p);`}
}
fn compatible(q:vec2i,point:vec3f,n:vec3f)->f32{
let p=aoClamp(q*2+vec2i(1),ao.size);if(${depth}(p)==0.0){return 0.0;}
let other=normalize(normal(${sharedNormals ? "q*2+vec2i(1)" : "p"}));let agreement=clamp(dot(other,n),0.0,1.0);
let delta=position(p)-point;
if(agreement<0.9){
// Connected concave faces share contact AO; silhouettes and depth gaps do not.
if(dot(other,n)<=-0.9){return 0.0;}
let epsilon=max(1e-4,point.z*1e-5);
if(dot(delta,n)<-epsilon||dot(delta,other)>epsilon){return 0.0;}
let view=normalize(-point);
let incidence=max(0.1,min(abs(dot(n,view)),abs(dot(other,view))));
let footprint=2.5*point.z*max(abs(ao.pixelViewSize.x),abs(ao.pixelViewSize.y))/incidence;
let limit=min(ao.radius*0.25,footprint);
return select(0.0,1.0,dot(delta,delta)<=limit*limit);
}
let allowance=max(1e-4,min(point.z*0.005,ao.radius*0.025))+0.5*length(delta)*length(other-n);
return clamp(1.0-abs(dot(delta,n))/allowance,0.0,1.0)*pow(agreement,8.0);
}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u${sharedNormals ? ",@builtin(workgroup_id) group:vec3u,@builtin(local_invocation_index) lane:u32" : ""}){
${
    sharedNormals
        ? wgsl`let origin=vec2i(group.xy*8u)-vec2i(5);
if(lane==0u){aoTileOrigin=origin;}
for(var i=lane;i<289u;i+=64u){
let p=origin+vec2i(vec2u(i%17u,i/17u));aoTileDepth[i]=aoRawDepth(p);
}
workgroupBarrier();
for(var i=lane;i<113u;i+=64u){
var q=vec2i(vec2u(i&7u,i>>3u))+vec2i(3);
if(i>=64u){
let j=i-64u;q=vec2i(vec2u(j%7u,j/7u))*2;
if(all(q>=vec2i(3))&&all(q<=vec2i(10))){continue;}
}
let p=aoClamp(origin+vec2i(2)+q,ao.size);var n=vec3f(0,0,-1);
if(aoCachedDepth(p)!=0.0){n=aoDepthNormal(p);}
aoTileNormals[q.y*13+q.x]=n;
}
workgroupBarrier();`
        : wgsl``
}
if(any(id.xy>=ao.size)){return;}let p=vec2i(id.xy);var value=1.0;
if(${depth}(p)!=0.0){
let point=position(p);let n=normalize(normal(p));let dims=textureDimensions(sparseVisibility);
var grid=(vec2f(id.xy)-1.0)*0.5;
if(id.x==ao.size.x-1u&&(ao.size.x&1u)!=0u){grid.x=f32(dims.x-1u);}
if(id.y==ao.size.y-1u&&(ao.size.y&1u)!=0u){grid.y=f32(dims.y-1u);}
let base=vec2i(floor(grid));let f=fract(grid);var sum=0.0;var weights=0.0;
for(var y=0;y<2;y++){for(var x=0;x<2;x++){
let q=aoClamp(base+vec2i(x,y),dims);
let w=select(1.0-f.x,f.x,x==1)*select(1.0-f.y,f.y,y==1)*compatible(q,point,n);
sum+=w*textureLoad(sparseVisibility,q,0).r;weights+=w;
}}
if(weights<1e-6){let nearest=aoClamp(vec2i(round(grid)),dims);
for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){
let q=aoClamp(nearest+vec2i(x,y),dims);let d=vec2f(q)-grid;
let w=compatible(q,point,n)/(1.0+dot(d,d));sum+=w*textureLoad(sparseVisibility,q,0).r;weights+=w;
}}}
if(weights>=1e-6){value=clamp(sum/weights,0.0,1.0);}
}
textureStore(output,p,vec4f(value,value,value,1));
}`;
}
