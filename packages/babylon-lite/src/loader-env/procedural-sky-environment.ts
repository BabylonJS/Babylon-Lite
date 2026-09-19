import { F32 } from "../engine/typed-arrays.js";
import { TU } from "../engine/gpu-flags.js";
import type { SceneContext } from "../scene/scene.js";
import { acquireGPUTexture, releaseGPUTexture } from "../resource/gpu-pool.js";
import { createEmptyUniformBuffer } from "../resource/gpu-buffers.js";
import type { EnvironmentTextures } from "./load-env.js";
import { polynomialToPreScaledHarmonics } from "./load-env.js";
import { assembleEnvironmentTextures, loadBrdfImage } from "./env-helpers.js";
import { mipLevelCount } from "../texture/mip-count.js";
import { prepareMipmaps, recordPreparedMipmaps, type PreparedMipmapLevel } from "../texture/mipmap-preparation.js";
import { _invalidateSceneUboCaches, registerEnvSceneUniforms } from "../scene/scene-ubo-extras.js";
import { wgsl } from "../shader/wgsl.js";

const FACE_SIZE = 128;

const SKY_CUBE_WGSL = wgsl`
struct Params{sunPosition:vec4f,atmosphere:vec4f}
@group(0)@binding(0)var outputFaces:texture_storage_2d_array<rgba16float,write>;
@group(0)@binding(1)var<uniform> params:Params;
const PI=3.141592653589793;
const WAVELENGTH=vec3f(680e-9,550e-9,450e-9);
const MIE_K=vec3f(0.686,0.678,0.666);
const RAYLEIGH_ZENITH_LENGTH=8.4e3;
const MIE_ZENITH_LENGTH=1.25e3;
const SUN_ENERGY=1000.0;
const SUN_ANGULAR_DIAMETER_COS=0.9999566769464484;
const CUTOFF_ANGLE=PI/1.95;
const STEEPNESS=1.5;
const FACE_SOURCE=array<u32,6>(4u,5u,2u,3u,1u,0u);
const CORNERS=array<vec3f,24>(
vec3f(1,-1,1),vec3f(-1,-1,1),vec3f(1,1,1),vec3f(-1,1,1),
vec3f(-1,-1,-1),vec3f(1,-1,-1),vec3f(-1,1,-1),vec3f(1,1,-1),
vec3f(-1,-1,-1),vec3f(-1,-1,1),vec3f(1,-1,-1),vec3f(1,-1,1),
vec3f(1,1,-1),vec3f(1,1,1),vec3f(-1,1,-1),vec3f(-1,1,1),
vec3f(1,-1,-1),vec3f(1,-1,1),vec3f(1,1,-1),vec3f(1,1,1),
vec3f(-1,-1,1),vec3f(-1,-1,-1),vec3f(-1,1,1),vec3f(-1,1,-1));
fn simplifiedRayleigh()->vec3f{return vec3f(0.0005)/vec3f(94.0,40.0,18.0);}
fn totalMie(turbidity:f32)->vec3f{
let c=(0.2*turbidity)*10e-18;
return 0.434*c*PI*pow((2.0*PI)/WAVELENGTH,vec3f(2.0))*MIE_K;
}
fn rayleighPhase(cosTheta:f32)->f32{return (3.0/(16.0*PI))*(1.0+cosTheta*cosTheta);}
fn hgPhase(cosTheta:f32,g:f32)->f32{
let gc=clamp(g,-0.999,0.999);let ct=clamp(cosTheta,-1.0,1.0);let g2=gc*gc;
return (1.0/(4.0*PI))*((1.0-g2)/pow(1.0-2.0*gc*ct+g2,1.5));
}
fn sunIntensity(zenithCos:f32)->f32{
return SUN_ENERGY*max(0.0,1.0-exp(-(CUTOFF_ANGLE-acos(clamp(zenithCos,-1.0,1.0)))/STEEPNESS));
}
fn tonemap(x:vec3f)->vec3f{
let a=0.15;let b=0.5;let c=0.1;let d=0.2;let e=0.02;let f=0.3;
return ((x*(a*x+c*b)+d*e)/(x*(a*x+b)+d*f))-e/f;
}
fn sky(direction:vec3f)->vec3f{
let up=vec3f(0,1,0);
let sunDirection=normalize(params.sunPosition.xyz);
let sunFade=1.0-clamp(1.0-exp(params.sunPosition.y/450000.0),0.0,1.0);
let rayleighCoefficient=params.atmosphere.z-(1.0-sunFade);
let sunE=sunIntensity(dot(sunDirection,up));
let betaR=simplifiedRayleigh()*rayleighCoefficient;
let betaM=totalMie(params.atmosphere.y)*params.atmosphere.w;
let zenithAngle=acos(max(0.0,dot(up,direction)));
let opticalDenominator=cos(zenithAngle)+0.15*pow(93.885-zenithAngle*180.0/PI,-1.253);
let extinction=exp(-(betaR*(RAYLEIGH_ZENITH_LENGTH/opticalDenominator)+betaM*(MIE_ZENITH_LENGTH/opticalDenominator)));
let cosTheta=dot(direction,sunDirection);
let betaRayleighTheta=betaR*rayleighPhase(cosTheta*0.5+0.5);
let betaMieTheta=betaM*hgPhase(cosTheta,params.atmosphere.x);
let scattering=sunE*((betaRayleighTheta+betaMieTheta)/(betaR+betaM));
var incoming=pow(scattering*(1.0-extinction),vec3f(1.5));
let horizonMix=clamp(pow(1.0-dot(up,sunDirection),5.0),0.0,1.0);
incoming*=mix(vec3f(1.0),pow(scattering*extinction,vec3f(0.5)),vec3f(horizonMix));
var background=vec3f(0.1)*extinction;
let sunDisk=smoothstep(SUN_ANGULAR_DIAMETER_COS,SUN_ANGULAR_DIAMETER_COS+0.00002,cosTheta);
background+=sunE*19000.0*extinction*sunDisk;
var color=(incoming+background)*0.04+vec3f(0.0,0.001,0.0025)*0.3;
let whiteScale=vec3f(1.0)/tonemap(vec3f(1000.0));
let exposure=log2(2.0/pow(params.sunPosition.w,4.0));
return clamp(tonemap(exposure*color)*whiteScale,vec3f(0.0),vec3f(1.0));
}
@compute @workgroup_size(8,8,1)
fn main(@builtin(global_invocation_id)gid:vec3u){
let size=textureDimensions(outputFaces).x;
if(gid.x>=size||gid.y>=size||gid.z>=6u){return;}
let u=(f32(gid.x)+0.5)/f32(size);
let v=(f32(gid.y)+0.5)/f32(size);
let base=FACE_SOURCE[gid.z]*4u;
let cubeDirection=normalize(CORNERS[base]*(1.0-u)*(1.0-v)+CORNERS[base+1u]*u*(1.0-v)+CORNERS[base+2u]*(1.0-u)*v+CORNERS[base+3u]*u*v);
let reflectionProbeDirection=vec3f(cubeDirection.x,-cubeDirection.y,cubeDirection.z);
textureStore(outputFaces,vec2i(gid.xy),i32(gid.z),vec4f(pow(sky(reflectionProbeDirection),vec3f(2.2)),1.0));
}`;

