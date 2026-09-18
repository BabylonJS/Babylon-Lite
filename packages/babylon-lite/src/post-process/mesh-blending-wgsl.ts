import { wgsl, type WgslSource } from "../shader/wgsl.js";

export interface MeshBlendingWgslOptions {
    quality: number;
    depthType: number;
    debugMode: number;
    hasBaseColor: boolean;
}

export interface MeshBlendingQualitySettings {
    readonly directionCount: number;
    readonly radialSampleCount: number;
    readonly directionRefinementSampleCount: number;
    readonly directionRefinementStepCount: number;
    readonly exactEdgeSampleCount: number;
    readonly radiusScale: number;
    readonly fullRandomRotation: boolean;
    readonly searchJitterFactor: number;
    readonly immediateFourNeighborFallback: boolean;
    readonly tinyObjectSafeguard: boolean;
    readonly multiTargetSecondaryBlend: boolean;
    readonly colorInterpolation: "sRGB" | "OKLab";
}

/** Return the compile-time constants for a mesh-blending quality variant. */
export function getMeshBlendingQualitySettings(quality: number): MeshBlendingQualitySettings {
    switch (quality) {
        case 0:
            return {
                directionCount: 3,
                radialSampleCount: 2,
                directionRefinementSampleCount: 1,
                directionRefinementStepCount: 2,
                exactEdgeSampleCount: 5,
                radiusScale: 0.5,
                fullRandomRotation: false,
                searchJitterFactor: 0.5,
                immediateFourNeighborFallback: false,
                tinyObjectSafeguard: false,
                multiTargetSecondaryBlend: false,
                colorInterpolation: "sRGB",
            };
        case 1:
            return {
                directionCount: 3,
                radialSampleCount: 3,
                directionRefinementSampleCount: 2,
                directionRefinementStepCount: 4,
                exactEdgeSampleCount: 8,
                radiusScale: 0.9,
                fullRandomRotation: false,
                searchJitterFactor: 0.5,
                immediateFourNeighborFallback: false,
                tinyObjectSafeguard: false,
                multiTargetSecondaryBlend: false,
                colorInterpolation: "OKLab",
            };
        case 2:
            return {
                directionCount: 3,
                radialSampleCount: 3,
                directionRefinementSampleCount: 3,
                directionRefinementStepCount: 5,
                exactEdgeSampleCount: 10,
                radiusScale: 1,
                fullRandomRotation: true,
                searchJitterFactor: 0.5,
                immediateFourNeighborFallback: true,
                tinyObjectSafeguard: true,
                multiTargetSecondaryBlend: true,
                colorInterpolation: "OKLab",
            };
        case 3:
            return {
                directionCount: 8,
                radialSampleCount: 6,
                directionRefinementSampleCount: 4,
                directionRefinementStepCount: 5,
                exactEdgeSampleCount: 50,
                radiusScale: 0.95,
                fullRandomRotation: true,
                searchJitterFactor: 1,
                immediateFourNeighborFallback: true,
                tinyObjectSafeguard: true,
                multiTargetSecondaryBlend: true,
                colorInterpolation: "OKLab",
            };
        default:
            throw new RangeError("Mesh-blending quality must be Low, Medium, High, or Cinematic.");
    }
}

export function projectMeshBlendWorldRadiusToPixels(worldRadius: number, viewDepth: number, renderTargetHeight: number, projectionYScale: number, isOrthographic: boolean): number {
    const projectionScale = Math.max(0.5 * renderTargetHeight * Math.abs(projectionYScale), 0.00001);
    return worldRadius * (isOrthographic ? projectionScale : projectionScale / Math.max(Math.abs(viewDepth), 0.00001));
}

export function calculateMeshBlendSearchRadius(
    definition: { readonly worldRadius: number; readonly minimumProjectedRadius: number },
    viewDepth: number,
    renderTargetHeight: number,
    projectionYScale: number,
    isOrthographic: boolean,
    quality: number
): number {
    const projected = projectMeshBlendWorldRadiusToPixels(definition.worldRadius, viewDepth, renderTargetHeight, projectionYScale, isOrthographic);
    const scaled = Math.max(projected, definition.minimumProjectedRadius) * getMeshBlendingQualitySettings(quality).radiusScale;
    return scaled > 0 ? Math.max(1, scaled) : 0;
}

export function calculateMeshBlendFade(distancePixels: number, searchRadiusPixels: number): number {
    const normalized = Math.min(Math.max(Math.max(distancePixels - 0.5, 0) / Math.max(searchRadiusPixels, 0.00001), 0), 1);
    const inverse = 1 - normalized;
    return (inverse * inverse + (inverse - inverse * inverse) * Math.min(Math.max(inverse - 0.75, 0), 1)) * 0.5;
}

export function calculateMeshBlendEffectiveWorldRadius(
    radiusPixels: number,
    viewDepth: number,
    renderTargetHeight: number,
    projectionYScale: number,
    isOrthographic: boolean
): number {
    const projectionScale = Math.max(0.5 * renderTargetHeight * Math.abs(projectionYScale), 0.00001);
    return radiusPixels * (isOrthographic ? 1 / projectionScale : Math.max(Math.abs(viewDepth), 0.00001) / projectionScale);
}

