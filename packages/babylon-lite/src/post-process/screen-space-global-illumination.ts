/**
 * Screen-space global illumination — a frame-graph post-process task producing one-bounce
 * indirect color from the scene's own lit color + depth buffers, with temporal
 * accumulation, a fused depth-aware five-tap spatial filter, and an optional
 * additive/color-bleed composite (see `docs/lite/architecture/52-screen-space-effects.md`).
 *
 * Opt-in and tree-shakable: nothing here runs unless a scene calls
 * `createScreenSpaceGlobalIlluminationPostProcessTask`. Mirrors
 * `screen-space-contact-shadows.ts`'s structure: a dedicated producer pipeline (binds the
 * scene depth through a depth-only `texture_depth_2d` view plus the already-lit scene
 * color), the shared temporal owner (kind `"color"`), and an optional composite built on
 * `createPostProcessTask`.
 */

import { F32 } from "../engine/typed-arrays.js";
import { SS, BU } from "../engine/gpu-flags.js";
import type { Camera } from "../camera/camera.js";
import { getCameraPosition, getEffectiveAspectRatio, getViewMatrix, getViewProjectionMatrix, _cameraChangeKey } from "../camera/camera.js";
import type { EngineContext } from "../engine/engine.js";
import type { RenderTarget } from "../engine/render-target.js";
import { buildRenderTarget, createRenderTarget, disposeRenderTarget } from "../engine/render-target.js";
import { mat4Invert } from "../math/mat4-invert.js";
import { packMat4IntoF32 } from "../math/pack-mat4-into-f32.js";
import { createPostProcessTask, type PostProcessTask } from "../frame-graph/post-process-task.js";
import type { Task } from "../frame-graph/task.js";
import { getBilinearSampler } from "../resource/samplers.js";
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
import { wgsl, type WgslSource } from "../shader/wgsl.js";

/** Configuration for `createScreenSpaceGlobalIlluminationPostProcessTask`. */
export interface ScreenSpaceGlobalIlluminationPostProcessTaskConfig {
    name?: string;
    /** Scene color + depth target already rendered this frame (single-sample). Sampled at the ray-hit UV for indirect color. */
    sourceTexture: RenderTarget;
    /** Depth attachment source, when different from `sourceTexture` (must be single-sample). */
    depthTexture?: RenderTarget;
    camera: Camera;
    /** Composite destination. `null`/omitted composites over `sourceTexture`'s own target size. Must differ from `sourceTexture`. */
    targetTexture?: RenderTarget | null;
    resolutionScale?: number;
    intensity?: number;
    stepCount?: number;
    /** Independently seeded hemisphere rays traced per effect pixel. */
    rayCount?: number;
    rayLength?: number;
    thickness?: number;
    bias?: number;
    fadeStart?: number;
    fadeEnd?: number;
    edgeFade?: number;
    temporalWeight?: number;
    temporalSamples?: number;
    resetVersion?: number;
    composition?: "none" | "additive" | "color-bleed";
    colorBleedGain?: number;
    colorBleedMax?: number;
}

/** A screen-space global-illumination frame-graph task. Mutable fields are sampled fresh each frame. */
export interface ScreenSpaceGlobalIlluminationPostProcessTask extends Task {
    readonly name: string;
    readonly sourceTexture: RenderTarget;
    readonly depthTexture: RenderTarget;
    readonly targetTexture: RenderTarget | null;
    outputTexture: RenderTarget;
    /** The resolved, temporally stable indirect-illumination target (`rgba16float`: color in `.rgb`, view distance in `.a`). */
    readonly illuminationTexture: RenderTarget;
    enabled: boolean;
    intensity: number;
    stepCount: number;
    rayCount: number;
    rayLength: number;
    thickness: number;
    bias: number;
    fadeStart: number;
    fadeEnd: number;
    edgeFade: number;
    temporalWeight: number;
    colorBleedGain: number;
    colorBleedMax: number;
    resetVersion: number;
}