/** Atmospheric parameters used to generate and update a procedural sky environment. */
export interface ProceduralSkyEnvironmentOptions {
    /** Normalized world-space direction from the scene toward the sun. */
    readonly sunDirection: readonly [number, number, number];
    /** Sky luminance/exposure control. */
    readonly luminance: number;
    /** Atmospheric aerosol density. */
    readonly turbidity: number;
    /** Rayleigh scattering strength. */
    readonly rayleigh: number;
    /** Mie scattering strength. */
    readonly mieCoefficient: number;
    /** Mie phase-function directionality. */
    readonly mieDirectionalG: number;
}

/** Initial procedural-sky parameters plus the BRDF lookup texture URL. */
export interface ProceduralSkyEnvironmentLoadOptions extends ProceduralSkyEnvironmentOptions {
    /** URL of the BRDF lookup texture used by PBR environment lighting. */
    readonly brdfUrl: string;
    /** @internal Test hook for deterministic asynchronous chunk scheduling. */
    readonly _yield?: () => Promise<void>;
}

/** Opaque handle for an environment created by {@link loadProceduralSkyEnvironment}. */
export interface ProceduralSkyEnvironment {
    /** @internal */
    readonly _scene: SceneContext;
    /** @internal */
    readonly _texture: GPUTexture;
    /** @internal */
    readonly _parameterBuffer: GPUBuffer;
    /** @internal */
    readonly _bindGroup: GPUBindGroup;
    /** @internal */
    readonly _pipeline: GPUComputePipeline;
    /** @internal */
    readonly _mipmaps: readonly (readonly PreparedMipmapLevel[])[];
    /** @internal The exact environment facade installed by this generation. */
    readonly _textures: EnvironmentTextures;
    /** @internal */
    _disposed: boolean;
    /** @internal */
    _revision: number;
    /** @internal */
    readonly _yield?: () => Promise<void>;
}

