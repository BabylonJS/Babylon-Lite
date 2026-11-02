import { wgsl, type WgslSource } from "../shader/wgsl.js";

/** @internal Explicit 176-byte layout; the first 96 bytes follow the pinned XeGTAO oracle. */
export const SSAO_PARAMS_WGSL = wgsl`struct AoParams {
size:vec2u,invSize:vec2f,depthUnpack:vec2f,tanHalfFov:vec2f,
ndcMul:vec2f,ndcAdd:vec2f,pixelViewSize:vec2f,radius:f32,falloff:f32,
radiusMultiplier:f32,padding:f32,finalPower:f32,blurBeta:f32,
samplePower:f32,thinCompensation:f32,mipOffset:f32,phase:u32,
extra:vec4f,view:mat4x4f
}
@group(0) @binding(0) var<uniform> ao:AoParams;
override PIXEL_STRIDE:u32=1u;
fn aoPosition(uv:vec2f,z:f32)->vec3f{return vec3f((ao.ndcMul*uv+ao.ndcAdd)*z,z);}
fn aoClamp(p:vec2i,dims:vec2u)->vec2i{return clamp(p,vec2i(0),vec2i(dims)-1);}
`;

/**
 * Raw depth always has the AoParams size, so clamping to it avoids a texture-size query ahead of
 * every depth fetch.
 */
export function ssaoDepthBindingWGSL(kind: "depth" | "float", binding: number): WgslSource {
    return wgsl`@group(0) @binding(${binding}) var rawDepth:${kind === "depth" ? "texture_depth_2d" : "texture_2d<f32>"};
fn aoRawDepth(p:vec2i)->f32{return textureLoad(rawDepth,aoClamp(p,ao.size),0)${kind === "float" ? ".r" : ""};}`;
}

/** @internal No filterable-float32 feature is required. */
export function ssaoDepthCopyWGSL(kind: "depth" | "float"): WgslSource {
    return wgsl`${SSAO_PARAMS_WGSL}
${ssaoDepthBindingWGSL(kind, 1)}
@group(0) @binding(2) var outDepth:texture_storage_2d<r32float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
if(any(id.xy>=ao.size)){return;}
let d=aoRawDepth(vec2i(id.xy));
let z=clamp(ao.depthUnpack.x/(ao.depthUnpack.y-d),0.0,65504.0);
textureStore(outDepth,vec2i(id.xy),vec4f(z,0,0,0));
}`;
}

/** @internal Weighted depth filtering, distinct from the engine's min/max Hi-Z. */
export function ssaoDepthReduceWGSL(): WgslSource {
    return wgsl`${SSAO_PARAMS_WGSL}
@group(0) @binding(1) var previous:texture_2d<f32>;
@group(0) @binding(2) var outDepth:texture_storage_2d<r32float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
let dims=textureDimensions(outDepth);
if(any(id.xy>=dims)){return;}
let source=textureDimensions(previous);
let start=id.xy*2u;
var end=min(start+2u,source);
if(id.x==dims.x-1u){end.x=source.x;}
if(id.y==dims.y-1u){end.y=source.y;}
var farthest=0.0;
for(var y=start.y;y<end.y;y++){for(var x=start.x;x<end.x;x++){
farthest=max(farthest,textureLoad(previous,vec2i(vec2u(x,y)),0).r);
}}
let radius=0.75*ao.radius*ao.radiusMultiplier;
let falloff=ao.falloff*radius;
let mul=-1.0/falloff;
let add=radius*(1.0-ao.falloff)/falloff+1.0;
var sum=0.0;var weights=0.0;
for(var y=start.y;y<end.y;y++){for(var x=start.x;x<end.x;x++){
let z=textureLoad(previous,vec2i(vec2u(x,y)),0).r;
let w=clamp((farthest-z)*mul+add,0.0,1.0);
sum+=w*z;weights+=w;
}}
textureStore(outDepth,vec2i(id.xy),vec4f(sum/weights,0,0,0));
}`;
}
/** @internal Shared estimator bindings and signed-normal reconstruction. */
function ssaoEstimatorBindingsWGSL(kind: "depth" | "float"): WgslSource {
    return wgsl`${SSAO_PARAMS_WGSL}
override SLICE_COUNT:u32=3u;
override STEP_COUNT:u32=3u;
${ssaoDepthBindingWGSL(kind, 1)}
@group(0) @binding(2) var viewDepth:texture_2d<f32>;
@group(0) @binding(3) var normalInput:texture_2d<f32>;
// Packed working AO (bits 0-7) and XeGTAO edges (bits 8-15): one store here, one load per resolve tap.
@group(0) @binding(4) var working:texture_storage_2d<r32uint,write>;
fn aoDepth(p:vec2i)->f32{
let c=aoClamp(p,ao.size);
return textureLoad(viewDepth,c,0).r;
}
${ssaoNormalWGSL()}
fn aoPackedEdges(p:vec2i)->u32{
let z=aoDepth(p);
let stride=i32(PIXEL_STRIDE);
var e=vec4f(aoDepth(p+vec2i(-stride,0)),aoDepth(p+vec2i(stride,0)),aoDepth(p+vec2i(0,-stride)),aoDepth(p+vec2i(0,stride)))-z;
let slope=vec2f((e.y-e.x)*0.5,(e.w-e.z)*0.5);
e=min(abs(e),abs(e+vec4f(slope.x,-slope.x,slope.y,-slope.y)));
let packed=vec4u(round(clamp(1.25-e/(z*0.011),vec4f(0),vec4f(1))*2.9));
return (packed.x<<6u)|(packed.y<<4u)|(packed.z<<2u)|packed.w;
}`;
}

