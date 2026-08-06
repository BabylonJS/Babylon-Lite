/**
 * Screen-space contact shadows — a frame-graph post-process task producing short,
 * dual-surface raymarched contact occlusion from the scene's own depth buffer, with
 * temporal accumulation and an optional multiply composite (see
 * `docs/lite/architecture/52-screen-space-effects.md`).
 *
 * Opt-in and tree-shakable: nothing here runs unless a scene calls
 * `createScreenSpaceContactShadowsPostProcessTask`. The producer needs to bind the
 * scene's depth attachment through a depth-only `texture_depth_2d` view, which
 * `createPostProcessTask` cannot express, so this task builds its own dedicated
 * WebGPU pipeline instead of composing post-process sub-tasks for the producer stage.
 * The temporal resolve + history-copy passes are owned by the shared
 * `screen-space-temporal.ts` module (kind `"scalar"`); the optional composite reuses
 * `createPostProcessTask`, matching every other multi-pass effect in this package.
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
import type { SceneContext } from "../scene/scene-core.js";
import { screenSpaceRaymarchWGSL } from "./screen-space-raymarch-wgsl.js";
import {
    advanceAccumulation,
    advancePhaseWindow,
    assertScreenSpaceTargetNotAliasingSource,
    computeScreenSpaceScaledSize,
    computeTemporalWeight,
    createScreenSpaceTemporalOwner,
    decideScreenSpaceReset,
    identityChanged,
    phaseValue,
    resolveScreenSpaceSourceSize,
} from "./screen-space-temporal.js";
import type { ScreenSpacePhaseWindow, ScreenSpaceTemporalOwner } from "./screen-space-temporal.js";

/** Configuration for `createScreenSpaceContactShadowsPostProcessTask`. */
export interface ScreenSpaceContactShadowsPostProcessTaskConfig {
    name?: string;
    /** Scene color + depth target already rendered this frame (single-sample). */
    sourceTexture: RenderTarget;
    /** Depth attachment source, when different from `sourceTexture` (must be single-sample). */
    depthTexture?: RenderTarget;
    camera: Camera;
    lightDirection: { x: number; y: number; z: number };
    /** Composite destination. `null`/omitted composites over `sourceTexture`'s own target size. Must differ from `sourceTexture`. */
    targetTexture?: RenderTarget | null;
    resolutionScale?: number;
    intensity?: number;
    tint?: readonly [number, number, number];
    stepCount?: number;
    maxDistance?: number;
    thickness?: number;
    bias?: number;
    normalBias?: number;
    temporalWeight?: number;
    temporalSamples?: number;
    resetVersion?: number;
    composition?: "none" | "multiply";
}

/** A screen-space contact-shadows frame-graph task. Mutable fields are sampled fresh each frame. */
export interface ScreenSpaceContactShadowsPostProcessTask extends Task {
    readonly name: string;
    readonly sourceTexture: RenderTarget;
    readonly depthTexture: RenderTarget;
    readonly targetTexture: RenderTarget | null;
    outputTexture: RenderTarget;
    /** The resolved, temporally stable contact-occlusion target (`rg16float`: occlusion in `.r`, view distance in `.g`). */
    readonly shadowTexture: RenderTarget;
    enabled: boolean;
    intensity: number;
    tint: readonly [number, number, number];
    stepCount: number;
    maxDistance: number;
    thickness: number;
    bias: number;
    normalBias: number;
    temporalWeight: number;
    resetVersion: number;
    readonly lightDirection: { x: number; y: number; z: number };
}