interface SkySceneGeneration {
    _current: ProceduralSkyEnvironment | null;
    _disposed: boolean;
}

let _skyScenes: WeakMap<SceneContext, SkySceneGeneration> | null = null;

interface CpuSkyContext {
    sunX: number;
    sunY: number;
    sunZ: number;
    sunE: number;
    betaR: [number, number, number];
    betaM: [number, number, number];
    mieG: number;
    exposure: number;
    whiteScale: number;
}

function tonemap(value: number): number {
    return (value * (0.15 * value + 0.05) + 0.004) / (value * (0.15 * value + 0.5) + 0.06) - 0.02 / 0.3;
}

function makeCpuContext(options: ProceduralSkyEnvironmentOptions): CpuSkyContext {
    const [sx0, sy0, sz0] = options.sunDirection;
    const invLength = 1 / Math.hypot(sx0, sy0, sz0);
    const sunX = sx0 * invLength;
    const sunY = sy0 * invLength;
    const sunZ = sz0 * invLength;
    const sunFade = 1 - Math.min(1, Math.max(0, 1 - Math.exp((sunY * 500) / 450000)));
    const rayleighCoefficient = options.rayleigh - (1 - sunFade);
    const betaR: [number, number, number] = [(0.0005 / 94) * rayleighCoefficient, (0.0005 / 40) * rayleighCoefficient, (0.0005 / 18) * rayleighCoefficient];
    const wavelengths = [680e-9, 550e-9, 450e-9] as const;
    const mieK = [0.686, 0.678, 0.666] as const;
    const c = 0.2 * options.turbidity * 10e-18;
    const betaM = wavelengths.map((wavelength, index) => 0.434 * c * Math.PI * ((2 * Math.PI) / wavelength) ** 2 * mieK[index]! * options.mieCoefficient) as [
        number,
        number,
        number,
    ];
    const cutoffAngle = Math.PI / 1.95;
    const sunE = 1000 * Math.max(0, 1 - Math.exp(-(cutoffAngle - Math.acos(Math.min(1, Math.max(-1, sunY)))) / 1.5));
    return {
        sunX,
        sunY,
        sunZ,
        sunE,
        betaR,
        betaM,
        mieG: options.mieDirectionalG,
        exposure: Math.log2(2 / options.luminance ** 4),
        whiteScale: 1 / tonemap(1000),
    };
}

