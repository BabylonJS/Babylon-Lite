/**
 * Opt-in per-material environment overrides and box-projected local image-based lighting.
 *
 * This module is reachable only through enablePbrLocalCubemap(). It patches the
 * ordinary scene-IBL shader when one exists and supplies a complete local IBL
 * fragment when the scene has no global environment.
 */

import type { ComposedShader, ShaderFragment, UboField } from "../../../shader/fragment-types.js";
import { BU } from "../../../engine/gpu-flags.js";
import { createMappedBuffer, createUniformBuffer } from "../../../resource/gpu-buffers.js";
import type { PbrExt, _PbrBindCtx } from "../pbr-flags.js";
import { PBR_HAS_SKYBOX, PBR2_ESM_SHADOW_OUTPUT, PBR2_NO_COLOR_OUTPUT } from "../pbr-flag-bits.js";
import { _getPbrLocalEnvironment, type PbrLocalEnvironmentState } from "../pbr-local-cubemap-state.js";
import {
    _PBR_LOCAL_ENVIRONMENT_DEBUG_COLOR_FLAG,
    _PBR_LOCAL_ENVIRONMENT_PARALLAX_FLAG,
    _PBR_LOCAL_ENVIRONMENT_SPHERE_FLAG,
    MAX_PBR_LOCAL_ENVIRONMENT_CANDIDATES,
    MAX_PBR_LOCAL_ENVIRONMENT_PROBES,
} from "../pbr-local-cubemap-limits.js";

const PBR_HAS_LOCAL_ENVIRONMENT = 1 << 31;
const STAGE_FRAGMENT = 0x2;
const LOCAL_ENVIRONMENT_OVERRIDE_MODE = 1;
const LOCAL_ENVIRONMENT_BOX_MODE = 2;
const LOCAL_ENVIRONMENT_SPHERE_MODE = 3;
const LOCAL_ENVIRONMENT_PROBES_MODE = 4;

const LOCAL_SH_FIELDS = [
    "localSphericalL00",
    "localSphericalL1_1",
    "localSphericalL10",
    "localSphericalL11",
    "localSphericalL2_2",
    "localSphericalL2_1",
    "localSphericalL20",
    "localSphericalL21",
    "localSphericalL22",
] as const;

const LOCAL_SH_UBO_FIELDS: readonly UboField[] = LOCAL_SH_FIELDS.map((_name) => ({ _name, _type: "vec3<f32>" }));

const SINGLE_CUBEMAP_HELPERS = `fn parallaxCorrectBoxNormal(vertexPos:vec3f,origVec:vec3f,cubeSize:vec3f,cubePos:vec3f,capturePos:vec3f)->vec3f{
let invOrigVec=vec3f(1.0)/origVec;
let halfSize=cubeSize*0.5;
let intersecAtMaxPlane=(cubePos+halfSize-vertexPos)*invOrigVec;
let intersecAtMinPlane=(cubePos-halfSize-vertexPos)*invOrigVec;
let largestIntersec=max(intersecAtMaxPlane,intersecAtMinPlane);
let distance=min(min(largestIntersec.x,largestIntersec.y),largestIntersec.z);
return vertexPos+origVec*distance-capturePos;
}
fn parallaxCorrectSphereNormal(vertexPos:vec3f,origVec:vec3f,sphereSize:vec3f,spherePos:vec3f,capturePos:vec3f)->vec3f{
let localPos=vertexPos-spherePos;
let a=dot(origVec,origVec);
let b=dot(localPos,origVec);
let radius=sphereSize.x*0.5;
let c=dot(localPos,localPos)-radius*radius;
let determinant=b*b-a*c;
if(determinant<0.0){return origVec;}
let distance=(-b+sqrt(determinant))/max(a,0.00001);
if(distance<=0.0){return origVec;}
return vertexPos+origVec*distance-capturePos;
}
fn localSingleReflectionDirection(vertexPos:vec3f,origVec:vec3f,mode:f32,projectionSize:vec3f,projectionPosition:vec3f,capturePosition:vec3f)->vec3f{
if(mode==${LOCAL_ENVIRONMENT_BOX_MODE}.0){return parallaxCorrectBoxNormal(vertexPos,origVec,projectionSize,projectionPosition,capturePosition);}
if(mode==${LOCAL_ENVIRONMENT_SPHERE_MODE}.0){return parallaxCorrectSphereNormal(vertexPos,origVec,projectionSize,projectionPosition,capturePosition);}
return origVec;
}`;

