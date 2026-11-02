import { wgsl, type WgslSource } from "../../../packages/babylon-lite/src/shader/wgsl.js";
import { SSAO_PARAMS_WGSL, ssaoDepthBindingWGSL, ssaoNormalWGSL } from "../../../packages/babylon-lite/src/post-process/ssao-wgsl.js";

/** @internal Active-tile bounds and depth range; camera-only motion is removed. */
export function ssaoMotionWGSL(kind: "depth" | "float"): WgslSource {
    return wgsl`${SSAO_PARAMS_WGSL}
${ssaoDepthBindingWGSL(kind, 1)}
@group(0) @binding(2) var normalInput:texture_2d<f32>;
@group(0) @binding(3) var velocity:texture_2d<f32>;
@group(0) @binding(4) var geometry:texture_2d<u32>;
struct TemporalParams{invView:mat4x4f,previousView:mat4x4f,previousViewProjection:mat4x4f,control:vec4f}
@group(0) @binding(5) var<uniform> temporal:TemporalParams;
@group(0) @binding(6) var result:texture_storage_2d<rgba32uint,write>;
fn aoDepth(p:vec2i)->f32{return ao.depthUnpack.x/(ao.depthUnpack.y-aoRawDepth(p));}
${ssaoNormalWGSL()}
var<workgroup> activity:atomic<u32>;
var<workgroup> minimumDepth:atomic<u32>;
var<workgroup> maximumDepth:atomic<u32>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u,@builtin(local_invocation_index) local:u32,@builtin(workgroup_id) tile:vec3u){
if(local==0u){atomicStore(&activity,0u);atomicStore(&minimumDepth,0x7f7fffffu);atomicStore(&maximumDepth,0u);}workgroupBarrier();
if(all(id.xy<ao.size)&&temporal.control.x==0.0){
let p=vec2i(id.xy);let depth=aoRawDepth(p);
var moving=false;
var movementDepth=aoDepth(p);
if(depth==0.0){
moving=(textureLoad(geometry,p,0).r&0x7fffffffu)!=0u;
movementDepth=bitcast<f32>(textureLoad(geometry,p,0).r&0x7fffffffu);
}else{
let uv=(vec2f(p)+0.5)*ao.invSize;
let position=aoPosition(uv,aoDepth(p));
let world=temporal.invView*vec4f(position,1);
let clip=temporal.previousViewProjection*world;
if(clip.w>0.0){
let previousUv=vec2f(clip.x/clip.w*0.5+0.5,0.5-clip.y/clip.w*0.5);
let actual=textureLoad(velocity,p,0).xy*vec2f(1,-1);
moving=length((actual-(previousUv-uv))*vec2f(ao.size))>0.5;
if(all(previousUv>=vec2f(0))&&all(previousUv<=vec2f(1))){
let q=aoClamp(vec2i(previousUv*vec2f(ao.size)),ao.size);
let stored=bitcast<f32>(textureLoad(geometry,q,0).r&0x7fffffffu);
let n=normalize((temporal.previousView*temporal.invView*vec4f(aoNormal(p),0)).xyz);
let previousPosition=(temporal.previousView*world).xyz;
let ray=aoPosition((vec2f(q)+0.5)*ao.invSize,1);
let denominator=dot(ray,n);
if(abs(denominator)>1e-5){
let expected=dot(previousPosition,n)/denominator;
let tolerance=max(1e-4,min(abs(expected)*0.005,ao.radius*0.025));
moving=moving||stored<=0.0||abs(stored-expected)>tolerance;
}
}
}
}
if(moving){atomicOr(&activity,1u);atomicMin(&minimumDepth,bitcast<u32>(movementDepth));atomicMax(&maximumDepth,bitcast<u32>(movementDepth));}
}
workgroupBarrier();
if(local==0u){
var bounds=vec4u(0xffffffffu,0u,0x7f7fffffu,0u);
if(atomicLoad(&activity)!=0u){
bounds=vec4u(tile.x|(tile.y<<16u),(tile.x+1u)|((tile.y+1u)<<16u),atomicLoad(&minimumDepth),atomicLoad(&maximumDepth));
}
textureStore(result,vec2i(tile.xy),bounds);
}
}`;
}

/** @internal Bounding hierarchy, retaining odd trailing rows/columns conservatively. */
export function ssaoMotionReduceWGSL(): WgslSource {
    return wgsl`@group(0) @binding(0) var source:texture_2d<u32>;
@group(0) @binding(1) var result:texture_storage_2d<rgba32uint,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
let dims=textureDimensions(result);if(any(id.xy>=dims)){return;}
let sourceDims=textureDimensions(source);let start=id.xy*2u;var end=min(start+2u,sourceDims);
if(id.x==dims.x-1u){end.x=sourceDims.x;}if(id.y==dims.y-1u){end.y=sourceDims.y;}
var lower=vec2u(65535u);var upper=vec2u(0);var minDepth=0x7f7fffffu;var maxDepth=0u;
for(var y=start.y;y<end.y;y++){for(var x=start.x;x<end.x;x++){
let cell=textureLoad(source,vec2i(vec2u(x,y)),0);
if(cell.y==0u){continue;}
lower=min(lower,vec2u(cell.x&65535u,cell.x>>16u));
upper=max(upper,vec2u(cell.y&65535u,cell.y>>16u));
minDepth=min(minDepth,cell.z);maxDepth=max(maxDepth,cell.w);
}}
textureStore(result,vec2i(id.xy),vec4u(lower.x|(lower.y<<16u),upper.x|(upper.y<<16u),minDepth,maxDepth));
}`;
}