function writeSkyColor(output: Float32Array, offset: number, x: number, y: number, z: number, context: CpuSkyContext, minimum = 0): void {
    const zenithAngle = Math.acos(Math.max(0, y));
    const denominator = Math.cos(zenithAngle) + 0.15 * (93.885 - (zenithAngle * 180) / Math.PI) ** -1.253;
    const rayleighLength = 8400 / denominator;
    const mieLength = 1250 / denominator;
    const cosTheta = Math.min(1, Math.max(-1, x * context.sunX + y * context.sunY + z * context.sunZ));
    const rayleighPhase = (3 / (16 * Math.PI)) * (1 + (cosTheta * 0.5 + 0.5) ** 2);
    const mieG = Math.min(0.999, Math.max(-0.999, context.mieG));
    const g2 = mieG ** 2;
    const miePhase = (1 / (4 * Math.PI)) * ((1 - g2) / (1 - 2 * mieG * cosTheta + g2) ** 1.5);
    const horizonMix = Math.min(1, Math.max(0, (1 - context.sunY) ** 5));
    const sunDiskLinear = Math.min(1, Math.max(0, (cosTheta - 0.9999566769464484) / 0.00002));
    const sunDisk = sunDiskLinear * sunDiskLinear * (3 - 2 * sunDiskLinear);
    for (let channel = 0; channel < 3; channel++) {
        const betaR = context.betaR[channel]!;
        const betaM = context.betaM[channel]!;
        const extinction = Math.exp(-(betaR * rayleighLength + betaM * mieLength));
        const scattering = context.sunE * ((betaR * rayleighPhase + betaM * miePhase) / (betaR + betaM));
        let incoming = (scattering * (1 - extinction)) ** 1.5;
        incoming *= 1 + (Math.sqrt(scattering * extinction) - 1) * horizonMix;
        const background = 0.1 * extinction + context.sunE * 19000 * extinction * sunDisk;
        const color = (incoming + background) * 0.04 + [0, 0.001, 0.0025][channel]! * 0.3;
        output[offset + channel] = Math.min(1, Math.max(minimum, tonemap(context.exposure * color) * context.whiteScale)) ** 2.2;
    }
}

function areaElement(x: number, y: number): number {
    return Math.atan2(x * y, Math.sqrt(x * x + y * y + 1));
}

