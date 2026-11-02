import { wgsl, type WgslSource } from "../../../packages/babylon-lite/src/shader/wgsl.js";
import { SSAO_PARAMS_WGSL, ssaoHalfWGSL } from "../../../packages/babylon-lite/src/post-process/ssao-wgsl.js";

/** @internal Suppress sample flicker after genuine rejection without blurring stable history. */
export function ssaoStabilizeWGSL(): WgslSource {
    return wgsl`${SSAO_PARAMS_WGSL}
${ssaoHalfWGSL()}
@group(0) @binding(1) var resolved:texture_2d<f32>;
@group(0) @binding(2) var geometry:texture_2d<u32>;
@group(0) @binding(3) var result:texture_storage_2d<rgba16float,write>;
fn normal(bits:u32)->vec3f{
let p=unpack2x16snorm(bits);var n=vec3f(p,1.0-abs(p.x)-abs(p.y));
let t=clamp(-n.z,0.0,1.0);n.x+=select(t,-t,n.x>=0.0);n.y+=select(t,-t,n.y>=0.0);
return normalize(n);
}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
if(any(id.xy>=ao.size)){return;}
let p=vec2i(id.xy);let center=textureLoad(resolved,p,0);
let g=textureLoad(geometry,p,0).rg;let z=bitcast<f32>(g.x&0x7fffffffu);
if(z<=0.0||center.g>=16.0||(g.x&0x80000000u)!=0u){
textureStore(result,p,vec4f(center.rrr,1));return;
}
let worldNormal=normal(g.y);
let n=normalize((ao.view*vec4f(worldNormal,0)).xyz);
let position=aoPosition((vec2f(p)+0.5)*ao.invSize,z);
let tolerance=max(1e-4,min(z*0.005,ao.radius*0.025));
let sigma=max(0.05,4.0*sqrt(max(center.b,0.0)));
let kernel=array<f32,5>(1,4,6,4,1);
var sum=0.0;var weights=0.0;
for(var y=-2;y<=2;y++){for(var x=-2;x<=2;x++){
let q=aoClamp(p+vec2i(x,y),ao.size);
let tapGeometry=textureLoad(geometry,q,0).rg;
let tapDepth=bitcast<f32>(tapGeometry.x&0x7fffffffu);
let tapNormal=normal(tapGeometry.y);
if(tapDepth<=0.0||dot(worldNormal,tapNormal)<0.9){continue;}
let tapPosition=aoPosition((vec2f(q)+0.5)*ao.invSize,tapDepth);
let delta=tapPosition-position;
let distance=length(delta);
let curvature=0.5*distance*length(tapNormal-worldNormal);
if(distance>ao.radius*2.0||abs(dot(delta,n))>tolerance+curvature){continue;}
let tap=textureLoad(resolved,q,0);
let difference=tap.a-center.a;
let agreement=exp2(-difference*difference/(sigma*sigma));
let w=kernel[u32(x+2)]*kernel[u32(y+2)]*agreement;
sum+=tap.r*w;weights+=w;
}}
let filtered=sum/max(weights,1e-6);
let strength=1.0-smoothstep(2.0,16.0,center.g);
let value=aoHalf(clamp(mix(center.r,filtered,strength),0.0,1.0));
textureStore(result,p,vec4f(value,value,value,1));
}`;
}
