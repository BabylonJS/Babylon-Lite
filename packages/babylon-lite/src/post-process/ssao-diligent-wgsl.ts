import { wgsl, type WgslSource } from "../shader/wgsl.js";
import { SSAO_PARAMS_WGSL, ssaoDepthBindingWGSL, ssaoNormalWGSL } from "./ssao-wgsl.js";

export const DILIGENT_FULLSCREEN_WGSL = wgsl`@vertex fn fullscreen(@builtin(vertex_index) index:u32)->@builtin(position) vec4f{
let uv=vec2f(f32((index<<1u)&2u),f32(index&2u));
return vec4f(uv*vec2f(2,-2)+vec2f(-1,1),0,1);
}`;

const COMMON = wgsl`${SSAO_PARAMS_WGSL}
${DILIGENT_FULLSCREEN_WGSL}
fn dZ(d:f32)->f32{return ao.depthUnpack.x/(ao.depthUnpack.y-d);}
fn dGeom(a:vec3f,b:vec3f,n:vec3f)->f32{return clamp(1.0-abs(dot(b-a,n))*(10.0/(1.0+a.z)),0.0,1.0);}
// Geometry history is RG32Uint: exact device-depth bits, then an octahedral world normal in two snorm16.
fn geometryNormalBits(n:vec3f)->u32{
var e=n.xy/max(abs(n.x)+abs(n.y)+abs(n.z),1e-20);
if(n.z<0.0){e=(1.0-abs(e.yx))*select(vec2f(-1),vec2f(1),e>=vec2f(0));}
return pack2x16snorm(e);
}
fn geometryNormal(bits:u32)->vec3f{
let e=unpack2x16snorm(bits);var n=vec3f(e,1.0-abs(e.x)-abs(e.y));
let fold=max(-n.z,0.0);n.x+=select(fold,-fold,n.x>=0.0);n.y+=select(fold,-fold,n.y>=0.0);
return normalize(n);
}
`;

/**
 * @internal Temporal camera state. `tolerance.x` is the relative tolerance of supplied previous
 * depth and `tolerance.y` the relative tolerance of supplied motion, matching the velocity format.
 * `dot(reprojectW,v)/dot(inverseW,v)` is the static previous view depth of current NDC `v`.
 */
export const SSAO_TEMPORAL_PARAMS_WGSL = wgsl`struct Temporal{invView:mat4x4f,previousView:mat4x4f,previousVP:mat4x4f,control:vec4f,invVP:mat4x4f,previousInvVP:mat4x4f,tolerance:vec4f,reprojectW:vec4f,inverseW:vec4f}`;

export function diligentClosestMotionWGSL(kind: "depth" | "float"): WgslSource {
    return wgsl`${COMMON}
${ssaoDepthBindingWGSL(kind, 1)}
@group(0) @binding(2) var velocity:texture_2d<f32>;
@fragment fn main(@builtin(position) pixel:vec4f)->@location(0) vec2f{
let p=vec2i(pixel.xy);var closest=0.0;var q=p;
for(var x=-1;x<=1;x++){for(var y=-1;y<=1;y++){
let s=p+vec2i(x,y);
var d=0.0;if(all(s>=vec2i(0))&&all(s<vec2i(ao.size))){d=aoRawDepth(s);}
if(d>closest){closest=d;q=s;}
}}
return -2.0*textureLoad(velocity,q,0).xy;
}`;
}