export function calculateMeshBlendSlopeScale(oppositeFacing: number, slopeFactor: number): number {
    if (slopeFactor <= 1) {
        return 1;
    }
    return 0.25 + 0.75 * Math.pow(Math.min(Math.max(oppositeFacing, 0), 1), slopeFactor - 1);
}

/** Generate one fully specialized mesh-blending fullscreen shader. */
export function createMeshBlendingWGSL(options: MeshBlendingWgslOptions): WgslSource {
    const q = getMeshBlendingQualitySettings(options.quality);
    if (options.depthType !== 0 && options.depthType !== 1) {
        throw new RangeError("Mesh-blending depthType must be View or Screen.");
    }
    if (!Number.isInteger(options.debugMode) || options.debugMode < 0 || options.debugMode > 12) {
        throw new RangeError("Mesh-blending debugMode is not a defined MeshBlendDebugMode value.");
    }
    const baseBinding = options.hasBaseColor ? "@group(0) @binding(3) var baseColorTexture:texture_2d<f32>;" : "";
    const noiseBinding = options.hasBaseColor ? 4 : 3;
    const uniformBinding = options.hasBaseColor ? 5 : 4;
    const baseFields = options.hasBaseColor ? "d:vec3f,e:vec3f," : "";
    const baseLoads = options.hasBaseColor
        ? `s.d=textureLoad(baseColorTexture,result.f,0).rgb;
let plusOneBase=textureLoad(baseColorTexture,plusOnePixel,0).rgb;
let plusTwoBase=textureLoad(baseColorTexture,plusTwoPixel,0).rgb;`
        : "";
    const baseOnePixel = options.hasBaseColor ? "s.e=s.d;" : "";
    const baseSelect = options.hasBaseColor ? "s.e=select(plusOneBase,plusTwoBase,usePlusTwo);" : "";
    const shadowFunctions = options.hasBaseColor
        ? `fn es(rendered:vec3f,base:vec3f)->f32{
let baseLuma=lm(L(base));
if(baseLuma<=BASE_LUMINANCE_EPSILON){return 1.0;}
return lm(L(rendered))/baseLuma;
}
fn sa(current:vec3f,s:S)->f32{
let difference=abs(es(s.f.rgb,s.d)-es(s.c.rgb,s.e));
let mismatch=smoothstep(SHADOW_DIFFERENCE_LOW,SHADOW_DIFFERENCE_HIGH,difference);
let currentLuma=lm(L(current));
let targetLuma=lm(L(s.t.rgb));
let targetNotDark=smoothstep(TARGET_DARKER_RATIO,TARGET_NON_DARK_RATIO,targetLuma/max(currentLuma,BASE_LUMINANCE_EPSILON));
return mix(1.0,SHADOW_MIN_ATTENUATION,mismatch*targetNotDark);
}`
        : "";
    const shadowConstants = options.hasBaseColor
        ? `const BASE_LUMINANCE_EPSILON:f32=0.00001;
const TARGET_DARKER_RATIO:f32=0.65;
const TARGET_NON_DARK_RATIO:f32=0.9;
const SHADOW_DIFFERENCE_LOW:f32=0.15;
const SHADOW_DIFFERENCE_HIGH:f32=0.5;
const SHADOW_MIN_ATTENUATION:f32=0.25;`
        : "";
    const shadowEvaluate = options.hasBaseColor ? "evaluation.sa=sa(evaluation.c.rgb,evaluation.s);" : "";
    const worldPositionField = "w:vec3f,";
    const worldPositionEvaluate = options.debugMode === 12 ? "evaluation.w=(uniforms.inverseView*vec4f(result.p,1)).xyz;" : "";
    const worldPositionDebug = options.debugMode === 12 ? "return vec4f(fract(primaryColor.w*0.1),1);" : "";
    const secondarySearch = q.multiTargetSecondaryBlend
        ? `var secondary=ir();
if(primary.v){secondary=eb(pixel,size,current,currentRadius,abs(sizingPosition.z),primary.k.t,random,rotation,sector,direction0,direction1,direction2);}`
        : "let secondary=ir();";
    const secondaryBlend = q.multiTargetSecondaryBlend
        ? `if(secondary.v){let secondaryColor=ec(pixel,size,current,secondary);let totalDistance=max(primary.k.x+secondary.k.x,EPSILON);let primaryWeight=primaryColor.f*secondary.k.x/totalDistance;let secondaryWeight=secondaryColor.f*primary.k.x/totalDistance;let combined=primaryWeight+secondaryWeight;if(combined<=EPSILON){return source;}return (primaryColor.b*primaryWeight+secondaryColor.b*secondaryWeight)/combined;}`
        : "";
    const fullRandomRotation = q.fullRandomRotation ? "true" : "false";
    const fourNeighborFallback = q.immediateFourNeighborFallback ? "true" : "false";
    const tinyObjectSafeguard = q.tinyObjectSafeguard ? "true" : "false";
    const multiTargetSecondaryBlend = q.multiTargetSecondaryBlend ? "true" : "false";
    const srgbInterpolation = q.colorInterpolation === "sRGB" ? "true" : "false";
    const interpolateFunction =
        q.colorInterpolation === "sRGB"
            ? `fn ci(current:vec3f,t:vec3f,amount:f32)->vec3f{
return G(mix(L(current),L(t),amount));
}`
            : `fn cr(value:f32)->f32{return sign(value)*pow(abs(value),1.0/3.0);}
fn lo(color:vec3f)->vec3f{
let l=cr(0.4122214708*color.r+0.5363325363*color.g+0.0514459929*color.b);
let m=cr(0.2119034982*color.r+0.6806995451*color.g+0.1073969566*color.b);
let s=cr(0.0883024619*color.r+0.2817188376*color.g+0.6299787005*color.b);
return vec3f(0.2104542553*l+0.7936177850*m-0.0040720468*s,1.9779984951*l-2.4285922050*m+0.4505937099*s,0.0259040371*l+0.7827717662*m-0.8086757660*s);
}
fn ol(color:vec3f)->vec3f{
let l_=color.x+0.3963377774*color.y+0.2158037573*color.z;
let m_=color.x-0.1055613458*color.y-0.0638541728*color.z;
let s_=color.x-0.0894841775*color.y-1.2914855480*color.z;
let l=l_*l_*l_;let m=m_*m_*m_;let s=s_*s_*s_;
return vec3f(4.0767416621*l-3.3077115913*m+0.2309699292*s,-1.2684380046*l+2.6097574011*m-0.3413193965*s,-0.0041960863*l-0.7034186147*m+1.7076147010*s);
}
fn ci(current:vec3f,t:vec3f,amount:f32)->vec3f{return ol(mix(lo(current),lo(t),amount));}`;

    return wgsl`struct VertexOutput{@builtin(position) position:vec4f,@location(0) uv:vec2f}
@vertex fn meshBlendVertex(@builtin(vertex_index) vertexIndex:u32)->VertexOutput{
var positions=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));
let p=positions[vertexIndex];var out:VertexOutput;out.position=vec4f(p,0,1);out.uv=vec2f(p.x*0.5+0.5,0.5-p.y*0.5);return out;
}
@group(0) @binding(0) var sourceTexture:texture_2d<f32>;
@group(0) @binding(1) var tagTexture:texture_2d<u32>;
@group(0) @binding(2) var depthTexture:texture_2d<f32>;
${baseBinding}
@group(0) @binding(${noiseBinding}) var blueNoiseTexture:texture_2d<f32>;
struct MeshBlendUniforms{projection:mat4x4f,inverseProjection:mat4x4f,inverseView:mat4x4f,worldRadii:vec4f,minimumProjectedRadii:vec4f,flags:vec4f}
@group(0) @binding(${uniformBinding}) var<uniform> uniforms:MeshBlendUniforms;
const DIRECTION_COUNT:i32=${q.directionCount};
const RADIAL_SAMPLE_COUNT:i32=${q.radialSampleCount};
const REFINEMENT_SAMPLE_COUNT:i32=${q.directionRefinementSampleCount};
const REFINEMENT_STEP_COUNT:i32=${q.directionRefinementStepCount};
const EXACT_EDGE_SAMPLE_COUNT:i32=${q.exactEdgeSampleCount};
const RADIUS_SCALE:f32=${q.radiusScale};
const FULL_RANDOM_ROTATION:bool=${fullRandomRotation};
const JITTER_FACTOR:f32=${q.searchJitterFactor};
const FOUR_NEIGHBOR_FALLBACK:bool=${fourNeighborFallback};
const TINY_OBJECT_SAFEGUARD:bool=${tinyObjectSafeguard};
const MULTI_TARGET_SECONDARY_BLEND:bool=${multiTargetSecondaryBlend};
const DEPTH_TYPE:i32=${options.depthType};
const DEBUG_MODE:i32=${options.debugMode};
const TWO_PI:f32=6.283185307179586;
const EPSILON:f32=0.00001;
const REFINEMENT_SECTOR_SCALE:f32=0.2;
const TINY_OBJECT_PROBE_COUNT:i32=8;
const MIN_SLOPE_SCALE:f32=0.25;
const BOUNDARY_SEPARATION_FACTOR:f32=0.75;
const BOUNDARY_PIXEL_TOLERANCE:f32=3.0;
const FOREGROUND_DEPTH_FACTOR:f32=0.35;
const FOREGROUND_LATERAL_FACTOR:f32=2.0;
const TARGET_SPAN_FACTOR:f32=1.5;
const TOTAL_SPAN_FACTOR:f32=2.5;
const NEAR_EDGE_TARGET_WEIGHT:f32=0.35;
const NEAR_SEAM_MAX_DISTANCE:f32=1.25;
const NEAR_SEAM_COLOR_DELTA:f32=0.02;
${shadowConstants}
const REJECTION_NONE:i32=0;
const REJECTION_NO_CANDIDATE:i32=1;
const REJECTION_NO_CONTINUATION:i32=2;
const REJECTION_INVALID_DEPTH:i32=3;
const REJECTION_DEPTH_SEPARATION:i32=4;
const REJECTION_FOREGROUND_BACKGROUND:i32=5;
const REJECTION_PHYSICAL_SPAN:i32=6;
const REJECTION_CONTACT_ANGLE:i32=7;
struct T{g:u32,c:u32}
struct C{t:u32,c:u32,d:vec2f,x:f32,r:f32,s:f32,v:bool}
struct R{k:C,t:vec2i,f:vec2i,p:vec3f,e:f32,fade:f32,q:f32,j:i32,h:i32,v:bool,n:bool,u:bool,z:bool}
struct S{f:vec4f,a:vec4f,b:vec4f,c:vec4f,t:vec4f,${baseFields}o:bool}
struct E{s:S,c:vec4f,b:vec4f,${worldPositionField}sa:f32,f:f32,n:bool}
fn cp(pixel:vec2i,size:vec2i)->vec2i{return clamp(pixel,vec2i(0),size-vec2i(1));}
fn ib(pixel:vec2i,size:vec2i)->bool{return pixel.x>=0&&pixel.y>=0&&pixel.x<size.x&&pixel.y<size.y;}
fn pu(pixel:vec2i,size:vec2i)->vec2f{return (vec2f(cp(pixel,size))+vec2f(0.5))/vec2f(size);}
fn lt(pixel:vec2i,size:vec2i)->T{let packed=textureLoad(tagTexture,cp(pixel,size),0).r;return T(packed&0x3fu,packed>>6u);}
fn ld(pixel:vec2i,size:vec2i)->f32{return textureLoad(depthTexture,cp(pixel,size),0).r;}
fn cv(values:vec4f,index:u32)->f32{if(index==0u){return values.x;}if(index==1u){return values.y;}if(index==2u){return values.z;}return values.w;}
fn dn(depth:f32)->f32{if(DEPTH_TYPE==1){return depth;}let clip=uniforms.projection*vec4f(0,0,depth,1);return clip.z/clip.w;}
fn rv(pixel:vec2i,size:vec2i,depth:f32)->vec3f{
let uv=pu(pixel,size);let ndcXY=vec2f(uv.x*2.0-1.0,1.0-uv.y*2.0);
let view=uniforms.inverseProjection*vec4f(ndcXY,dn(depth),1);return view.xyz/view.w;
}
fn fv(value:f32)->bool{return (bitcast<u32>(value)&0x7f800000u)!=0x7f800000u;}
fn vp(value:vec3f)->bool{return fv(value.x)&&fv(value.y)&&fv(value.z);}
fn ps(renderHeight:f32)->f32{return max(0.5*renderHeight*abs(uniforms.projection[1][1]),EPSILON);}
fn rf(c:u32,viewDepth:f32,renderHeight:f32)->f32{
let scale=ps(renderHeight);var projected=cv(uniforms.worldRadii,c)*scale;
if(uniforms.flags.x<0.5){projected/=max(viewDepth,EPSILON);}
let scaled=max(projected,cv(uniforms.minimumProjectedRadii,c))*RADIUS_SCALE;
return select(0.0,max(1.0,scaled),scaled>0.0);
}
fn wu(viewDepth:f32,renderHeight:f32)->f32{let units=1.0/ps(renderHeight);return select(units*max(viewDepth,EPSILON),units,uniforms.flags.x>0.5);}
fn ss(oppositeFacing:f32)->f32{if(uniforms.flags.y<=1.0){return 1.0;}return MIN_SLOPE_SCALE+(1.0-MIN_SLOPE_SCALE)*pow(clamp(oppositeFacing,0.0,1.0),uniforms.flags.y-1.0);}
fn ap(pixel:vec2i,size:vec2i)->vec2i{return vec2i(pixel.x,size.y-1-pixel.y);}
fn po(d:vec2f,x:f32)->vec2i{return vec2i(round(vec2f(d.x,-d.y)*x));}
fn ln(pixel:vec2i,renderSize:vec2i)->vec2f{let noiseSize=vec2i(textureDimensions(blueNoiseTexture,0));let noisePixel=ap(pixel,renderSize);let wrapped=vec2i(noisePixel.x%noiseSize.x,noisePixel.y%noiseSize.y);return textureLoad(blueNoiseTexture,wrapped,0).rg;}
fn da(index:i32,rotation:f32,sector:f32,direction0:vec2f,direction1:vec2f,direction2:vec2f)->vec2f{if(DIRECTION_COUNT==3){if(index==0){return direction0;}if(index==1){return direction1;}return direction2;}let angle=rotation+sector*f32(index);return vec2f(cos(angle),sin(angle));}
fn ic()->C{return C(0u,0u,vec2f(0),0,0,-1.0,false);}
fn ir()->R{return R(ic(),vec2i(0),vec2i(0),vec3f(0),0,0,1.0,REJECTION_NO_CANDIDATE,1,false,false,false,false);}
fn fc(pixel:vec2i,size:vec2i,current:T,currentRadius:f32,viewDepth:f32,ignoredGroup:u32,random:vec2f,rotation:f32,sector:f32,direction0:vec2f,direction1:vec2f,direction2:vec2f)->C{
var best=ic();let jitter=mix(0.5,random.y,JITTER_FACTOR);
for(var radial=0;radial<RADIAL_SAMPLE_COUNT;radial++){
let normalized=(f32(radial)+jitter)/f32(RADIAL_SAMPLE_COUNT);let x=max(1.0,ceil(normalized*normalized*normalized*currentRadius));
for(var directionIndex=0;directionIndex<DIRECTION_COUNT;directionIndex++){
let d=da(directionIndex,rotation,sector,direction0,direction1,direction2);let sampled=lt(pixel+po(d,x),size);
if(sampled.g==0u||sampled.g==current.g||sampled.g==ignoredGroup){continue;}
let c=min(current.c,sampled.c);let radius=rf(c,viewDepth,f32(size.y));
if(x>radius){continue;}let s=1.0-clamp(x/max(radius,EPSILON),0.0,1.0);
if(s>best.s){best=C(sampled.g,c,d,x,radius,s,true);}
}
if(best.v){break;}
}
return best;
}
fn rd(pixel:vec2i,size:vec2i,input:C,random:vec2f)->C{
var k=input;if(k.x<=2.0){return k;}
let center=atan2(k.d.y,k.d.x);let halfWidth=(TWO_PI/f32(DIRECTION_COUNT))*REFINEMENT_SECTOR_SCALE;
let stepSize=max(1.0,k.x/f32(REFINEMENT_STEP_COUNT+1));
for(var sample=0;sample<REFINEMENT_SAMPLE_COUNT;sample++){
let sampleRandom=fract(random.y+random.x*0.754877666+f32(sample)*0.618033989);let angle=center+mix(-halfWidth,halfWidth,sampleRandom);let d=vec2f(cos(angle),sin(angle));
var x=k.x-stepSize;
for(var step=0;step<REFINEMENT_STEP_COUNT;step++){if(x<=0.0){break;}if(lt(pixel+po(d,x),size).g!=k.t){break;}k.d=d;k.x=x;x-=stepSize;}
}
return k;
}
fn rb(pixel:vec2i,size:vec2i,input:C)->C{
var k=input;var x=k.x;
for(var sample=0;sample<EXACT_EDGE_SAMPLE_COUNT;sample++){x-=1.0;if(x<=0.0){break;}if(lt(pixel+po(k.d,x),size).g!=k.t){break;}k.x=x;}
return k;
}
fn continuation(pixel:vec2i,size:vec2i,k:C,outPixel:ptr<function,vec2i>)->bool{
let x=max(k.x*2.0,k.x+1.0);*outPixel=pixel+po(k.d,x);
return ib(*outPixel,size)&&lt(*outPixel,size).g==k.t;
}
fn tr(t:vec2i,size:vec2i,viewDepth:f32,k:ptr<function,C>)->bool{
(*k).c=min((*k).c,lt(t,size).c);
(*k).r=min((*k).r,rf((*k).c,viewDepth,f32(size.y)));
return (*k).x<=(*k).r;
}
fn nf(pixel:vec2i,size:vec2i,current:T,viewDepth:f32,ignoredGroup:u32,preferredGroup:u32)->C{
var best=ic();
for(var index=0;index<4;index++){var offset:vec2i;if(index==0){offset=vec2i(1,0);}else if(index==1){offset=vec2i(-1,0);}else if(index==2){offset=vec2i(0,1);}else{offset=vec2i(0,-1);}
let tag=lt(pixel+po(vec2f(offset),1.0),size);if(tag.g==0u||tag.g==current.g||tag.g==ignoredGroup){continue;}
let c=min(current.c,tag.c);let radius=rf(c,viewDepth,f32(size.y));if(radius<1.0){continue;}
var s=1.0-1.0/max(radius,1.0);if(tag.g==preferredGroup){s+=1.0;}if(s>best.s){best=C(tag.g,c,vec2f(offset),1.0,radius,s,true);}
}
return best;
}
fn to(pixel:vec2i,size:vec2i,current:T,k:C,reduced:ptr<function,bool>)->f32{
var thickness=k.r;var oppositeBoundary=false;
for(var probe=1;probe<=TINY_OBJECT_PROBE_COUNT;probe++){let x=max(1.0,k.r*f32(probe)/f32(TINY_OBJECT_PROBE_COUNT));if(lt(pixel-po(k.d,x),size).g!=current.g){thickness=x;oppositeBoundary=true;break;}}
var outside=0;for(var index=0;index<4;index++){var d:vec2f;if(index==0){d=vec2f(1,0);}else if(index==1){d=vec2f(-1,0);}else if(index==2){d=vec2f(0,1);}else{d=vec2f(0,-1);}if(lt(pixel+po(d,k.r),size).g!=current.g){outside++;}}
*reduced=oppositeBoundary&&outside>=3;if(!*reduced){return k.r;}return max(k.x,min(k.r,max(1.0,thickness*1.25)));
}
fn vc(a:vec2i,e:vec2i,b:vec2i,c:vec2i,size:vec2i,current:T,k:C,allowMissingContinuation:bool,narrowed:ptr<function,f32>,currentPosition:ptr<function,vec3f>)->i32{
*currentPosition=vec3f(0);let tagE=lt(e,size);let tagB=lt(b,size);let tagC=lt(c,size);
if(tagE.g!=current.g||tagB.g!=k.t||(!allowMissingContinuation&&tagC.g!=k.t)){return REJECTION_NO_CONTINUATION;}
let pa=rv(a,size,ld(a,size));let pe=rv(e,size,ld(e,size));let pb=rv(b,size,ld(b,size));let pc=rv(c,size,ld(c,size));
if(!vp(pa)||!vp(pe)||!vp(pb)||!vp(pc)){return REJECTION_INVALID_DEPTH;}*currentPosition=pa;
let units=wu(abs(pa.z),f32(size.y));let radius=k.r*units;let tolerance=BOUNDARY_PIXEL_TOLERANCE*units;let boundary=pb-pe;
if(length(boundary)>BOUNDARY_SEPARATION_FACTOR*radius+tolerance){return REJECTION_DEPTH_SEPARATION;}
let depthDelta=abs(abs(pb.z)-abs(pe.z));if(depthDelta>max(FOREGROUND_DEPTH_FACTOR*radius,tolerance)&&depthDelta>FOREGROUND_LATERAL_FACTOR*length(boundary.xy)){return REJECTION_FOREGROUND_BACKGROUND;}
if(distance(pb,pc)>TARGET_SPAN_FACTOR*radius+tolerance||distance(pa,pc)>TOTAL_SPAN_FACTOR*radius+tolerance){return REJECTION_PHYSICAL_SPAN;}
let currentDirection=pa-pb;let targetDirection=pc-pb;let currentLength=length(currentDirection);let targetLength=length(targetDirection);var oppositeFacing=1.0;
if(currentLength>EPSILON&&targetLength>EPSILON){oppositeFacing=-dot(currentDirection/currentLength,targetDirection/targetLength);}
*narrowed=k.r*ss(oppositeFacing);if(k.x>*narrowed){return REJECTION_CONTACT_ANGLE;}return REJECTION_NONE;
}
fn cf(x:f32,radius:f32)->f32{let normalized=clamp(max(x-0.5,0.0)/max(radius,EPSILON),0.0,1.0);let inverse=1.0-normalized;return mix(inverse*inverse,inverse,clamp(inverse-0.75,0.0,1.0))*0.5;}
fn eb(pixel:vec2i,size:vec2i,current:T,currentRadius:f32,viewDepth:f32,ignoredGroup:u32,random:vec2f,rotation:f32,sector:f32,direction0:vec2f,direction1:vec2f,direction2:vec2f)->R{
var result=ir();var k=fc(pixel,size,current,currentRadius,viewDepth,ignoredGroup,random,rotation,sector,direction0,direction1,direction2);result.k=k;if(!k.v){return result;}
result.h=2;k=rb(pixel,size,rd(pixel,size,k,random));result.k=k;result.h=3;
let t=cp(pixel+po(k.d,k.x),size);if(!tr(t,size,viewDepth,&k)){result.k=k;result.j=REJECTION_PHYSICAL_SPAN;return result;}
var farPixel:vec2i;var foundContinuation=continuation(pixel,size,k,&farPixel);
if(!foundContinuation){if(!FOUR_NEIGHBOR_FALLBACK){result.k=k;result.j=REJECTION_NO_CONTINUATION;return result;}let fallback=nf(pixel,size,current,viewDepth,ignoredGroup,k.t);if(!fallback.v){result.k=k;result.j=REJECTION_NO_CONTINUATION;return result;}k=fallback;result.u=true;foundContinuation=continuation(pixel,size,k,&farPixel);}
result.n=foundContinuation;result.h=4;if(foundContinuation&&!tr(farPixel,size,viewDepth,&k)){result.k=k;result.j=REJECTION_PHYSICAL_SPAN;return result;}
let originalRadius=k.r;var reduced=false;if(TINY_OBJECT_SAFEGUARD){k.r=to(pixel,size,current,k,&reduced);result.h=5;}result.z=reduced;
result.k=k;result.e=k.r;result.q=k.r/max(originalRadius,EPSILON);
let b=cp(pixel+po(k.d,k.x),size);let e=cp(pixel+po(k.d,max(k.x-2.0,0.0)),size);var c=b;if(foundContinuation){c=farPixel;}
var narrowed=k.r;var currentPosition=vec3f(0);result.j=vc(pixel,e,b,c,size,current,k,result.u&&!foundContinuation,&narrowed,&currentPosition);
result.p=currentPosition;result.h=6;result.e=narrowed;if(result.j!=REJECTION_NONE){return result;}
result.fade=cf(k.x,narrowed);if(result.fade<=0.0){result.j=REJECTION_PHYSICAL_SPAN;return result;}
result.t=b;result.f=select(b,farPixel,foundContinuation);result.h=7;result.v=true;return result;
}
fn ls(value:f32)->f32{if(value<=0.0031308){return value*12.92;}return 1.055*pow(value,1.0/2.4)-0.055;}
fn sl(value:f32)->f32{if(value<=0.04045){return value/12.92;}return pow((value+0.055)/1.055,2.4);}
fn L(color:vec3f)->vec3f{return vec3f(ls(color.r),ls(color.g),ls(color.b));}
fn G(color:vec3f)->vec3f{return vec3f(sl(color.r),sl(color.g),sl(color.b));}
${interpolateFunction}
fn lm(color:vec3f)->f32{return dot(color,vec3f(0.2126,0.7152,0.0722));}
fn ts(size:vec2i,result:R)->S{
var s:S;let plusOnePixel=cp(result.t+po(result.k.d,1.0),size);let plusTwoPixel=cp(result.t+po(result.k.d,2.0),size);
let plusOneTag=lt(plusOnePixel,size);let plusTwoTag=lt(plusTwoPixel,size);s.f=textureLoad(sourceTexture,result.f,0);s.a=textureLoad(sourceTexture,plusOnePixel,0);s.b=textureLoad(sourceTexture,plusTwoPixel,0);
${baseLoads}
s.o=plusOneTag.g!=result.k.t;if(s.o){s.c=s.f;${baseOnePixel}s.t=s.f;return s;}
let usePlusTwo=plusTwoTag.g==result.k.t&&lm(L(s.b.rgb))<lm(L(s.a.rgb));
s.c=select(s.a,s.b,usePlusTwo);${baseSelect}
s.t=mix(s.f,s.c,NEAR_EDGE_TARGET_WEIGHT);return s;
}
fn ns(pixel:vec2i,size:vec2i,current:T,result:R,s:S,c:vec4f,corrected:ptr<function,bool>)->vec4f{
*corrected=false;if(!s.o||result.k.x>NEAR_SEAM_MAX_DISTANCE){return c;}
let oppositePixel=cp(pixel-po(result.k.d,1.0),size);if(lt(oppositePixel,size).g!=current.g){return c;}
let oppositeColor=textureLoad(sourceTexture,oppositePixel,0);if(distance(c.rgb,s.t.rgb)+NEAR_SEAM_COLOR_DELTA>=distance(oppositeColor.rgb,s.t.rgb)){return c;}*corrected=true;return oppositeColor;
}
${shadowFunctions}
fn ec(pixel:vec2i,size:vec2i,current:T,result:R)->E{
var evaluation:E;evaluation.s=ts(size,result);${worldPositionEvaluate}
var corrected=false;evaluation.c=ns(pixel,size,current,result,evaluation.s,textureLoad(sourceTexture,pixel,0),&corrected);evaluation.n=corrected;evaluation.sa=1.0;${shadowEvaluate}
evaluation.f=result.fade*evaluation.sa;evaluation.b=vec4f(ci(evaluation.c.rgb,evaluation.s.t.rgb,evaluation.f),mix(evaluation.c.a,evaluation.s.t.a,evaluation.f));return evaluation;
}
fn rc(c:u32)->vec3f{if(c==0u){return vec3f(0.15,0.55,1.0);}if(c==1u){return vec3f(0.15,0.9,0.35);}if(c==2u){return vec3f(1.0,0.65,0.1);}return vec3f(0.95,0.2,0.65);}
fn jc(reason:i32,ratio:f32)->vec3f{if(reason==REJECTION_NONE){return mix(vec3f(0.1,0.55,1),vec3f(0.2,1,0.25),ratio);}if(reason==REJECTION_NO_CANDIDATE){return vec3f(0.12);}if(reason==REJECTION_NO_CONTINUATION){return vec3f(0.75,0.1,0.85);}if(reason==REJECTION_INVALID_DEPTH){return vec3f(1,0,1);}if(reason==REJECTION_DEPTH_SEPARATION){return vec3f(1,0.1,0.1);}if(reason==REJECTION_FOREGROUND_BACKGROUND){return vec3f(1,0.4,0.05);}if(reason==REJECTION_PHYSICAL_SPAN){return vec3f(1,0.9,0.05);}return vec3f(0.05,0.8,1);}
fn sc(stage:i32)->vec3f{if(stage<=0){return vec3f(0.03);}if(stage==1){return vec3f(0.1,0.15,0.45);}if(stage==2){return vec3f(0.1,0.35,0.7);}if(stage==3){return vec3f(0.05,0.65,0.8);}if(stage==4){return vec3f(0.1,0.8,0.55);}if(stage==5){return vec3f(0.45,0.9,0.25);}if(stage==6){return vec3f(0.95,0.75,0.1);}return vec3f(0.15,1,0.25);}
@fragment fn meshBlendFragment(input:VertexOutput)->@location(0) vec4f{
let size=vec2i(textureDimensions(depthTexture,0));let pixel=clamp(vec2i(floor(input.uv*vec2f(size))),vec2i(0),size-vec2i(1));let source=textureLoad(sourceTexture,pixel,0);
if(uniforms.flags.z<0.5){return source;}
let current=lt(pixel,size);if(DEBUG_MODE==1){if(current.g==0u){return vec4f(0,0,0,1);}return vec4f(rc(current.c)*(0.45+0.55*fract(f32(current.g)*0.61803398875)),1);}
if(current.g==0u){if(DEBUG_MODE==3){return vec4f(0,0,0,1);}return select(source,vec4f(0.04,0.04,0.04,1),DEBUG_MODE!=0);}
let sizingPosition=rv(pixel,size,ld(pixel,size));if(!vp(sizingPosition)){if(DEBUG_MODE==4){return vec4f(jc(REJECTION_INVALID_DEPTH,0),1);}if(DEBUG_MODE==5){return vec4f(0.45,0.1,0.1,1);}return select(source,vec4f(0.04,0.04,0.04,1),DEBUG_MODE!=0);}
let currentRadius=rf(current.c,abs(sizingPosition.z),f32(size.y));if(currentRadius<1.0){if(DEBUG_MODE==3){return vec4f(rc(current.c)*0.25,1);}if(DEBUG_MODE==4){return vec4f(jc(REJECTION_PHYSICAL_SPAN,0),1);}if(DEBUG_MODE==5){return vec4f(0.2,0.2,0.65,1);}return select(source,vec4f(0.04,0.04,0.04,1),DEBUG_MODE!=0);}
let random=ln(pixel,size);let sector=TWO_PI/f32(DIRECTION_COUNT);let rotation=select(floor(random.x*8.0)*0.125*sector,random.x*sector,FULL_RANDOM_ROTATION);
let direction0=vec2f(cos(rotation),sin(rotation));let direction1=vec2f(cos(rotation+sector),sin(rotation+sector));let direction2=vec2f(cos(rotation+sector*2.0),sin(rotation+sector*2.0));
let primary=eb(pixel,size,current,currentRadius,abs(sizingPosition.z),0u,random,rotation,sector,direction0,direction1,direction2);${secondarySearch}
if(DEBUG_MODE==2){if(!primary.k.v){return vec4f(0.04,0.04,0.04,1);}return vec4f(primary.k.d*0.5+0.5,1.0-clamp(primary.k.x/max(primary.k.r,EPSILON),0.0,1.0),1);}
if(DEBUG_MODE==6){if(!primary.k.v){return vec4f(0.04,0.04,0.04,1);}if(primary.j==REJECTION_NO_CONTINUATION){return vec4f(0.85,0.05,0.7,1);}if(primary.u){return vec4f(1,0.75,0.05,1);}return vec4f(0.1,0.9,0.25,1);}
if(DEBUG_MODE==7){if(!TINY_OBJECT_SAFEGUARD||!primary.k.v){return vec4f(0.04,0.04,0.04,1);}let color=mix(vec3f(1,0.1,0.05),vec3f(0.1,0.65,1),primary.q);return vec4f(select(color*0.45,color,primary.z),1);}
if(DEBUG_MODE==8){if(secondary.v){return vec4f(0.95,0.95,1,1);}if(secondary.k.v){return vec4f(0.8,0.15,0.75,1);}if(primary.v){return vec4f(0.1,0.45,0.95,1);}return vec4f(0.04,0.04,0.04,1);}
if(DEBUG_MODE==4){let ratio=select(0.0,primary.e/max(primary.k.r,EPSILON),primary.k.v);return vec4f(jc(primary.j,ratio),1);}
if(DEBUG_MODE==5){return vec4f(sc(max(primary.h,secondary.h)),1);}
if(!primary.v){if(DEBUG_MODE==3){let c=select(current.c,primary.k.c,primary.k.v);return vec4f(rc(c)*0.25,1);}return select(source,vec4f(0.04,0.04,0.04,1),DEBUG_MODE!=0);}
if(DEBUG_MODE==3){let totalFade=select(primary.fade,min(0.5,primary.fade+secondary.fade),secondary.v);return vec4f(mix(rc(primary.k.c)*0.25,vec3f(1),clamp(totalFade*2.0,0.0,1.0)),1);}
let primaryColor=ec(pixel,size,current,primary);
${worldPositionDebug}
if(DEBUG_MODE==9){let sample=(pixel.x/4)%4;if(sample==0){return vec4f(primaryColor.s.f.rgb,1);}if(sample==1){return vec4f(primaryColor.s.a.rgb,1);}if(sample==2){return vec4f(primaryColor.s.b.rgb,1);}return vec4f(primaryColor.s.t.rgb,1);}
if(DEBUG_MODE==10){return vec4f(1.0-primaryColor.sa,primaryColor.sa,select(0.0,1.0,primaryColor.n),1);}
if(DEBUG_MODE==11){let modeColor=select(vec3f(0.1,0.75,1),vec3f(1,0.4,0.05),${srgbInterpolation});return vec4f(modeColor*mix(0.35,1.0,clamp(primaryColor.f*2.0,0.0,1.0)),1);}
${secondaryBlend}
return primaryColor.b;
}`;
}
