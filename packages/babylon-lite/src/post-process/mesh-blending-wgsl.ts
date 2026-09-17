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
    const baseFields = options.hasBaseColor ? "fartherBaseColor:vec3f,conservativeNearBaseColor:vec3f," : "";
    const baseLoads = options.hasBaseColor
        ? `samples.fartherBaseColor=textureLoad(baseColorTexture,result.targetFarPixel,0).rgb;
let plusOneBase=textureLoad(baseColorTexture,plusOnePixel,0).rgb;
let plusTwoBase=textureLoad(baseColorTexture,plusTwoPixel,0).rgb;`
        : "";
    const baseOnePixel = options.hasBaseColor ? "samples.conservativeNearBaseColor=samples.fartherBaseColor;" : "";
    const baseSelect = options.hasBaseColor ? "samples.conservativeNearBaseColor=select(plusOneBase,plusTwoBase,usePlusTwo);" : "";
    const shadowFunctions = options.hasBaseColor
        ? `fn estimateShadow(rendered:vec3f,base:vec3f)->f32{
let baseLuma=luminance(linearToSrgb(base));
if(baseLuma<=BASE_LUMINANCE_EPSILON){return 1.0;}
return luminance(linearToSrgb(rendered))/baseLuma;
}
fn shadowAttenuation(current:vec3f,samples:MeshBlendTargetColorSamples)->f32{
let difference=abs(estimateShadow(samples.fartherColor.rgb,samples.fartherBaseColor)-estimateShadow(samples.conservativeNearColor.rgb,samples.conservativeNearBaseColor));
let mismatch=smoothstep(SHADOW_DIFFERENCE_LOW,SHADOW_DIFFERENCE_HIGH,difference);
let currentLuma=luminance(linearToSrgb(current));
let targetLuma=luminance(linearToSrgb(samples.targetColor.rgb));
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
    const shadowEvaluate = options.hasBaseColor ? "evaluation.shadowAttenuation=shadowAttenuation(evaluation.currentColor.rgb,evaluation.samples);" : "";
    const worldPositionField = "worldPosition:vec3f,";
    const worldPositionEvaluate = options.debugMode === 12 ? "evaluation.worldPosition=(uniforms.inverseView*vec4f(result.currentViewPosition,1)).xyz;" : "";
    const worldPositionDebug = options.debugMode === 12 ? "return vec4f(fract(primaryColor.worldPosition*0.1),1);" : "";
    const secondarySearch = q.multiTargetSecondaryBlend
        ? `var secondary=invalidResult();
if(primary.valid){secondary=evaluateBlend(pixel,size,current,currentRadius,abs(sizingPosition.z),primary.candidate.targetGroupId,random,rotation,sector,direction0,direction1,direction2);}`
        : "let secondary=invalidResult();";
    const secondaryBlend = q.multiTargetSecondaryBlend
        ? `if(secondary.valid){let secondaryColor=evaluateColor(pixel,size,current,secondary);let totalDistance=max(primary.candidate.distancePixels+secondary.candidate.distancePixels,EPSILON);let primaryWeight=primaryColor.adjustedFade*secondary.candidate.distancePixels/totalDistance;let secondaryWeight=secondaryColor.adjustedFade*primary.candidate.distancePixels/totalDistance;let combined=primaryWeight+secondaryWeight;if(combined<=EPSILON){return source;}return (primaryColor.blendedColor*primaryWeight+secondaryColor.blendedColor*secondaryWeight)/combined;}`
        : "";
    const fullRandomRotation = q.fullRandomRotation ? "true" : "false";
    const fourNeighborFallback = q.immediateFourNeighborFallback ? "true" : "false";
    const tinyObjectSafeguard = q.tinyObjectSafeguard ? "true" : "false";
    const multiTargetSecondaryBlend = q.multiTargetSecondaryBlend ? "true" : "false";
    const srgbInterpolation = q.colorInterpolation === "sRGB" ? "true" : "false";
    const interpolateFunction =
        q.colorInterpolation === "sRGB"
            ? `fn interpolateColor(current:vec3f,targetColor:vec3f,amount:f32)->vec3f{
return srgbToLinear(mix(linearToSrgb(current),linearToSrgb(targetColor),amount));
}`
            : `fn signedCubeRoot(value:f32)->f32{return sign(value)*pow(abs(value),1.0/3.0);}