export function diligentTemporalWGSL(kind: "depth" | "float"): WgslSource {
    return wgsl`${COMMON}
${ssaoDepthBindingWGSL(kind, 1)}
@group(0) @binding(2) var currentAO:texture_2d<f32>;
@group(0) @binding(3) var velocity:texture_2d<f32>;
@group(0) @binding(4) var history:texture_2d<f32>;
@group(0) @binding(5) var geometry:texture_2d<u32>;
@group(0) @binding(6) var counts:texture_2d<f32>;
${SSAO_TEMPORAL_PARAMS_WGSL}
@group(0) @binding(7) var<uniform> t:Temporal;
@group(0) @binding(8) var transport:texture_2d<f32>;
@group(0) @binding(9) var normalInput:texture_2d<f32>;
@group(0) @binding(10) var suppliedVelocity:texture_2d<f32>;
override HAS_VELOCITY:u32=0u;
override HAS_TRANSPORT:u32=0u;
fn aoDepth(p:vec2i)->f32{return dZ(aoRawDepth(p));}
${ssaoNormalWGSL()}
struct Output{@location(0) visibility:f32,@location(1) count:f32,@location(2) depth:f32}
@fragment fn main(@builtin(position) pixel:vec4f)->Output{
let p=vec2i(pixel.xy);let depth=aoRawDepth(p);
// Receiver inputs are fetched with depth so their latency overlaps it rather than following the background test.
let current=textureLoad(currentAO,p,0).r;let suppliedNormal=aoSuppliedNormal(p);
var receiverMotion=vec4f(0);
if(HAS_VELOCITY!=0u){if(t.control.w!=0.0){receiverMotion=textureLoad(suppliedVelocity,p,0);}else{receiverMotion=textureLoad(velocity,p,0);}}
var warp=vec4f(0);if(HAS_TRANSPORT!=0u){warp=textureLoad(transport,p,0);}
if(depth<1e-6){return Output(1,1,depth);}
let worldNormal=normalize((t.invView*vec4f(aoNormalOf(p,suppliedNormal),0)).xyz);
let uv=pixel.xy*ao.invSize;
var previousZ=0.0;var oldPixel=vec2f(0);var motion=vec2f(0);
if(HAS_VELOCITY!=0u&&t.control.w!=0.0){
let supplied=receiverMotion;
motion=supplied.xy*vec2f(-1,1);previousZ=supplied.z;
oldPixel=pixel.xy-motion*vec2f(ao.size);
// Static receivers take exact camera depth; reduced velocity precision only affects real motion.
let cameraZ=dot(t.reprojectW,vec4f(uv*vec2f(2,-2)+vec2f(-1,1),depth,1))/dot(t.inverseW,vec4f(uv*vec2f(2,-2)+vec2f(-1,1),depth,1));
if(abs(supplied.z-cameraZ)<=max(1e-4,abs(cameraZ)*t.tolerance.x)){previousZ=cameraZ;}
}else{
let homogeneous=t.invVP*vec4f(uv*vec2f(2,-2)+vec2f(-1,1),depth,1);
let world=vec4f(homogeneous.xyz/homogeneous.w,1);let clip=t.previousVP*world;
previousZ=dZ(clip.z/clip.w);
oldPixel=vec2f(clip.x/clip.w*0.5+0.5,0.5-clip.y/clip.w*0.5)*vec2f(ao.size);
motion=(pixel.xy-oldPixel)*ao.invSize;
if(HAS_VELOCITY!=0u){
motion=receiverMotion.xy*vec2f(0.5,-0.5);
oldPixel=pixel.xy-motion*vec2f(ao.size);
}
}
var blendLimit=t.control.y;
if(HAS_TRANSPORT!=0u){if(warp.w>0.0){
oldPixel=warp.xy*vec2f(ao.size);previousZ=dZ(warp.z);
if(t.control.z!=0.0){blendLimit=min(blendLimit,clamp(warp.w*0.25,2.0,16.0));}
if(ao.padding!=0.0&&warp.w<16.0){blendLimit=min(blendLimit,2.0);}
}}
let location=oldPixel-0.5;let base=vec2i(floor(location));let f=fract(location);
let previousPosition=aoPosition(oldPixel*ao.invSize,previousZ);
let previousNormal=normalize((t.previousView*vec4f(worldNormal,0)).xyz);
// A tap storing this receiver's normal word has exactly zero curvature.
let worldNormalBits=geometryNormalBits(worldNormal);
var weights=0.0;var old=0.0;var count=0.0;
for(var y=0;y<2;y++){for(var x=0;x<2;x++){
let w=select(1.0-f.x,f.x,x==1)*select(1.0-f.y,f.y,y==1);
if(w==0.0){continue;}
let q=aoClamp(base+vec2i(x,y),ao.size);
// History and counts are fetched with the geometry so their latency overlaps the rejection tests.
let previousGeometry=textureLoad(geometry,q,0).xy;let previousVisibility=textureLoad(history,q,0).r;let previousCount=textureLoad(counts,q,0).r;
let storedDepth=bitcast<f32>(previousGeometry.x);let oldZ=dZ(storedDepth);
if(!(previousZ>0.0)||storedDepth<1e-6){continue;}
if(t.control.z==0.0){if(abs(1.0-previousZ/oldZ)>=0.01){continue;}}
else{
let storedNormal=geometryNormal(previousGeometry.y);
if(!(dot(worldNormal,storedNormal)>=0.9)){continue;}
let delta=aoPosition((vec2f(q)+0.5)*ao.invSize,oldZ)-previousPosition;
let separation=length(delta);var curvature=0.0;
if(previousGeometry.y!=worldNormalBits){
let tapNormal=normalize((t.previousView*vec4f(storedNormal,0)).xyz);
curvature=0.5*separation*length(tapNormal-previousNormal);
}
let allowance=max(1e-4,min(previousZ*0.005,ao.radius*0.025))+curvature;
if(abs(dot(delta,previousNormal))>allowance||separation>ao.radius*2.0){continue;}
}
old+=previousVisibility*w;
count+=min(previousCount+1.0,t.control.y)*w;weights+=w;
}}
if(weights<=0.01||t.control.x!=0.0||(t.control.z!=0.0&&(any(oldPixel<vec2f(0))||any(oldPixel>=vec2f(ao.size))))){old=1.0;count=1.0;}
else{
old/=weights;count/=weights;
let unchanged=t.control.z!=0.0&&abs(old-current)<=1.0/255.0+1.0/4096.0;
if(!unchanged){
var m1=0.0;var m2=0.0;
for(var x=-1;x<=1;x++){for(var y=-1;y<=1;y++){
let v=textureLoad(currentAO,aoClamp(p+vec2i(x,y),ao.size),0).r;m1+=v;m2+=v*v;
}}
let mean=m1/9.0;let deviation=sqrt(max(m2/9.0-mean*mean,0.0));
let factor=clamp(1.025-length(vec2f(motion.x*f32(ao.size.x)/f32(ao.size.y),motion.y))*128.0,0.0,1.0);
let gamma=mix(0.5,2.5,factor*factor);
if(!(mean-gamma*deviation<old&&old<mean+gamma*deviation)){count=max(1.0,factor*count);}
if(t.control.z!=0.0&&abs(old-current)>0.5){count=1.0;}
}
}
var value=mix(old,current,max(1.0/count,1.0/blendLimit));
if(t.control.z!=0.0&&count>1.0&&abs(current-old)>1.0/8388608.0&&abs(value-old)<=0.5/255.0+1.0/8388608.0){
let seed=(u32(p.x)+u32(p.y)*ao.size.x)*747796405u+2891336453u;
let noise=f32((reverseBits(ao.phase)+seed)>>8u)/16777216.0;
value+=(clamp(noise,0.001,0.999)-0.5)/255.0;
}
return Output(value,count,depth);
}`;
}

