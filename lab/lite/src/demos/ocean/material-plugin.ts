import type { ComputeStorageTexture, MaterialPlugin, PluginTextureBinding, Texture2D } from "babylon-lite";
import { OCEAN_LENGTH_SCALES } from "./constants.js";
import type { OceanComputeResources } from "./resources.js";

export interface OceanMaterialPluginState {
    color: [number, number, number];
    foamColor: [number, number, number];
    sssColor: [number, number, number];
    maxGloss: number;
    roughnessScale: number;
    lodScale: number;
    foamScale: number;
    foamBias: number;
    contactFoam: number;
    sssStrength: number;
    sssBase: number;
    sssScale: number;
    lightDirection: [number, number, number];
    time: number;
    turbulenceIndex: number;
    debugMode: number;
    cameraNear: number;
    cameraFar: number;
    screenWidth: number;
    screenHeight: number;
}

export interface OceanMaterialPlugin {
    readonly plugin: MaterialPlugin;
    readonly state: OceanMaterialPluginState;
}

function sampled(resource: ComputeStorageTexture): Texture2D {
    if (!resource.sampledTexture) {
        throw new Error("Ocean render texture is not sampleable.");
    }
    return resource.sampledTexture;
}

function writeScalar(data: Float32Array, offsets: ReadonlyMap<string, number>, name: string, value: number): void {
    data[offsets.get(name)! / 4] = value;
}

function writeVector3(data: Float32Array, offsets: ReadonlyMap<string, number>, name: string, value: readonly [number, number, number]): void {
    data.set(value, offsets.get(name)! / 4);
}

function writeVector2(data: Float32Array, offsets: ReadonlyMap<string, number>, name: string, x: number, y: number): void {
    const offset = offsets.get(name)! / 4;
    data[offset] = x;
    data[offset + 1] = y;
}

