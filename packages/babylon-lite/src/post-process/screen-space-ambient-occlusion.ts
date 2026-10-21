/**
 * Screen-space ambient occlusion — a frame-graph post-process task producing
 * depth-derived, horizon-based occlusion with bilateral denoising, temporal
 * accumulation, and an optional multiply composite (see
 * `docs/lite/architecture/52-screen-space-effects.md`).
 *
 * The producer and blur passes bind the scene depth attachment as
 * `texture_depth_2d`; this task therefore owns dedicated WebGPU pipelines.
 * Temporal resolve and history-copy are delegated to the shared scalar owner.
 */

import { F32 } from "../engine/typed-arrays.js";
import { SS, BU } from "../engine/gpu-flags.js";
import type { Camera } from "../camera/camera.js";
import { getEffectiveAspectRatio, getViewMatrix, getViewProjectionMatrix, _cameraChangeKey } from "../camera/camera.js";
import type { EngineContext } from "../engine/engine.js";
import type { RenderTarget } from "../engine/render-target.js";
import { buildRenderTarget, createRenderTarget, disposeRenderTarget } from "../engine/render-target.js";
import { invertMat4 } from "../math/invert-mat4.js";
import { packMat4IntoF32 } from "../math/pack-mat4-into-f32.js";
import { createPostProcessTask, type PostProcessTask } from "../frame-graph/post-process-task.js";
import type { Task } from "../frame-graph/task.js";
import type { SceneContext } from "../scene/scene-core.js";
import { screenSpaceRaymarchWGSL } from "./screen-space-raymarch-wgsl.js";
import {
    advanceAccumulation,
    advancePhaseIndex,
    assertScreenSpaceTargetNotAliasingSource,
    computeScreenSpaceScaledSize,
    computeTemporalWeight,
    createScreenSpaceTemporalOwner,
    decideScreenSpaceReset,
    identityChanged,
    phaseValue,
    resolveScreenSpaceSourceSize,
} from "./screen-space-temporal.js";
import type { ScreenSpaceTemporalOwner } from "./screen-space-temporal.js";
import { wgsl } from "../shader/wgsl.js";

/** Configuration for `createScreenSpaceAmbientOcclusionPostProcessTask`. */
export interface ScreenSpaceAmbientOcclusionPostProcessTaskConfig {
    name?: string;
    /** Scene color + depth target already rendered this frame (single-sample). */
    sourceTexture: RenderTarget;
    /** Depth attachment source, when different from `sourceTexture` (must be single-sample). */
    depthTexture?: RenderTarget;
    /** Must use a fullscreen viewport (omitted, or x/y = 0 and width/height = 1). */
    camera: Camera;
    /** Composite destination. `null`/omitted composites over `sourceTexture`; must differ from it. */
    targetTexture?: RenderTarget | null;
    resolutionScale?: number;
    intensity?: number;
    /** World-space search radius in scene units. */
    radius?: number;
    /** Minimum view-direction cosine considered an occluding horizon. */
    bias?: number;
    power?: number;
    sliceCount?: number;
    stepCount?: number;
    fadeStart?: number;
    fadeEnd?: number;
    temporalWeight?: number;
    temporalSamples?: number;
    resetVersion?: number;
    composition?: "none" | "multiply";
}

/** A screen-space ambient-occlusion frame-graph task. Mutable fields are sampled fresh each frame. */
export interface ScreenSpaceAmbientOcclusionPostProcessTask extends Task {
    readonly name: string;
    readonly sourceTexture: RenderTarget;
    readonly depthTexture: RenderTarget;
    readonly targetTexture: RenderTarget | null;
    outputTexture: RenderTarget;
    /** The resolved occlusion target (`rg16float`: occlusion amount in `.r`, view distance in `.g`). */
    readonly occlusionTexture: RenderTarget;
    enabled: boolean;
    intensity: number;
    radius: number;
    bias: number;
    power: number;
    sliceCount: number;
    stepCount: number;
    fadeStart: number;
    fadeEnd: number;
    temporalWeight: number;
    resetVersion: number;
}