/** @internal Deterministic asynchronous irradiance integration used by the loader and focused tests. */
export async function _computeProceduralSkyIrradiance(
    options: ProceduralSkyEnvironmentOptions,
    yieldTask: () => Promise<void> = createYieldTask(),
    isCurrent: () => boolean = () => true
): Promise<Float32Array | null> {
    const context = makeCpuContext(options);
    const faceAxes = [
        [1, 0, 0, 0, 0, -1, 0, -1, 0],
        [-1, 0, 0, 0, 0, 1, 0, -1, 0],
        [0, 1, 0, 1, 0, 0, 0, 0, 1],
        [0, -1, 0, 1, 0, 0, 0, 0, -1],
        [0, 0, 1, 1, 0, 0, 0, -1, 0],
        [0, 0, -1, -1, 0, 0, 0, -1, 0],
    ] as const;
    const basisConstants = [
        Math.sqrt(1 / (4 * Math.PI)),
        -Math.sqrt(3 / (4 * Math.PI)),
        Math.sqrt(3 / (4 * Math.PI)),
        -Math.sqrt(3 / (4 * Math.PI)),
        Math.sqrt(15 / (4 * Math.PI)),
        -Math.sqrt(15 / (4 * Math.PI)),
        Math.sqrt(5 / (16 * Math.PI)),
        -Math.sqrt(15 / (4 * Math.PI)),
        Math.sqrt(15 / (16 * Math.PI)),
    ] as const;
    const harmonics = new Float64Array(27);
    const sample = new F32(3);
    const du = 2 / FACE_SIZE;
    const halfTexel = du * 0.5;
    const minUv = halfTexel - 1;
    let totalSolidAngle = 0;
    for (let faceIndex = 0; faceIndex < faceAxes.length; faceIndex++) {
        const axes = faceAxes[faceIndex]!;
        let v = minUv;
        for (let py = 0; py < FACE_SIZE; py++, v += du) {
            let u = minUv;
            for (let px = 0; px < FACE_SIZE; px++, u += du) {
                const dx0 = axes[0] + axes[3] * u + axes[6] * v;
                const dy0 = axes[1] + axes[4] * u + axes[7] * v;
                const dz0 = axes[2] + axes[5] * u + axes[8] * v;
                const invLength = 1 / Math.hypot(dx0, dy0, dz0);
                const x = dx0 * invLength;
                const y = dy0 * invLength;
                const z = dz0 * invLength;
                const solidAngle =
                    areaElement(u - halfTexel, v - halfTexel) -
                    areaElement(u - halfTexel, v + halfTexel) -
                    areaElement(u + halfTexel, v - halfTexel) +
                    areaElement(u + halfTexel, v + halfTexel);
                // Side-face render-target rows are upside down at readback. The
                // dedicated up/down layers are swapped by the probe converter,
                // so their Y direction is already correct.
                writeSkyColor(sample, 0, x, faceIndex === 2 || faceIndex === 3 ? y : -y, z, context);
                const basis0 = basisConstants[0] * solidAngle;
                const basis1 = basisConstants[1] * y * solidAngle;
                const basis2 = basisConstants[2] * z * solidAngle;
                const basis3 = basisConstants[3] * x * solidAngle;
                const basis4 = basisConstants[4] * x * y * solidAngle;
                const basis5 = basisConstants[5] * y * z * solidAngle;
                const basis6 = basisConstants[6] * (3 * z * z - 1) * solidAngle;
                const basis7 = basisConstants[7] * x * z * solidAngle;
                const basis8 = basisConstants[8] * (x * x - y * y) * solidAngle;
                for (let channel = 0; channel < 3; channel++) {
                    const color = sample[channel]!;
                    const offset = channel * 9;
                    harmonics[offset] = harmonics[offset]! + color * basis0;
                    harmonics[offset + 1] = harmonics[offset + 1]! + color * basis1;
                    harmonics[offset + 2] = harmonics[offset + 2]! + color * basis2;
                    harmonics[offset + 3] = harmonics[offset + 3]! + color * basis3;
                    harmonics[offset + 4] = harmonics[offset + 4]! + color * basis4;
                    harmonics[offset + 5] = harmonics[offset + 5]! + color * basis5;
                    harmonics[offset + 6] = harmonics[offset + 6]! + color * basis6;
                    harmonics[offset + 7] = harmonics[offset + 7]! + color * basis7;
                    harmonics[offset + 8] = harmonics[offset + 8]! + color * basis8;
                }
                totalSolidAngle += solidAngle;
            }
            if ((py & 7) === 7) {
                if (!isCurrent()) {
                    return null;
                }
                await yieldTask();
                if (!isCurrent()) {
                    return null;
                }
            }
        }
    }
    const convolution = [Math.PI, (2 * Math.PI) / 3, (2 * Math.PI) / 3, (2 * Math.PI) / 3, Math.PI / 4, Math.PI / 4, Math.PI / 4, Math.PI / 4, Math.PI / 4];
    const correction = (4 * Math.PI) / totalSolidAngle / Math.PI;
    for (let channel = 0; channel < 3; channel++) {
        for (let band = 0; band < 9; band++) {
            const index = channel * 9 + band;
            harmonics[index] = harmonics[index]! * correction * convolution[band]!;
        }
    }
    const polynomial = new F32(27);
    for (let channel = 0; channel < 3; channel++) {
        const offset = channel * 9;
        const l00 = harmonics[offset]!;
        const l1_1 = harmonics[offset + 1]!;
        const l10 = harmonics[offset + 2]!;
        const l11 = harmonics[offset + 3]!;
        const l2_2 = harmonics[offset + 4]!;
        const l2_1 = harmonics[offset + 5]!;
        const l20 = harmonics[offset + 6]!;
        const l21 = harmonics[offset + 7]!;
        const l22 = harmonics[offset + 8]!;
        polynomial[channel] = (-l11 * 1.02333) / Math.PI;
        polynomial[3 + channel] = (-l1_1 * 1.02333) / Math.PI;
        polynomial[6 + channel] = (l10 * 1.02333) / Math.PI;
        polynomial[9 + channel] = (l00 * 0.886277 - l20 * 0.247708 + l22 * 0.429043) / Math.PI;
        polynomial[12 + channel] = (l00 * 0.886277 - l20 * 0.247708 - l22 * 0.429043) / Math.PI;
        polynomial[15 + channel] = (l00 * 0.886277 + l20 * 0.495417) / Math.PI;
        polynomial[18 + channel] = (-l2_1 * 0.858086) / Math.PI;
        polynomial[21 + channel] = (-l21 * 0.858086) / Math.PI;
        polynomial[24 + channel] = (l2_2 * 0.858086) / Math.PI;
    }
    return polynomial;
}