const IBL_SCENE_IRRADIANCE = `let environmentIrradiance = (scene.vSphericalL00.rgb
  + scene.vSphericalL1_1.rgb * N_env.y + scene.vSphericalL10.rgb * N_env.z + scene.vSphericalL11.rgb * N_env.x
  + scene.vSphericalL2_2.rgb * (N_env.y * N_env.x) + scene.vSphericalL2_1.rgb * (N_env.y * N_env.z)
  + scene.vSphericalL20.rgb * (3.0 * N_env.z * N_env.z - 1.0) + scene.vSphericalL21.rgb * (N_env.z * N_env.x)
  + scene.vSphericalL22.rgb * (N_env.x * N_env.x - N_env.y * N_env.y)) * material.environmentIntensity;`;

const IBL_SCENE_OR_LOCAL_IRRADIANCE = `let sceneEnvironmentIrradiance = (scene.vSphericalL00.rgb
  + scene.vSphericalL1_1.rgb * N_env.y + scene.vSphericalL10.rgb * N_env.z + scene.vSphericalL11.rgb * N_env.x
  + scene.vSphericalL2_2.rgb * (N_env.y * N_env.x) + scene.vSphericalL2_1.rgb * (N_env.y * N_env.z)
  + scene.vSphericalL20.rgb * (3.0 * N_env.z * N_env.z - 1.0) + scene.vSphericalL21.rgb * (N_env.z * N_env.x)
  + scene.vSphericalL22.rgb * (N_env.x * N_env.x - N_env.y * N_env.y)) * material.environmentIntensity;
let localEnvironmentIrradiance = (material.localSphericalL00.rgb
  + material.localSphericalL1_1.rgb * N_env.y + material.localSphericalL10.rgb * N_env.z + material.localSphericalL11.rgb * N_env.x
  + material.localSphericalL2_2.rgb * (N_env.y * N_env.x) + material.localSphericalL2_1.rgb * (N_env.y * N_env.z)
  + material.localSphericalL20.rgb * (3.0 * N_env.z * N_env.z - 1.0) + material.localSphericalL21.rgb * (N_env.z * N_env.x)
  + material.localSphericalL22.rgb * (N_env.x * N_env.x - N_env.y * N_env.y)) * material.environmentIntensity;
let environmentIrradiance=select(localEnvironmentIrradiance,sceneEnvironmentIrradiance,material.localEnvironmentMode==${LOCAL_ENVIRONMENT_PROBES_MODE}.0);`;

const IBL_LOCAL_IRRADIANCE = `let environmentIrradiance = (material.localSphericalL00.rgb
  + material.localSphericalL1_1.rgb * N_env.y + material.localSphericalL10.rgb * N_env.z + material.localSphericalL11.rgb * N_env.x
  + material.localSphericalL2_2.rgb * (N_env.y * N_env.x) + material.localSphericalL2_1.rgb * (N_env.y * N_env.z)
  + material.localSphericalL20.rgb * (3.0 * N_env.z * N_env.z - 1.0) + material.localSphericalL21.rgb * (N_env.z * N_env.x)
  + material.localSphericalL22.rgb * (N_env.x * N_env.x - N_env.y * N_env.y)) * material.environmentIntensity;`;