const CLAMP = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** Clamp raw config into safe ranges (see the architecture doc's ambient-occlusion table). */
export function clampScreenSpaceAmbientOcclusionConfig(config: ScreenSpaceAmbientOcclusionPostProcessTaskConfig): {
    resolutionScale: number;
    intensity: number;
    radius: number;
    bias: number;
    power: number;
    sliceCount: number;
    stepCount: number;
    fadeStart: number;
    fadeEnd: number;
    temporalWeight: number;
    temporalSamples: number;
} {
    const fadeStart = CLAMP(config.fadeStart ?? 20, 0, 100000);
    return {
        resolutionScale: CLAMP(config.resolutionScale ?? 0.5, 0.25, 1),
        intensity: CLAMP(config.intensity ?? 1, 0, 4),
        radius: CLAMP(config.radius ?? 0.5, 0.01, 20),
        bias: CLAMP(config.bias ?? 0.05, 0, 0.99),
        power: CLAMP(config.power ?? 1.5, 0.1, 8),
        sliceCount: Math.round(CLAMP(config.sliceCount ?? 3, 1, 8)),
        stepCount: Math.round(CLAMP(config.stepCount ?? 4, 1, 8)),
        fadeStart,
        fadeEnd: Math.max(config.fadeEnd ?? 60, fadeStart + 0.001),
        temporalWeight: CLAMP(config.temporalWeight ?? 1 / 32, 0, 1),
        temporalSamples: Math.round(CLAMP(config.temporalSamples ?? 64, 1, 256)),
    };
}

/** Producer uniform layout: 44 floats / 176 bytes (16-byte aligned). */
export const SS_AO_PRODUCER_UNIFORM_FLOATS = 44;
const SS_AO_PRODUCER_UNIFORM_BYTES = SS_AO_PRODUCER_UNIFORM_FLOATS * 4;
/** Blur uniform layout: 40 floats / 160 bytes (16-byte aligned). */
const SS_AO_BLUR_UNIFORM_FLOATS = 40;
const SS_AO_BLUR_UNIFORM_BYTES = SS_AO_BLUR_UNIFORM_FLOATS * 4;

const AO_PRODUCER_UNIFORM_WGSL = wgsl`struct SsAoParams{invViewProj:mat4x4f,view:mat4x4f,outputDims:vec2f,depthDims:vec2f,radius:f32,bias:f32,power:f32,fadeStart:f32,fadeEnd:f32,sliceCount:f32,stepCount:f32,phase:f32}`;
const AO_PRODUCER_BINDINGS_WGSL = wgsl`@group(0)@binding(0) var ssAoDepth:texture_depth_2d;
@group(0)@binding(1) var<uniform> ssAo:SsAoParams;`;

const AO_FULLSCREEN_VERTEX_WGSL = wgsl`struct SsAoVOut{@builtin(position) position:vec4f}
@vertex fn ssAoVertex(@builtin(vertex_index) i:u32)->SsAoVOut{
  let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[i];
  return SsAoVOut(vec4f(p,0,1));
}`;

const AO_PRODUCER_FRAGMENT_WGSL = wgsl`@fragment fn ssAoFragment(v:SsAoVOut)->@location(0) vec4f{
  let coord=vec2i(v.position.xy);
  let uv=ssTexelUv(coord,ssAo.outputDims);
  let depthCoord=ssUvToCoord(uv,ssAo.depthDims);
  let depth=textureLoad(ssAoDepth,depthCoord,0);
  if(ssIsClearDepth(depth)){return vec4f(0.0);}

  let depthUv=ssTexelUv(depthCoord,ssAo.depthDims);
  let worldPos=ssWorldFromDepth(depthUv,depth,ssAo.invViewProj);
  let viewPos=(ssAo.view*vec4f(worldPos,1.0)).xyz;
  let fade=1.0-smoothstep(ssAo.fadeStart,ssAo.fadeEnd,abs(viewPos.z));
  if(fade<=0.0){return vec4f(0.0);}
  let rayNear=ssWorldFromDepth(depthUv,1.0,ssAo.invViewProj);
  let rayFar=ssWorldFromDepth(depthUv,0.5,ssAo.invViewProj);
  let towardViewer=(ssAo.view*vec4f(rayNear-rayFar,0.0)).xyz;
  var normal=normalize((ssAo.view*vec4f(ssNormalFromDepth(depthUv,ssAo.depthDims,ssAo.invViewProj,ssAoDepth),0.0)).xyz);
  if(dot(normal,towardViewer)<0.0){normal=-normal;}

  let adjacentX=ssWorldFromDepth(depthUv+vec2f(1.0/ssAo.depthDims.x,0.0),depth,ssAo.invViewProj);
  let adjacentY=ssWorldFromDepth(depthUv+vec2f(0.0,1.0/ssAo.depthDims.y),depth,ssAo.invViewProj);
  let worldPerUvX=length(adjacentX-worldPos)*ssAo.depthDims.x;
  let worldPerUvY=length(adjacentY-worldPos)*ssAo.depthDims.y;
  let radiusUv=vec2f(ssAo.radius)/max(vec2f(worldPerUvX,worldPerUvY),vec2f(1e-4));
  let sliceCount=max(1u,u32(ssAo.sliceCount));
  let stepCount=max(1u,u32(ssAo.stepCount));
  let jitter=ssPhaseAngle(vec2f(coord)+vec2f(19.0,73.0),ssAo.phase);
  let rotation=ssPhaseAngle(vec2f(coord),ssAo.phase)*6.28318530718;
  var occlusion=0.0;

  for(var slice:u32=0u;slice<sliceCount;slice=slice+1u){
    let angle=rotation+3.14159265359*(f32(slice)+0.5)/f32(sliceCount);
    let direction=vec2f(cos(angle),sin(angle));
    for(var side:u32=0u;side<2u;side=side+1u){
      let signedDirection=direction*select(-1.0,1.0,side==0u);
      var horizon=0.0;
      for(var step:u32=0u;step<stepCount;step=step+1u){
        let fraction=(f32(step)+jitter)/f32(stepCount);
        let sampleUv=depthUv+signedDirection*radiusUv*fraction;
        if(sampleUv.x<0.0||sampleUv.x>1.0||sampleUv.y<0.0||sampleUv.y>1.0){continue;}
        if(length((sampleUv-depthUv)*ssAo.depthDims)<1.0){continue;}
        let sampleCoord=ssUvToCoord(sampleUv,ssAo.depthDims);
        let sampleDepth=textureLoad(ssAoDepth,sampleCoord,0);
        if(ssIsClearDepth(sampleDepth)){continue;}
        let sampleWorld=ssWorldFromDepth(ssTexelUv(sampleCoord,ssAo.depthDims),sampleDepth,ssAo.invViewProj);
        let sampleView=(ssAo.view*vec4f(sampleWorld,1.0)).xyz;
        let delta=sampleView-viewPos;
        let distance=length(delta);
        if(distance<=1e-4||distance>ssAo.radius){continue;}
        let cosine=dot(normal,delta/distance);
        let radialWeight=1.0-(distance/ssAo.radius)*(distance/ssAo.radius);
        horizon=max(horizon,clamp((cosine-ssAo.bias)/max(1.0-ssAo.bias,1e-4),0.0,1.0)*radialWeight);
      }
      occlusion=occlusion+horizon;
    }
  }

  let averageOcclusion=clamp(occlusion/f32(sliceCount*2u),0.0,1.0);
  let shaped=pow(averageOcclusion,ssAo.power);
  return vec4f(shaped*fade,0.0,0.0,0.0);
}`;

/** Full depth-horizon producer shader module source. Exported for WGSL-contract unit tests. */
export function screenSpaceAmbientOcclusionProducerWGSL(): string {
    return wgsl`${AO_FULLSCREEN_VERTEX_WGSL}\n${AO_PRODUCER_UNIFORM_WGSL}\n${AO_PRODUCER_BINDINGS_WGSL}\n${screenSpaceRaymarchWGSL()}\n${AO_PRODUCER_FRAGMENT_WGSL}`;
}

const AO_BLUR_UNIFORM_WGSL = wgsl`struct SsAoBlurParams{invViewProj:mat4x4f,view:mat4x4f,effectDims:vec2f,depthDims:vec2f,direction:vec2f,depthSigma:f32,p0:f32}`;
const AO_BLUR_BINDINGS_WGSL = wgsl`@group(0)@binding(0) var ssAoBlurDepth:texture_depth_2d;
@group(0)@binding(1) var ssAoInput:texture_2d<f32>;
@group(0)@binding(2) var<uniform> ssAoBlur:SsAoBlurParams;`;
const AO_BLUR_FRAGMENT_WGSL = wgsl`@fragment fn ssAoBlurFragment(v:SsAoVOut)->@location(0) vec4f{
  let coord=vec2i(v.position.xy);
  let uv=ssTexelUv(coord,ssAoBlur.effectDims);
  let centerDepth=textureLoad(ssAoBlurDepth,ssUvToCoord(uv,ssAoBlur.depthDims),0);
  if(ssIsClearDepth(centerDepth)){return vec4f(0.0);}
  let centerWorld=ssWorldFromDepth(uv,centerDepth,ssAoBlur.invViewProj);
  let centerDistance=abs((ssAoBlur.view*vec4f(centerWorld,1.0)).z);
  let offsets=array<i32,5>(-2,-1,0,1,2);
  let spatialWeights=array<f32,5>(0.2,0.55,1.0,0.55,0.2);
  var sum=0.0;
  var totalWeight=0.0;
  for(var i:u32=0u;i<5u;i=i+1u){
    let tapCoord=ssClampCoord(coord+vec2i(ssAoBlur.direction*f32(offsets[i])),ssAoBlur.effectDims);
    let tapUv=ssTexelUv(tapCoord,ssAoBlur.effectDims);
    let tapDepth=textureLoad(ssAoBlurDepth,ssUvToCoord(tapUv,ssAoBlur.depthDims),0);
    if(ssIsClearDepth(tapDepth)){continue;}
    let tapWorld=ssWorldFromDepth(tapUv,tapDepth,ssAoBlur.invViewProj);
    let tapDistance=abs((ssAoBlur.view*vec4f(tapWorld,1.0)).z);
    let relativeDepth=abs(tapDistance-centerDistance)/max(centerDistance,0.001);
    let depthWeight=exp(-relativeDepth/max(ssAoBlur.depthSigma,1e-4));
    let weight=spatialWeights[i]*depthWeight;
    sum=sum+textureLoad(ssAoInput,tapCoord,0).r*weight;
    totalWeight=totalWeight+weight;
  }
  return vec4f(sum/max(totalWeight,1e-4),0.0,0.0,0.0);
}`;

/** Full bilateral blur shader module source. */
export function screenSpaceAmbientOcclusionBlurWGSL(): string {
    return wgsl`${AO_FULLSCREEN_VERTEX_WGSL}\n${AO_BLUR_UNIFORM_WGSL}\n${AO_BLUR_BINDINGS_WGSL}\n${screenSpaceRaymarchWGSL()}\n${AO_BLUR_FRAGMENT_WGSL}`;
}

const AO_COMPOSITE_TEXTURE_WGSL = wgsl`@group(0)@binding(2) var ssAoTexture:texture_2d<f32>;`;
const AO_COMPOSITE_UNIFORM_WGSL = wgsl`struct SsAoCompositeParams{intensity:f32,enabled:f32,p0:f32,p1:f32}
@group(0)@binding(3) var<uniform> ssAoComposite:SsAoCompositeParams;`;
const AO_COMPOSITE_FRAGMENT_WGSL = wgsl`fn applyPostProcess(color:vec4f,uv:vec2f)->vec4f{
  if(ssAoComposite.enabled<0.5){return color;}
  let occlusion=textureSample(ssAoTexture,sourceSampler,uv).r;
  let amount=clamp(occlusion*ssAoComposite.intensity,0.0,1.0);
  return vec4f(color.rgb*(1.0-amount),color.a);
}`;

/**
 * Create a screen-space ambient-occlusion post-process task.
 * @param config - Source/depth textures, camera, and effect parameters.
 * @param engine - The owning engine.
 * @param scene - Optional owning scene.
 * @returns The ambient-occlusion task. Add it after the source render task.
 */
export function createScreenSpaceAmbientOcclusionPostProcessTask(
    config: ScreenSpaceAmbientOcclusionPostProcessTaskConfig,
    engine: EngineContext,
    scene?: SceneContext
): ScreenSpaceAmbientOcclusionPostProcessTask {
    const name = config.name ?? "screen-space-ambient-occlusion";
    const camera = config.camera;
    function assertFullscreenViewport(): void {
        const viewport = camera.viewport;
        if (viewport && (viewport.x !== 0 || viewport.y !== 0 || viewport.width !== 1 || viewport.height !== 1)) {
            throw new Error(`ScreenSpaceAmbientOcclusionPostProcessTask "${name}": camera.viewport must be fullscreen (x=0, y=0, width=1, height=1).`);
        }
    }
    assertFullscreenViewport();
    const source = config.sourceTexture;
    const depthSource = config.depthTexture ?? source;
    if ((source._descriptor.samples ?? 1) !== 1) {
        throw new Error(`ScreenSpaceAmbientOcclusionPostProcessTask "${name}": sourceTexture must be single-sample.`);
    }
    if ((depthSource._descriptor.samples ?? 1) !== 1) {
        throw new Error(`ScreenSpaceAmbientOcclusionPostProcessTask "${name}": depthTexture must be single-sample.`);
    }
    if (!depthSource._descriptor.dFormat) {
        throw new Error(`ScreenSpaceAmbientOcclusionPostProcessTask "${name}": depth source has no depth attachment.`);
    }
    assertScreenSpaceTargetNotAliasingSource(`ScreenSpaceAmbientOcclusionPostProcessTask "${name}"`, config.targetTexture, source);

    const clamped = clampScreenSpaceAmbientOcclusionConfig(config);
    const params = {
        camera,
        enabled: true,
        composition: config.composition ?? "multiply",
        resetVersion: config.resetVersion ?? 0,
        ...clamped,
    };

    const raw = createRenderTarget({ lbl: `${name}-raw`, format: "r8unorm", samples: 1, size: { width: 1, height: 1 } });
    const blurHorizontal = createRenderTarget({ lbl: `${name}-blur-horizontal`, format: "r8unorm", samples: 1, size: { width: 1, height: 1 } });
    const blurVertical = createRenderTarget({ lbl: `${name}-blur-vertical`, format: "r8unorm", samples: 1, size: { width: 1, height: 1 } });
    const owner: ScreenSpaceTemporalOwner = createScreenSpaceTemporalOwner({ name, kind: "scalar", engine, scene });

    let producerPipeline: GPURenderPipeline | null = null;
    let producerBindGroupLayout: GPUBindGroupLayout | null = null;
    let producerBindGroup: GPUBindGroup | null = null;
    let producerUniformBuffer: GPUBuffer | null = null;
    const producerUniformData = new F32(SS_AO_PRODUCER_UNIFORM_FLOATS);
    let blurPipeline: GPURenderPipeline | null = null;
    let blurBindGroupLayout: GPUBindGroupLayout | null = null;
    let horizontalBlurBindGroup: GPUBindGroup | null = null;
    let verticalBlurBindGroup: GPUBindGroup | null = null;
    let horizontalBlurUniformBuffer: GPUBuffer | null = null;
    let verticalBlurUniformBuffer: GPUBuffer | null = null;
    const horizontalBlurUniformData = new F32(SS_AO_BLUR_UNIFORM_FLOATS);
    const verticalBlurUniformData = new F32(SS_AO_BLUR_UNIFORM_FLOATS);
    let boundDepthForProducer: GPUTexture | null = null;
    let boundDepthForBlur: GPUTexture | null = null;
    let boundRawForBlur: GPUTexture | null = null;
    let boundHorizontalForBlur: GPUTexture | null = null;
    let boundVerticalForBlur: GPUTexture | null = null;

    const composite: PostProcessTask | null =
        params.composition === "none"
            ? null
            : createPostProcessTask(
                  {
                      name: `${name}-composite`,
                      sourceTexture: source,
                      sourceSamplingMode: "linear",
                      targetTexture: config.targetTexture ?? null,
                      _shader: {
                          extraTextureWGSL: AO_COMPOSITE_TEXTURE_WGSL,
                          extraTextures: [owner.stableTexture],
                          uniformWGSL: AO_COMPOSITE_UNIFORM_WGSL,
                          uniformBinding: 3,
                          uniformByteLength: 16,
                          writeUniforms(data) {
                              data[0] = task.intensity;
                              data[1] = task.enabled ? 1 : 0;
                          },
                          fragmentWGSL: AO_COMPOSITE_FRAGMENT_WGSL,
                      },
                  },
                  engine,
                  scene
              );

    let width = 0;
    let height = 0;
    let firstFrame = true;
    let pendingReallocation = false;
    let lastEnabled: boolean | undefined;
    let lastResetVersion: number | undefined;
    let lastDepthTexture: GPUTexture | null = null;
    let lastCameraKey = -1;
    let accumulatedSamples = 1;
    let phaseIndex = 0;
    let previousInverseWasSingular = false;

    function ensurePipelines(): void {
        if (producerPipeline && blurPipeline) {
            return;
        }
        const device = engine._device;
        producerBindGroupLayout = device.createBindGroupLayout({
            label: `${name}-producer-bgl`,
            entries: [
                { binding: 0, visibility: SS.FRAGMENT, texture: { sampleType: "depth" } },
                { binding: 1, visibility: SS.FRAGMENT, buffer: { type: "uniform" } },
            ],
        });
        const producerModule = device.createShaderModule({ label: `${name}-producer`, code: screenSpaceAmbientOcclusionProducerWGSL() });
        producerPipeline = device.createRenderPipeline({
            label: `${name}-producer-pipeline`,
            layout: device.createPipelineLayout({ label: `${name}-producer-layout`, bindGroupLayouts: [producerBindGroupLayout] }),
            vertex: { module: producerModule, entryPoint: "ssAoVertex" },
            fragment: { module: producerModule, entryPoint: "ssAoFragment", targets: [{ format: "r8unorm" }] },
            primitive: { topology: "triangle-list" },
        });
        producerUniformBuffer = device.createBuffer({ label: `${name}-producer-uniforms`, size: SS_AO_PRODUCER_UNIFORM_BYTES, usage: BU.UNIFORM | BU.COPY_DST });

        blurBindGroupLayout = device.createBindGroupLayout({
            label: `${name}-blur-bgl`,
            entries: [
                { binding: 0, visibility: SS.FRAGMENT, texture: { sampleType: "depth" } },
                { binding: 1, visibility: SS.FRAGMENT, texture: { sampleType: "float" } },
                { binding: 2, visibility: SS.FRAGMENT, buffer: { type: "uniform" } },
            ],
        });
        const blurModule = device.createShaderModule({ label: `${name}-blur`, code: screenSpaceAmbientOcclusionBlurWGSL() });
        blurPipeline = device.createRenderPipeline({
            label: `${name}-blur-pipeline`,
            layout: device.createPipelineLayout({ label: `${name}-blur-layout`, bindGroupLayouts: [blurBindGroupLayout] }),
            vertex: { module: blurModule, entryPoint: "ssAoVertex" },
            fragment: { module: blurModule, entryPoint: "ssAoBlurFragment", targets: [{ format: "r8unorm" }] },
            primitive: { topology: "triangle-list" },
        });
        horizontalBlurUniformBuffer = device.createBuffer({ label: `${name}-blur-horizontal-uniforms`, size: SS_AO_BLUR_UNIFORM_BYTES, usage: BU.UNIFORM | BU.COPY_DST });
        verticalBlurUniformBuffer = device.createBuffer({ label: `${name}-blur-vertical-uniforms`, size: SS_AO_BLUR_UNIFORM_BYTES, usage: BU.UNIFORM | BU.COPY_DST });
    }

    function rebuildProducerBindGroup(): void {
        producerBindGroup = engine._device.createBindGroup({
            label: `${name}-producer-bind-group`,
            layout: producerBindGroupLayout!,
            entries: [
                { binding: 0, resource: depthSource._depthTexture!.createView({ aspect: "depth-only" }) },
                { binding: 1, resource: { buffer: producerUniformBuffer! } },
            ],
        });
        boundDepthForProducer = depthSource._depthTexture!;
    }

    function rebuildBlurBindGroups(): void {
        horizontalBlurBindGroup = engine._device.createBindGroup({
            label: `${name}-blur-horizontal-bind-group`,
            layout: blurBindGroupLayout!,
            entries: [
                { binding: 0, resource: depthSource._depthTexture!.createView({ aspect: "depth-only" }) },
                { binding: 1, resource: raw._colorView! },
                { binding: 2, resource: { buffer: horizontalBlurUniformBuffer! } },
            ],
        });
        verticalBlurBindGroup = engine._device.createBindGroup({
            label: `${name}-blur-vertical-bind-group`,
            layout: blurBindGroupLayout!,
            entries: [
                { binding: 0, resource: depthSource._depthTexture!.createView({ aspect: "depth-only" }) },
                { binding: 1, resource: blurHorizontal._colorView! },
                { binding: 2, resource: { buffer: verticalBlurUniformBuffer! } },
            ],
        });
        boundDepthForBlur = depthSource._depthTexture!;
        boundRawForBlur = raw._colorTexture;
        boundHorizontalForBlur = blurHorizontal._colorTexture;
        boundVerticalForBlur = blurVertical._colorTexture;
    }

    function buildAoTarget(target: RenderTarget, targetWidth: number, targetHeight: number): void {
        target._eager = false;
        disposeRenderTarget(target);
        target._descriptor.size = { width: targetWidth, height: targetHeight };
        buildRenderTarget(target, engine);
        target._eager = true;
    }

    const task: ScreenSpaceAmbientOcclusionPostProcessTask = {
        name,
        engine,
        scene,
        _passes: [],
        sourceTexture: source,
        depthTexture: depthSource,
        targetTexture: config.targetTexture ?? null,
        outputTexture: composite ? composite.outputTexture : owner.stableTexture,
        occlusionTexture: owner.stableTexture,
        enabled: true,
        intensity: params.intensity,
        radius: params.radius,
        bias: params.bias,
        power: params.power,
        sliceCount: params.sliceCount,
        stepCount: params.stepCount,
        fadeStart: params.fadeStart,
        fadeEnd: params.fadeEnd,
        temporalWeight: params.temporalWeight,
        resetVersion: params.resetVersion,
        record(): void {
            assertFullscreenViewport();
            ensurePipelines();
            const srcSize = resolveScreenSpaceSourceSize(depthSource);
            const scaled = computeScreenSpaceScaledSize(srcSize.width, srcSize.height, params.resolutionScale);
            if (scaled.width !== width || scaled.height !== height) {
                width = scaled.width;
                height = scaled.height;
                buildAoTarget(raw, width, height);
                buildAoTarget(blurHorizontal, width, height);
                buildAoTarget(blurVertical, width, height);
                producerBindGroup = null;
                horizontalBlurBindGroup = null;
                verticalBlurBindGroup = null;
                pendingReallocation = true;
            }
            if (owner.record(width, height)) {
                pendingReallocation = true;
            }
            composite?.record();
            task.outputTexture = composite ? composite.outputTexture : owner.stableTexture;
        },
        execute(): number {
            assertFullscreenViewport();
            if (!task.enabled) {
                if (lastEnabled) {
                    owner.clearIdentity();
                }
                lastEnabled = false;
                lastResetVersion = task.resetVersion;
                firstFrame = false;
                pendingReallocation = false;
                composite?.updateUniforms();
                return composite?.execute?.() ?? 0;
            }

            const aspect = getEffectiveAspectRatio(params.camera, depthSource._width || 1, depthSource._height || 1);
            const viewProj = getViewProjectionMatrix(params.camera, aspect);
            const invViewProj = invertMat4(viewProj);
            const viewMatrix = getViewMatrix(params.camera);
            const cameraKey = _cameraChangeKey(params.camera);
            const cameraMoved = cameraKey !== lastCameraKey;
            lastCameraKey = cameraKey;

            if (!invViewProj) {
                previousInverseWasSingular = true;
                lastEnabled = true;
                lastResetVersion = task.resetVersion;
                firstFrame = false;
                pendingReallocation = false;
                owner.clearIdentity();
                composite?.updateUniforms();
                return composite?.execute?.() ?? 0;
            }

            const depthIdentityChanged = identityChanged(lastDepthTexture, depthSource._depthTexture);
            const reset = decideScreenSpaceReset({
                firstAllocation: firstFrame,
                targetReallocated: pendingReallocation,
                sourceIdentityChanged: depthIdentityChanged || previousInverseWasSingular,
                resetVersionChanged: task.resetVersion !== lastResetVersion,
                enabledTransitionedOn: !lastEnabled,
                singularInverse: false,
                cameraMoved,
            });
            previousInverseWasSingular = false;

            accumulatedSamples = advanceAccumulation(accumulatedSamples, reset.invalidateHistory, params.temporalSamples);
            const weight = computeTemporalWeight(CLAMP(task.temporalWeight, 0, 1), accumulatedSamples);
            phaseIndex = advancePhaseIndex(phaseIndex, reset.restartPhase);
            const phase = phaseValue(phaseIndex, params.temporalSamples);

            if (identityChanged(boundDepthForProducer, depthSource._depthTexture) || !producerBindGroup) {
                rebuildProducerBindGroup();
            }
            if (
                identityChanged(boundDepthForBlur, depthSource._depthTexture) ||
                identityChanged(boundRawForBlur, raw._colorTexture) ||
                identityChanged(boundHorizontalForBlur, blurHorizontal._colorTexture) ||
                identityChanged(boundVerticalForBlur, blurVertical._colorTexture) ||
                !horizontalBlurBindGroup ||
                !verticalBlurBindGroup
            ) {
                rebuildBlurBindGroups();
            }

            const radius = CLAMP(task.radius, 0.01, 20);
            const sliceCount = Math.round(CLAMP(task.sliceCount, 1, 8));
            const stepCount = Math.round(CLAMP(task.stepCount, 1, 8));
            const fadeStart = CLAMP(task.fadeStart, 0, 100000);
            const fadeEnd = Math.max(task.fadeEnd, fadeStart + 0.001);
            producerUniformData.fill(0);
            packMat4IntoF32(producerUniformData, invViewProj, 0);
            packMat4IntoF32(producerUniformData, viewMatrix, 16);
            producerUniformData[32] = width;
            producerUniformData[33] = height;
            producerUniformData[34] = depthSource._width;
            producerUniformData[35] = depthSource._height;
            producerUniformData[36] = radius;
            producerUniformData[37] = CLAMP(task.bias, 0, 0.99);
            producerUniformData[38] = CLAMP(task.power, 0.1, 8);
            producerUniformData[39] = fadeStart;
            producerUniformData[40] = fadeEnd;
            producerUniformData[41] = sliceCount;
            producerUniformData[42] = stepCount;
            producerUniformData[43] = phase;
            engine._device.queue.writeBuffer(producerUniformBuffer!, 0, producerUniformData as Float32Array<ArrayBuffer>);

            const blurUniforms = (data: Float32Array<ArrayBuffer>, directionX: number, directionY: number): void => {
                data.fill(0);
                packMat4IntoF32(data, invViewProj, 0);
                packMat4IntoF32(data, viewMatrix, 16);
                data[32] = width;
                data[33] = height;
                data[34] = depthSource._width;
                data[35] = depthSource._height;
                data[36] = directionX;
                data[37] = directionY;
                data[38] = 0.02;
            };
            blurUniforms(horizontalBlurUniformData, 1, 0);
            blurUniforms(verticalBlurUniformData, 0, 1);
            engine._device.queue.writeBuffer(horizontalBlurUniformBuffer!, 0, horizontalBlurUniformData as Float32Array<ArrayBuffer>);
            engine._device.queue.writeBuffer(verticalBlurUniformBuffer!, 0, verticalBlurUniformData as Float32Array<ArrayBuffer>);

            const producerPass = engine._currentEncoder.beginRenderPass({
                label: `${name}-producer`,
                colorAttachments: [{ view: raw._colorView!, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
            });
            producerPass.setPipeline(producerPipeline!);
            producerPass.setBindGroup(0, producerBindGroup!);
            producerPass.draw(3);
            producerPass.end();

            const horizontalPass = engine._currentEncoder.beginRenderPass({
                label: `${name}-blur-horizontal`,
                colorAttachments: [{ view: blurHorizontal._colorView!, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
            });
            horizontalPass.setPipeline(blurPipeline!);
            horizontalPass.setBindGroup(0, horizontalBlurBindGroup!);
            horizontalPass.draw(3);
            horizontalPass.end();

            const verticalPass = engine._currentEncoder.beginRenderPass({
                label: `${name}-blur-vertical`,
                colorAttachments: [{ view: blurVertical._colorView!, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
            });
            verticalPass.setPipeline(blurPipeline!);
            verticalPass.setBindGroup(0, verticalBlurBindGroup!);
            verticalPass.draw(3);
            verticalPass.end();

            const draws =
                3 +
                owner.resolve({
                    width,
                    height,
                    depthWidth: depthSource._width,
                    depthHeight: depthSource._height,
                    rawTexture: blurVertical,
                    depthTexture: depthSource,
                    invViewProj,
                    viewMatrix,
                    viewProjMatrix: viewProj,
                    weight,
                    spatialRadius: 0,
                });

            lastEnabled = true;
            lastResetVersion = task.resetVersion;
            lastDepthTexture = depthSource._depthTexture;
            firstFrame = false;
            pendingReallocation = false;
            composite?.updateUniforms();
            return draws + (composite?.execute?.() ?? 0);
        },
        dispose(): void {
            task._passes.length = 0;
            composite?.dispose();
            owner.dispose();
            for (const target of [raw, blurHorizontal, blurVertical]) {
                target._eager = false;
                disposeRenderTarget(target);
            }
            producerPipeline = null;
            producerBindGroup = null;
            producerBindGroupLayout = null;
            producerUniformBuffer?.destroy();
            producerUniformBuffer = null;
            blurPipeline = null;
            horizontalBlurBindGroup = null;
            verticalBlurBindGroup = null;
            blurBindGroupLayout = null;
            horizontalBlurUniformBuffer?.destroy();
            verticalBlurUniformBuffer?.destroy();
            horizontalBlurUniformBuffer = null;
            verticalBlurUniformBuffer = null;
            boundDepthForProducer = null;
            boundDepthForBlur = null;
            boundRawForBlur = null;
            boundHorizontalForBlur = null;
            boundVerticalForBlur = null;
            lastDepthTexture = null;
        },
    };
    return task;
}