function validateOptions(options: ProceduralSkyEnvironmentOptions): void {
    const directionLength = Math.hypot(options.sunDirection[0], options.sunDirection[1], options.sunDirection[2]);
    if (
        !Number.isFinite(directionLength) ||
        !(directionLength > 0) ||
        !Number.isFinite(options.luminance) ||
        !(options.luminance > 0) ||
        !Number.isFinite(options.turbidity) ||
        !Number.isFinite(options.rayleigh) ||
        !Number.isFinite(options.mieCoefficient) ||
        !Number.isFinite(options.mieDirectionalG)
    ) {
        throw new Error("Procedural sky environment requires finite atmospheric parameters, a non-zero sun direction, and positive luminance.");
    }
}

function writeParameters(environment: ProceduralSkyEnvironment, options: ProceduralSkyEnvironmentOptions): void {
    const directionLength = Math.hypot(options.sunDirection[0], options.sunDirection[1], options.sunDirection[2]);
    const directionScale = 500 / directionLength;
    const parameters = new F32(8);
    parameters[0] = options.sunDirection[0] * directionScale;
    parameters[1] = options.sunDirection[1] * directionScale;
    parameters[2] = options.sunDirection[2] * directionScale;
    parameters[3] = options.luminance;
    parameters[4] = options.mieDirectionalG;
    parameters[5] = options.turbidity;
    parameters[6] = options.rayleigh;
    parameters[7] = options.mieCoefficient;
    environment._scene.surface.engine._device.queue.writeBuffer(environment._parameterBuffer, 0, parameters);
}

function submitSkyCube(environment: ProceduralSkyEnvironment, options: ProceduralSkyEnvironmentOptions): void {
    const scene = environment._scene;
    const engine = scene.surface.engine;
    const device = engine._device;
    writeParameters(environment, options);
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(environment._pipeline);
    pass.setBindGroup(0, environment._bindGroup);
    pass.dispatchWorkgroups(Math.ceil(FACE_SIZE / 8), Math.ceil(FACE_SIZE / 8), 6);
    pass.end();
    for (const faceMipmaps of environment._mipmaps) {
        recordPreparedMipmaps(encoder, faceMipmaps);
    }
    device.queue.submit([encoder.finish()]);
}

function createPreScaledHarmonics(irradiance: Float32Array): Float32Array {
    const harmonics = polynomialToPreScaledHarmonics(irradiance);
    for (const offset of [4, 16, 20]) {
        harmonics[offset] = -harmonics[offset]!;
        harmonics[offset + 1] = -harmonics[offset + 1]!;
        harmonics[offset + 2] = -harmonics[offset + 2]!;
    }
    return harmonics;
}