function createProbeArrayHelpers(): string {
    return `struct LocalEnvironmentProbe{
projectionCentreAndLayer:vec4f,
projectionHalfSizeAndLodScale:vec4f,
capturePositionAndLodBias:vec4f,
influenceCentreAndCos:vec4f,
influenceInnerHalfSizeAndSin:vec4f,
influenceOuterCentre:vec4f,
influenceOuterHalfSize:vec4f,
}
struct localProbeDataUniforms{
params:vec4u,
probes:array<LocalEnvironmentProbe,${MAX_PBR_LOCAL_ENVIRONMENT_PROBES}>,
}
struct localProbeGridUniforms{
minimumAndInverseCellSize:vec4f,
dimensionsAndStride:vec4u,
indices:array<u32>,
}
fn probeToLocal(v:vec3f,c:f32,s:f32)->vec3f{
return vec3f(c*v.x-s*v.z,v.y,s*v.x+c*v.z);
}
fn probeToWorld(v:vec3f,c:f32,s:f32)->vec3f{
return vec3f(c*v.x+s*v.z,v.y,-s*v.x+c*v.z);
}
fn localProbeVoxelBase(worldPos:vec3f)->u32{
let dimensions=localProbeGrid.dimensionsAndStride.xyz;
let raw=vec3i(floor((worldPos-localProbeGrid.minimumAndInverseCellSize.xyz)*localProbeGrid.minimumAndInverseCellSize.w));
let coordinates=clamp(raw,vec3i(0),vec3i(dimensions)-vec3i(1));
let cellIndex=(u32(coordinates.z)*dimensions.y+u32(coordinates.y))*dimensions.x+u32(coordinates.x);
return cellIndex*localProbeGrid.dimensionsAndStride.w;
}
fn voxelProbeIndex(base:u32,slot:u32)->u32{
return localProbeGrid.indices[base+1u+slot];
}
fn localProbeIsSphere(probe:LocalEnvironmentProbe)->bool{
return (bitcast<u32>(probe.influenceOuterHalfSize.w)&${_PBR_LOCAL_ENVIRONMENT_SPHERE_FLAG}u)!=0u;
}
fn insideProbeVolume(localPosition:vec3f,extent:vec3f,isSphere:bool)->bool{
return select(all(abs(localPosition)<=extent),length(localPosition)<=extent.x,isSphere);
}
fn probeNdf(localPosition:vec3f,innerExtent:vec3f,outerOffset:vec3f,outerExtent:vec3f,isSphere:bool)->f32{
if(isSphere){
return (length(localPosition)-innerExtent.x)/max(outerExtent.x-innerExtent.x,0.00001);
}
let span=max(select(-outerOffset,outerOffset,localPosition>=vec3f(0.0))+outerExtent-innerExtent,vec3f(0.00001));
let axisNdf=(abs(localPosition)-innerExtent)/span;
return max(axisNdf.x,max(axisNdf.y,axisNdf.z));
}
fn probeReflectionDirection(worldPos:vec3f,worldRay:vec3f,probe:LocalEnvironmentProbe)->vec3f{
if((localProbeData.params.w&${_PBR_LOCAL_ENVIRONMENT_PARALLAX_FLAG}u)==0u){return worldRay;}
let c=probe.influenceCentreAndCos.w;
let s=probe.influenceInnerHalfSizeAndSin.w;
let boxCentre=probe.projectionCentreAndLayer.xyz;
let localPos=probeToLocal(worldPos-boxCentre,c,s);
let localRay=probeToLocal(worldRay,c,s);
let halfSize=probe.projectionHalfSizeAndLodScale.xyz;
if(localProbeIsSphere(probe)){
let a=dot(localRay,localRay);
let b=dot(localPos,localRay);
let radius=halfSize.x;
let determinant=b*b-a*(dot(localPos,localPos)-radius*radius);
if(determinant<0.0){return worldRay;}
let distance=(-b+sqrt(determinant))/max(a,0.00001);
if(distance<=0.0){return worldRay;}
let localHit=localPos+localRay*distance;
let localCapture=probeToLocal(probe.capturePositionAndLodBias.xyz-boxCentre,c,s);
return probeToWorld(localHit-localCapture,c,s);
}
let invRay=vec3f(1.0)/localRay;
let maxPlane=(halfSize-localPos)*invRay;
let minPlane=(-halfSize-localPos)*invRay;
let furthest=max(maxPlane,minPlane);
let distance=min(furthest.x,min(furthest.y,furthest.z));
let localHit=localPos+localRay*distance;
let localCapture=probeToLocal(probe.capturePositionAndLodBias.xyz-boxCentre,c,s);
return probeToWorld(localHit-localCapture,c,s);
}
fn localProbeDebugColor(probe:LocalEnvironmentProbe)->vec3f{
let packed=bitcast<u32>(probe.influenceOuterHalfSize.w);
return vec3f(f32(packed&255u),f32((packed>>8u)&255u),f32((packed>>16u)&255u))/255.0;
}
fn sampleOneLocalProbe(probeIndex:u32,worldPos:vec3f,worldRay:vec3f,alphaG:f32,envRotationY:f32)->vec3f{
let probe=localProbeData.probes[probeIndex];
if((localProbeData.params.w&${_PBR_LOCAL_ENVIRONMENT_DEBUG_COLOR_FLAG}u)!=0u){return localProbeDebugColor(probe);}
let direction=rotateY(probeReflectionDirection(worldPos,worldRay,probe),envRotationY);
let dimension=f32(textureDimensions(localProbeTexture).x);
let maxLevel=f32(textureNumLevels(localProbeTexture)-1);
let lod=log2(dimension*alphaG)*probe.projectionHalfSizeAndLodScale.w+probe.capturePositionAndLodBias.w;
return textureSampleLevel(localProbeTexture,localProbeSampler,direction,i32(probe.projectionCentreAndLayer.w),clamp(lod,0.0,maxLevel)).rgb;
}
fn sampleLocalProbeRadiance(worldPos:vec3f,worldRay:vec3f,alphaG:f32,envRotationY:f32,intensity:f32)->vec3f{
let voxelBase=localProbeVoxelBase(worldPos);
let candidateCount=min(localProbeGrid.indices[voxelBase],${MAX_PBR_LOCAL_ENVIRONMENT_CANDIDATES}u);
let outputIntensity=select(intensity,1.0,(localProbeData.params.w&${_PBR_LOCAL_ENVIRONMENT_DEBUG_COLOR_FLAG}u)!=0u);
var ndfs:array<f32,${MAX_PBR_LOCAL_ENVIRONMENT_CANDIDATES}>;
var included:array<bool,${MAX_PBR_LOCAL_ENVIRONMENT_CANDIDATES}>;
var sumNdf=0.0;
var inverseSumNdf=0.0;
var outerCount=0u;
var nearestProbeIndex=voxelProbeIndex(voxelBase,0u);
var nearestNdf=1e30;
for(var slot=0u;slot<${MAX_PBR_LOCAL_ENVIRONMENT_CANDIDATES}u;slot++){
if(slot>=candidateCount){break;}
let probeIndex=voxelProbeIndex(voxelBase,slot);
let probe=localProbeData.probes[probeIndex];
let localPosition=probeToLocal(worldPos-probe.influenceCentreAndCos.xyz,probe.influenceCentreAndCos.w,probe.influenceInnerHalfSizeAndSin.w);
let localOuterPosition=probeToLocal(worldPos-probe.influenceOuterCentre.xyz,probe.influenceCentreAndCos.w,probe.influenceInnerHalfSizeAndSin.w);
let localOuterOffset=probeToLocal(probe.influenceOuterCentre.xyz-probe.influenceCentreAndCos.xyz,probe.influenceCentreAndCos.w,probe.influenceInnerHalfSizeAndSin.w);
let isSphere=localProbeIsSphere(probe);
if(insideProbeVolume(localPosition,probe.influenceInnerHalfSizeAndSin.xyz,isSphere)){
return sampleOneLocalProbe(probeIndex,worldPos,worldRay,alphaG,envRotationY)*outputIntensity;
}
let rawNdf=probeNdf(localPosition,probe.influenceInnerHalfSizeAndSin.xyz,localOuterOffset,probe.influenceOuterHalfSize.xyz,isSphere);
if(rawNdf<nearestNdf){
nearestNdf=rawNdf;
nearestProbeIndex=probeIndex;
}
if(insideProbeVolume(localOuterPosition,probe.influenceOuterHalfSize.xyz,isSphere)){
let ndf=clamp(rawNdf,0.0,1.0);
ndfs[slot]=ndf;
included[slot]=true;
sumNdf+=ndf;
inverseSumNdf+=1.0-ndf;
outerCount++;
}
}
if(outerCount==0u){
return sampleOneLocalProbe(nearestProbeIndex,worldPos,worldRay,alphaG,envRotationY)*outputIntensity;
}
if(outerCount==1u){
for(var slot=0u;slot<${MAX_PBR_LOCAL_ENVIRONMENT_CANDIDATES}u;slot++){
if(slot>=candidateCount){break;}
if(included[slot]){
return sampleOneLocalProbe(voxelProbeIndex(voxelBase,slot),worldPos,worldRay,alphaG,envRotationY)*outputIntensity;
}
}
}
var weights:array<f32,${MAX_PBR_LOCAL_ENVIRONMENT_CANDIDATES}>;
var sumWeights=0.0;
let countMinusOne=f32(outerCount-1u);
for(var slot=0u;slot<${MAX_PBR_LOCAL_ENVIRONMENT_CANDIDATES}u;slot++){
if(slot>=candidateCount){break;}
if(included[slot]){
let ndf=ndfs[slot];
let boundaryWeight=(1.0-ndf/max(sumNdf,0.00001))/countMinusOne;
let centreWeight=(1.0-ndf)/max(inverseSumNdf,0.00001);
let weight=max(0.0,boundaryWeight*centreWeight);
weights[slot]=weight;
sumWeights+=weight;
}
}
if(sumWeights<=0.00001){
return sampleOneLocalProbe(nearestProbeIndex,worldPos,worldRay,alphaG,envRotationY)*outputIntensity;
}
var radiance=vec3f(0.0);
for(var slot=0u;slot<${MAX_PBR_LOCAL_ENVIRONMENT_CANDIDATES}u;slot++){
if(slot>=candidateCount){break;}
let weight=weights[slot]/sumWeights;
if(weight>0.00001){
radiance+=sampleOneLocalProbe(voxelProbeIndex(voxelBase,slot),worldPos,worldRay,alphaG,envRotationY)*weight;
}
}
return radiance*outputIntensity;
}`;
}