export function diligentTransportWGSL(kind: "depth" | "float", declarations: WgslSource = wgsl``, beforeSearch: WgslSource = wgsl``): WgslSource {
    return wgsl`${COMMON}
${ssaoDepthBindingWGSL(kind, 1)}
@group(0) @binding(2) var normalInput:texture_2d<f32>;
@group(0) @binding(3) var velocity:texture_2d<f32>;
@group(0) @binding(4) var currentAO:texture_2d<f32>;
@group(0) @binding(5) var history:texture_2d<f32>;
@group(0) @binding(6) var previousDepth:texture_2d<u32>;
${SSAO_TEMPORAL_PARAMS_WGSL}
@group(0) @binding(7) var<uniform> t:Temporal;
${declarations}
fn aoDepth(p:vec2i)->f32{return dZ(aoRawDepth(p));}
${ssaoNormalWGSL()}
fn world(uv:vec2f,d:f32)->vec3f{
let h=t.invVP*vec4f(uv*vec2f(2,-2)+vec2f(-1,1),d,1);return h.xyz/h.w;
}
fn previousWorld(uv:vec2f,d:f32)->vec3f{
let h=t.previousInvVP*vec4f(uv*vec2f(2,-2)+vec2f(-1,1),d,1);return h.xyz/h.w;
}
fn previousDeviceDepth(uv:vec2f,normal:vec3f)->f32{
let location=uv*vec2f(ao.size)-0.5;let b=vec2i(floor(location));let f=fract(location);
var sum=0.0;var total=0.0;
for(var i=0;i<4;i++){
let offset=vec2i(i&1,i>>1);
let g=textureLoad(previousDepth,aoClamp(b+offset,ao.size),0).xy;let stored=bitcast<f32>(g.x);
if(stored<1e-6||dot(geometryNormal(g.y),normal)<0.9){continue;}
let weight=select(1.0-f.x,f.x,(i&1)==1)*select(1.0-f.y,f.y,i>=2);
sum+=stored*weight;total+=weight;
}
if(total<0.5){return 0.0;}return sum/total;
}
@fragment fn main(@builtin(position) pixel:vec4f)->@location(0) vec4f{
let p=vec2i(pixel.xy);let depth=aoRawDepth(p);
// The unoccluded test's inputs are fetched with depth.
let currentVisibility=textureLoad(currentAO,p,0).r;let previousVisibility=textureLoad(history,p,0).r;
if(t.control.x!=0.0||depth<1e-6){return vec4f(0);}
if(currentVisibility>=0.999&&previousVisibility>=0.999){return vec4f(0);}
let uv=pixel.xy*ao.invSize;let receiver=world(uv,depth);
let receiverClip=t.previousVP*vec4f(receiver,1);
let cameraUv=vec2f(receiverClip.x/receiverClip.w*0.5+0.5,0.5-receiverClip.y/receiverClip.w*0.5);
let receiverVelocity=textureLoad(velocity,p,0);
let receiverOldUv=uv+receiverVelocity.xy*vec2f(1,-1);
let normal=normalize((t.invView*vec4f(aoNormal(p),0)).xyz);
let movingReceiver=length((receiverOldUv-cameraUv)*vec2f(ao.size))>0.05+length(receiverVelocity.xy*vec2f(ao.size))*t.tolerance.y||
(t.control.w!=0.0&&abs(receiverVelocity.z-receiverClip.w)>max(1e-4,abs(receiverClip.w)*t.tolerance.x));
var previousReceiver=receiver;
if(movingReceiver){
if(any(receiverOldUv<vec2f(0))||any(receiverOldUv>vec2f(1))){return vec4f(0);}
var oldDepth=0.0;
if(t.control.w!=0.0){
if(!(receiverVelocity.z>0.0)){return vec4f(0);}
oldDepth=ao.depthUnpack.y-ao.depthUnpack.x/receiverVelocity.z;
}else{oldDepth=previousDeviceDepth(receiverOldUv,normal);}
if(oldDepth<1e-6){return vec4f(0);}
previousReceiver=previousWorld(receiverOldUv,oldDepth);
}
let receiverShift=receiver-previousReceiver;
let physicalRadius=ao.radius*ao.radiusMultiplier;
let physicalProjected=physicalRadius*f32(ao.size.y)/(2.0*ao.tanHalfFov.y*dZ(depth));
let vacated=currentVisibility>=0.999;
let radius=physicalRadius*select(1.0,2.0,vacated);
let projected=min(radius*f32(ao.size.y)/(2.0*ao.tanHalfFov.y*dZ(depth)),256.0);
${beforeSearch}
var displacement=vec3f(0);var total=0.0;var staticWeight=0.0;
for(var ring=1;ring<=3;ring++){
let ringRadius=projected*f32(ring)/3.0;
for(var direction=0;direction<12;direction++){
let angle=f32(direction)*0.5235987755982988;let offset=ringRadius*vec2f(cos(angle),sin(angle));
let q=aoClamp(vec2i(pixel.xy+offset),ao.size);let sampledDepth=aoRawDepth(q);
if(sampledDepth<1e-6){continue;}
let sampleUv=(vec2f(q)+0.5)*ao.invSize;let position=world(sampleUv,sampledDepth);
let delta=position-receiver;let height=dot(delta,normal);
if(height<0.005){continue;}
let distance=length(delta);if(distance>=radius){continue;}
let sampleClip=t.previousVP*vec4f(position,1);
let sampleCameraUv=vec2f(sampleClip.x/sampleClip.w*0.5+0.5,0.5-sampleClip.y/sampleClip.w*0.5);
let supplied=textureLoad(velocity,q,0);
let oldUv=sampleUv+supplied.xy*vec2f(1,-1);
let elevation=clamp(height/max(distance,1e-5),0.0,1.0);
let weight=(1.0-distance/radius)*(1.0-distance/radius)*elevation;
if(length((oldUv-sampleCameraUv)*vec2f(ao.size))<0.05+length(supplied.xy*vec2f(ao.size))*t.tolerance.y){
let staticFalloff=max(0.0,1.0-distance/physicalRadius);
staticWeight+=staticFalloff*staticFalloff*elevation;continue;
}
if(any(oldUv<vec2f(0))||any(oldUv>vec2f(1))){continue;}
var oldDepth=0.0;
if(t.control.w!=0.0){
if(!(supplied.z>0.0)){continue;}
oldDepth=ao.depthUnpack.y-ao.depthUnpack.x/supplied.z;
}else{
let sampleNormal=normalize((t.invView*vec4f(aoNormal(q),0)).xyz);
oldDepth=previousDeviceDepth(oldUv,sampleNormal);
}
if(oldDepth<1e-6){continue;}
let shift=position-previousWorld(oldUv,oldDepth);
let projectedShift=length((oldUv-sampleCameraUv)*ao.tanHalfFov*2.0)*dZ(sampledDepth);
if(length(shift)>min(radius*0.1,projectedShift*2.0)){continue;}
displacement+=shift*weight;total+=weight;
}}
let support=total+staticWeight;
if(support<=0.0||(total<=0.0&&!movingReceiver)){return vec4f(0);}
displacement/=max(total,1e-20);
let relative=displacement*(total/support)-receiverShift;
let tangential=relative-normal*dot(relative,normal);
if(abs(dot(displacement-receiverShift,normal))>length(tangential)*0.5){return vec4f(0);}
let previous=t.previousVP*vec4f(previousReceiver-tangential,1);
return vec4f(previous.x/previous.w*0.5+0.5,0.5-previous.y/previous.w*0.5,previous.z/previous.w,physicalProjected);
}`;
}