/** @internal Raw device depth is affine on projected planes, including at continuous-depth creases. */
export function ssaoDepthNormalWGSL(depthFunction = "aoRawDepth"): WgslSource {
    return wgsl`fn aoPlaneSupport(g:vec2f,c:f32,limit:f32,ringA:vec4f,ringB:vec4f,seconds:vec4f,oxA:vec4f,oyA:vec4f,oxB:vec4f,oyB:vec4f,oxC:vec4f,oyC:vec4f)->u32{
let a=select(vec4u(0),vec4u(1),(ringA>vec4f(0))&(abs((ringA-c)-(g.x*oxA+g.y*oyA))<=vec4f(limit)));
let b=select(vec4u(0),vec4u(1),(ringB>vec4f(0))&(abs((ringB-c)-(g.x*oxB+g.y*oyB))<=vec4f(limit)));
let s=select(vec4u(0),vec4u(1),(seconds>vec4f(0))&(abs((seconds-c)-(g.x*oxC+g.y*oyC))<=vec4f(limit)));
let total=a+b+s;return 1u+total.x+total.y+total.z+total.w;
}
fn aoDepthNormal(p:vec2i)->vec3f{
let centerDepth=${depthFunction}(p);
let l=aoClamp(p+vec2i(-1,0),ao.size);let r=aoClamp(p+vec2i(1,0),ao.size);
let t=aoClamp(p+vec2i(0,-1),ao.size);let b=aoClamp(p+vec2i(0,1),ao.size);
let depth=vec4f(${depthFunction}(l),${depthFunction}(r),${depthFunction}(t),${depthFunction}(b));
let centerZ=clamp(ao.depthUnpack.x/(ao.depthUnpack.y-centerDepth),0.0,65504.0);
let z=clamp(ao.depthUnpack.x/(vec4f(ao.depthUnpack.y)-depth),vec4f(0),vec4f(65504));
var left=p.x==i32(ao.size.x)-1||(p.x>0&&abs(z.x-centerZ)<abs(z.y-centerZ));
var top=p.y==i32(ao.size.y)-1||(p.y>0&&abs(z.z-centerZ)<abs(z.w-centerZ));
var errorX=vec2f(1);var errorY=vec2f(1);var secondX=vec2f(0);var secondY=vec2f(0);
if(p.x>1&&p.x+2<i32(ao.size.x)){
secondX=vec2f(${depthFunction}(p+vec2i(-2,0)),${depthFunction}(p+vec2i(2,0)));
errorX=abs((depth.xy-centerDepth)-(secondX-depth.xy));
left=errorX.x<errorX.y;
}
if(p.y>1&&p.y+2<i32(ao.size.y)){
secondY=vec2f(${depthFunction}(p+vec2i(0,-2)),${depthFunction}(p+vec2i(0,2)));
errorY=abs((depth.zw-centerDepth)-(secondY-depth.zw));
top=errorY.x<errorY.y;
}
if(depth.x==0.0){left=false;}else if(depth.y==0.0){left=true;}
if(depth.z==0.0){top=false;}else if(depth.w==0.0){top=true;}
let roundoff=max(centerDepth,max(max(depth.x,depth.y),max(depth.z,depth.w)))*4.76837158203125e-7;
if(min(errorX.x,errorX.y)>roundoff&&all(depth.xy>vec2f(0))&&p.x>0&&p.x+1<i32(ao.size.x)){
let dy=select(1,-1,top);let row=select(depth.w,depth.z,top);
let diagonal=vec2f(${depthFunction}(p+vec2i(-1,dy)),${depthFunction}(p+vec2i(1,dy)));
if(row>0.0&&all(diagonal>vec2f(0))){errorX=abs((depth.xy-centerDepth)-(diagonal-row));left=errorX.x<errorX.y;}
}
if(min(errorY.x,errorY.y)>roundoff&&all(depth.zw>vec2f(0))&&p.y>0&&p.y+1<i32(ao.size.y)){
let dx=select(1,-1,left);let column=select(depth.y,depth.x,left);
let diagonal=vec2f(${depthFunction}(p+vec2i(dx,-1)),${depthFunction}(p+vec2i(dx,1)));
if(column>0.0&&all(diagonal>vec2f(0))){errorY=abs((depth.zw-centerDepth)-(diagonal-column));top=errorY.x<errorY.y;}
}
let center=aoPosition((vec2f(p)+0.5)*ao.invSize,centerZ);
var horizontal=aoPosition((vec2f(r)+0.5)*ao.invSize,z.y)-center;
if(left){
horizontal=center-aoPosition((vec2f(l)+0.5)*ao.invSize,z.x);
}
var vertical=aoPosition((vec2f(b)+0.5)*ao.invSize,z.w)-center;
if(top){
vertical=center-aoPosition((vec2f(t)+0.5)*ao.invSize,z.z);
}
if(any(depth==vec4f(0))){
let q=aoClamp(p+vec2i(select(1,-1,left),select(1,-1,top)),ao.size);
let diagonalDepth=${depthFunction}(q);
if(diagonalDepth>0.0){
let diagonalZ=clamp(ao.depthUnpack.x/(ao.depthUnpack.y-diagonalDepth),0.0,65504.0);
let diagonal=aoPosition((vec2f(q)+0.5)*ao.invSize,diagonalZ);
if(any(depth.xy==vec2f(0))){
let row=aoPosition((vec2f(select(b,t,top))+0.5)*ao.invSize,select(z.w,z.z,top));
horizontal=select(diagonal-row,row-diagonal,left);
}
if(any(depth.zw==vec2f(0))){
let column=aoPosition((vec2f(select(r,l,left))+0.5)*ao.invSize,select(z.y,z.x,left));
vertical=select(diagonal-column,column-diagonal,top);
}
}
}
// Thin receivers can lack an axial plane; require support beyond a candidate triangle.
// Samples and offsets stay in vectors with constant lanes: runtime-indexed local arrays spill to
// slow memory on common GPUs. Arithmetic, candidate order and strict tie-breaking are unchanged.
if((min(errorX.x,errorX.y)>roundoff||min(errorY.x,errorY.y)>roundoff)&&all(depth>vec4f(0))&&p.x>1&&p.y>1&&p.x+2<i32(ao.size.x)&&p.y+2<i32(ao.size.y)){
let ringA=vec4f(depth.x,${depthFunction}(p+vec2i(-1,-1)),depth.z,${depthFunction}(p+vec2i(1,-1)));
let ringB=vec4f(depth.y,${depthFunction}(p+vec2i(1,1)),depth.w,${depthFunction}(p+vec2i(-1,1)));
let seconds=vec4f(secondX,secondY);
let oxA=vec4f(-1,-1,0,1);let oyA=vec4f(0,-1,-1,-1);let oxB=vec4f(1,1,0,-1);let oyB=vec4f(0,1,1,1);
let oxC=vec4f(-2,2,0,0);let oyC=vec4f(0,0,-2,2);
let limit=roundoff*2.0;
var best=5u;var found=false;var chosenDepth=vec2f(0);var chosenOffsets=vec4f(0);
let initial=cross(horizontal,vertical);let plane=dot(initial,center);
if(abs(plane)>1e-20){
let gradient=-ao.depthUnpack.x/plane*initial.xy*ao.ndcMul*ao.invSize;
best=max(best,aoPlaneSupport(gradient,centerDepth,limit,ringA,ringB,seconds,oxA,oyA,oxB,oyB,oxC,oyC));
}
for(var candidate=0u;candidate<16u;candidate++){
let i=candidate&7u;let j=(i+1u+(candidate>>3u))&7u;
let si=select(ringA[i&3u],ringB[i&3u],i>=4u);let sj=select(ringA[j&3u],ringB[j&3u],j>=4u);
if(si==0.0||sj==0.0){continue;}
let a=select(vec2f(oxA[i&3u],oyA[i&3u]),vec2f(oxB[i&3u],oyB[i&3u]),i>=4u);
let b=select(vec2f(oxA[j&3u],oyA[j&3u]),vec2f(oxB[j&3u],oyB[j&3u]),j>=4u);
let da=si-centerDepth;let db=sj-centerDepth;
let gradient=vec2f(da*b.y-db*a.y,a.x*db-b.x*da)/(a.x*b.y-a.y*b.x);
let support=aoPlaneSupport(gradient,centerDepth,limit,ringA,ringB,seconds,oxA,oyA,oxB,oyB,oxC,oyC);
if(support>best){best=support;found=true;chosenDepth=vec2f(si,sj);chosenOffsets=vec4f(a,b);}
}
if(found){
let zs=clamp(ao.depthUnpack.x/(vec2f(ao.depthUnpack.y)-chosenDepth),vec2f(0),vec2f(65504));
horizontal=aoPosition((vec2f(p)+chosenOffsets.xy+0.5)*ao.invSize,zs.x)-center;
vertical=aoPosition((vec2f(p)+chosenOffsets.zw+0.5)*ao.invSize,zs.y)-center;
}
}let n=cross(horizontal,vertical);
if(dot(n,n)<1e-20){return vec3f(0,0,-1);}
return normalize(n);
}
`;
}