function replaceExactly(source: string, needle: string, replacement: string, label: string): string {
    const parts = source.split(needle);
    if (parts.length !== 2) {
        throw new Error(`${label}: expected to rewrite 1 occurrence, rewrote ${parts.length - 1}`);
    }
    return parts.join(replacement);
}

function patchProbeGridStorage(composed: ComposedShader): ComposedShader {
    let binding = -1;
    let rewrites = 0;
    const fragmentWGSL = composed._fragmentWGSL.replace(/@group\(1\)@binding\((\d+)\)\s*var<uniform>\s*localProbeGrid\s*:/g, (_match, value: string) => {
        binding = Number(value);
        rewrites++;
        return `@group(1)@binding(${value}) var<storage, read> localProbeGrid:`;
    });
    if (rewrites !== 1) {
        throw new Error(`local probe array _postCompose: expected to rewrite 1 voxel-grid binding declaration, rewrote ${rewrites}`);
    }
    const entries = (composed._meshBGLDescriptor.entries as GPUBindGroupLayoutEntry[]).map((entry) =>
        entry.binding === binding ? { ...entry, buffer: { type: "read-only-storage" as const } } : entry
    );
    return { ...composed, _fragmentWGSL: fragmentWGSL, _meshBGLDescriptor: { ...composed._meshBGLDescriptor, entries } };
}