export function diligentReduceWGSL(): WgslSource {
    return wgsl`${DILIGENT_FULLSCREEN_WGSL}
@group(0) @binding(0) var sourceAO:texture_2d<f32>;
@group(0) @binding(1) var sourceDepth:texture_2d<f32>;
struct Output{@location(0) visibility:f32,@location(1) depth:f32}
@fragment fn main(@builtin(position) pixel:vec4f)->Output{
let dims=textureDimensions(sourceAO);
let nx=select(2,3,(dims.x&1u)!=0u);let ny=select(2,3,(dims.y&1u)!=0u);
let offsets=array<vec2i,9>(vec2i(0,0),vec2i(0,1),vec2i(1,0),vec2i(1,1),vec2i(2,0),vec2i(2,1),vec2i(0,2),vec2i(1,2),vec2i(2,2));
var sum=vec2f(0);var count=0.0;
for(var i=0;i<9;i++){
let offset=offsets[i];if(offset.x>=nx||offset.y>=ny){continue;}
let q=clamp(2*vec2i(pixel.xy)+offset,vec2i(0),vec2i(dims)-1);
sum+=vec2f(textureLoad(sourceAO,q,0).r,textureLoad(sourceDepth,q,0).r);count+=1.0;
}
return Output(sum.r/count,sum.g/count);
}`;
}