/** @internal Shared signed normals; callers supply raw depth and normalInput. */
export function ssaoNormalWGSL(): WgslSource {
    return wgsl`${ssaoDepthNormalWGSL()}
override PROVIDED_NORMALS:u32=1u;
override WORLD_NORMALS:u32=0u;
// Callers fetch a supplied normal early, before branching on depth, so its latency overlaps other work.
fn aoSuppliedNormal(p:vec2i)->vec3f{if(PROVIDED_NORMALS!=0u){return textureLoad(normalInput,p,0).xyz;}return vec3f(0);}
fn aoNormalOf(p:vec2i,supplied:vec3f)->vec3f{
if(PROVIDED_NORMALS!=0u){
if(WORLD_NORMALS!=0u){return normalize((ao.view*vec4f(supplied,0)).xyz);}
return supplied;
}
return aoDepthNormal(p);
}
fn aoNormal(p:vec2i)->vec3f{return aoNormalOf(p,aoSuppliedNormal(p));}
`;
}

/** @internal XeGTAO's radiometric integral and tuned sampling, without vendor engine infrastructure. */
export function ssaoXeEstimatorWGSL(kind: "depth" | "float"): WgslSource {
    return wgsl`${ssaoEstimatorBindingsWGSL(kind)}
const PI=3.14159265358979323846;
const HALF_PI=1.57079632679489661923;
fn xeAcos(v:f32)->f32{
let x=abs(v);
let root=bitcast<f32>(0x1fbd1df5+(bitcast<i32>(1.0-x)>>1));
let result=(-0.156583*x+1.570796)*root;
return select(3.141593-result,result,v>=0.0);
}
fn hilbert(p:vec2u)->u32{
var px=p.x%64u;var py=p.y%64u;var index=0u;var level=32u;
loop{
if(level==0u){break;}
let x=select(0u,1u,(px&level)!=0u);
let y=select(0u,1u,(py&level)!=0u);
index+=level*level*((3u*x)^y);
if(y==0u){
if(x==1u){px=63u-px;py=63u-py;}
let temporary=px;px=py;py=temporary;
}
level/=2u;
}
return index;
}
// Nearest-mip, nearest-texel, clamp-to-edge sampling of the prefiltered depth chain, as in XeGTAO.
@group(0) @binding(6) var depthSampler:sampler;
fn sampleViewDepth(uv:vec2f,level:f32)->f32{return textureSampleLevel(viewDepth,depthSampler,uv,level).r;}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
if(any(id.xy>=(ao.size+PIXEL_STRIDE-1u)/PIXEL_STRIDE)){return;}
let p=vec2i(min(id.xy*PIXEL_STRIDE+PIXEL_STRIDE/2u,ao.size-1u));
let outputPixel=vec2i(id.xy);
// View depth and a supplied normal are fetched with the background test so their latency overlaps it.
let raw=aoRawDepth(p);let viewZ=aoDepth(p);let suppliedNormal=aoSuppliedNormal(p);
if(raw==0.0){
textureStore(working,outputPixel,vec4u(170u,0,0,0));return;
}
let uv=(vec2f(p)+0.5)*ao.invSize;
let z=viewZ*0.99999;
let origin=aoPosition(uv,z);
let view=normalize(-origin);
let normal=aoNormalOf(p,suppliedNormal);
let index=hilbert(vec2u(p))+288u*(ao.phase%64u);
let noise=fract(0.5+f32(index)*vec2f(0.75487766624669276005,0.5698402909980532659114));
let radius=ao.radius*ao.radiusMultiplier;
let falloff=ao.falloff*radius;
let falloffMul=-1.0/falloff;
let falloffAdd=radius*(1.0-ao.falloff)/falloff+1.0;
let screenRadius=radius/(z*ao.pixelViewSize.x);
let minimumStep=1.3/screenRadius;
var visibility=clamp((10.0-screenRadius)/100.0,0.0,1.0)*0.5;
for(var slice=0u;slice<SLICE_COUNT;slice++){
let phi=(f32(slice)+noise.x)/f32(SLICE_COUNT)*PI;
let direction=vec3f(cos(phi),sin(phi),0);
let ortho=direction-dot(direction,view)*view;
let axis=normalize(cross(ortho,view));
let projected=normal-axis*dot(normal,axis);
let projectedLength=length(projected);
let cosine=clamp(dot(projected,view)/max(projectedLength,1e-20),0.0,1.0);
let angle=sign(dot(ortho,projected))*xeAcos(cosine);
let low=vec2f(cos(angle+HALF_PI),cos(angle-HALF_PI));
var horizon=low;
let omega=vec2f(direction.x,-direction.y)*screenRadius;
for(var step=0u;step<STEP_COUNT;step++){
let jitter=fract(noise.y+f32(slice+step*SLICE_COUNT)*0.6180339887498948482);
let stepFraction=(f32(step)+jitter)/f32(STEP_COUNT);
let distance=stepFraction*stepFraction+minimumStep;
let offset=distance*omega;
let level=clamp(log2(length(offset))-ao.mipOffset,0.0,5.0);
let deltaUv=round(offset)*ao.invSize;
let uv0=uv+deltaUv;let uv1=uv-deltaUv;
let d0=aoPosition(uv0,sampleViewDepth(uv0,level))-origin;
let d1=aoPosition(uv1,sampleViewDepth(uv1,level))-origin;
let length0=length(d0);let length1=length(d1);
let weights=clamp(vec2f(length0,length1)*falloffMul+falloffAdd,vec2f(0),vec2f(1));
let candidates=vec2f(dot(d0/max(length0,1e-20),view),dot(d1/max(length1,1e-20),view));
horizon=max(horizon,mix(low,candidates,weights));
}
let h0=-xeAcos(horizon.y);let h1=xeAcos(horizon.x);
let integral0=(cosine+2.0*h0*sin(angle)-cos(2.0*h0-angle))/4.0;
let integral1=(cosine+2.0*h1*sin(angle)-cos(2.0*h1-angle))/4.0;
visibility+=mix(projectedLength,1.0,0.05)*(integral0+integral1);
}
visibility=max(0.03,pow(max(visibility/f32(SLICE_COUNT),0.0),ao.finalPower));
let packed=u32(clamp(floor(clamp(visibility/1.5,0.0,1.0)*255.0+0.5),0.0,255.0));
// Edges are evaluated after sampling so they do not occupy registers through the horizon search.
textureStore(working,outputPixel,vec4u(packed|(aoPackedEdges(p)<<8u),0,0,0));
}`;
}