fn linearToOklab(color:vec3f)->vec3f{
let l=signedCubeRoot(0.4122214708*color.r+0.5363325363*color.g+0.0514459929*color.b);
let m=signedCubeRoot(0.2119034982*color.r+0.6806995451*color.g+0.1073969566*color.b);
let s=signedCubeRoot(0.0883024619*color.r+0.2817188376*color.g+0.6299787005*color.b);
return vec3f(0.2104542553*l+0.7936177850*m-0.0040720468*s,1.9779984951*l-2.4285922050*m+0.4505937099*s,0.0259040371*l+0.7827717662*m-0.8086757660*s);
}
fn oklabToLinear(color:vec3f)->vec3f{
let l_=color.x+0.3963377774*color.y+0.2158037573*color.z;
let m_=color.x-0.1055613458*color.y-0.0638541728*color.z;
let s_=color.x-0.0894841775*color.y-1.2914855480*color.z;
let l=l_*l_*l_;let m=m_*m_*m_;let s=s_*s_*s_;
return vec3f(4.0767416621*l-3.3077115913*m+0.2309699292*s,-1.2684380046*l+2.6097574011*m-0.3413193965*s,-0.0041960863*l-0.7034186147*m+1.7076147010*s);
}
fn interpolateColor(current:vec3f,targetColor:vec3f,amount:f32)->vec3f{return oklabToLinear(mix(linearToOklab(current),linearToOklab(targetColor),amount));}`;

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
struct MeshBlendTag{groupId:u32,radiusClass:u32}
struct MeshBlendCandidate{targetGroupId:u32,radiusClass:u32,direction:vec2f,distancePixels:f32,searchRadiusPixels:f32,score:f32,valid:bool}
struct MeshBlendResult{candidate:MeshBlendCandidate,targetPixel:vec2i,targetFarPixel:vec2i,currentViewPosition:vec3f,effectiveRadiusPixels:f32,fade:f32,tinyObjectRadiusRatio:f32,rejectionReason:i32,stageReached:i32,valid:bool,continuationFound:bool,usedFallback:bool,tinyObjectRadiusReduced:bool}
struct MeshBlendTargetColorSamples{fartherColor:vec4f,boundaryPlusOneColor:vec4f,boundaryPlusTwoColor:vec4f,conservativeNearColor:vec4f,targetColor:vec4f,${baseFields}onePixelEdge:bool}
struct MeshBlendColorEvaluation{samples:MeshBlendTargetColorSamples,currentColor:vec4f,blendedColor:vec4f,${worldPositionField}shadowAttenuation:f32,adjustedFade:f32,nearSeamCorrected:bool}
fn clampPixel(pixel:vec2i,size:vec2i)->vec2i{return clamp(pixel,vec2i(0),size-vec2i(1));}
fn pixelInBounds(pixel:vec2i,size:vec2i)->bool{return pixel.x>=0&&pixel.y>=0&&pixel.x<size.x&&pixel.y<size.y;}
fn pixelUv(pixel:vec2i,size:vec2i)->vec2f{return (vec2f(clampPixel(pixel,size))+vec2f(0.5))/vec2f(size);}
fn loadTag(pixel:vec2i,size:vec2i)->MeshBlendTag{let packed=textureLoad(tagTexture,clampPixel(pixel,size),0).r;return MeshBlendTag(packed&0x3fu,packed>>6u);}
fn loadDepth(pixel:vec2i,size:vec2i)->f32{return textureLoad(depthTexture,clampPixel(pixel,size),0).r;}
fn classValue(values:vec4f,index:u32)->f32{if(index==0u){return values.x;}if(index==1u){return values.y;}if(index==2u){return values.z;}return values.w;}
fn depthToNdc(depth:f32)->f32{if(DEPTH_TYPE==1){return depth;}let clip=uniforms.projection*vec4f(0,0,depth,1);return clip.z/clip.w;}
fn reconstructViewPosition(pixel:vec2i,size:vec2i,depth:f32)->vec3f{
let uv=pixelUv(pixel,size);let ndcXY=vec2f(uv.x*2.0-1.0,1.0-uv.y*2.0);
let view=uniforms.inverseProjection*vec4f(ndcXY,depthToNdc(depth),1);return view.xyz/view.w;
}
fn finiteValue(value:f32)->bool{return (bitcast<u32>(value)&0x7f800000u)!=0x7f800000u;}
fn validPosition(value:vec3f)->bool{return finiteValue(value.x)&&finiteValue(value.y)&&finiteValue(value.z);}
fn projectionScale(renderHeight:f32)->f32{return max(0.5*renderHeight*abs(uniforms.projection[1][1]),EPSILON);}
fn radiusForClass(radiusClass:u32,viewDepth:f32,renderHeight:f32)->f32{
let scale=projectionScale(renderHeight);var projected=classValue(uniforms.worldRadii,radiusClass)*scale;
if(uniforms.flags.x<0.5){projected/=max(viewDepth,EPSILON);}
let scaled=max(projected,classValue(uniforms.minimumProjectedRadii,radiusClass))*RADIUS_SCALE;
return select(0.0,max(1.0,scaled),scaled>0.0);
}
fn worldUnitsPerPixel(viewDepth:f32,renderHeight:f32)->f32{let units=1.0/projectionScale(renderHeight);return select(units*max(viewDepth,EPSILON),units,uniforms.flags.x>0.5);}
fn slopeScale(oppositeFacing:f32)->f32{if(uniforms.flags.y<=1.0){return 1.0;}return MIN_SLOPE_SCALE+(1.0-MIN_SLOPE_SCALE)*pow(clamp(oppositeFacing,0.0,1.0),uniforms.flags.y-1.0);}
fn algorithmPixel(pixel:vec2i,size:vec2i)->vec2i{return vec2i(pixel.x,size.y-1-pixel.y);}
fn pixelOffset(direction:vec2f,distancePixels:f32)->vec2i{return vec2i(round(vec2f(direction.x,-direction.y)*distancePixels));}
fn loadNoise(pixel:vec2i,renderSize:vec2i)->vec2f{let noiseSize=vec2i(textureDimensions(blueNoiseTexture,0));let noisePixel=algorithmPixel(pixel,renderSize);let wrapped=vec2i(noisePixel.x%noiseSize.x,noisePixel.y%noiseSize.y);return textureLoad(blueNoiseTexture,wrapped,0).rg;}
fn directionAt(index:i32,rotation:f32,sector:f32,direction0:vec2f,direction1:vec2f,direction2:vec2f)->vec2f{if(DIRECTION_COUNT==3){if(index==0){return direction0;}if(index==1){return direction1;}return direction2;}let angle=rotation+sector*f32(index);return vec2f(cos(angle),sin(angle));}
fn invalidCandidate()->MeshBlendCandidate{return MeshBlendCandidate(0u,0u,vec2f(0),0,0,-1.0,false);}
fn invalidResult()->MeshBlendResult{return MeshBlendResult(invalidCandidate(),vec2i(0),vec2i(0),vec3f(0),0,0,1.0,REJECTION_NO_CANDIDATE,1,false,false,false,false);}
fn findCandidate(pixel:vec2i,size:vec2i,current:MeshBlendTag,currentRadius:f32,viewDepth:f32,ignoredGroup:u32,random:vec2f,rotation:f32,sector:f32,direction0:vec2f,direction1:vec2f,direction2:vec2f)->MeshBlendCandidate{
var best=invalidCandidate();let jitter=mix(0.5,random.y,JITTER_FACTOR);
for(var radial=0;radial<RADIAL_SAMPLE_COUNT;radial++){
let normalized=(f32(radial)+jitter)/f32(RADIAL_SAMPLE_COUNT);let distancePixels=max(1.0,ceil(normalized*normalized*normalized*currentRadius));
for(var directionIndex=0;directionIndex<DIRECTION_COUNT;directionIndex++){
let direction=directionAt(directionIndex,rotation,sector,direction0,direction1,direction2);let sampled=loadTag(pixel+pixelOffset(direction,distancePixels),size);
if(sampled.groupId==0u||sampled.groupId==current.groupId||sampled.groupId==ignoredGroup){continue;}
let radiusClass=min(current.radiusClass,sampled.radiusClass);let radius=radiusForClass(radiusClass,viewDepth,f32(size.y));
if(distancePixels>radius){continue;}let score=1.0-clamp(distancePixels/max(radius,EPSILON),0.0,1.0);
if(score>best.score){best=MeshBlendCandidate(sampled.groupId,radiusClass,direction,distancePixels,radius,score,true);}
}
if(best.valid){break;}
}
return best;
}
fn refineDirection(pixel:vec2i,size:vec2i,input:MeshBlendCandidate,random:vec2f)->MeshBlendCandidate{
var candidate=input;if(candidate.distancePixels<=2.0){return candidate;}
let center=atan2(candidate.direction.y,candidate.direction.x);let halfWidth=(TWO_PI/f32(DIRECTION_COUNT))*REFINEMENT_SECTOR_SCALE;
let stepSize=max(1.0,candidate.distancePixels/f32(REFINEMENT_STEP_COUNT+1));
for(var sample=0;sample<REFINEMENT_SAMPLE_COUNT;sample++){
let sampleRandom=fract(random.y+random.x*0.754877666+f32(sample)*0.618033989);let angle=center+mix(-halfWidth,halfWidth,sampleRandom);let direction=vec2f(cos(angle),sin(angle));
var distancePixels=candidate.distancePixels-stepSize;
for(var step=0;step<REFINEMENT_STEP_COUNT;step++){if(distancePixels<=0.0){break;}if(loadTag(pixel+pixelOffset(direction,distancePixels),size).groupId!=candidate.targetGroupId){break;}candidate.direction=direction;candidate.distancePixels=distancePixels;distancePixels-=stepSize;}
}
return candidate;
}
fn refineBoundary(pixel:vec2i,size:vec2i,input:MeshBlendCandidate)->MeshBlendCandidate{
var candidate=input;var distancePixels=candidate.distancePixels;
for(var sample=0;sample<EXACT_EDGE_SAMPLE_COUNT;sample++){distancePixels-=1.0;if(distancePixels<=0.0){break;}if(loadTag(pixel+pixelOffset(candidate.direction,distancePixels),size).groupId!=candidate.targetGroupId){break;}candidate.distancePixels=distancePixels;}
return candidate;
}
fn continuation(pixel:vec2i,size:vec2i,candidate:MeshBlendCandidate,outPixel:ptr<function,vec2i>)->bool{
let distancePixels=max(candidate.distancePixels*2.0,candidate.distancePixels+1.0);*outPixel=pixel+pixelOffset(candidate.direction,distancePixels);
return pixelInBounds(*outPixel,size)&&loadTag(*outPixel,size).groupId==candidate.targetGroupId;
}
fn tightenRadius(targetPixel:vec2i,size:vec2i,viewDepth:f32,candidate:ptr<function,MeshBlendCandidate>)->bool{
(*candidate).radiusClass=min((*candidate).radiusClass,loadTag(targetPixel,size).radiusClass);
(*candidate).searchRadiusPixels=min((*candidate).searchRadiusPixels,radiusForClass((*candidate).radiusClass,viewDepth,f32(size.y)));
return (*candidate).distancePixels<=(*candidate).searchRadiusPixels;
}
fn neighborFallback(pixel:vec2i,size:vec2i,current:MeshBlendTag,viewDepth:f32,ignoredGroup:u32,preferredGroup:u32)->MeshBlendCandidate{
var best=invalidCandidate();
for(var index=0;index<4;index++){var offset:vec2i;if(index==0){offset=vec2i(1,0);}else if(index==1){offset=vec2i(-1,0);}else if(index==2){offset=vec2i(0,1);}else{offset=vec2i(0,-1);}
let tag=loadTag(pixel+pixelOffset(vec2f(offset),1.0),size);if(tag.groupId==0u||tag.groupId==current.groupId||tag.groupId==ignoredGroup){continue;}
let radiusClass=min(current.radiusClass,tag.radiusClass);let radius=radiusForClass(radiusClass,viewDepth,f32(size.y));if(radius<1.0){continue;}
var score=1.0-1.0/max(radius,1.0);if(tag.groupId==preferredGroup){score+=1.0;}if(score>best.score){best=MeshBlendCandidate(tag.groupId,radiusClass,vec2f(offset),1.0,radius,score,true);}
}
return best;
}
fn tinyObjectRadius(pixel:vec2i,size:vec2i,current:MeshBlendTag,candidate:MeshBlendCandidate,reduced:ptr<function,bool>)->f32{
var thickness=candidate.searchRadiusPixels;var oppositeBoundary=false;
for(var probe=1;probe<=TINY_OBJECT_PROBE_COUNT;probe++){let distancePixels=max(1.0,candidate.searchRadiusPixels*f32(probe)/f32(TINY_OBJECT_PROBE_COUNT));if(loadTag(pixel-pixelOffset(candidate.direction,distancePixels),size).groupId!=current.groupId){thickness=distancePixels;oppositeBoundary=true;break;}}
var outside=0;for(var index=0;index<4;index++){var direction:vec2f;if(index==0){direction=vec2f(1,0);}else if(index==1){direction=vec2f(-1,0);}else if(index==2){direction=vec2f(0,1);}else{direction=vec2f(0,-1);}if(loadTag(pixel+pixelOffset(direction,candidate.searchRadiusPixels),size).groupId!=current.groupId){outside++;}}
*reduced=oppositeBoundary&&outside>=3;if(!*reduced){return candidate.searchRadiusPixels;}return max(candidate.distancePixels,min(candidate.searchRadiusPixels,max(1.0,thickness*1.25)));
}
fn validateContact(a:vec2i,e:vec2i,b:vec2i,c:vec2i,size:vec2i,current:MeshBlendTag,candidate:MeshBlendCandidate,allowMissingContinuation:bool,narrowed:ptr<function,f32>,currentPosition:ptr<function,vec3f>)->i32{
*currentPosition=vec3f(0);let tagE=loadTag(e,size);let tagB=loadTag(b,size);let tagC=loadTag(c,size);
if(tagE.groupId!=current.groupId||tagB.groupId!=candidate.targetGroupId||(!allowMissingContinuation&&tagC.groupId!=candidate.targetGroupId)){return REJECTION_NO_CONTINUATION;}
let pa=reconstructViewPosition(a,size,loadDepth(a,size));let pe=reconstructViewPosition(e,size,loadDepth(e,size));let pb=reconstructViewPosition(b,size,loadDepth(b,size));let pc=reconstructViewPosition(c,size,loadDepth(c,size));
if(!validPosition(pa)||!validPosition(pe)||!validPosition(pb)||!validPosition(pc)){return REJECTION_INVALID_DEPTH;}*currentPosition=pa;
let units=worldUnitsPerPixel(abs(pa.z),f32(size.y));let radius=candidate.searchRadiusPixels*units;let tolerance=BOUNDARY_PIXEL_TOLERANCE*units;let boundary=pb-pe;
if(length(boundary)>BOUNDARY_SEPARATION_FACTOR*radius+tolerance){return REJECTION_DEPTH_SEPARATION;}
let depthDelta=abs(abs(pb.z)-abs(pe.z));if(depthDelta>max(FOREGROUND_DEPTH_FACTOR*radius,tolerance)&&depthDelta>FOREGROUND_LATERAL_FACTOR*length(boundary.xy)){return REJECTION_FOREGROUND_BACKGROUND;}
if(distance(pb,pc)>TARGET_SPAN_FACTOR*radius+tolerance||distance(pa,pc)>TOTAL_SPAN_FACTOR*radius+tolerance){return REJECTION_PHYSICAL_SPAN;}
let currentDirection=pa-pb;let targetDirection=pc-pb;let currentLength=length(currentDirection);let targetLength=length(targetDirection);var oppositeFacing=1.0;
if(currentLength>EPSILON&&targetLength>EPSILON){oppositeFacing=-dot(currentDirection/currentLength,targetDirection/targetLength);}
*narrowed=candidate.searchRadiusPixels*slopeScale(oppositeFacing);if(candidate.distancePixels>*narrowed){return REJECTION_CONTACT_ANGLE;}return REJECTION_NONE;
}
fn calculateFade(distancePixels:f32,radius:f32)->f32{let normalized=clamp(max(distancePixels-0.5,0.0)/max(radius,EPSILON),0.0,1.0);let inverse=1.0-normalized;return mix(inverse*inverse,inverse,clamp(inverse-0.75,0.0,1.0))*0.5;}
fn evaluateBlend(pixel:vec2i,size:vec2i,current:MeshBlendTag,currentRadius:f32,viewDepth:f32,ignoredGroup:u32,random:vec2f,rotation:f32,sector:f32,direction0:vec2f,direction1:vec2f,direction2:vec2f)->MeshBlendResult{
var result=invalidResult();var candidate=findCandidate(pixel,size,current,currentRadius,viewDepth,ignoredGroup,random,rotation,sector,direction0,direction1,direction2);result.candidate=candidate;if(!candidate.valid){return result;}
result.stageReached=2;candidate=refineBoundary(pixel,size,refineDirection(pixel,size,candidate,random));result.candidate=candidate;result.stageReached=3;
let targetPixel=clampPixel(pixel+pixelOffset(candidate.direction,candidate.distancePixels),size);if(!tightenRadius(targetPixel,size,viewDepth,&candidate)){result.candidate=candidate;result.rejectionReason=REJECTION_PHYSICAL_SPAN;return result;}
var farPixel:vec2i;var foundContinuation=continuation(pixel,size,candidate,&farPixel);
if(!foundContinuation){if(!FOUR_NEIGHBOR_FALLBACK){result.candidate=candidate;result.rejectionReason=REJECTION_NO_CONTINUATION;return result;}let fallback=neighborFallback(pixel,size,current,viewDepth,ignoredGroup,candidate.targetGroupId);if(!fallback.valid){result.candidate=candidate;result.rejectionReason=REJECTION_NO_CONTINUATION;return result;}candidate=fallback;result.usedFallback=true;foundContinuation=continuation(pixel,size,candidate,&farPixel);}
result.continuationFound=foundContinuation;result.stageReached=4;if(foundContinuation&&!tightenRadius(farPixel,size,viewDepth,&candidate)){result.candidate=candidate;result.rejectionReason=REJECTION_PHYSICAL_SPAN;return result;}
let originalRadius=candidate.searchRadiusPixels;var reduced=false;if(TINY_OBJECT_SAFEGUARD){candidate.searchRadiusPixels=tinyObjectRadius(pixel,size,current,candidate,&reduced);result.stageReached=5;}result.tinyObjectRadiusReduced=reduced;
result.candidate=candidate;result.effectiveRadiusPixels=candidate.searchRadiusPixels;result.tinyObjectRadiusRatio=candidate.searchRadiusPixels/max(originalRadius,EPSILON);
let b=clampPixel(pixel+pixelOffset(candidate.direction,candidate.distancePixels),size);let e=clampPixel(pixel+pixelOffset(candidate.direction,max(candidate.distancePixels-2.0,0.0)),size);var c=b;if(foundContinuation){c=farPixel;}
var narrowed=candidate.searchRadiusPixels;var currentPosition=vec3f(0);result.rejectionReason=validateContact(pixel,e,b,c,size,current,candidate,result.usedFallback&&!foundContinuation,&narrowed,&currentPosition);
result.currentViewPosition=currentPosition;result.stageReached=6;result.effectiveRadiusPixels=narrowed;if(result.rejectionReason!=REJECTION_NONE){return result;}
result.fade=calculateFade(candidate.distancePixels,narrowed);if(result.fade<=0.0){result.rejectionReason=REJECTION_PHYSICAL_SPAN;return result;}
result.targetPixel=b;result.targetFarPixel=select(b,farPixel,foundContinuation);result.stageReached=7;result.valid=true;return result;
}
fn linearToSrgbChannel(value:f32)->f32{if(value<=0.0031308){return value*12.92;}return 1.055*pow(value,1.0/2.4)-0.055;}
fn srgbToLinearChannel(value:f32)->f32{if(value<=0.04045){return value/12.92;}return pow((value+0.055)/1.055,2.4);}
fn linearToSrgb(color:vec3f)->vec3f{return vec3f(linearToSrgbChannel(color.r),linearToSrgbChannel(color.g),linearToSrgbChannel(color.b));}
fn srgbToLinear(color:vec3f)->vec3f{return vec3f(srgbToLinearChannel(color.r),srgbToLinearChannel(color.g),srgbToLinearChannel(color.b));}
${interpolateFunction}
fn luminance(color:vec3f)->f32{return dot(color,vec3f(0.2126,0.7152,0.0722));}
fn targetSamples(size:vec2i,result:MeshBlendResult)->MeshBlendTargetColorSamples{
var samples:MeshBlendTargetColorSamples;let plusOnePixel=clampPixel(result.targetPixel+pixelOffset(result.candidate.direction,1.0),size);let plusTwoPixel=clampPixel(result.targetPixel+pixelOffset(result.candidate.direction,2.0),size);
let plusOneTag=loadTag(plusOnePixel,size);let plusTwoTag=loadTag(plusTwoPixel,size);samples.fartherColor=textureLoad(sourceTexture,result.targetFarPixel,0);samples.boundaryPlusOneColor=textureLoad(sourceTexture,plusOnePixel,0);samples.boundaryPlusTwoColor=textureLoad(sourceTexture,plusTwoPixel,0);
${baseLoads}
samples.onePixelEdge=plusOneTag.groupId!=result.candidate.targetGroupId;if(samples.onePixelEdge){samples.conservativeNearColor=samples.fartherColor;${baseOnePixel}samples.targetColor=samples.fartherColor;return samples;}
let usePlusTwo=plusTwoTag.groupId==result.candidate.targetGroupId&&luminance(linearToSrgb(samples.boundaryPlusTwoColor.rgb))<luminance(linearToSrgb(samples.boundaryPlusOneColor.rgb));
samples.conservativeNearColor=select(samples.boundaryPlusOneColor,samples.boundaryPlusTwoColor,usePlusTwo);${baseSelect}
samples.targetColor=mix(samples.fartherColor,samples.conservativeNearColor,NEAR_EDGE_TARGET_WEIGHT);return samples;
}
fn nearSeamColor(pixel:vec2i,size:vec2i,current:MeshBlendTag,result:MeshBlendResult,samples:MeshBlendTargetColorSamples,currentColor:vec4f,corrected:ptr<function,bool>)->vec4f{
*corrected=false;if(!samples.onePixelEdge||result.candidate.distancePixels>NEAR_SEAM_MAX_DISTANCE){return currentColor;}
let oppositePixel=clampPixel(pixel-pixelOffset(result.candidate.direction,1.0),size);if(loadTag(oppositePixel,size).groupId!=current.groupId){return currentColor;}
let oppositeColor=textureLoad(sourceTexture,oppositePixel,0);if(distance(currentColor.rgb,samples.targetColor.rgb)+NEAR_SEAM_COLOR_DELTA>=distance(oppositeColor.rgb,samples.targetColor.rgb)){return currentColor;}*corrected=true;return oppositeColor;
}
${shadowFunctions}
fn evaluateColor(pixel:vec2i,size:vec2i,current:MeshBlendTag,result:MeshBlendResult)->MeshBlendColorEvaluation{
var evaluation:MeshBlendColorEvaluation;evaluation.samples=targetSamples(size,result);${worldPositionEvaluate}
var corrected=false;evaluation.currentColor=nearSeamColor(pixel,size,current,result,evaluation.samples,textureLoad(sourceTexture,pixel,0),&corrected);evaluation.nearSeamCorrected=corrected;evaluation.shadowAttenuation=1.0;${shadowEvaluate}
evaluation.adjustedFade=result.fade*evaluation.shadowAttenuation;evaluation.blendedColor=vec4f(interpolateColor(evaluation.currentColor.rgb,evaluation.samples.targetColor.rgb,evaluation.adjustedFade),mix(evaluation.currentColor.a,evaluation.samples.targetColor.a,evaluation.adjustedFade));return evaluation;
}
fn radiusColor(radiusClass:u32)->vec3f{if(radiusClass==0u){return vec3f(0.15,0.55,1.0);}if(radiusClass==1u){return vec3f(0.15,0.9,0.35);}if(radiusClass==2u){return vec3f(1.0,0.65,0.1);}return vec3f(0.95,0.2,0.65);}
fn rejectionColor(reason:i32,ratio:f32)->vec3f{if(reason==REJECTION_NONE){return mix(vec3f(0.1,0.55,1),vec3f(0.2,1,0.25),ratio);}if(reason==REJECTION_NO_CANDIDATE){return vec3f(0.12);}if(reason==REJECTION_NO_CONTINUATION){return vec3f(0.75,0.1,0.85);}if(reason==REJECTION_INVALID_DEPTH){return vec3f(1,0,1);}if(reason==REJECTION_DEPTH_SEPARATION){return vec3f(1,0.1,0.1);}if(reason==REJECTION_FOREGROUND_BACKGROUND){return vec3f(1,0.4,0.05);}if(reason==REJECTION_PHYSICAL_SPAN){return vec3f(1,0.9,0.05);}return vec3f(0.05,0.8,1);}
fn stageColor(stage:i32)->vec3f{if(stage<=0){return vec3f(0.03);}if(stage==1){return vec3f(0.1,0.15,0.45);}if(stage==2){return vec3f(0.1,0.35,0.7);}if(stage==3){return vec3f(0.05,0.65,0.8);}if(stage==4){return vec3f(0.1,0.8,0.55);}if(stage==5){return vec3f(0.45,0.9,0.25);}if(stage==6){return vec3f(0.95,0.75,0.1);}return vec3f(0.15,1,0.25);}
@fragment fn meshBlendFragment(input:VertexOutput)->@location(0) vec4f{
let size=vec2i(textureDimensions(depthTexture,0));let pixel=clamp(vec2i(floor(input.uv*vec2f(size))),vec2i(0),size-vec2i(1));let source=textureLoad(sourceTexture,pixel,0);
if(uniforms.flags.z<0.5){return source;}
let current=loadTag(pixel,size);if(DEBUG_MODE==1){if(current.groupId==0u){return vec4f(0,0,0,1);}return vec4f(radiusColor(current.radiusClass)*(0.45+0.55*fract(f32(current.groupId)*0.61803398875)),1);}
if(current.groupId==0u){if(DEBUG_MODE==3){return vec4f(0,0,0,1);}return select(source,vec4f(0.04,0.04,0.04,1),DEBUG_MODE!=0);}
let sizingPosition=reconstructViewPosition(pixel,size,loadDepth(pixel,size));if(!validPosition(sizingPosition)){if(DEBUG_MODE==4){return vec4f(rejectionColor(REJECTION_INVALID_DEPTH,0),1);}if(DEBUG_MODE==5){return vec4f(0.45,0.1,0.1,1);}return select(source,vec4f(0.04,0.04,0.04,1),DEBUG_MODE!=0);}
let currentRadius=radiusForClass(current.radiusClass,abs(sizingPosition.z),f32(size.y));if(currentRadius<1.0){if(DEBUG_MODE==3){return vec4f(radiusColor(current.radiusClass)*0.25,1);}if(DEBUG_MODE==4){return vec4f(rejectionColor(REJECTION_PHYSICAL_SPAN,0),1);}if(DEBUG_MODE==5){return vec4f(0.2,0.2,0.65,1);}return select(source,vec4f(0.04,0.04,0.04,1),DEBUG_MODE!=0);}
let random=loadNoise(pixel,size);let sector=TWO_PI/f32(DIRECTION_COUNT);let rotation=select(floor(random.x*8.0)*0.125*sector,random.x*sector,FULL_RANDOM_ROTATION);
let direction0=vec2f(cos(rotation),sin(rotation));let direction1=vec2f(cos(rotation+sector),sin(rotation+sector));let direction2=vec2f(cos(rotation+sector*2.0),sin(rotation+sector*2.0));
let primary=evaluateBlend(pixel,size,current,currentRadius,abs(sizingPosition.z),0u,random,rotation,sector,direction0,direction1,direction2);${secondarySearch}
if(DEBUG_MODE==2){if(!primary.candidate.valid){return vec4f(0.04,0.04,0.04,1);}return vec4f(primary.candidate.direction*0.5+0.5,1.0-clamp(primary.candidate.distancePixels/max(primary.candidate.searchRadiusPixels,EPSILON),0.0,1.0),1);}
if(DEBUG_MODE==6){if(!primary.candidate.valid){return vec4f(0.04,0.04,0.04,1);}if(primary.rejectionReason==REJECTION_NO_CONTINUATION){return vec4f(0.85,0.05,0.7,1);}if(primary.usedFallback){return vec4f(1,0.75,0.05,1);}return vec4f(0.1,0.9,0.25,1);}
if(DEBUG_MODE==7){if(!TINY_OBJECT_SAFEGUARD||!primary.candidate.valid){return vec4f(0.04,0.04,0.04,1);}let color=mix(vec3f(1,0.1,0.05),vec3f(0.1,0.65,1),primary.tinyObjectRadiusRatio);return vec4f(select(color*0.45,color,primary.tinyObjectRadiusReduced),1);}
if(DEBUG_MODE==8){if(secondary.valid){return vec4f(0.95,0.95,1,1);}if(secondary.candidate.valid){return vec4f(0.8,0.15,0.75,1);}if(primary.valid){return vec4f(0.1,0.45,0.95,1);}return vec4f(0.04,0.04,0.04,1);}
if(DEBUG_MODE==4){let ratio=select(0.0,primary.effectiveRadiusPixels/max(primary.candidate.searchRadiusPixels,EPSILON),primary.candidate.valid);return vec4f(rejectionColor(primary.rejectionReason,ratio),1);}
if(DEBUG_MODE==5){return vec4f(stageColor(max(primary.stageReached,secondary.stageReached)),1);}
if(!primary.valid){if(DEBUG_MODE==3){let radiusClass=select(current.radiusClass,primary.candidate.radiusClass,primary.candidate.valid);return vec4f(radiusColor(radiusClass)*0.25,1);}return select(source,vec4f(0.04,0.04,0.04,1),DEBUG_MODE!=0);}
if(DEBUG_MODE==3){let totalFade=select(primary.fade,min(0.5,primary.fade+secondary.fade),secondary.valid);return vec4f(mix(radiusColor(primary.candidate.radiusClass)*0.25,vec3f(1),clamp(totalFade*2.0,0.0,1.0)),1);}
let primaryColor=evaluateColor(pixel,size,current,primary);
${worldPositionDebug}
if(DEBUG_MODE==9){let sample=(pixel.x/4)%4;if(sample==0){return vec4f(primaryColor.samples.fartherColor.rgb,1);}if(sample==1){return vec4f(primaryColor.samples.boundaryPlusOneColor.rgb,1);}if(sample==2){return vec4f(primaryColor.samples.boundaryPlusTwoColor.rgb,1);}return vec4f(primaryColor.samples.targetColor.rgb,1);}
if(DEBUG_MODE==10){return vec4f(1.0-primaryColor.shadowAttenuation,primaryColor.shadowAttenuation,select(0.0,1.0,primaryColor.nearSeamCorrected),1);}
if(DEBUG_MODE==11){let modeColor=select(vec3f(0.1,0.75,1),vec3f(1,0.4,0.05),${srgbInterpolation});return vec4f(modeColor*mix(0.35,1.0,clamp(primaryColor.adjustedFade*2.0,0.0,1.0)),1);}
${secondaryBlend}
return primaryColor.blendedColor;
}`;
}