function reconstructionBindings(kind: "depth" | "float"): WgslSource {
    return wgsl`${COMMON}
${ssaoDepthBindingWGSL(kind, 1)}
@group(0) @binding(2) var normalInput:texture_2d<f32>;
@group(0) @binding(3) var temporalCounts:texture_2d<f32>;
fn aoDepth(p:vec2i)->f32{return dZ(aoRawDepth(p));}
${ssaoNormalWGSL()}
fn dNormal(p:vec2i)->vec3f{
if(PROVIDED_NORMALS!=0u){let n=textureLoad(normalInput,p,0).xyz;if(WORLD_NORMALS!=0u){return (ao.view*vec4f(n,0)).xyz;}return n;}
return aoNormal(p);
}
`;
}

export function diligentRepairWGSL(kind: "depth" | "float", filterableDepth: boolean): WgslSource {
    return wgsl`${reconstructionBindings(kind)}
@group(0) @binding(4) var mipsAO:texture_2d<f32>;
@group(0) @binding(5) var mipsDepth:texture_2d<f32>;
@group(0) @binding(6) var depthSampler:sampler;
@group(0) @binding(7) var aoSampler:sampler;
fn linearDepth(uv:vec2f,mip:i32)->f32{
${
    filterableDepth
        ? wgsl`return textureSampleLevel(mipsDepth,depthSampler,uv,f32(mip)).r;`
        : wgsl`
let dims=textureDimensions(mipsDepth,mip);let p=uv*vec2f(dims)-0.5;let b=vec2i(floor(p));let f=fract(p);
let a=textureLoad(mipsDepth,clamp(b,vec2i(0),vec2i(dims)-1),mip).r;
let c=textureLoad(mipsDepth,clamp(b+vec2i(1,0),vec2i(0),vec2i(dims)-1),mip).r;
let d=textureLoad(mipsDepth,clamp(b+vec2i(0,1),vec2i(0),vec2i(dims)-1),mip).r;
let e=textureLoad(mipsDepth,clamp(b+vec2i(1),vec2i(0),vec2i(dims)-1),mip).r;
return mix(mix(a,c,f.x),mix(d,e,f.x),f.y);`
}
}
@fragment fn main(@builtin(position) pixel:vec4f)->@location(0) f32{
let p=vec2i(pixel.xy);let depth=aoRawDepth(p);let h=textureLoad(temporalCounts,p,0).r;
// Converged and background receivers keep their own value; it is fetched with the tests.
let own=textureLoad(mipsAO,p,0).r;
let factor=(h-1.0)/4.0;
if(depth<1e-6||factor>=1.0){return own;}
let position=aoPosition(pixel.xy*ao.invSize,dZ(depth));let n=dNormal(p);
var mip=i32(4.0*(1.0-clamp(factor,0.0,1.0)));mip=min(mip,i32(textureNumLevels(mipsAO))-1);
var sum=0.0;var total=0.0;
loop{
if(mip<0||total>=0.995){break;}
let virtualSize=vec2f(ao.size)/exp2(f32(mip));let location=pixel.xy/exp2(f32(mip));
let b=vec2i(location-0.5);let f=fract(location+0.5);sum=0.0;total=0.0;
for(var i=0;i<4;i++){
let offset=vec2i(i&1,i>>1);let uv=(vec2f(b+offset)+0.5)/virtualSize;
let d=linearDepth(uv,mip);
let value=textureSampleLevel(mipsAO,aoSampler,uv,f32(mip)).r;
let w=select(1.0-f.x,f.x,(i&1)==1)*select(1.0-f.y,f.y,i>=2)*dGeom(position,aoPosition(uv,dZ(d)),n);
sum+=value*w;total+=w;
}
mip-=1;
}
return sum/max(total,1e-20);
}`;
}