const CLAMP = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Clamp raw config into safe ranges (see the architecture doc's "Defaults and clamps" table). Pure + exported for unit tests. */
export function clampScreenSpaceContactShadowsConfig(config: ScreenSpaceContactShadowsPostProcessTaskConfig): {
    resolutionScale: number;
    intensity: number;
    tint: readonly [number, number, number];
    stepCount: number;
    maxDistance: number;
    thickness: number;
    bias: number;
    normalBias: number;
    temporalWeight: number;
    temporalSamples: number;
} {
    return {
        resolutionScale: CLAMP(config.resolutionScale ?? 1, 0.25, 1),
        intensity: CLAMP(config.intensity ?? 0.6, 0, 4),
        tint: config.tint ?? [0.35, 0.38, 0.48],
        stepCount: Math.round(CLAMP(config.stepCount ?? 8, 1, 64)),
        maxDistance: CLAMP(config.maxDistance ?? 0.3, 0.001, 1000),
        thickness: CLAMP(config.thickness ?? 0.35, 0.001, 1000),
        bias: CLAMP(config.bias ?? 0.03, 0, 100),
        normalBias: CLAMP(config.normalBias ?? 0.035, 0.001, 100),
        temporalWeight: CLAMP(config.temporalWeight ?? 1 / 32, 0, 1),
        temporalSamples: Math.round(CLAMP(config.temporalSamples ?? 32, 1, 256)),
    };
}

/** Producer uniform layout: 48 floats / 192 bytes (16-byte aligned). Exported for unit tests. */
export const SS_CONTACT_PRODUCER_UNIFORM_FLOATS = 48;
const SS_CONTACT_PRODUCER_UNIFORM_BYTES = SS_CONTACT_PRODUCER_UNIFORM_FLOATS * 4;

const CONTACT_PRODUCER_UNIFORM_WGSL = `struct SsContactParams{invViewProj:mat4x4f,viewProj:mat4x4f,rayDir:vec3f,stepCount:f32,cameraPos:vec3f,maxDistance:f32,outputDims:vec2f,depthDims:vec2f,bias:f32,normalBias:f32,thickness:f32,phase:f32}`;

const CONTACT_PRODUCER_BINDINGS_WGSL = `@group(0)@binding(0) var ssDepth:texture_depth_2d;
@group(0)@binding(1) var<uniform> ssContact:SsContactParams;`;

const CONTACT_TANGENT_PLANE_WGSL = `fn ssTangentPlaneClearance(candidateWorld:vec3f,receiverWorld:vec3f,receiverNormal:vec3f)->f32{
  return dot(candidateWorld-receiverWorld,receiverNormal);
}`;

const CONTACT_PRODUCER_VERTEX_WGSL = `struct SsCVOut{@builtin(position) position:vec4f}
@vertex fn ssContactVertex(@builtin(vertex_index) i:u32)->SsCVOut{
  let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[i];
  return SsCVOut(vec4f(p,0,1));
}`;

const CONTACT_PRODUCER_FRAGMENT_WGSL = `@fragment fn ssContactFragment(v:SsCVOut)->@location(0) vec4f{
  let coord=vec2i(v.position.xy);
  let uv=ssTexelUv(coord,ssContact.outputDims);
  let depth=textureLoad(ssDepth,ssUvToCoord(uv,ssContact.depthDims),0);
  if(ssIsClearDepth(depth)){return vec4f(0.0,0.0,0.0,0.0);}
  let worldPos=ssWorldFromDepth(uv,depth,ssContact.invViewProj);
  let normal=ssNormalFromDepth(uv,ssContact.depthDims,ssContact.invViewProj,ssDepth);
  let originPos=worldPos+normal*ssContact.bias;
  let stepCount=max(1u,u32(ssContact.stepCount));
  let stepLen=ssContact.maxDistance/f32(stepCount);
  let jitter=ssPhaseAngle(vec2f(coord),ssContact.phase);
  var occlusion=0.0;
  for(var i:u32=0u;i<stepCount;i=i+1u){
    let t=(f32(i)+jitter)*stepLen;
    let samplePos=originPos+ssContact.rayDir*t;
    let hit=ssDualSurfaceHit(samplePos,ssContact.cameraPos,ssContact.viewProj,ssContact.invViewProj,ssContact.depthDims,ssDepth,ssContact.bias,ssContact.thickness);
    if(hit.hit){
      let hitDepth=textureLoad(ssDepth,ssUvToCoord(hit.uv,ssContact.depthDims),0);
      let hitWorld=ssWorldFromDepth(hit.uv,hitDepth,ssContact.invViewProj);
      let clearance=ssTangentPlaneClearance(hitWorld,worldPos,normal);
      let clearanceFoot=ssContact.normalBias*0.35;
      if(clearance>clearanceFoot){
        let distFactor=clamp(1.0-t/ssContact.maxDistance,0.0,1.0);
        let penetration=clamp(1.0-abs(hit.rayDist-hit.surfaceDist)/max(ssContact.thickness,1e-4),0.0,1.0);
        let clearanceWeight=smoothstep(clearanceFoot,ssContact.normalBias,clearance);
        occlusion=max(occlusion,distFactor*penetration*clearanceWeight);
      }
    }
  }
  return vec4f(occlusion,0.0,0.0,0.0);
}`;

/** Full contact-shadow producer shader module source. Exported for WGSL-contract unit tests. */
export function screenSpaceContactShadowsProducerWGSL(): string {
    return `${CONTACT_PRODUCER_VERTEX_WGSL}\n${CONTACT_PRODUCER_UNIFORM_WGSL}\n${CONTACT_PRODUCER_BINDINGS_WGSL}\n${screenSpaceRaymarchWGSL()}\n${CONTACT_TANGENT_PLANE_WGSL}\n${CONTACT_PRODUCER_FRAGMENT_WGSL}`;
}

const COMPOSITE_EXTRA_TEXTURE_WGSL = `@group(0)@binding(2) var ssShadowTex:texture_2d<f32>;`;
const COMPOSITE_UNIFORM_WGSL = `struct SsContactCompositeParams{intensity:f32,enabled:f32,tintR:f32,tintG:f32,tintB:f32,p0:f32,p1:f32,p2:f32}
@group(0)@binding(3) var<uniform> ssContactComposite:SsContactCompositeParams;`;
const COMPOSITE_FRAGMENT_WGSL = `fn applyPostProcess(color:vec4f, uv:vec2f)->vec4f{
  if(ssContactComposite.enabled<0.5){return color;}
  let shadow=textureSample(ssShadowTex,sourceSampler,uv).r;
  let amount=clamp(shadow*ssContactComposite.intensity,0.0,1.0);
  let tint=vec3f(ssContactComposite.tintR,ssContactComposite.tintG,ssContactComposite.tintB);
  return vec4f(color.rgb*mix(vec3f(1.0),tint,amount),color.a);
}`;

/**
 * Create a screen-space contact-shadows post-process task.
 * @param config - Source/depth textures, camera, light direction, and effect parameters.
 * @param engine - The owning engine.
 * @param scene - Optional owning scene.
 * @returns The contact-shadows task. Add it after the source render task.
 */
export function createScreenSpaceContactShadowsPostProcessTask(
    config: ScreenSpaceContactShadowsPostProcessTaskConfig,
    engine: EngineContext,
    scene?: SceneContext
): ScreenSpaceContactShadowsPostProcessTask {
    const name = config.name ?? "screen-space-contact-shadows";
    const source = config.sourceTexture;
    const depthSource = config.depthTexture ?? source;
    if ((source._descriptor.samples ?? 1) !== 1) {
        throw new Error(`ScreenSpaceContactShadowsPostProcessTask "${name}": sourceTexture must be single-sample.`);
    }
    if ((depthSource._descriptor.samples ?? 1) !== 1) {
        throw new Error(`ScreenSpaceContactShadowsPostProcessTask "${name}": depthTexture must be single-sample.`);
    }
    if (!depthSource._descriptor.dFormat) {
        throw new Error(`ScreenSpaceContactShadowsPostProcessTask "${name}": depth source has no depth attachment.`);
    }
    assertScreenSpaceTargetNotAliasingSource(`ScreenSpaceContactShadowsPostProcessTask "${name}"`, config.targetTexture, source);

    const clamped = clampScreenSpaceContactShadowsConfig(config);
    const params = {
        camera: config.camera,
        lightDirection: config.lightDirection,
        enabled: true,
        composition: config.composition ?? "multiply",
        resetVersion: config.resetVersion ?? 0,
        ...clamped,
    };

    const raw = createRenderTarget({ lbl: `${name}-raw`, format: "r8unorm", samples: 1, size: { width: 1, height: 1 } });
    const owner: ScreenSpaceTemporalOwner = createScreenSpaceTemporalOwner({ name, kind: "scalar", engine, scene });

    let producerPipeline: GPURenderPipeline | null = null;
    let producerBindGroupLayout: GPUBindGroupLayout | null = null;
    let producerBindGroup: GPUBindGroup | null = null;
    let producerUniformBuffer: GPUBuffer | null = null;
    const producerUniformData = new F32(SS_CONTACT_PRODUCER_UNIFORM_FLOATS);
    let boundDepthForProducer: GPUTexture | null = null;

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
                          uniformByteLength: 32,
                          writeUniforms(data) {
                              data[0] = task.intensity;
                              data[1] = task.enabled ? 1 : 0;
                              data[2] = task.tint[0];
                              data[3] = task.tint[1];
                              data[4] = task.tint[2];
                          },
                          fragmentWGSL: COMPOSITE_FRAGMENT_WGSL,
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
    let lastCameraKey = -1;
    let accumulatedSamples = 1;
    let phaseWindow: ScreenSpacePhaseWindow = { index: 0, remaining: params.temporalSamples };
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
                { binding: 1, visibility: SS.FRAGMENT, buffer: { type: "uniform" } },
            ],
        });
        const module = device.createShaderModule({ label: `${name}-producer`, code: screenSpaceContactShadowsProducerWGSL() });
        producerPipeline = device.createRenderPipeline({
            label: `${name}-producer-pipeline`,
            layout: device.createPipelineLayout({ label: `${name}-producer-layout`, bindGroupLayouts: [producerBindGroupLayout] }),
            vertex: { module, entryPoint: "ssContactVertex" },
            fragment: { module, entryPoint: "ssContactFragment", targets: [{ format: "r8unorm" }] },
            primitive: { topology: "triangle-list" },
        });
        producerUniformBuffer = device.createBuffer({ label: `${name}-producer-uniforms`, size: SS_CONTACT_PRODUCER_UNIFORM_BYTES, usage: BU.UNIFORM | BU.COPY_DST });
    }

    function rebuildProducerBindGroup(): void {
        const depthView = depthSource._depthTexture!.createView({ aspect: "depth-only" });
        producerBindGroup = engine._device.createBindGroup({
            label: `${name}-producer-bind-group`,
            layout: producerBindGroupLayout!,
            entries: [
                { binding: 0, resource: depthView },
                { binding: 1, resource: { buffer: producerUniformBuffer! } },
            ],
        });
        boundDepthForProducer = depthSource._depthTexture!;
    }

    const task: ScreenSpaceContactShadowsPostProcessTask = {
        name,
        engine,
        scene,
        _passes: [],
        sourceTexture: source,
        depthTexture: depthSource,
        targetTexture: config.targetTexture ?? null,
        outputTexture: composite ? composite.outputTexture : owner.stableTexture,
        shadowTexture: owner.stableTexture,
        enabled: true,
        intensity: params.intensity,
        tint: params.tint,
        stepCount: params.stepCount,
        maxDistance: params.maxDistance,
        thickness: params.thickness,
        bias: params.bias,
        normalBias: params.normalBias,
        temporalWeight: params.temporalWeight,
        resetVersion: params.resetVersion,
        lightDirection: params.lightDirection,
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
            const decision = decideScreenSpaceReset({
                firstAllocation: firstFrame,
                targetReallocated: pendingReallocation,
                sourceIdentityChanged: depthIdentityChanged || prevInvViewProjNull,
                resetVersionChanged: task.resetVersion !== lastResetVersion,
                enabledTransitionedOn: !lastEnabled,
                singularInverse: false,
                cameraMoved: moved,
            });
            prevInvViewProjNull = false;

            accumulatedSamples = advanceAccumulation(accumulatedSamples, decision.invalidateHistory, params.temporalSamples);
            const weight = computeTemporalWeight(CLAMP(task.temporalWeight, 0, 1), accumulatedSamples);
            phaseWindow = advancePhaseWindow(phaseWindow, moved, decision.restartPhase, params.temporalSamples);
            const phase = phaseValue(phaseWindow.index, params.temporalSamples);

            if (identityChanged(boundDepthForProducer, depthSource._depthTexture) || !producerBindGroup) {
                rebuildProducerBindGroup();
            }

            const lightDir = task.lightDirection;
            const len = Math.hypot(lightDir.x, lightDir.y, lightDir.z) || 1;
            const stepCount = Math.round(CLAMP(task.stepCount, 1, 64));
            const maxDistance = CLAMP(task.maxDistance, 0.001, 1000);
            const bias = CLAMP(task.bias, 0, 100);
            const normalBias = CLAMP(task.normalBias, 0.001, 100);
            const thickness = CLAMP(task.thickness, 0.001, 1000);
            producerUniformData.fill(0);
            packMat4IntoF32(producerUniformData, invViewProj, 0);
            packMat4IntoF32(producerUniformData, viewProj, 16);
            producerUniformData[32] = -lightDir.x / len;
            producerUniformData[33] = -lightDir.y / len;
            producerUniformData[34] = -lightDir.z / len;
            producerUniformData[35] = stepCount;
            producerUniformData[36] = cameraPos.x;
            producerUniformData[37] = cameraPos.y;
            producerUniformData[38] = cameraPos.z;
            producerUniformData[39] = maxDistance;
            producerUniformData[40] = width;
            producerUniformData[41] = height;
            producerUniformData[42] = depthSource._width;
            producerUniformData[43] = depthSource._height;
            producerUniformData[44] = bias;
            producerUniformData[45] = normalBias;
            producerUniformData[46] = thickness;
            producerUniformData[47] = phase;
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
        },
    };
    return task;
}
