import {
    createUniformEffectRenderTask,
    createUniformEffectWrapper,
    setUniformEffectUniforms,
    type Camera,
    type EngineContext,
    type RenderTarget,
    type SceneContext,
    type UniformEffectRenderTask,
} from "babylon-lite";
import { OCEAN_SUN_DIRECTION } from "./constants.js";
import type { OceanSkyParameter } from "./controls.js";

const SKY_FRAGMENT = `struct SkyParams{
cameraWorld:mat4x4f,
sunPosition:vec4f,
atmosphere:vec4f,
view:vec4f,
}
@group(0)@binding(0)var<uniform> params:SkyParams;

const PI=3.141592653589793;
const WAVELENGTH=vec3f(680e-9,550e-9,450e-9);
const MIE_K=vec3f(0.686,0.678,0.666);
const RAYLEIGH_ZENITH_LENGTH=8.4e3;
const MIE_ZENITH_LENGTH=1.25e3;
const SUN_ENERGY=1000.0;
const SUN_ANGULAR_DIAMETER_COS=0.9999566769464484;
const CUTOFF_ANGLE=PI/1.95;
const STEEPNESS=1.5;

fn simplifiedRayleigh()->vec3f{
return vec3f(0.0005)/vec3f(94.0,40.0,18.0);
}
fn totalMie(turbidity:f32)->vec3f{
let c=(0.2*turbidity)*10e-18;
return 0.434*c*PI*pow((2.0*PI)/WAVELENGTH,vec3f(2.0))*MIE_K;
}
fn rayleighPhase(cosTheta:f32)->f32{
return (3.0/(16.0*PI))*(1.0+cosTheta*cosTheta);
}
fn henyeyGreensteinPhase(cosTheta:f32,g:f32)->f32{
let gc=clamp(g,-0.999,0.999);let ct=clamp(cosTheta,-1.0,1.0);let g2=gc*gc;
return (1.0/(4.0*PI))*((1.0-g2)/pow(1.0-2.0*gc*ct+g2,1.5));
}
fn sunIntensity(zenithCos:f32)->f32{
return SUN_ENERGY*max(0.0,1.0-exp(-(CUTOFF_ANGLE-acos(clamp(zenithCos,-1.0,1.0)))/STEEPNESS));
}
fn uncharted2Tonemap(x:vec3f)->vec3f{
let a=0.15;let b=0.5;let c=0.1;let d=0.2;let e=0.02;let f=0.3;
return ((x*(a*x+c*b)+d*e)/(x*(a*x+b)+d*f))-e/f;
}
@fragment fn effectFragment(input:EffectVertexOutput)->@location(0) vec4f{
let screen=input.uv*2.0-1.0;
let localDirection=normalize(vec3f(screen.x*params.view.y*params.view.z,screen.y*params.view.z,1.0));
let direction=normalize((params.cameraWorld*vec4f(localDirection,0.0)).xyz);
let up=vec3f(0.0,1.0,0.0);
let sunDirection=normalize(params.sunPosition.xyz);
let sunFade=1.0-clamp(1.0-exp(params.sunPosition.y/450000.0),0.0,1.0);
let rayleighCoefficient=params.atmosphere.z-(1.0-sunFade);
let sunE=sunIntensity(dot(sunDirection,up));
let betaR=simplifiedRayleigh()*rayleighCoefficient;
let betaM=totalMie(params.atmosphere.y)*params.atmosphere.w;
let zenithAngle=acos(max(0.0,dot(up,direction)));
let opticalDenominator=cos(zenithAngle)+0.15*pow(93.885-zenithAngle*180.0/PI,-1.253);
let rayleighLength=RAYLEIGH_ZENITH_LENGTH/opticalDenominator;
let mieLength=MIE_ZENITH_LENGTH/opticalDenominator;
let extinction=exp(-(betaR*rayleighLength+betaM*mieLength));
let cosTheta=dot(direction,sunDirection);
let betaRayleighTheta=betaR*rayleighPhase(cosTheta*0.5+0.5);
let betaMieTheta=betaM*henyeyGreensteinPhase(cosTheta,params.view.x);
let scattering=sunE*((betaRayleighTheta+betaMieTheta)/(betaR+betaM));
var incoming=pow(scattering*(1.0-extinction),vec3f(1.5));
let horizonMix=clamp(pow(1.0-dot(up,sunDirection),5.0),0.0,1.0);
incoming*=mix(vec3f(1.0),pow(scattering*extinction,vec3f(0.5)),vec3f(horizonMix));
var background=vec3f(0.1)*extinction;
let sunDisk=smoothstep(SUN_ANGULAR_DIAMETER_COS,SUN_ANGULAR_DIAMETER_COS+0.00002,cosTheta);
background+=sunE*19000.0*extinction*sunDisk;
var color=(incoming+background)*0.04;
color+=vec3f(0.0,0.001,0.0025)*0.3;
let whiteScale=vec3f(1.0)/uncharted2Tonemap(vec3f(1000.0));
let exposure=log2(2.0/pow(params.atmosphere.x,4.0));
return vec4f(clamp(uncharted2Tonemap(exposure*color)*whiteScale,vec3f(0.0),vec3f(1.0)),1.0);
}`;

export interface OceanSky {
    readonly task: UniformEffectRenderTask;
    setSunDirection(direction: readonly [number, number, number]): void;
    setParameter(name: OceanSkyParameter, value: number): void;
    update(camera: Camera, width: number, height: number): void;
}

export function createOceanSky(engine: EngineContext, scene: SceneContext, target: RenderTarget): OceanSky {
    const effect = createUniformEffectWrapper(engine, {
        name: "ocean-sky",
        fragmentWGSL: SKY_FRAGMENT,
        uniformByteLength: 112,
    });
    const uniforms = new Float32Array(28);
    uniforms.set([OCEAN_SUN_DIRECTION[0] * 500, OCEAN_SUN_DIRECTION[1] * 500, OCEAN_SUN_DIRECTION[2] * 500, 0], 16);
    uniforms.set([1, 10, 2, 0.005], 20);
    uniforms[24] = 0.8;
    let cameraVersion = -1;
    let viewAspect = -1;
    let viewFov = -1;
    setUniformEffectUniforms(effect, uniforms);
    return {
        task: createUniformEffectRenderTask({ name: "ocean-sky", effect, target, clear: true }, engine, scene),
        setSunDirection(direction: readonly [number, number, number]): void {
            uniforms[16] = direction[0] * 500;
            uniforms[17] = direction[1] * 500;
            uniforms[18] = direction[2] * 500;
            setUniformEffectUniforms(effect, uniforms);
        },
        setParameter(name: OceanSkyParameter, value: number): void {
            const index = name === "luminance" ? 20 : name === "turbidity" ? 21 : name === "rayleigh" ? 22 : name === "mieCoefficient" ? 23 : name === "mieDirectionalG" ? 24 : -1;
            if (index >= 0) {
                uniforms[index] = value;
                setUniformEffectUniforms(effect, uniforms);
            }
        },
        update(camera: Camera, width: number, height: number): void {
            const aspect = width / Math.max(height, 1);
            if (cameraVersion === camera.worldMatrixVersion && viewAspect === aspect && viewFov === camera.fov) {
                return;
            }
            uniforms.set(camera.worldMatrix, 0);
            uniforms[25] = aspect;
            uniforms[26] = Math.tan(camera.fov * 0.5);
            setUniformEffectUniforms(effect, uniforms);
            cameraVersion = camera.worldMatrixVersion;
            viewAspect = aspect;
            viewFov = camera.fov;
        },
    };
}