function patchProbeCubeArray(composed: ComposedShader): ComposedShader {
    let binding = -1;
    let rewrites = 0;
    const fragmentWGSL = composed._fragmentWGSL.replace(/@group\(1\)@binding\((\d+)\)\s*var\s+localProbeTexture\s*:\s*texture_cube<f32>/g, (_match, value: string) => {
        binding = Number(value);
        rewrites++;
        return `@group(1)@binding(${value}) var localProbeTexture:texture_cube_array<f32>`;
    });
    if (rewrites !== 1) {
        throw new Error(`local probe array _postCompose: expected to rewrite 1 cube-array binding declaration, rewrote ${rewrites}`);
    }
    const entries = (composed._meshBGLDescriptor.entries as GPUBindGroupLayoutEntry[]).map((entry) =>
        entry.binding === binding && entry.texture ? { ...entry, texture: { ...entry.texture, viewDimension: "cube-array" as const } } : entry
    );
    return { ...composed, _fragmentWGSL: fragmentWGSL, _meshBGLDescriptor: { ...composed._meshBGLDescriptor, entries } };
}

function patchLayeredLocalIbl(fragmentWGSL: string, composed: ComposedShader): string {
    if (composed._fragmentKey?.split("|").some((id) => id === "clearcoat" || id.startsWith("clearcoat-"))) {
        let reflectionRewrites = 0;
        fragmentWGSL = fragmentWGSL.replace(/let\s+ccR_ibl\s*=\s*rotateY\(\s*ccR_raw\s*,\s*scene\.envRotationY\s*\);/g, () => {
            reflectionRewrites++;
            return "let ccR_ibl=rotateY(localSingleReflectionDirection(input.worldPos,ccR_raw,material.localEnvironmentMode,material.vReflectionSize,material.vReflectionPosition,material.vReflectionCapturePosition),scene.envRotationY);";
        });
        if (reflectionRewrites !== 1) {
            throw new Error(`local cubemap _postCompose: expected to rewrite 1 clearcoat reflection direction, rewrote ${reflectionRewrites}`);
        }
        let rewrites = 0;
        fragmentWGSL = fragmentWGSL.replace(
            /let\s+ccEnvRadiance_ibl\s*=\s*textureSampleLevel\(\s*iblTexture\s*,\s*iblSampler\s*,\s*ccR_ibl\s*,\s*clamp\(\s*ccSpecLod_ibl\s*,\s*0\.0\s*,\s*maxLod\s*\)\s*\)\.rgb\s*\*\s*material\.environmentIntensity\s*;/g,
            () => {
                rewrites++;
                return `var ccEnvRadiance_ibl:vec3f;
if(material.localEnvironmentMode==${LOCAL_ENVIRONMENT_PROBES_MODE}.0){ccEnvRadiance_ibl=sampleLocalProbeRadiance(input.worldPos,ccR_raw,ccAlphaG_ibl,scene.envRotationY,material.environmentIntensity);}else{ccEnvRadiance_ibl=textureSampleLevel(iblTexture,iblSampler,ccR_ibl,clamp(ccSpecLod_ibl,0.0,maxLod)).rgb*material.environmentIntensity;}`;
            }
        );
        if (rewrites !== 1) {
            throw new Error(`local cubemap _postCompose: expected to rewrite 1 clearcoat radiance sample, rewrote ${rewrites}`);
        }
    }
    if (composed._fragmentKey?.split("|").some((id) => id === "sheen" || id.startsWith("sheen-"))) {
        let rewrites = 0;
        fragmentWGSL = fragmentWGSL.replace(
            /let\s+shEnvRadiance\s*=\s*textureSampleLevel\(\s*iblTexture\s*,\s*iblSampler\s*,\s*R\s*,\s*clamp\(\s*shSpecLod\s*,\s*0\.0\s*,\s*maxLod\s*\)\s*\)\.rgb\s*\*\s*material\.environmentIntensity\s*;/g,
            () => {
                rewrites++;
                return `var shEnvRadiance:vec3f;
if(material.localEnvironmentMode==${LOCAL_ENVIRONMENT_PROBES_MODE}.0){shEnvRadiance=sampleLocalProbeRadiance(input.worldPos,R_raw,shAlphaG_ibl,scene.envRotationY,material.environmentIntensity);}else{shEnvRadiance=textureSampleLevel(iblTexture,iblSampler,R,clamp(shSpecLod,0.0,maxLod)).rgb*material.environmentIntensity;}`;
            }
        );
        if (rewrites !== 1) {
            throw new Error(`local cubemap _postCompose: expected to rewrite 1 sheen radiance sample, rewrote ${rewrites}`);
        }
    }
    return fragmentWGSL;
}