/**
 * Final spatial filter. It also writes public visibility and the next frame's geometry history,
 * so no separate full-screen pass rereads the eight-bit feedback.
 */
export function diligentOutputWGSL(kind: "depth" | "float"): WgslSource {
    return wgsl`${reconstructionBindings(kind)}
@group(0) @binding(4) var repaired:texture_2d<f32>;
@group(0) @binding(5) var<uniform> inverseView:mat4x4f;
struct Output{@location(0) history:f32,@location(1) visibility:vec4f,@location(2) geometry:vec2u}
@fragment fn main(@builtin(position) pixel:vec4f)->Output{
let p=vec2i(pixel.xy);let depth=aoRawDepth(p);let h=textureLoad(temporalCounts,p,0).r;
let factor=pow(abs((h-1.0)/8.0),0.2);
var result=textureLoad(repaired,p,0).r;let suppliedNormal=aoSuppliedNormal(p);
var normal=vec3f(0);
if(depth>=1e-6){
normal=normalize((inverseView*vec4f(aoNormalOf(p,suppliedNormal),0)).xyz);
if(factor<1.0){
let poisson=array<vec3f,8>(
vec3f(-0.4706069,-0.4427112,0.6461146),vec3f(-0.9057375,0.3003471,0.9542373),
vec3f(-0.3487388,0.4037880,0.5335386),vec3f(0.1023042,0.6439373,0.6520134),
vec3f(0.5699277,0.3513750,0.6695386),vec3f(0.2939128,-0.1131226,0.3149309),
vec3f(0.7836658,-0.4208784,0.8895339),vec3f(0.1564120,-0.8198990,0.8346850));
let id=vec2u(p);
let a=2068378560u*(1u-((id.x&3u)>>1u))+1500172770u*((id.x&3u)>>1u);
let b=((id.y&3u)+((id.x&1u)<<2u))<<2u;
let angle=f32(((a>>b)+ao.phase)&15u)/16.0*6.283185307179586;
let radius=4.0*(1.0-clamp(factor,0.0,1.0));let cs=cos(angle);let sn=sin(angle);
let position=aoPosition(pixel.xy*ao.invSize,dZ(depth));let n=dNormal(p);
var sum=0.0;var total=0.0;
for(var i=0;i<8;i++){
let tap=poisson[i];let xi=vec2f(cs*tap.x+sn*tap.y,-sn*tap.x+cs*tap.y);
let q=aoClamp(vec2i(pixel.xy+radius*xi),ao.size);
let qp=aoPosition((vec2f(q)+0.5)*ao.invSize,dZ(aoRawDepth(q)));
let weight=exp(-tap.z*tap.z/(2.0*0.9*0.9))*dGeom(position,qp,n);
sum+=weight*textureLoad(repaired,q,0).r;total+=weight;
}
if(total>0.0){result=sum/total;}
}
}
// Quantize once so public visibility equals the stored eight-bit feedback exactly.
let v=floor(clamp(result,0.0,1.0)*255.0+0.5)/255.0;
return Output(v,vec4f(v,v,v,1),vec2u(bitcast<u32>(depth),geometryNormalBits(normal)));
}`;
}