const CLAMP = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Clamp raw config into safe ranges (see the architecture doc's "Defaults and clamps" table). Pure + exported for unit tests. */
export function clampScreenSpaceGlobalIlluminationConfig(config: ScreenSpaceGlobalIlluminationPostProcessTaskConfig): {
    resolutionScale: number;
    intensity: number;
    stepCount: number;
    rayCount: number;
    rayLength: number;
    thickness: number;
    bias: number;
    fadeStart: number;
    fadeEnd: number;
    edgeFade: number;
    temporalWeight: number;
    temporalSamples: number;
    colorBleedGain: number;
    colorBleedMax: number;
} {
    const fadeStart = CLAMP(config.fadeStart ?? 20, 0, 100000);
    const fadeEnd = Math.max(config.fadeEnd ?? 60, fadeStart + 0.001);
    return {
        resolutionScale: CLAMP(config.resolutionScale ?? 0.5, 0.25, 1),
        intensity: CLAMP(config.intensity ?? 1, 0, 4),
        stepCount: Math.round(CLAMP(config.stepCount ?? 8, 1, 64)),
        rayCount: Math.round(CLAMP(config.rayCount ?? 1, 1, 8)),
        rayLength: CLAMP(config.rayLength ?? 2, 0.001, 1000),
        thickness: CLAMP(config.thickness ?? 0.45, 0.001, 1000),
        bias: CLAMP(config.bias ?? 0.05, 0, 100),
        fadeStart,
        fadeEnd,
        edgeFade: CLAMP(config.edgeFade ?? 0.1, 0.001, 0.5),
        temporalWeight: CLAMP(config.temporalWeight ?? 1 / 64, 0, 1),
        temporalSamples: Math.round(CLAMP(config.temporalSamples ?? 64, 1, 256)),
        colorBleedGain: CLAMP(config.colorBleedGain ?? 1, 0, 16),
        colorBleedMax: CLAMP(config.colorBleedMax ?? 0.45, 0, 1),
    };
}

/** Producer uniform layout: 48 floats / 192 bytes (16-byte aligned). Exported for unit tests. */
export const SS_GI_PRODUCER_UNIFORM_FLOATS = 48;
const SS_GI_PRODUCER_UNIFORM_BYTES = SS_GI_PRODUCER_UNIFORM_FLOATS * 4;

const GI_PRODUCER_UNIFORM_WGSL = wgsl`struct SsGiParams{invViewProj:mat4x4f,viewProj:mat4x4f,cameraPos:vec3f,stepCount:f32,rayLength:f32,thickness:f32,bias:f32,fadeStart:f32,fadeEnd:f32,edgeFade:f32,phase:f32,rayCount:f32,outputDims:vec2f,depthDims:vec2f}`;

const GI_PRODUCER_BINDINGS_WGSL = wgsl`@group(0)@binding(0) var ssGiDepth:texture_depth_2d;
@group(0)@binding(1) var ssGiColorSampler:sampler;
@group(0)@binding(2) var ssGiColor:texture_2d<f32>;
@group(0)@binding(3) var<uniform> ssGi:SsGiParams;`;

const GI_HEMISPHERE_WGSL = wgsl`fn ssCosineHemisphere(n:vec3f,u1:f32,u2:f32)->vec3f{
  let r=sqrt(u1);
  let theta=6.2831853*u2;
  let x=r*cos(theta);
  let y=r*sin(theta);
  let z=sqrt(max(0.0,1.0-u1));
  var up=vec3f(0.0,1.0,0.0);
  if(abs(n.y)>0.999){up=vec3f(1.0,0.0,0.0);}
  let tangent=normalize(cross(up,n));
  let bitangent=cross(n,tangent);
  return normalize(tangent*x+bitangent*y+n*z);
}`;

const GI_PRODUCER_VERTEX_WGSL = wgsl`struct SsGVOut{@builtin(position) position:vec4f}
@vertex fn ssGiVertex(@builtin(vertex_index) i:u32)->SsGVOut{
  let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[i];
  return SsGVOut(vec4f(p,0,1));
}`;

const GI_PRODUCER_FRAGMENT_WGSL = wgsl`@fragment fn ssGiFragment(v:SsGVOut)->@location(0) vec4f{
  let coord=vec2i(v.position.xy);
  let uv=ssTexelUv(coord,ssGi.outputDims);
  let depth=textureLoad(ssGiDepth,ssUvToCoord(uv,ssGi.depthDims),0);
  if(ssIsClearDepth(depth)){return vec4f(0.0,0.0,0.0,0.0);}
  let worldPos=ssWorldFromDepth(uv,depth,ssGi.invViewProj);
  let normal=ssNormalFromDepth(uv,ssGi.depthDims,ssGi.invViewProj,ssGiDepth);
  let originPos=worldPos+normal*ssGi.bias;
  let stepCount=max(1u,u32(ssGi.stepCount));
  let stepLen=ssGi.rayLength/f32(stepCount);
  let rayCount=max(1u,min(8u,u32(ssGi.rayCount)));
  var colorSum=vec3f(0.0);
  for(var rayIndex:u32=0u;rayIndex<8u;rayIndex=rayIndex+1u){
    if(rayIndex>=rayCount){break;}
    let raySeed=f32(rayIndex);
    let seedOffset=vec2f(raySeed*37.719,raySeed*17.173);
    let u1=fract(ssPhaseAngle(vec2f(coord)+seedOffset,ssGi.phase)+raySeed*0.754877666);
    let u2=fract(ssScreenSpaceNoise(vec2f(coord)*1.7+vec2f(23.11,9.07)+seedOffset)+ssGi.phase*0.61803399);
    let dither=fract(ssScreenSpaceNoise(vec2f(coord)*0.731+vec2f(11.317,31.179)+seedOffset)+ssGi.phase*0.38196601);
    let rayDir=ssCosineHemisphere(normal,u1,u2);
    var rayColor=vec3f(0.0);
    for(var i:u32=0u;i<stepCount;i=i+1u){
      let t=(f32(i)+0.35+0.65*dither)*stepLen;
      let samplePos=originPos+rayDir*t;
      let hit=ssDualSurfaceHit(samplePos,ssGi.cameraPos,ssGi.viewProj,ssGi.invViewProj,ssGi.depthDims,ssGiDepth,ssGi.bias,ssGi.thickness);
      if(hit.hit){
        let edge=min(min(hit.uv.x,1.0-hit.uv.x),min(hit.uv.y,1.0-hit.uv.y))/max(ssGi.edgeFade,1e-4);
        let edgeFactor=clamp(edge,0.0,1.0);
        let distFade=clamp(1.0-smoothstep(ssGi.fadeStart,ssGi.fadeEnd,hit.rayDist),0.0,1.0);
        let litColor=textureSampleLevel(ssGiColor,ssGiColorSampler,hit.uv,0.0).rgb;
        rayColor=litColor*edgeFactor*distFade;
        break;
      }
    }
    colorSum=colorSum+rayColor;
  }
  return vec4f(colorSum/f32(rayCount),1.0);
}`;

/** Full GI producer shader module source. Exported for WGSL-contract unit tests. */
export function screenSpaceGlobalIlluminationProducerWGSL(): string {
    return wgsl`${GI_PRODUCER_VERTEX_WGSL}\n${GI_PRODUCER_UNIFORM_WGSL}\n${GI_PRODUCER_BINDINGS_WGSL}\n${screenSpaceRaymarchWGSL()}\n${GI_HEMISPHERE_WGSL}\n${GI_PRODUCER_FRAGMENT_WGSL}`;
}

const COMPOSITE_EXTRA_TEXTURE_WGSL = wgsl`@group(0)@binding(2) var ssGiTex:texture_2d<f32>;`;
const COMPOSITE_UNIFORM_WGSL = wgsl`struct SsGiCompositeParams{intensity:f32,enabled:f32,colorBleedGain:f32,colorBleedMax:f32}
@group(0)@binding(3) var<uniform> ssGiComposite:SsGiCompositeParams;`;

function compositeFragmentWGSL(mode: "additive" | "color-bleed"): WgslSource {
    if (mode === "color-bleed") {
        return wgsl`fn applyPostProcess(color:vec4f, uv:vec2f)->vec4f{
  if(ssGiComposite.enabled<0.5){return color;}
  let illum=textureSample(ssGiTex,sourceSampler,uv).rgb;
  let luminance=dot(illum,vec3f(0.2126,0.7152,0.0722));
  let amount=min(ssGiComposite.intensity*min(luminance*ssGiComposite.colorBleedGain,1.0),ssGiComposite.colorBleedMax);
  return vec4f(color.rgb*mix(vec3f(1.0),illum/max(luminance,1e-4),amount),color.a);
}`;
    }
    return wgsl`fn applyPostProcess(color:vec4f, uv:vec2f)->vec4f{
  if(ssGiComposite.enabled<0.5){return color;}
  let illum=textureSample(ssGiTex,sourceSampler,uv).rgb;
  return vec4f(color.rgb+illum*ssGiComposite.intensity,color.a);
}`;
}

/**
 * Create a screen-space global-illumination post-process task.
 * @param config - Source/depth textures, camera, and effect parameters.
 * @param engine - The owning engine.
 * @param scene - Optional owning scene.
 * @returns The global-illumination task. Add it after the source render task.
 */
export function createScreenSpaceGlobalIlluminationPostProcessTask(
    config: ScreenSpaceGlobalIlluminationPostProcessTaskConfig,
    engine: EngineContext,
    scene?: SceneContext
): ScreenSpaceGlobalIlluminationPostProcessTask {
    const name = config.name ?? "screen-space-global-illumination";
    const source = config.sourceTexture;
    const depthSource = config.depthTexture ?? source;
    if ((source._descriptor.samples ?? 1) !== 1) {
        throw new Error(`ScreenSpaceGlobalIlluminationPostProcessTask "${name}": sourceTexture must be single-sample.`);
    }
    if ((depthSource._descriptor.samples ?? 1) !== 1) {
        throw new Error(`ScreenSpaceGlobalIlluminationPostProcessTask "${name}": depthTexture must be single-sample.`);
    }
    if (!depthSource._descriptor.dFormat) {
        throw new Error(`ScreenSpaceGlobalIlluminationPostProcessTask "${name}": depth source has no depth attachment.`);
    }
    assertScreenSpaceTargetNotAliasingSource(`ScreenSpaceGlobalIlluminationPostProcessTask "${name}"`, config.targetTexture, source);

    const clamped = clampScreenSpaceGlobalIlluminationConfig(config);
    const params = {
        camera: config.camera,
        composition: config.composition ?? "additive",
        resetVersion: config.resetVersion ?? 0,
        ...clamped,
    };

    const raw = createRenderTarget({ lbl: `${name}-raw`, format: "rgba16float", samples: 1, size: { width: 1, height: 1 } });
    const owner: ScreenSpaceTemporalOwner = createScreenSpaceTemporalOwner({ name, kind: "color", engine, scene });

    let producerPipeline: GPURenderPipeline | null = null;
    let producerBindGroupLayout: GPUBindGroupLayout | null = null;
    let producerBindGroup: GPUBindGroup | null = null;
    let producerUniformBuffer: GPUBuffer | null = null;
    const producerUniformData = new F32(SS_GI_PRODUCER_UNIFORM_FLOATS);
    let boundDepthForProducer: GPUTexture | null = null;
    let boundColorForProducer: GPUTexture | null = null;

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
                          extraTextureWGSL: COMPOSITE_EXTRA_TEXTURE_WGSL,
                          extraTextures: [owner.stableTexture],
                          uniformWGSL: COMPOSITE_UNIFORM_WGSL,
                          uniformBinding: 3,
                          uniformByteLength: 16,
                          writeUniforms(data) {
                              data[0] = task.intensity;
                              data[1] = task.enabled ? 1 : 0;
                              data[2] = task.colorBleedGain;
                              data[3] = task.colorBleedMax;
                          },
                          fragmentWGSL: compositeFragmentWGSL(params.composition === "color-bleed" ? "color-bleed" : "additive"),
                      },
                  },
                  engine,
                  scene
              );

    let width = 0;
    let height = 0;
    let firstFrame = true;
    let pendingReallocation = false;
    let lastEnabled: boolean | undefined = undefined;
    let lastResetVersion: number | undefined = undefined;
    let lastDepthTexture: GPUTexture | null = null;
    let lastColorTexture: GPUTexture | null = null;
    let lastCameraKey = -1;
    let accumulatedSamples = 1;
    let phaseIndex = 0;
    let prevInvViewProjNull = false;

    function ensureProducerPipeline(): void {
        if (producerPipeline) {
            return;
        }
        const device = engine._device;
        producerBindGroupLayout = device.createBindGroupLayout({
            label: `${name}-producer-bgl`,
            entries: [
                { binding: 0, visibility: SS.FRAGMENT, texture: { sampleType: "depth" } },
                { binding: 1, visibility: SS.FRAGMENT, sampler: { type: "filtering" } },
                { binding: 2, visibility: SS.FRAGMENT, texture: { sampleType: "float" } },
                { binding: 3, visibility: SS.FRAGMENT, buffer: { type: "uniform" } },
            ],
        });
        const module = device.createShaderModule({ label: `${name}-producer`, code: screenSpaceGlobalIlluminationProducerWGSL() });
        producerPipeline = device.createRenderPipeline({
            label: `${name}-producer-pipeline`,
            layout: device.createPipelineLayout({ label: `${name}-producer-layout`, bindGroupLayouts: [producerBindGroupLayout] }),
            vertex: { module, entryPoint: "ssGiVertex" },
            fragment: { module, entryPoint: "ssGiFragment", targets: [{ format: "rgba16float" }] },
            primitive: { topology: "triangle-list" },
        });
        producerUniformBuffer = device.createBuffer({ label: `${name}-producer-uniforms`, size: SS_GI_PRODUCER_UNIFORM_BYTES, usage: BU.UNIFORM | BU.COPY_DST });
    }

    function rebuildProducerBindGroup(): void {
        const depthView = depthSource._depthTexture!.createView({ aspect: "depth-only" });
        producerBindGroup = engine._device.createBindGroup({
            label: `${name}-producer-bind-group`,
            layout: producerBindGroupLayout!,
            entries: [
                { binding: 0, resource: depthView },
                { binding: 1, resource: getBilinearSampler(engine) },
                { binding: 2, resource: source._colorView! },
                { binding: 3, resource: { buffer: producerUniformBuffer! } },
            ],
        });
        boundDepthForProducer = depthSource._depthTexture!;
        boundColorForProducer = source._colorTexture!;
    }

    const task: ScreenSpaceGlobalIlluminationPostProcessTask = {
        name,
        engine,
        scene,
        _passes: [],
        sourceTexture: source,
        depthTexture: depthSource,
        targetTexture: config.targetTexture ?? null,
        outputTexture: composite ? composite.outputTexture : owner.stableTexture,
        illuminationTexture: owner.stableTexture,
        enabled: true,
        intensity: params.intensity,
        stepCount: params.stepCount,
        rayCount: params.rayCount,
        rayLength: params.rayLength,
        thickness: params.thickness,
        bias: params.bias,
        fadeStart: params.fadeStart,
        fadeEnd: params.fadeEnd,
        edgeFade: params.edgeFade,
        temporalWeight: params.temporalWeight,
        colorBleedGain: params.colorBleedGain,
        colorBleedMax: params.colorBleedMax,
        resetVersion: params.resetVersion,
        record(): void {
            ensureProducerPipeline();
            const srcSize = resolveScreenSpaceSourceSize(depthSource);
            const scaled = computeScreenSpaceScaledSize(srcSize.width, srcSize.height, params.resolutionScale);
            if (scaled.width !== width || scaled.height !== height) {
                width = scaled.width;
                height = scaled.height;
                raw._eager = false;
                disposeRenderTarget(raw);
                raw._descriptor.size = { width, height };
                buildRenderTarget(raw, engine);
                raw._eager = true;
                producerBindGroup = null;
                pendingReallocation = true;
            }
            if (owner.record(width, height)) {
                pendingReallocation = true;
            }
            composite?.record();
            task.outputTexture = composite ? composite.outputTexture : owner.stableTexture;
        },
        execute(): number {
            const enabled = task.enabled;
            if (!enabled) {
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

            const camera = params.camera;
            const aspect = getEffectiveAspectRatio(camera, depthSource._width || 1, depthSource._height || 1);
            const viewProj = getViewProjectionMatrix(camera, aspect);
            const invViewProj = mat4Invert(viewProj);
            const viewMatrix = getViewMatrix(camera);
            const cameraPos = getCameraPosition(camera);
            const camKey = _cameraChangeKey(camera);
            const moved = camKey !== lastCameraKey;
            lastCameraKey = camKey;

            if (!invViewProj) {
                prevInvViewProjNull = true;
                lastEnabled = true;
                lastResetVersion = task.resetVersion;
                firstFrame = false;
                pendingReallocation = false;
                owner.clearIdentity();
                composite?.updateUniforms();
                return composite?.execute?.() ?? 0;
            }

            const depthIdentityChanged = identityChanged(lastDepthTexture, depthSource._depthTexture);
            const colorIdentityChanged = identityChanged(lastColorTexture, source._colorTexture);
            const decision = decideScreenSpaceReset({
                firstAllocation: firstFrame,
                targetReallocated: pendingReallocation,
                sourceIdentityChanged: depthIdentityChanged || colorIdentityChanged || prevInvViewProjNull,
                resetVersionChanged: task.resetVersion !== lastResetVersion,
                enabledTransitionedOn: !lastEnabled,
                singularInverse: false,
                cameraMoved: moved,
            });
            prevInvViewProjNull = false;

            accumulatedSamples = advanceAccumulation(accumulatedSamples, decision.invalidateHistory, params.temporalSamples);
            const weight = computeTemporalWeight(CLAMP(task.temporalWeight, 0, 1), accumulatedSamples);
            phaseIndex = advancePhaseIndex(phaseIndex, decision.restartPhase);
            const phase = phaseValue(phaseIndex, params.temporalSamples);

            if (identityChanged(boundDepthForProducer, depthSource._depthTexture) || identityChanged(boundColorForProducer, source._colorTexture) || !producerBindGroup) {
                rebuildProducerBindGroup();
            }

            const stepCount = Math.round(CLAMP(task.stepCount, 1, 64));
            const rayCount = Math.round(CLAMP(task.rayCount, 1, 8));
            const rayLength = CLAMP(task.rayLength, 0.001, 1000);
            const thickness = CLAMP(task.thickness, 0.001, 1000);
            const bias = CLAMP(task.bias, 0, 100);
            const fadeStart = CLAMP(task.fadeStart, 0, 100000);
            const fadeEnd = Math.max(task.fadeEnd, fadeStart + 0.001);
            const edgeFade = CLAMP(task.edgeFade, 0.001, 0.5);
            producerUniformData.fill(0);
            packMat4IntoF32(producerUniformData, invViewProj, 0);
            packMat4IntoF32(producerUniformData, viewProj, 16);
            producerUniformData[32] = cameraPos.x;
            producerUniformData[33] = cameraPos.y;
            producerUniformData[34] = cameraPos.z;
            producerUniformData[35] = stepCount;
            producerUniformData[36] = rayLength;
            producerUniformData[37] = thickness;
            producerUniformData[38] = bias;
            producerUniformData[39] = fadeStart;
            producerUniformData[40] = fadeEnd;
            producerUniformData[41] = edgeFade;
            producerUniformData[42] = phase;
            producerUniformData[43] = rayCount;
            producerUniformData[44] = width;
            producerUniformData[45] = height;
            producerUniformData[46] = depthSource._width;
            producerUniformData[47] = depthSource._height;
            engine._device.queue.writeBuffer(producerUniformBuffer!, 0, producerUniformData as Float32Array<ArrayBuffer>);

            const pass = engine._currentEncoder.beginRenderPass({
                label: `${name}-producer`,
                colorAttachments: [{ view: raw._colorView!, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
            });
            pass.setPipeline(producerPipeline!);
            pass.setBindGroup(0, producerBindGroup!);
            pass.draw(3);
            pass.end();

            const draws =
                1 +
                owner.resolve({
                    width,
                    height,
                    depthWidth: depthSource._width,
                    depthHeight: depthSource._height,
                    rawTexture: raw,
                    depthTexture: depthSource,
                    invViewProj,
                    viewMatrix,
                    viewProjMatrix: viewProj,
                    weight,
                });

            lastEnabled = true;
            lastResetVersion = task.resetVersion;
            lastDepthTexture = depthSource._depthTexture;
            lastColorTexture = source._colorTexture;
            firstFrame = false;
            pendingReallocation = false;

            composite?.updateUniforms();
            return draws + (composite?.execute?.() ?? 0);
        },
        dispose(): void {
            task._passes.length = 0;
            composite?.dispose();
            owner.dispose();
            raw._eager = false;
            disposeRenderTarget(raw);
            producerPipeline = null;
            producerBindGroup = null;
            producerBindGroupLayout = null;
            producerUniformBuffer?.destroy();
            producerUniformBuffer = null;
            boundDepthForProducer = null;
            boundColorForProducer = null;
            lastColorTexture = null;
        },
    };
    return task;
}
