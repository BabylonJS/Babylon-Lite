/**
 * Shared temporal owner for the screen-space contact-shadow and global-illumination
 * effects (see `docs/lite/architecture/52-screen-space-effects.md`).
 *
 * Owns the two internal passes that run after either producer:
 *   1. Resolve: reconstruct the current world position, reproject through the previous
 *      view-projection, reject off-screen/depth-mismatched history, clamp accepted
 *      history to the current 3x3 neighborhood, and blend the current estimate.
 *   2. History copy: copy the resolved stable target into the history target used by
 *      the next frame.
 *
 * The module exports pure functions for the reset matrix, the accumulation ramp, and the
 * rotating phase index so they can be unit tested without a GPU device. All GPU state
 * lives behind `createScreenSpaceTemporalOwner`, which is only invoked by the two public
 * task factories — importing this module in isolation allocates nothing at module scope.
 */

import { packMat4IntoF32 } from "../math/pack-mat4-into-f32.js";
import { F32 } from "../engine/typed-arrays.js";
import { SS, BU } from "../engine/gpu-flags.js";
import { getBilinearSampler } from "../resource/samplers.js";
import type { EngineContext } from "../engine/engine.js";
import type { Mat4 } from "../math/types.js";
import type { RenderTarget } from "../engine/render-target.js";
import { buildRenderTarget, createRenderTarget, disposeRenderTarget } from "../engine/render-target.js";
import { createPostProcessTask, type PostProcessTask } from "../frame-graph/post-process-task.js";
import type { SceneContext } from "../scene/scene-core.js";
import { screenSpaceRaymarchWGSL } from "./screen-space-raymarch-wgsl.js";
import { wgsl } from "../shader/wgsl.js";

/** Which effect the temporal owner is resolving: `"scalar"` for contact shadows
 *  (`rg16float`: value in `.r`, view distance in `.g`), or `"color"` for global
 *  illumination (`rgba16float`: color in `.rgb`, view distance in `.a`). */
export type ScreenSpaceTemporalKind = "scalar" | "color";

// ─── Pure helpers (unit-testable without a GPU device) ─────────────────────

/** Running-mean ramp: `max(configuredWeight, 1 / accumulatedSamples)`. */
export function computeTemporalWeight(configuredWeight: number, accumulatedSamples: number): number {
    return Math.max(configuredWeight, 1 / accumulatedSamples);
}

/** Advance the accumulation counter. Resets to 1 (full-weight replace) when `reset` is
 *  true; otherwise increments and clamps at `temporalSamples` (beyond which the ramp in
 *  `computeTemporalWeight` can no longer go below `configuredWeight` by design — the
 *  codebase defaults set `configuredWeight ~= 1/temporalSamples`). */
export function advanceAccumulation(current: number, reset: boolean, temporalSamples: number): number {
    if (reset) {
        return 1;
    }
    return Math.min(current + 1, Math.max(1, temporalSamples));
}

/** Advance the continuously rotating producer phase, restarting at zero only
 *  when temporal history is invalidated. */
export function advancePhaseIndex(index: number, restart: boolean): number {
    return restart ? 0 : index + 1;
}

/** Map a phase index to the [0, 1) rotation fraction consumed by the producer noise. */
export function phaseValue(index: number, temporalSamples: number): number {
    const bound = Math.max(1, temporalSamples);
    return (index % bound) / bound;
}

/** Events observed since the previous frame; see the architecture doc's "Reset matrix" table. */
export interface ScreenSpaceResetEvent {
    firstAllocation: boolean;
    targetReallocated: boolean;
    sourceIdentityChanged: boolean;
    resetVersionChanged: boolean;
    enabledTransitionedOn: boolean;
    singularInverse: boolean;
    cameraMoved: boolean;
}

export interface ScreenSpaceResetDecision {
    readonly invalidateHistory: boolean;
    readonly restartPhase: boolean;
}

/** Decide whether to invalidate temporal history and/or restart the phase sequence this
 *  frame. Camera motion keeps valid history and advances the existing phase sequence
 *  through `advancePhaseIndex`; invalidation events restart that sequence at phase zero. */