function patchSceneIbl(composed: ComposedShader, hasSceneEnvironment: boolean): ComposedShader {
    let fragmentWGSL = composed._fragmentWGSL;
    let reflectionRewrites = 0;
    fragmentWGSL = fragmentWGSL.replace(/let\s+R\s*=\s*rotateY\(\s*R_raw\s*,\s*scene\.envRotationY\s*\);/g, () => {
        reflectionRewrites++;
        return "let R=rotateY(localSingleReflectionDirection(input.worldPos,R_raw,material.localEnvironmentMode,material.vReflectionSize,material.vReflectionPosition,material.vReflectionCapturePosition),scene.envRotationY);";
    });
    if (reflectionRewrites !== 1) {
        throw new Error(`local cubemap _postCompose: expected to rewrite 1 reflection direction, rewrote ${reflectionRewrites}`);
    }
    fragmentWGSL = replaceExactly(fragmentWGSL, IBL_SCENE_IRRADIANCE, hasSceneEnvironment ? IBL_SCENE_OR_LOCAL_IRRADIANCE : IBL_LOCAL_IRRADIANCE, "local cubemap irradiance");
    let lodRewrites = 0;
    fragmentWGSL = fragmentWGSL.replace(/scene\.vImageInfos\.z/g, () => {
        lodRewrites++;
        return "material.localLodGenerationScale";
    });
    if (lodRewrites < 1) {
        throw new Error("local cubemap _postCompose: expected at least 1 environment LOD scale rewrite");
    }
    let baseRewrites = 0;
    fragmentWGSL = fragmentWGSL.replace(
        /var\s+environmentRadiance\s*=\s*textureSampleLevel\(\s*iblTexture\s*,\s*iblSampler\s*,\s*R\s*,\s*clamp\(\s*specLod\s*,\s*0\.0\s*,\s*maxLod\s*\)\s*\)\.rgb\s*\*\s*material\.environmentIntensity\s*;/g,
        () => {
            baseRewrites++;
            return `var environmentRadiance:vec3f;
if(material.localEnvironmentMode==${LOCAL_ENVIRONMENT_PROBES_MODE}.0){environmentRadiance=sampleLocalProbeRadiance(input.worldPos,R_raw,alphaG,scene.envRotationY,material.environmentIntensity);}else{environmentRadiance=textureSampleLevel(iblTexture,iblSampler,R,clamp(specLod,0.0,maxLod)).rgb*material.environmentIntensity;}
let localProbeDebugOutput=environmentRadiance;`;
        }
    );
    if (baseRewrites !== 1) {
        throw new Error(`local cubemap _postCompose: expected to rewrite 1 base radiance sample, rewrote ${baseRewrites}`);
    }
    fragmentWGSL = patchLayeredLocalIbl(fragmentWGSL, composed);
    return patchProbeCubeArray(patchProbeGridStorage({ ...composed, _fragmentWGSL: fragmentWGSL }));
}