/** Compute the linear RGB sun color produced by the procedural atmosphere parameters. */
export function computeProceduralSkySunColor(options: ProceduralSkyEnvironmentOptions): [number, number, number] {
    validateOptions(options);
    const context = makeCpuContext(options);
    const output = new F32(3);
    writeSkyColor(output, 0, context.sunX, context.sunY, context.sunZ, context, 0.5);
    return [output[0]!, output[1]!, output[2]!];
}

/** Regenerate an active procedural environment. Returns false when superseded by a newer update. */
export async function updateProceduralSkyEnvironment(environment: ProceduralSkyEnvironment, options: ProceduralSkyEnvironmentOptions): Promise<boolean> {
    assertEnvironmentActive(environment);
    options = { ...options, sunDirection: [...options.sunDirection] };
    validateOptions(options);
    const revision = ++environment._revision;
    const irradiance = await _computeProceduralSkyIrradiance(
        options,
        environment._yield ?? createYieldTask(),
        () => environment._revision === revision && isEnvironmentActive(environment)
    );
    assertEnvironmentActive(environment);
    if (!irradiance || environment._revision !== revision) {
        return false;
    }
    const harmonics = createPreScaledHarmonics(irradiance);
    submitSkyCube(environment, options);
    assertEnvironmentActive(environment);
    const textures = environment._textures;
    textures.irradianceSH.set(irradiance);
    textures.sphericalHarmonics.set(harmonics);
    _invalidateSceneUboCaches(environment._scene);
    return true;
}

function isEnvironmentActive(environment: ProceduralSkyEnvironment): boolean {
    return !environment._disposed && !environment._scene._z && environment._scene._envTextures === environment._textures;
}

function assertEnvironmentActive(environment: ProceduralSkyEnvironment): void {
    if (environment._disposed || environment._scene._z) {
        throw new Error("Procedural sky environment has been disposed.");
    }
    if (!isEnvironmentActive(environment)) {
        throw new Error("Procedural sky environment no longer owns the scene environment.");
    }
}