export function decideScreenSpaceReset(ev: ScreenSpaceResetEvent): ScreenSpaceResetDecision {
    const invalidateHistory = ev.firstAllocation || ev.targetReallocated || ev.sourceIdentityChanged || ev.resetVersionChanged || ev.enabledTransitionedOn || ev.singularInverse;
    const restartPhase = invalidateHistory;
    return { invalidateHistory, restartPhase };
}

/** Reverse-Z reprojection rejection: reject history when the relative difference between
 *  the expected and stored previous view distances exceeds 4%, or when no valid distance
 *  was ever stored (`storedPrevDist <= 0`, e.g. a freshly cleared history target). */
export function isHistoryAccepted(expectedPrevDist: number, storedPrevDist: number): boolean {
    if (storedPrevDist <= 0) {
        return false;
    }
    const rel = Math.abs(expectedPrevDist - storedPrevDist) / Math.max(expectedPrevDist, 0.001);
    return rel <= 0.04;
}

/** True when two identity references differ (including null \<-\> non-null transitions).
 *  Used to detect a device-recovery or owner rebuild that reallocated a same-sized
 *  GPUTexture, which must rebuild bind groups but must NOT be conflated with a resize. */
export function identityChanged<T>(previous: T | null, current: T | null): boolean {
    return previous !== current;
}

/** Clamp a resolution scale into `[0.25, 1]` (shared by both producers). */
export function clampScreenSpaceResolutionScale(scale: number): number {
    return Math.min(1, Math.max(0.25, scale));
}