function localBindings(): NonNullable<ShaderFragment["_bindings"]> {
    return [
        { _name: "localProbeData", _type: { _kind: "uniform-buffer" }, _visibility: STAGE_FRAGMENT },
        { _name: "localProbeGrid", _type: { _kind: "uniform-buffer" }, _visibility: STAGE_FRAGMENT },
        { _name: "localProbeTexture", _type: { _kind: "texture", _textureType: "texture_cube<f32>" }, _visibility: STAGE_FRAGMENT },
        { _name: "localProbeSampler", _type: { _kind: "sampler", _samplerType: "sampler" }, _visibility: STAGE_FRAGMENT },
    ];
}

function createLocalEnvironmentFragment(hasSceneEnvironment: boolean): ShaderFragment {
    const uboFields: UboField[] = [
        { _name: "localEnvironmentMode", _type: "f32" },
        { _name: "vReflectionPosition", _type: "vec3<f32>" },
        { _name: "vReflectionSize", _type: "vec3<f32>" },
        { _name: "vReflectionCapturePosition", _type: "vec3<f32>" },
        { _name: "localLodGenerationScale", _type: "f32" },
        ...LOCAL_SH_UBO_FIELDS,
    ];
    return {
        _id: "local-cubemap",
        _dependencies: ["ibl"],
        _uboFields: uboFields,
        _bindings: localBindings(),
        _helperFunctions: `${SINGLE_CUBEMAP_HELPERS}\n${createProbeArrayHelpers()}`,
        _fragmentSlots: {
            BC: `if(material.localEnvironmentMode==${LOCAL_ENVIRONMENT_PROBES_MODE}.0&&(localProbeData.params.w&${_PBR_LOCAL_ENVIRONMENT_DEBUG_COLOR_FLAG}u)!=0u){color=localProbeDebugOutput;}`,
        },
        _pc: (composed) => patchSceneIbl(composed, hasSceneEnvironment),
    };
}

function localEnvironmentForState(state: PbrLocalEnvironmentState): {
    brdfLutView: GPUTextureView;
    brdfSampler: GPUSampler;
    specularCube: GPUTexture;
    specularCubeView: GPUTextureView;
    cubeSampler: GPUSampler;
    sphericalHarmonics: Float32Array;
    lodGenerationScale: number;
} {
    return state.kind === "probes" ? state.set.probes[0]!.environment : state.environment;
}

interface DummyProbeResources {
    readonly uniformBuffer: GPUBuffer;
    readonly gridBuffer: GPUBuffer;
}

let _dummyProbeResources: WeakMap<GPUDevice, DummyProbeResources> | null = null;

function dummyProbeResources(ctx: _PbrBindCtx): DummyProbeResources {
    const key = ctx._engine._device;
    let resources = _dummyProbeResources?.get(key);
    if (resources) {
        return resources;
    }
    const gridLength = Math.ceil((8 + 1 + MAX_PBR_LOCAL_ENVIRONMENT_CANDIDATES) / 4) * 4;
    const grid = new Uint32Array(gridLength);
    grid.set([1, 1, 1, 1 + MAX_PBR_LOCAL_ENVIRONMENT_CANDIDATES], 4);
    grid[8] = 1;
    resources = {
        uniformBuffer: createUniformBuffer(ctx._engine, new Float32Array(16 * 1024), "pbr-local-environment-dummy-probes"),
        gridBuffer: createMappedBuffer(ctx._engine, grid, BU.STORAGE, "pbr-local-environment-dummy-grid"),
    };
    (_dummyProbeResources ??= new WeakMap()).set(key, resources);
    return resources;
}

function replaceEntryResource(entries: GPUBindGroupEntry[], current: GPUBindingResource, replacement: GPUBindingResource, label: string): void {
    const entry = entries.find((candidate) => candidate.resource === current);
    if (!entry) {
        throw new Error(`[babylon-lite] local cubemap could not replace the scene ${label} binding`);
    }
    entry.resource = replacement;
}

