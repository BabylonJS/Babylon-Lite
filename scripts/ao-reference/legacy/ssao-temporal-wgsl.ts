import { wgsl, type WgslSource } from "../../../packages/babylon-lite/src/shader/wgsl.js";
import { SSAO_PARAMS_WGSL, ssaoDepthBindingWGSL, ssaoNormalWGSL, ssaoHalfWGSL } from "../../../packages/babylon-lite/src/post-process/ssao-wgsl.js";

/** @internal AO-specific reprojection; no final-color accumulation or hardware-filtered geometry. */
export function ssaoTemporalWGSL(kind: "depth" | "float"): WgslSource {
    return wgsl`${SSAO_PARAMS_WGSL}
${ssaoDepthBindingWGSL(kind, 1)}
@group(0) @binding(2) var normalInput:texture_2d<f32>;
@group(0) @binding(3) var currentAO:texture_2d<f32>;
@group(0) @binding(4) var velocity:texture_2d<f32>;
@group(0) @binding(5) var historyAO:texture_2d<f32>;
@group(0) @binding(6) var historyGeometry:texture_2d<u32>;
struct TemporalParams{invView:mat4x4f,previousView:mat4x4f,previousViewProjection:mat4x4f,control:vec4f}
@group(0) @binding(7) var<uniform> temporal:TemporalParams;
@group(0) @binding(8) var nextAO:texture_storage_2d<rgba16float,write>;
@group(0) @binding(9) var nextGeometry:texture_storage_2d<rg32uint,write>;
@group(0) @binding(10) var outputAO:texture_storage_2d<rgba16float,write>;
@group(0) @binding(11) var currentMotion:texture_2d<u32>;
@group(0) @binding(12) var previousMotion:texture_2d<u32>;
override HAS_VELOCITY:u32=0u;
fn aoDepth(p:vec2i)->f32{return ao.depthUnpack.x/(ao.depthUnpack.y-aoRawDepth(p));}
${ssaoNormalWGSL()}
${ssaoHalfWGSL()}
fn octEncode(n:vec3f)->u32{
var p=n.xy/(abs(n.x)+abs(n.y)+abs(n.z));
if(n.z<0.0){p=(1.0-abs(p.yx))*select(vec2f(-1),vec2f(1),p>=vec2f(0));}
return pack2x16snorm(p);
}
fn octDecode(bits:u32)->vec3f{
let p=unpack2x16snorm(bits);
var n=vec3f(p,1.0-abs(p.x)-abs(p.y));
let t=clamp(-n.z,0.0,1.0);
n.x+=select(t,-t,n.x>=0.0);n.y+=select(t,-t,n.y>=0.0);
return normalize(n);
}
fn depthTolerance(z:f32)->f32{return max(1e-4,min(z*0.005,ao.radius*0.025));}
fn historyGuide(p:vec2i,position:vec3f,n:vec3f)->vec2f{
let projected=ao.radius*ao.radiusMultiplier*vec2f(ao.size)/(2.0*ao.tanHalfFov*position.z);
let step=select(1,3,max(projected.x,projected.y)>40.0);
let tolerance=depthTolerance(position.z);
var sum=0.0;var second=0.0;var count=0.0;
for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){
let q=aoClamp(p+vec2i(x,y)*step,ao.size);
if(aoRawDepth(q)==0.0){continue;}
let qn=normalize(aoNormal(q));if(dot(n,qn)<0.9){continue;}
let qp=aoPosition((vec2f(q)+0.5)*ao.invSize,aoDepth(q));
let delta=qp-position;let distance=length(delta);
let curvature=0.5*distance*length(qn-n);
if(distance>ao.radius*2.0||abs(dot(delta,n))>tolerance+curvature){continue;}
let value=textureLoad(currentAO,q,0).r;
sum+=value;second+=value*value;count+=1.0;
}}
let mean=sum/max(count,1.0);
return vec2f(mean,max(0.0,second/max(count,1.0)-mean*mean));
}
fn activeFootprint(mask:texture_2d<u32>,uv:vec2f,z:f32)->bool{
let radius=ao.radius*ao.radiusMultiplier;
let extent=radius*vec2f(ao.size)/(2.0*ao.tanHalfFov*max(z-radius,0.1));
let level=u32(clamp(ceil(log2(max(1.0,2.0*max(extent.x,extent.y)/8.0))),0.0,f32(textureNumLevels(mask)-1u)));
let scale=8.0*exp2(f32(level));let center=uv*vec2f(ao.size);
let dims=textureDimensions(mask,level);
let start=clamp(vec2i(floor((center-extent)/scale)),vec2i(0),vec2i(dims)-1);
let end=clamp(vec2i(floor((center+extent)/scale)),vec2i(0),vec2i(dims)-1);
let rectangleMin=(center-extent)/8.0;let rectangleMax=(center+extent)/8.0;
for(var y=start.y;y<=end.y;y++){for(var x=start.x;x<=end.x;x++){
let cell=textureLoad(mask,vec2i(x,y),i32(level));
let lower=vec2f(f32(cell.x&65535u),f32(cell.x>>16u));
let upper=vec2f(f32(cell.y&65535u),f32(cell.y>>16u));
if(cell.y!=0u&&all(lower<=rectangleMax)&&all(upper>=rectangleMin)&&
bitcast<f32>(cell.z)<=z+radius&&bitcast<f32>(cell.w)>=z-radius){return true;}
}}
return false;
}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
if(any(id.xy>=ao.size)){return;}
let p=vec2i(id.xy);
if(aoRawDepth(p)==0.0){
textureStore(nextAO,p,vec4f(1,0,0,1));textureStore(nextGeometry,p,vec4u(0));
textureStore(outputAO,p,vec4f(1));return;
}
let uv=(vec2f(p)+0.5)*ao.invSize;
let z=aoDepth(p);
let position=aoPosition(uv,z);
let n=normalize(aoNormal(p));
let world=(temporal.invView*vec4f(position,1)).xyz;
let worldNormal=normalize((temporal.invView*vec4f(n,0)).xyz);
let center=textureLoad(currentAO,p,0).r;
let previousPosition=(temporal.previousView*vec4f(world,1)).xyz;
let clip=temporal.previousViewProjection*vec4f(world,1);
var previousUv=uv;
var previousDepth=z;
var movingReceiver=false;
if(temporal.control.x==0.0){
previousUv=vec2f(clip.x/clip.w*0.5+0.5,0.5-clip.y/clip.w*0.5);
let cameraUv=previousUv;
previousDepth=previousPosition.z;
if(HAS_VELOCITY!=0u){
let motion=textureLoad(velocity,p,0);
previousUv=uv+motion.xy*vec2f(1,-1);
if(temporal.control.w!=0.0){
previousDepth=motion.z;
movingReceiver=length((previousUv-cameraUv)*vec2f(ao.size))>0.125||
abs(previousDepth-previousPosition.z)>max(0.001,abs(previousPosition.z)*0.0001);
}
}
}
let activeArea=HAS_VELOCITY!=0u&&temporal.control.x==0.0&&!movingReceiver&&
(activeFootprint(currentMotion,uv,z)||(previousDepth>0.0&&all(previousUv>=vec2f(0))&&all(previousUv<=vec2f(1))&&activeFootprint(previousMotion,previousUv,previousDepth)));
let projectedRadius=ao.radius*ao.radiusMultiplier*vec2f(ao.size)/(2.0*ao.tanHalfFov*z);
let useGuide=activeArea&&max(projectedRadius.x,projectedRadius.y)>40.0;
var sum=0.0;var second=0.0;var total=0.0;var squaredWeights=0.0;
var boxSum=0.0;var boxSecond=0.0;var boxCount=0.0;
for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){
let q=aoClamp(p+vec2i(x,y),ao.size);
if(aoRawDepth(q)==0.0){continue;}
let tapUv=(vec2f(q)+0.5)*ao.invSize;
let tolerance=depthTolerance(z);
let tapPosition=aoPosition(tapUv,aoDepth(q));
let tapNormal=normalize(aoNormal(q));
let delta=tapPosition-position;
let distance=length(delta);
let error=abs(dot(delta,n));
let curvature=0.5*distance*length(tapNormal-n);
if(distance>ao.radius*2.0||error>tolerance+curvature){continue;}
let agreement=dot(n,tapNormal);
if(agreement<0.9){continue;}
let spatial=select(1.0,2.0,x==0)*select(1.0,2.0,y==0);
let weight=spatial*(1.0-error/(tolerance+curvature))*agreement;
let value=textureLoad(currentAO,q,0).r;
sum+=value*weight;second+=value*value*weight;total+=weight;squaredWeights+=weight*weight;
boxSum+=value;boxSecond+=value*value;boxCount+=1.0;
}}
let mean=select(center,sum/max(total,1e-6),total>0.0);
let variance=max(0.0,second/max(total,1e-6)-mean*mean);
var current=center;
var guide=vec2f(mean,variance);
if(useGuide){guide=historyGuide(p,position,n);}
var result=current;var count=1.0;var signalMean=select(mean,guide.x,useGuide);var signalVariance=0.0;
var trackedReceiver=false;
if(temporal.control.x==0.0){
if((clip.w>0.0||temporal.control.w!=0.0)&&previousDepth>0.0&&all(previousUv>=vec2f(0))&&all(previousUv<=vec2f(1))){
let previousNormal=normalize((temporal.previousView*vec4f(worldNormal,0)).xyz);
let anchor=aoPosition(previousUv,previousDepth);
let pixel=previousUv*vec2f(ao.size)-0.5;
let base=vec2i(floor(pixel));let f=fract(pixel);
var historySum=0.0;var countSum=0.0;var varianceSum=0.0;var signalSum=0.0;var weights=0.0;
for(var y=0;y<2;y++){for(var x=0;x<2;x++){
let q=base+vec2i(x,y);
if(any(q<vec2i(0))||any(q>=vec2i(ao.size))){continue;}
let geometry=textureLoad(historyGeometry,q,0).rg;
let stored=bitcast<f32>(geometry.x&0x7fffffffu);
let storedNormal=octDecode(geometry.y);
if(stored<=0.0||dot(worldNormal,storedNormal)<0.9){continue;}
let tapUv=(vec2f(q)+0.5)*ao.invSize;
let tapPosition=aoPosition(tapUv,stored);
let delta=tapPosition-anchor;
let distance=length(delta);
let curvature=0.5*distance*length(storedNormal-worldNormal);
if(distance>ao.radius*2.0||abs(dot(delta,previousNormal))>depthTolerance(previousDepth)+curvature){continue;}
if(temporal.control.w!=0.0&&(geometry.x&0x80000000u)!=0u){movingReceiver=true;}
let history=textureLoad(historyAO,q,0);
if(history.g<1.0){continue;}
let weight=select(1.0-f.x,f.x,x==1)*select(1.0-f.y,f.y,y==1);
historySum+=history.r*weight;countSum+=history.g*weight;varianceSum+=history.b*weight;signalSum+=history.a*weight;weights+=weight;
}}
if(weights>1e-4){
let old=historySum/weights;
let oldSignal=signalSum/weights;
let oldVariance=max(0.0,varianceSum/weights);
count=min(countSum+1.0,temporal.control.y);
if(!movingReceiver&&useGuide){
var fastGuide=mix(oldSignal,guide.x,0.75);
if(abs(guide.x-oldSignal)>0.05+3.0*sqrt(guide.y)){fastGuide=guide.x;}
let boxMean=boxSum/max(boxCount,1.0);
let boxVariance=max(0.0,boxSecond/max(boxCount,1.0)-boxMean*boxMean);
let clipVariance=min(boxVariance,guide.y);
let deviation=0.5*sqrt(clipVariance);
let clipped=clamp(old,fastGuide-deviation,fastGuide+deviation);
result=mix(clipped,current,1.0/count);
signalMean=fastGuide;signalVariance=clipVariance;
if(abs(current-old)>0.5&&abs(guide.x-oldSignal)>0.05){
result=current;count=1.0;signalMean=guide.x;
}
}else{
let meanVariance=variance*squaredWeights/max(total*total,1e-6);
let observation=select(mean,current,movingReceiver);
let bootstrapVariance=select(meanVariance,variance,movingReceiver);
let noise=sqrt(select(bootstrapVariance,oldVariance,countSum/weights>=4.0));
let changeLimit=0.015+3.0*noise;
let innovation=observation-oldSignal;
let reactive=smoothstep(select(changeLimit*0.5,changeLimit,movingReceiver),changeLimit*1.5,abs(innovation));
let deviation=2.0*sqrt(variance)+0.015;
let clipped=select(clamp(old,mean-deviation,mean+deviation),old,movingReceiver);
if(abs(clipped-old)>0.015){count=min(count,4.0);}
if(activeArea&&!movingReceiver){count=min(count,4.0);}
let weight=max(1.0/count,reactive);
count=1.0/weight;
result=mix(clipped,current,weight);
signalMean=mix(oldSignal,observation,weight);
let noiseInnovation=clamp(innovation,-changeLimit,changeLimit);
signalVariance=(1.0-weight)*(oldVariance+weight*noiseInnovation*noiseInnovation);
}
}
}
trackedReceiver=movingReceiver;
if(movingReceiver&&count==1.0){signalMean=current;signalVariance=variance;}
}
result=clamp(result,0.0,1.0);
result=aoHalf(result);
textureStore(nextAO,p,vec4f(result,aoHalf(count),aoHalf(signalVariance),aoHalf(signalMean)));
textureStore(nextGeometry,p,vec4u(bitcast<u32>(z)|select(0u,0x80000000u,trackedReceiver),octEncode(worldNormal),0,0));
textureStore(outputAO,p,vec4f(result,result,result,1));
}`;
}