/** @internal Explicit nearest-even quantization avoids repeated texture-store truncation bias. */
export function ssaoHalfWGSL(): WgslSource {
    return wgsl`fn aoHalf(value:f32)->f32{
if(value==0.0){return value;}
// Round before storage so the texture-format conversion cannot truncate the AO value.
let bits=bitcast<u32>(value);
if(bits<0x38800000u){
let scaled=value*16777216.0;
let lower=floor(scaled);let fraction=scaled-lower;
let rounded=u32(lower)+select(0u,1u,fraction>0.5||(fraction==0.5&&(u32(lower)&1u)!=0u));
return f32(rounded)/16777216.0;
}
return bitcast<f32>((bits+4095u+((bits>>13u)&1u))&0xffffe000u);
}
`;
}

/** @internal Edge-aware spatial filtering preserves native eight-bit packing semantics. */
export function ssaoResolveWGSL(kind: "depth" | "float"): WgslSource {
    const bindings = wgsl`${SSAO_PARAMS_WGSL}
${ssaoDepthBindingWGSL(kind, 1)}
@group(0) @binding(2) var working:texture_2d<u32>;
@group(0) @binding(4) var result:texture_storage_2d<rgba16float,write>;
${ssaoHalfWGSL()}`;
    const filter = wgsl`fn edgesOf(word:u32)->vec4f{
let bits=word>>8u;
return vec4f(f32((bits>>6u)&3u),f32((bits>>4u)&3u),f32((bits>>2u)&3u),f32(bits&3u))/3.0;
}
fn valueOf(word:u32)->f32{return f32(word&255u)/255.0;}
fn resolve(p:vec2i,dims:vec2u)->f32{
let c=textureLoad(working,aoClamp(p,dims),0).r;
let l=textureLoad(working,aoClamp(p+vec2i(-1,0),dims),0).r;let r=textureLoad(working,aoClamp(p+vec2i(1,0),dims),0).r;
let t=textureLoad(working,aoClamp(p+vec2i(0,-1),dims),0).r;let b=textureLoad(working,aoClamp(p+vec2i(0,1),dims),0).r;
let left=edgesOf(l);let right=edgesOf(r);let top=edgesOf(t);let bottom=edgesOf(b);
var center=edgesOf(c)*vec4f(left.y,right.x,top.w,bottom.z);
let leak=clamp(1.5-dot(center,vec4f(1)),0.0,1.0)/1.5*0.5;
center=clamp(center+leak,vec4f(0),vec4f(1));
let diagonal=0.425*vec4f(center.x*left.z+center.z*top.x,center.z*top.y+center.y*right.z,center.w*bottom.x+center.x*left.w,center.y*right.w+center.w*bottom.y);
var sum=valueOf(c)*ao.blurBeta;var weights=ao.blurBeta;
sum+=center.x*valueOf(l);weights+=center.x;
sum+=center.y*valueOf(r);weights+=center.y;
sum+=center.z*valueOf(t);weights+=center.z;
sum+=center.w*valueOf(b);weights+=center.w;
sum+=diagonal.x*valueOf(textureLoad(working,aoClamp(p+vec2i(-1,-1),dims),0).r);weights+=diagonal.x;
sum+=diagonal.y*valueOf(textureLoad(working,aoClamp(p+vec2i(1,-1),dims),0).r);weights+=diagonal.y;
sum+=diagonal.z*valueOf(textureLoad(working,aoClamp(p+vec2i(-1,1),dims),0).r);weights+=diagonal.z;
sum+=diagonal.w*valueOf(textureLoad(working,aoClamp(p+vec2i(1,1),dims),0).r);weights+=diagonal.w;
return clamp(floor(sum/weights*1.5*255.0+0.5),0.0,255.0)/255.0;
}`;
    return wgsl`${bindings}
${filter}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
// The working texture and every resolve target have the stride-reduced AoParams size.
let dims=(ao.size+PIXEL_STRIDE-1u)/PIXEL_STRIDE;
if(any(id.xy>=dims)){return;}
let p=vec2i(id.xy);
var visibility=1.0;
let source=min(id.xy*PIXEL_STRIDE+PIXEL_STRIDE/2u,ao.size-1u);
// The filter's loads are issued with the background test rather than after it.
let filtered=resolve(p,dims);
if(aoRawDepth(vec2i(source))!=0.0){visibility=clamp(mix(1.0,filtered,ao.extra.y),0.0,1.0);}
textureStore(result,p,vec4f(vec3f(aoHalf(visibility)),1));
}`;
}