function bindLocalEnvironment(ctx: _PbrBindCtx, entries: GPUBindGroupEntry[], binding: number, state: PbrLocalEnvironmentState): number {
    const environment = localEnvironmentForState(state);
    if (state.kind !== "probes" && ctx._env && ctx._env !== environment) {
        replaceEntryResource(entries, ctx._env.specularCubeView, environment.specularCubeView, "cubemap");
        replaceEntryResource(entries, ctx._env.cubeSampler, environment.cubeSampler, "cubemap sampler");
    }
    if (state.kind === "probes") {
        state.set._ensureDevice();
        entries.push({ binding: binding++, resource: { buffer: state.set._uniformBuffer } });
        entries.push({ binding: binding++, resource: { buffer: state.set._gridBuffer } });
        entries.push({ binding: binding++, resource: state.set._textureView });
        entries.push({ binding: binding++, resource: state.set._sampler });
    } else {
        const dummy = dummyProbeResources(ctx);
        entries.push({ binding: binding++, resource: { buffer: dummy.uniformBuffer } });
        entries.push({ binding: binding++, resource: { buffer: dummy.gridBuffer } });
        entries.push({
            binding: binding++,
            resource: environment.specularCube.createView({ dimension: "cube-array", baseArrayLayer: 0, arrayLayerCount: 6 }),
        });
        entries.push({ binding: binding++, resource: environment.cubeSampler });
    }
    return binding;
}

function writeLocalSphericalHarmonics(data: Float32Array, offsets: ReadonlyMap<string, number>, state: PbrLocalEnvironmentState): void {
    const sh = localEnvironmentForState(state).sphericalHarmonics;
    for (let index = 0; index < LOCAL_SH_FIELDS.length; index++) {
        const offset = offsets.get(LOCAL_SH_FIELDS[index]!);
        if (offset === undefined) {
            continue;
        }
        const output = offset / 4;
        const input = index * 4;
        data[output] = sh[input] ?? 0;
        data[output + 1] = sh[input + 1] ?? 0;
        data[output + 2] = sh[input + 2] ?? 0;
    }
}

export const pbrExt: PbrExt = {
    id: "local-cubemap",
    phase: "fragment",
    detect(material) {
        const state = _getPbrLocalEnvironment(material);
        return { f: state ? PBR_HAS_LOCAL_ENVIRONMENT : 0, f2: 0 };
    },
    frag(ctx) {
        const unsupportedVariant = (ctx._features & PBR_HAS_SKYBOX) !== 0 || (ctx._features2 & (PBR2_NO_COLOR_OUTPUT | PBR2_ESM_SHADOW_OUTPUT)) !== 0;
        return (ctx._features & PBR_HAS_LOCAL_ENVIRONMENT) !== 0 && !unsupportedVariant ? createLocalEnvironmentFragment(ctx._hasSceneIbl ?? false) : null;
    },
    iblFallback(material) {
        const state = _getPbrLocalEnvironment(material);
        return state ? localEnvironmentForState(state) : null;
    },
    writeUbo(data, material, offsets) {
        const state = _getPbrLocalEnvironment(material);
        if (!state) {
            return;
        }
        const modeOffset = offsets.get("localEnvironmentMode");
        if (modeOffset !== undefined) {
            data[modeOffset / 4] =
                state.kind === "environment"
                    ? LOCAL_ENVIRONMENT_OVERRIDE_MODE
                    : state.kind === "probes"
                      ? LOCAL_ENVIRONMENT_PROBES_MODE
                      : state.shape === "sphere"
                        ? LOCAL_ENVIRONMENT_SPHERE_MODE
                        : LOCAL_ENVIRONMENT_BOX_MODE;
        }
        writeLocalSphericalHarmonics(data, offsets, state);
        if (state.kind === "single") {
            const positionOffset = offsets.get("vReflectionPosition");
            const sizeOffset = offsets.get("vReflectionSize");
            const captureOffset = offsets.get("vReflectionCapturePosition");
            if (positionOffset !== undefined) {
                data.set(state.projectionPosition, positionOffset / 4);
            }
            if (sizeOffset !== undefined) {
                data.set(state.projectionSize, sizeOffset / 4);
            }
            if (captureOffset !== undefined) {
                data.set(state.capturePosition, captureOffset / 4);
            }
        }
        const lodOffset = offsets.get("localLodGenerationScale");
        if (lodOffset !== undefined) {
            data[lodOffset / 4] = localEnvironmentForState(state).lodGenerationScale ?? 0.8;
        }
    },
    bind(ctx, entries, binding) {
        const state = _getPbrLocalEnvironment(ctx._material);
        return state ? bindLocalEnvironment(ctx, entries, binding, state) : binding;
    },
};

/** @internal Install and register the extension without module-level side effects. */
export function registerPbrLocalCubemapExt(register: (ext: PbrExt) => void): void {
    register(pbrExt);
}