/** Scale `width`/`height` by `scale`, rounding and clamping each dimension to at least 1 pixel. */
export function computeScreenSpaceScaledSize(width: number, height: number, scale: number): { width: number; height: number } {
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Resolve a render target's current pixel size, falling back to its descriptor's surface
 *  or explicit pixel size before the target has been built. */
export function resolveScreenSpaceSourceSize(source: RenderTarget): { width: number; height: number } {
    if (source._width > 0 && source._height > 0) {
        return { width: source._width, height: source._height };
    }
    const size = source._descriptor.size;
    if ("canvas" in size) {
        return { width: size.canvas.width, height: size.canvas.height };
    }
    return size;
}

/** Throw when `target` is the same object as `source`: sampling and rendering the same
 *  texture in one WebGPU pass is invalid, so the composite destination must differ from
 *  the effect's source. */
export function assertScreenSpaceTargetNotAliasingSource(taskName: string, target: RenderTarget | null | undefined, source: RenderTarget): void {
    if (target && target === source) {
        throw new Error(`"${taskName}": targetTexture must differ from sourceTexture.`);
    }
}

// ─── WGSL fragment generation ───────────────────────────────────────────────

const TEMPORAL_UNIFORM_WGSL = wgsl`struct SsTemporalParams{invViewProj:mat4x4f,currentView:mat4x4f,prevViewProj:mat4x4f,prevView:mat4x4f,effectDims:vec2f,depthDims:vec2f,params:vec4f}`;

/** Float count / byte size of `SsTemporalParams` (4 mat4x4f + 2 vec2f + f32 + padding, 16-byte aligned). */
export const SS_TEMPORAL_UNIFORM_FLOATS = 72;
export const SS_TEMPORAL_UNIFORM_BYTES = SS_TEMPORAL_UNIFORM_FLOATS * 4;

const TEMPORAL_BINDINGS_WGSL = wgsl`@group(0)@binding(0) var ssLinearSampler:sampler;
@group(0)@binding(1) var ssCurrentDepth:texture_depth_2d;
@group(0)@binding(2) var ssRawTex:texture_2d<f32>;
@group(0)@binding(3) var ssHistoryTex:texture_2d<f32>;
@group(0)@binding(4) var<uniform> ssTemporal:SsTemporalParams;`;

const TEMPORAL_VERTEX_WGSL = wgsl`struct SsVOut{@builtin(position) position:vec4f}
@vertex fn ssResolveVertex(@builtin(vertex_index) i:u32)->SsVOut{
  let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[i];
  return SsVOut(vec4f(p,0,1));
}`;

/** The fused depth-aware five-tap cross filter applied to the raw GI estimate before
 *  temporal blending (see the architecture doc's "Global-illumination producer" pipeline
 *  section). Combines a fixed spatial weight with relative view-depth agreement so it
 *  removes independent pixel noise without allocating another target or pass. */
const GI_FUSED_FILTER_WGSL = wgsl`fn ssFusedGiFilter(coord:vec2i,effectDims:vec2f,depthDims:vec2f)->vec3f{
  let centerUv=ssTexelUv(coord,effectDims);
  let centerDepth=textureLoad(ssCurrentDepth,ssUvToCoord(centerUv,depthDims),0);
  let centerWorld=ssWorldFromDepth(centerUv,centerDepth,ssTemporal.invViewProj);
  let centerDist=(ssTemporal.currentView*vec4f(centerWorld,1.0)).z;
  var sum=textureLoad(ssRawTex,coord,0).rgb;
  var totalWeight=1.0;
  let offsets=array<vec2i,8>(vec2i(1,0),vec2i(-1,0),vec2i(0,1),vec2i(0,-1),vec2i(1,1),vec2i(-1,1),vec2i(1,-1),vec2i(-1,-1));
  let spatialWeights=array<f32,8>(0.75,0.75,0.75,0.75,0.5,0.5,0.5,0.5);
  for(var i=0;i<8;i=i+1){
    let nCoord=ssClampCoord(coord+offsets[i],effectDims);
    let nUv=ssTexelUv(nCoord,effectDims);
    let nDepth=textureLoad(ssCurrentDepth,ssUvToCoord(nUv,depthDims),0);
    if(ssIsClearDepth(nDepth)){continue;}
    let nWorld=ssWorldFromDepth(nUv,nDepth,ssTemporal.invViewProj);
    let nDist=(ssTemporal.currentView*vec4f(nWorld,1.0)).z;
    let agreement=max(0.0,1.0-abs(nDist-centerDist)/max(centerDist,1e-4));
    let w=spatialWeights[i]*agreement;
    sum=sum+textureLoad(ssRawTex,nCoord,0).rgb*w;
    totalWeight=totalWeight+w;
  }
  return sum/max(totalWeight,1e-4);
}`;

/** Same-surface temporal supersampling for scalar contact shadows. Each phase
 *  selects one tap inside a bounded disk; depth validation prevents filtering
 *  across silhouettes while the temporal mean turns binary march hits into a
 *  stable, continuous contact term. */
const CONTACT_TEMPORAL_SAMPLE_WGSL = wgsl`fn ssFusedContactFilter(coord:vec2i,effectDims:vec2f,depthDims:vec2f)->f32{
  let centerUv=ssTexelUv(coord,effectDims);
  let centerDepth=textureLoad(ssCurrentDepth,ssUvToCoord(centerUv,depthDims),0);
  let centerWorld=ssWorldFromDepth(centerUv,centerDepth,ssTemporal.invViewProj);
  let centerDist=(ssTemporal.currentView*vec4f(centerWorld,1.0)).z;
  let offsets=array<vec2i,9>(vec2i(-1,-1),vec2i(0,-1),vec2i(1,-1),vec2i(-1,0),vec2i(0,0),vec2i(1,0),vec2i(-1,1),vec2i(0,1),vec2i(1,1));
  let spatialWeights=array<f32,9>(0.5,0.75,0.5,0.75,1.0,0.75,0.5,0.75,0.5);
  var sum=0.0;
  var totalWeight=0.0;
  for(var i=0;i<9;i=i+1){
    let tapCoord=ssClampCoord(coord+offsets[i],effectDims);
    let tapUv=ssTexelUv(tapCoord,effectDims);
    let tapDepth=textureLoad(ssCurrentDepth,ssUvToCoord(tapUv,depthDims),0);
    if(ssIsClearDepth(tapDepth)){continue;}
    let tapWorld=ssWorldFromDepth(tapUv,tapDepth,ssTemporal.invViewProj);
    let tapDist=(ssTemporal.currentView*vec4f(tapWorld,1.0)).z;
    let relErr=abs(tapDist-centerDist)/max(centerDist,0.001);
    if(relErr>0.04){continue;}
    let weight=spatialWeights[i]*(1.0-relErr/0.04);
    sum=sum+textureLoad(ssRawTex,tapCoord,0).r*weight;
    totalWeight=totalWeight+weight;
  }
  return sum/max(totalWeight,1e-4);
}

fn ssContactTemporalSample(coord:vec2i,effectDims:vec2f,depthDims:vec2f)->f32{
  let radius=max(ssTemporal.params.y,0.0);
  if(radius<=0.0){return ssFusedContactFilter(coord,effectDims,depthDims);}
  let phase=ssTemporal.params.z;
  let angle=phase*2.39996323;
  let radial=sqrt(fract(phase*0.754877666));
  let offset=vec2i(round(vec2f(cos(angle),sin(angle))*radial*radius));
  if(all(offset==vec2i(0))){return ssFusedContactFilter(coord,effectDims,depthDims);}
  let sampleCoord=ssClampCoord(coord+offset,effectDims);
  let centerUv=ssTexelUv(coord,effectDims);
  let sampleUv=ssTexelUv(sampleCoord,effectDims);
  let centerDepth=textureLoad(ssCurrentDepth,ssUvToCoord(centerUv,depthDims),0);
  let sampleDepth=textureLoad(ssCurrentDepth,ssUvToCoord(sampleUv,depthDims),0);
  if(ssIsClearDepth(sampleDepth)){return ssFusedContactFilter(coord,effectDims,depthDims);}
  let centerWorld=ssWorldFromDepth(centerUv,centerDepth,ssTemporal.invViewProj);
  let sampleWorld=ssWorldFromDepth(sampleUv,sampleDepth,ssTemporal.invViewProj);
  let centerDist=(ssTemporal.currentView*vec4f(centerWorld,1.0)).z;
  let sampleDist=(ssTemporal.currentView*vec4f(sampleWorld,1.0)).z;
  let relErr=abs(sampleDist-centerDist)/max(centerDist,0.001);
  if(relErr>0.04){return ssFusedContactFilter(coord,effectDims,depthDims);}
  return ssFusedContactFilter(sampleCoord,effectDims,depthDims);
}`;

/** Build the resolve-pass fragment shader for a given temporal kind. Both kinds share the
 *  reconstruction, reprojection-rejection, and 3x3 neighborhood-clamp logic; only the raw
 *  sample (same-surface temporal disk for scalar, fused filter for color) and the
 *  history channel layout (`.r`/`.g` vs `.rgb`/`.a`) differ. */
function resolveFragmentWGSL(kind: ScreenSpaceTemporalKind): string {
    const isColor = kind === "color";
    const rawSample = isColor ? wgsl`let rawValue=ssFusedGiFilter(coord,effectDims,depthDims);` : wgsl`let rawValue=ssContactTemporalSample(coord,effectDims,depthDims);`;
    const historyChannel = isColor ? "hist.rgb" : "hist.r";
    const storedPrevChannel = isColor ? "hist.a" : "hist.g";
    const zero = isColor ? "vec3f(0.0)" : "0.0";
    const clampBlock = isColor
        ? wgsl`var mn=rawValue;var mx=rawValue;
  let nOffsets=array<vec2i,8>(vec2i(-1,-1),vec2i(0,-1),vec2i(1,-1),vec2i(-1,0),vec2i(1,0),vec2i(-1,1),vec2i(0,1),vec2i(1,1));
  for(var i=0;i<8;i=i+1){
    let n=textureLoad(ssRawTex,ssClampCoord(coord+nOffsets[i],effectDims),0).rgb;
    mn=min(mn,n);
    mx=max(mx,n);
  }
  historyValue=clamp(historyValue,mn,mx);`
        : wgsl`var mn=rawValue;var mx=rawValue;
  let nOffsets=array<vec2i,8>(vec2i(-1,-1),vec2i(0,-1),vec2i(1,-1),vec2i(-1,0),vec2i(1,0),vec2i(-1,1),vec2i(0,1),vec2i(1,1));
  for(var i=0;i<8;i=i+1){
    let n=textureLoad(ssRawTex,ssClampCoord(coord+nOffsets[i],effectDims),0).r;
    mn=min(mn,n);
    mx=max(mx,n);
  }
  historyValue=clamp(historyValue,mn,mx);`;
    const output = isColor ? wgsl`vec4f(mix(historyValue,rawValue,weight),curDist)` : wgsl`vec4f(mix(historyValue,rawValue,weight),curDist,0.0,0.0)`;

    return wgsl`${isColor ? GI_FUSED_FILTER_WGSL : CONTACT_TEMPORAL_SAMPLE_WGSL}
@fragment fn ssResolveFragment(v:SsVOut)->@location(0) vec4f{
  let coord=vec2i(v.position.xy);
  let effectDims=ssTemporal.effectDims;
  let depthDims=ssTemporal.depthDims;
  let uv=ssTexelUv(coord,effectDims);
  let depth=textureLoad(ssCurrentDepth,ssUvToCoord(uv,depthDims),0);
  if(ssIsClearDepth(depth)){return vec4f(${zero === "0.0" ? "0.0,0.0,0.0,0.0" : "0.0,0.0,0.0,0.0"});}
  let worldPos=ssWorldFromDepth(uv,depth,ssTemporal.invViewProj);
  let curDist=(ssTemporal.currentView*vec4f(worldPos,1.0)).z;
  ${rawSample}
  var weight=ssTemporal.params.x;
  var historyValue=${zero};
  var moved=false;
  let reproj=ssUvFromWorld(worldPos,ssTemporal.prevViewProj);
  if(reproj.x>=0.0&&reproj.x<=1.0&&reproj.y>=0.0&&reproj.y<=1.0){
    let expectedPrev=(ssTemporal.prevView*vec4f(worldPos,1.0)).z;
    let hist=textureSampleLevel(ssHistoryTex,ssLinearSampler,reproj.xy,0.0);
    let storedPrev=${storedPrevChannel};
    let relErr=abs(expectedPrev-storedPrev)/max(expectedPrev,0.001);
    if(storedPrev>0.0&&relErr<=0.04){
      historyValue=${historyChannel};
      moved=length((reproj.xy-uv)*effectDims)>=1.0;
    }else{
      weight=1.0;
    }
  }else{
    weight=1.0;
  }
  if(moved){${clampBlock}}
  return ${output};
}`;
}

/** Full resolve-pass shader module source for a given kind (vertex + shared raymarch
 *  library + bindings + fragment). Exported for WGSL-contract unit tests. */
export function screenSpaceTemporalResolveWGSL(kind: ScreenSpaceTemporalKind): string {
    return wgsl`${TEMPORAL_VERTEX_WGSL}\n${TEMPORAL_UNIFORM_WGSL}\n${TEMPORAL_BINDINGS_WGSL}\n${screenSpaceRaymarchWGSL()}\n${resolveFragmentWGSL(kind)}`;
}

const HISTORY_COPY_FRAGMENT_WGSL = wgsl`fn applyPostProcess(color:vec4f, uv:vec2f)->vec4f{return color;}`;

/** Configuration for `createScreenSpaceTemporalOwner`. */
export interface ScreenSpaceTemporalOwnerConfig {
    name: string;
    kind: ScreenSpaceTemporalKind;
    engine: EngineContext;
    scene?: SceneContext;
}

/** Per-frame inputs consumed by the temporal owner's resolve pass. */
export interface ScreenSpaceTemporalResolveInputs {
    width: number;
    height: number;
    depthWidth: number;
    depthHeight: number;
    /** Producer's raw output this frame (r8unorm scalar or rgba16float color). */
    rawTexture: RenderTarget;
    /** Depth-only reconstruction source (matches the producer's depth binding). */
    depthTexture: RenderTarget;
    /** Current inverse view-projection matrix (world reconstruction from depth). */
    invViewProj: Mat4;
    /** Current view matrix (view-space distance for the stored history value). */
    viewMatrix: Mat4;
    /** Current view-projection matrix (saved as next frame's `prevViewProj`). */
    viewProjMatrix: Mat4;
    /** Blend weight of the current estimate against reprojected history (see `computeTemporalWeight`). */
    weight: number;
    /** Same-surface spatial supersampling radius in effect pixels (scalar/contact only). */
    spatialRadius?: number;
    /** Integer temporal phase selecting the scalar supersampling tap. */
    spatialPhase?: number;
}

/** The shared temporal owner: allocates the stable/history targets, builds the resolve
 *  pipeline, and runs resolve + history-copy each frame. Created once per public task
 *  (contact shadows or global illumination); never imported unless that task is used. */
export interface ScreenSpaceTemporalOwner {
    /** Resolved, reprojected, neighborhood-clamped effect target (this frame's stable output). */
    readonly stableTexture: RenderTarget;
    /** Previous frame's stable output, sampled by the resolve pass this frame. */
    readonly historyTexture: RenderTarget;
    /** True once GPU state has been (re)allocated for the current `width`/`height`. */
    readonly allocated: boolean;
    /** Allocate or resize the owned targets + resolve pipeline. Idempotent when unchanged.
     *  Returns true when a reallocation occurred (targets were freshly sized). */
    record(width: number, height: number): boolean;
    /** Run the resolve + history-copy passes for this frame. Must be called AFTER the
     *  producer has written `inputs.rawTexture`. Returns the draw call count (2). */
    resolve(inputs: ScreenSpaceTemporalResolveInputs): number;
    /** Zero the stable and history targets once (the enabled -\> disabled transition). */
    clearIdentity(): void;
    dispose(): void;
}

/** Create the shared temporal owner for one producer (`kind` selects the scalar contact-
 *  shadow layout or the color GI layout, including the fused five-tap prefilter). */
export function createScreenSpaceTemporalOwner(config: ScreenSpaceTemporalOwnerConfig): ScreenSpaceTemporalOwner {
    const { engine, kind, scene } = config;
    const name = config.name;
    const format: GPUTextureFormat = kind === "color" ? "rgba16float" : "rg16float";

    const stable = createRenderTarget({ lbl: `${name}-stable`, format, samples: 1, size: { width: 1, height: 1 } });
    const history = createRenderTarget({ lbl: `${name}-history`, format, samples: 1, size: { width: 1, height: 1 } });
    stable._eager = true;
    history._eager = true;

    const historyCopy: PostProcessTask = createPostProcessTask(
        {
            name: `${name}-history-copy`,
            sourceTexture: stable,
            sourceSamplingMode: "nearest",
            targetTexture: history,
            _shader: { fragmentWGSL: HISTORY_COPY_FRAGMENT_WGSL },
        },
        engine,
        scene
    );

    let width = 0;
    let height = 0;
    let pipeline: GPURenderPipeline | null = null;
    let bindGroupLayout: GPUBindGroupLayout | null = null;
    let bindGroup: GPUBindGroup | null = null;
    let uniformBuffer: GPUBuffer | null = null;
    const uniformData = new F32(SS_TEMPORAL_UNIFORM_FLOATS);

    let boundRaw: GPUTexture | null = null;
    let boundDepth: GPUTexture | null = null;
    let boundHistory: GPUTexture | null = null;

    const prevViewProj = new F32(16);
    const prevView = new F32(16);

    const renderPassDescriptor: GPURenderPassDescriptor = {
        label: `${name}-resolve`,
        colorAttachments: [{ view: undefined!, loadOp: "clear", storeOp: "store" }],
    };

    function ensurePipeline(): void {
        if (pipeline) {
            return;
        }
        const device = engine._device;
        bindGroupLayout = device.createBindGroupLayout({
            label: `${name}-resolve-bgl`,
            entries: [
                { binding: 0, visibility: SS.FRAGMENT, sampler: { type: "filtering" } },
                { binding: 1, visibility: SS.FRAGMENT, texture: { sampleType: "depth" } },
                { binding: 2, visibility: SS.FRAGMENT, texture: { sampleType: "float" } },
                { binding: 3, visibility: SS.FRAGMENT, texture: { sampleType: "float" } },
                { binding: 4, visibility: SS.FRAGMENT, buffer: { type: "uniform" } },
            ],
        });
        const code = screenSpaceTemporalResolveWGSL(kind);
        const module = device.createShaderModule({ label: `${name}-resolve`, code });
        pipeline = device.createRenderPipeline({
            label: `${name}-resolve-pipeline`,
            layout: device.createPipelineLayout({ label: `${name}-resolve-layout`, bindGroupLayouts: [bindGroupLayout] }),
            vertex: { module, entryPoint: "ssResolveVertex" },
            fragment: { module, entryPoint: "ssResolveFragment", targets: [{ format }] },
            primitive: { topology: "triangle-list" },
        });
        uniformBuffer = device.createBuffer({ label: `${name}-resolve-uniforms`, size: SS_TEMPORAL_UNIFORM_BYTES, usage: BU.UNIFORM | BU.COPY_DST });
    }

    function rebuildBindGroup(rawTexture: RenderTarget, depthTexture: RenderTarget): void {
        const depthView = depthTexture._depthTexture!.createView({ aspect: "depth-only" });
        bindGroup = engine._device.createBindGroup({
            label: `${name}-resolve-bind-group`,
            layout: bindGroupLayout!,
            entries: [
                { binding: 0, resource: getBilinearSampler(engine) },
                { binding: 1, resource: depthView },
                { binding: 2, resource: rawTexture._colorView! },
                { binding: 3, resource: history._colorView! },
                { binding: 4, resource: { buffer: uniformBuffer! } },
            ],
        });
        boundRaw = rawTexture._colorTexture;
        boundDepth = depthTexture._depthTexture;
        boundHistory = history._colorTexture;
    }

    return {
        get stableTexture(): RenderTarget {
            return stable;
        },
        get historyTexture(): RenderTarget {
            return history;
        },
        get allocated(): boolean {
            return width > 0 && height > 0;
        },
        record(w: number, h: number): boolean {
            ensurePipeline();
            const nw = Math.max(1, Math.floor(w));
            const nh = Math.max(1, Math.floor(h));
            if (nw === width && nh === height) {
                return false;
            }
            width = nw;
            height = nh;
            stable._eager = false;
            history._eager = false;
            disposeRenderTarget(stable);
            disposeRenderTarget(history);
            stable._descriptor.size = { width: nw, height: nh };
            history._descriptor.size = { width: nw, height: nh };
            buildRenderTarget(stable, engine);
            buildRenderTarget(history, engine);
            stable._eager = true;
            history._eager = true;
            historyCopy.record();
            bindGroup = null; // stale: pointed at the old history/stable textures
            return true;
        },
        resolve(inputs: ScreenSpaceTemporalResolveInputs): number {
            const rawIdentityChanged = identityChanged(boundRaw, inputs.rawTexture._colorTexture);
            const depthIdentityChanged = identityChanged(boundDepth, inputs.depthTexture._depthTexture);
            const historyIdentityChanged = identityChanged(boundHistory, history._colorTexture);
            if (!bindGroup || rawIdentityChanged || depthIdentityChanged || historyIdentityChanged) {
                rebuildBindGroup(inputs.rawTexture, inputs.depthTexture);
            }

            uniformData.fill(0);
            packMat4IntoF32(uniformData, inputs.invViewProj, 0);
            packMat4IntoF32(uniformData, inputs.viewMatrix, 16);
            packMat4IntoF32(uniformData, prevViewProj, 32);
            packMat4IntoF32(uniformData, prevView, 48);
            uniformData[64] = inputs.width;
            uniformData[65] = inputs.height;
            uniformData[66] = inputs.depthWidth;
            uniformData[67] = inputs.depthHeight;
            uniformData[68] = inputs.weight;
            uniformData[69] = inputs.spatialRadius ?? 0;
            uniformData[70] = inputs.spatialPhase ?? 0;
            engine._device.queue.writeBuffer(uniformBuffer!, 0, uniformData as Float32Array<ArrayBuffer>);

            renderPassDescriptor.colorAttachments = [{ view: stable._colorView!, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }];
            const pass = engine._currentEncoder.beginRenderPass(renderPassDescriptor);
            pass.setPipeline(pipeline!);
            pass.setBindGroup(0, bindGroup!);
            pass.draw(3);
            pass.end();

            const draws = 1 + (historyCopy.execute?.() ?? 0);

            packMat4IntoF32(prevViewProj, inputs.viewProjMatrix, 0);
            packMat4IntoF32(prevView, inputs.viewMatrix, 0);

            return draws;
        },
        clearIdentity(): void {
            if (stable._colorView) {
                const pass = engine._currentEncoder.beginRenderPass({
                    label: `${name}-clear-stable`,
                    colorAttachments: [{ view: stable._colorView, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
                });
                pass.end();
            }
            if (history._colorView) {
                const pass = engine._currentEncoder.beginRenderPass({
                    label: `${name}-clear-history`,
                    colorAttachments: [{ view: history._colorView, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
                });
                pass.end();
            }
        },
        dispose(): void {
            historyCopy.dispose();
            stable._eager = false;
            history._eager = false;
            disposeRenderTarget(stable);
            disposeRenderTarget(history);
            pipeline = null;
            bindGroup = null;
            bindGroupLayout = null;
            uniformBuffer?.destroy();
            uniformBuffer = null;
            boundRaw = null;
            boundDepth = null;
            boundHistory = null;
        },
    };
}