/** Create, publish, and own a procedural PBR environment for an unregistered scene without an existing environment. */
export async function loadProceduralSkyEnvironment(scene: SceneContext, options: ProceduralSkyEnvironmentLoadOptions): Promise<ProceduralSkyEnvironment> {
    if (scene._z) {
        throw new Error("loadProceduralSkyEnvironment cannot load into a disposed scene.");
    }
    if (scene._envTextures) {
        throw new Error("loadProceduralSkyEnvironment requires a scene without an existing environment.");
    }
    if (scene._built) {
        throw new Error("loadProceduralSkyEnvironment must run before the scene is registered.");
    }
    const states = (_skyScenes ??= new WeakMap());
    if (states.has(scene)) {
        throw new Error("A procedural sky environment is already loading for this scene.");
    }
    options = { ...options, sunDirection: [...options.sunDirection] };
    validateOptions(options);
    const generation: SkySceneGeneration = { _current: null, _disposed: false };
    states.set(scene, generation);
    const engine = scene.surface.engine;
    let brdfImage: ImageBitmap | null = null;
    let brdfLut: GPUTexture | null = null;
    let texture: GPUTexture | null = null;
    let parameterBuffer: GPUBuffer | null = null;
    let textureRetained = false;
    let brdfRetained = false;
    const closeImage = (): void => {
        brdfImage?.close();
        brdfImage = null;
    };
    const isPending = (): boolean => !generation._disposed && !scene._z && !scene._built && !scene._envTextures && states.get(scene) === generation;
    const assertPending = (): void => {
        if (!isPending()) {
            throw new Error("Procedural sky environment initialization was cancelled: the scene was disposed, registered, or acquired another environment.");
        }
    };
    const dispose = (): void => {
        generation._disposed = true;
        const current = generation._current;
        if (current && !current._disposed) {
            current._disposed = true;
            current._revision++;
            if (scene._envTextures === current._textures) {
                scene._envTextures = undefined;
            }
        }
        parameterBuffer?.destroy();
        parameterBuffer = null;
        if (texture) {
            if (textureRetained) {
                releaseGPUTexture(texture);
            } else {
                texture.destroy();
            }
            texture = null;
        }
        if (brdfLut) {
            if (brdfRetained) {
                releaseGPUTexture(brdfLut);
            } else {
                brdfLut.destroy();
            }
            brdfLut = null;
        }
        textureRetained = brdfRetained = false;
        closeImage();
        if (states.get(scene) === generation) {
            states.delete(scene);
        }
    };
    scene._disposables.push(dispose);
    try {
        const imageReady = loadBrdfImage(options.brdfUrl).then((image) => {
            if (!isPending()) {
                image.close();
                assertPending();
            }
            brdfImage = image;
            return image;
        });
        const [irradiance, image] = await Promise.all([_computeProceduralSkyIrradiance(options, options._yield ?? createYieldTask(), isPending), imageReady]);
        assertPending();
        if (!irradiance) {
            throw new Error("Procedural sky environment initialization was cancelled.");
        }
        const rgbd = await import("./rgbd-decode.js");
        assertPending();
        try {
            brdfLut = rgbd.decodeBrdfPng(engine, image);
        } finally {
            closeImage();
        }
        assertPending();
        const device = engine._device;
        texture = device.createTexture({
            size: [FACE_SIZE, FACE_SIZE, 6],
            mipLevelCount: mipLevelCount(FACE_SIZE, FACE_SIZE),
            format: "rgba16float",
            usage: TU.TEXTURE_BINDING | TU.STORAGE_BINDING | TU.RENDER_ATTACHMENT,
        });
        const module = device.createShaderModule({ code: SKY_CUBE_WGSL });
        const pipeline = device.createComputePipeline({
            layout: "auto",
            compute: { module, entryPoint: "main" },
        });
        parameterBuffer = createEmptyUniformBuffer(engine, 32);
        const bindGroup = device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: texture.createView({ dimension: "2d-array", baseMipLevel: 0, mipLevelCount: 1 }) },
                { binding: 1, resource: { buffer: parameterBuffer } },
            ],
        });
        const mipmaps: PreparedMipmapLevel[][] = [];
        for (let face = 0; face < 6; face++) {
            mipmaps.push(prepareMipmaps(engine, texture, face));
        }
        const textures = assembleEnvironmentTextures(texture, brdfLut, irradiance, 0, engine, createPreScaledHarmonics(irradiance));
        const environment: ProceduralSkyEnvironment = {
            _scene: scene,
            _texture: texture,
            _parameterBuffer: parameterBuffer,
            _bindGroup: bindGroup,
            _pipeline: pipeline,
            _mipmaps: mipmaps,
            _textures: textures,
            _disposed: false,
            _revision: 0,
            _yield: options._yield,
        };
        assertPending();
        submitSkyCube(environment, options);
        assertPending();
        acquireGPUTexture(texture);
        textureRetained = true;
        acquireGPUTexture(brdfLut);
        brdfRetained = true;
        generation._current = environment;
        scene._envTextures = textures;
        registerEnvSceneUniforms(scene);
        return environment;
    } catch (error) {
        dispose();
        const index = scene._disposables.indexOf(dispose);
        if (index >= 0) {
            scene._disposables.splice(index, 1);
        }
        throw error;
    }
}

function createYieldTask(): () => Promise<void> {
    const scheduler = (globalThis as typeof globalThis & { scheduler?: { yield?: () => Promise<void> } }).scheduler;
    if (scheduler?.yield) {
        return scheduler.yield.bind(scheduler);
    }
    return () =>
        new Promise<void>((resolve) => {
            const channel = new MessageChannel();
            channel.port1.onmessage = () => {
                channel.port1.close();
                channel.port2.close();
                resolve();
            };
            channel.port2.postMessage(undefined);
        });
}