export function createOceanMaterialPlugin(
    resources: OceanComputeResources,
    sceneDepth: Texture2D,
    foamTexture: Texture2D,
    cameraNearFar: readonly [number, number],
    useMid: boolean,
    useClose: boolean,
    foamBias: number
): OceanMaterialPlugin {
    const state: OceanMaterialPluginState = {
        color: [0.011126082368383245, 0.05637409755197975, 0.09868919754109445],
        foamColor: [1, 1, 1],
        sssColor: [0.1541919, 0.8857628, 0.990566],
        maxGloss: 0.91,
        roughnessScale: 0.0044,
        lodScale: 7.13,
        foamScale: 2.4,
        foamBias,
        contactFoam: 1,
        sssStrength: 0.15,
        sssBase: -0.261,
        sssScale: 4.7,
        lightDirection: [0, -1, 0],
        time: 0,
        turbulenceIndex: 1,
        debugMode: 0,
        cameraNear: cameraNearFar[0],
        cameraFar: cameraNearFar[1],
        screenWidth: 1,
        screenHeight: 1,
    };
    const cascades = resources.cascades;
    const textures = [
        sampled(cascades[0]!.displacement),
        sampled(cascades[1]!.displacement),
        sampled(cascades[2]!.displacement),
        sampled(cascades[0]!.derivatives),
        sampled(cascades[1]!.derivatives),
        sampled(cascades[2]!.derivatives),
        sampled(cascades[0]!.turbulenceA),
        sampled(cascades[0]!.turbulenceB),
        sampled(cascades[1]!.turbulenceA),
        sampled(cascades[1]!.turbulenceB),
        sampled(cascades[2]!.turbulenceA),
        sampled(cascades[2]!.turbulenceB),
        sceneDepth,
        foamTexture,
    ] as const;
    const midVertex = useMid ? "oceanDisplacement+=textureSampleLevel(oceanDisplacement1,oceanDisplacement1Sampler,oceanUv1,0.0).xyz*oceanLod.y;" : "";
    const closeVertex = useClose ? "oceanDisplacement+=textureSampleLevel(oceanDisplacement2,oceanDisplacement2Sampler,oceanUv2,0.0).xyz*oceanLod.z;" : "";
    const midDerivatives = useMid ? "oceanDerivatives+=textureSample(oceanDerivatives1,oceanDerivatives1Sampler,input.oceanUv1)*input.oceanLodScales.y;" : "";
    const closeDerivatives = useClose ? "oceanDerivatives+=textureSample(oceanDerivatives2,oceanDerivatives2Sampler,input.oceanUv2)*input.oceanLodScales.z;" : "";
    const turbulence = useClose
        ? "var oceanJacobian=oceanTurbulence(oceanTurbulence0A,oceanTurbulence0ASampler,oceanTurbulence0B,oceanTurbulence0BSampler,input.oceanUv0)+oceanTurbulence(oceanTurbulence1A,oceanTurbulence1ASampler,oceanTurbulence1B,oceanTurbulence1BSampler,input.oceanUv1)+oceanTurbulence(oceanTurbulence2A,oceanTurbulence2ASampler,oceanTurbulence2B,oceanTurbulence2BSampler,input.oceanUv2);"
        : useMid
          ? "var oceanJacobian=oceanTurbulence(oceanTurbulence0A,oceanTurbulence0ASampler,oceanTurbulence0B,oceanTurbulence0BSampler,input.oceanUv0)+oceanTurbulence(oceanTurbulence1A,oceanTurbulence1ASampler,oceanTurbulence1B,oceanTurbulence1BSampler,input.oceanUv1);"
          : "var oceanJacobian=oceanTurbulence(oceanTurbulence0A,oceanTurbulence0ASampler,oceanTurbulence0B,oceanTurbulence0BSampler,input.oceanUv0);";

    const plugin: MaterialPlugin = {
        name: `ocean-pbr-${useMid ? 1 : 0}${useClose ? 1 : 0}`,
        defines: { MID: useMid, CLOSE: useClose },
        getVaryings() {
            return [
                { name: "oceanWorldUv", type: "vec2<f32>" },
                { name: "oceanUv0", type: "vec2<f32>" },
                { name: "oceanUv1", type: "vec2<f32>" },
                { name: "oceanUv2", type: "vec2<f32>" },
                { name: "oceanViewVector", type: "vec3<f32>" },
                { name: "oceanLodScales", type: "vec4<f32>" },
                { name: "oceanHeight", type: "f32" },
            ];
        },
        getUniforms() {
            return {
                ubo: [
                    { name: "oceanColor", type: "vec3<f32>" },
                    { name: "oceanFoamColor", type: "vec3<f32>" },
                    { name: "oceanSssColor", type: "vec3<f32>" },
                    { name: "oceanLightDirection", type: "vec3<f32>" },
                    { name: "oceanLengthScales", type: "vec3<f32>", visibility: "vertex-fragment" },
                    { name: "oceanMaxGloss", type: "f32" },
                    { name: "oceanRoughnessScale", type: "f32" },
                    { name: "oceanLodScale", type: "f32", visibility: "vertex" },
                    { name: "oceanFoamScale", type: "f32" },
                    { name: "oceanFoamBias", type: "f32" },
                    { name: "oceanContactFoam", type: "f32" },
                    { name: "oceanSssStrength", type: "f32" },
                    { name: "oceanSssBase", type: "f32", visibility: "vertex-fragment" },
                    { name: "oceanSssScale", type: "f32", visibility: "vertex-fragment" },
                    { name: "oceanTime", type: "f32" },
                    { name: "oceanTurbulenceIndex", type: "f32" },
                    { name: "oceanDebugMode", type: "f32" },
                    { name: "oceanCameraNear", type: "f32" },
                    { name: "oceanCameraFar", type: "f32" },
                    { name: "oceanScreenSize", type: "vec2<f32>" },
                ],
            };
        },
        getSamplers() {
            return [
                { texture: "oceanDisplacement0", sampler: "oceanDisplacement0Sampler", visibility: "vertex" },
                { texture: "oceanDisplacement1", sampler: "oceanDisplacement1Sampler", visibility: "vertex" },
                { texture: "oceanDisplacement2", sampler: "oceanDisplacement2Sampler", visibility: "vertex" },
                { texture: "oceanDerivatives0", sampler: "oceanDerivatives0Sampler" },
                { texture: "oceanDerivatives1", sampler: "oceanDerivatives1Sampler" },
                { texture: "oceanDerivatives2", sampler: "oceanDerivatives2Sampler" },
                { texture: "oceanTurbulence0A", sampler: "oceanTurbulence0ASampler" },
                { texture: "oceanTurbulence0B", sampler: "oceanTurbulence0BSampler" },
                { texture: "oceanTurbulence1A", sampler: "oceanTurbulence1ASampler" },
                { texture: "oceanTurbulence1B", sampler: "oceanTurbulence1BSampler" },
                { texture: "oceanTurbulence2A", sampler: "oceanTurbulence2ASampler" },
                { texture: "oceanTurbulence2B", sampler: "oceanTurbulence2BSampler" },
                { texture: "oceanDepth", sampler: "oceanDepthSampler", depthTexture: true, samplerType: "sampler_non_filtering" },
                { texture: "oceanFoam", sampler: "oceanFoamSampler" },
            ];
        },
        bindTextures(out: PluginTextureBinding[]) {
            for (const texture of textures) {
                out.push({ texture });
            }
        },
        getActiveTextures(out: Texture2D[]) {
            out.push(...textures);
        },
        writeUbo(data, offsets) {
            writeVector3(data, offsets, "oceanColor", state.color);
            writeVector3(data, offsets, "oceanFoamColor", state.foamColor);
            writeVector3(data, offsets, "oceanSssColor", state.sssColor);
            writeVector3(data, offsets, "oceanLightDirection", state.lightDirection);
            writeVector3(data, offsets, "oceanLengthScales", OCEAN_LENGTH_SCALES);
            writeScalar(data, offsets, "oceanMaxGloss", state.maxGloss);
            writeScalar(data, offsets, "oceanRoughnessScale", state.roughnessScale);
            writeScalar(data, offsets, "oceanLodScale", state.lodScale);
            writeScalar(data, offsets, "oceanFoamScale", state.foamScale);
            writeScalar(data, offsets, "oceanFoamBias", state.foamBias);
            writeScalar(data, offsets, "oceanContactFoam", state.contactFoam);
            writeScalar(data, offsets, "oceanSssStrength", state.sssStrength);
            writeScalar(data, offsets, "oceanSssBase", state.sssBase);
            writeScalar(data, offsets, "oceanSssScale", state.sssScale);
            writeScalar(data, offsets, "oceanTime", state.time);
            writeScalar(data, offsets, "oceanTurbulenceIndex", state.turbulenceIndex);
            writeScalar(data, offsets, "oceanDebugMode", state.debugMode);
            writeScalar(data, offsets, "oceanCameraNear", state.cameraNear);
            writeScalar(data, offsets, "oceanCameraFar", state.cameraFar);
            writeVector2(data, offsets, "oceanScreenSize", state.screenWidth, state.screenHeight);
        },
        getCustomCode(shaderType) {
            if (shaderType === "vertex") {
                return {
                    CUSTOM_VERTEX_UPDATE_WORLDPOS: `
let oceanBaseWorld=(finalWorld*vec4<f32>(position,1.0)).xyz;
let oceanViewVector=scene.vEyePosition.xyz-oceanBaseWorld;
let oceanViewDistance=length(oceanViewVector);
let oceanLod=min(material.oceanLodScale*material.oceanLengthScales/oceanViewDistance,vec3<f32>(1.0));
let oceanUv0=oceanBaseWorld.xz/material.oceanLengthScales.x;
let oceanUv1=oceanBaseWorld.xz/material.oceanLengthScales.y;
let oceanUv2=oceanBaseWorld.xz/material.oceanLengthScales.z;
var oceanDisplacement=textureSampleLevel(oceanDisplacement0,oceanDisplacement0Sampler,oceanUv0,0.0).xyz*oceanLod.x;
let oceanLargeWavesBias=oceanDisplacement.y;
${midVertex}
${closeVertex}
finalWorld[3]=vec4<f32>(finalWorld[3].xyz+oceanDisplacement,finalWorld[3].w);
let oceanCrest=max(oceanDisplacement.y-oceanLargeWavesBias*0.8-material.oceanSssBase,0.0)/material.oceanSssScale;`,
                    CUSTOM_VERTEX_MAIN_END: `
out.oceanWorldUv=oceanBaseWorld.xz;
out.oceanUv0=oceanUv0;
out.oceanUv1=oceanUv1;
out.oceanUv2=oceanUv2;
out.oceanViewVector=oceanViewVector;
out.oceanLodScales=vec4<f32>(oceanLod,oceanCrest);
out.oceanHeight=oceanDisplacement.y;`,
                };
            }
            return {
                CUSTOM_FRAGMENT_DEFINITIONS: `
fn oceanPow5(value:f32)->f32{let value2=value*value;return value2*value2*value;}
fn oceanTurbulence(a:texture_2d<f32>,sa:sampler,b:texture_2d<f32>,sb:sampler,uv:vec2<f32>)->f32{
let va=textureSample(a,sa,uv).x;
let vb=textureSample(b,sb,uv).x;
return select(va,vb,material.oceanTurbulenceIndex>0.5);
}`,
                CUSTOM_FRAGMENT_BEFORE_LIGHTS: `
var oceanDerivatives=textureSample(oceanDerivatives0,oceanDerivatives0Sampler,input.oceanUv0);
${midDerivatives}
${closeDerivatives}
let oceanSlope=vec2<f32>(oceanDerivatives.x/(1.0+oceanDerivatives.z),oceanDerivatives.y/(1.0+oceanDerivatives.w));
N=normalize(vec3<f32>(-oceanSlope.x,1.0,-oceanSlope.y));
N_geom=N;
NdotVUnclamped=dot(N,V);
NdotV=abs(NdotVUnclamped)+0.0000001;
${turbulence}
oceanJacobian=clamp((-oceanJacobian+material.oceanFoamBias)*material.oceanFoamScale,0.0,1.0);
let oceanScreenUv=input.clipPos.xy/material.oceanScreenSize;
let oceanBackgroundDepth=textureSample(oceanDepth,oceanDepthSampler,oceanScreenUv);
let oceanSurfaceView=material.oceanCameraNear*material.oceanCameraFar/(input.clipPos.z*(material.oceanCameraFar-material.oceanCameraNear)+material.oceanCameraNear);
let oceanBackgroundView=material.oceanCameraNear*material.oceanCameraFar/(oceanBackgroundDepth*(material.oceanCameraFar-material.oceanCameraNear)+material.oceanCameraNear);
let oceanDepthDifference=max(0.0,oceanBackgroundView-oceanSurfaceView-0.5);
let oceanContactSample=textureSample(oceanFoam,oceanFoamSampler,input.oceanWorldUv*0.5+material.oceanTime*2.0).r;
let oceanContact=select(0.0,clamp(max(0.0,oceanContactSample-oceanDepthDifference)*5.0,0.0,1.0)*0.9,oceanBackgroundDepth>0.0);
oceanJacobian+=material.oceanContactFoam*oceanContact;
surfaceAlbedo=mix(vec3<f32>(0.0),material.oceanFoamColor,oceanJacobian)*(1.0-material.reflectance);
let oceanViewDirection=normalize(input.oceanViewVector);
let oceanHalf=normalize(-N+material.oceanLightDirection);
let oceanViewDotHalf=oceanPow5(clamp(dot(oceanViewDirection,-oceanHalf),0.0,1.0))*30.0*material.oceanSssStrength;
let oceanBodyColor=mix(material.oceanColor,clamp(material.oceanColor+material.oceanSssColor*oceanViewDotHalf*input.oceanLodScales.w,vec3<f32>(0.0),vec3<f32>(1.0)),input.oceanLodScales.z);
let oceanFresnel=oceanPow5(clamp(1.0-dot(N,oceanViewDirection),0.0,1.0));
let oceanDistanceGloss=mix(1.0-roughness,material.oceanMaxGloss,1.0/(1.0+length(input.oceanViewVector)*material.oceanRoughnessScale));
roughness=1.0-mix(oceanDistanceGloss,0.0,oceanJacobian);`,
                CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: `
color+=mix(oceanBodyColor*(1.0-oceanFresnel),vec3<f32>(0.0),oceanJacobian);`,
                CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: `
if(material.oceanDebugMode>0.5&&material.oceanDebugMode<1.5){color=vec3<f32>(0.5+input.oceanHeight*0.08);}
if(material.oceanDebugMode>1.5&&material.oceanDebugMode<2.5){color=oceanDerivatives.xyz*0.5+0.5;}
if(material.oceanDebugMode>2.5){color=vec3<f32>(clamp(oceanJacobian,0.0,1.0));}`,
            };
        },
    };
    return { plugin, state };
}
