// Temporal Anti-Aliasing (TAA) — a frame-graph post-process task.
//
// TAA jitters the camera projection by a sub-pixel Halton offset every frame and
// accumulates a moving average of consecutive (jittered) frames. Spreading the
// supersampling over time yields high-quality edge anti-aliasing without rendering
// the scene multiple times per frame. The accumulated history converges to a
// supersampled image after a few dozen frames.
//
// This task is a pure frame-graph node: add it at the END of a chain whose source
// render task draws the scene into `sourceTexture`. Each frame it:
//   1. blend     : temp = mix(history, current, factor)   (history bound as extra)
//   2. present    : temp -> targetTexture (e.g. the swapchain)
//   3. historyUpd : temp -> history        (becomes next frame's history)
//   4. advances the Halton sequence and writes the jittered viewProjection into the
//      *source render task's* scene UBO so the NEXT frame renders sub-pixel shifted.
//
// `factor` is the blend weight of the current frame (BJS default 0.05). On the first
// frame and on a camera-move reset it is forced to 1 (output == current) so no stale
// history bleeds in.
//
// The jitter is injected by overwriting only the viewProjection slice (bytes 0..63)
// of the source task's already-packed scene UBO. The source task's UBO write is
// cached on the camera's worldMatrixVersion, so with a static camera our jittered
// matrix survives each frame; when the camera moves the source re-packs a clean
// matrix (a natural reset) and we set factor=1 for that frame. This needs zero
// changes to the shared camera / scene-uniform hot path — so scenes that do not use
// TAA pay nothing.

import { F32 } from "../engine/typed-arrays.js";
import type { EngineContext } from "../engine/engine.js";
import type { RenderTarget } from "../engine/render-target.js";
import { buildRenderTarget, createRenderTarget, disposeRenderTarget } from "../engine/render-target.js";
import { createPostProcessTask, type PostProcessTask, type PostProcessTaskSettings } from "../frame-graph/post-process-task.js";
import type { RenderTask } from "../frame-graph/render-task.js";
import type { Task } from "../frame-graph/task.js";
import type { SceneContext } from "../scene/scene-core.js";

/** Configuration for `createTaaPostProcessTask`. */
export interface TaaPostProcessTaskConfig extends PostProcessTaskSettings {
    /** The render task that draws the scene into `sourceTexture`. TAA jitters this
     *  task's camera projection each frame (mirrors BJS `FrameGraphTAATask.objectRendererTask`). */
    sourceRenderTask: RenderTask;
    /** Blend weight of the current frame against the accumulated history (default: 0.05). */
    factor?: number;
    /** Number of jitter samples in the Halton sequence (default: 8). */
    samples?: number;
    /** Force a one-frame reset (output == current) whenever the camera moves (default: true).
     *  Avoids ghosting while the view changes. */
    disableOnCameraMove?: boolean;
}

/** A Temporal Anti-Aliasing post-process task: accumulates jittered frames into an
 *  anti-aliased image. Inject at the end of a frame-graph chain. */
export interface TaaPostProcessTask extends Task, PostProcessTaskSettings {
    readonly name: string;
    sourceTexture: RenderTarget;
    targetTexture: RenderTarget | null;
    outputTexture: RenderTarget;
    /** Blend weight of the current frame (smaller = smoother / slower convergence). */
    factor: number;
    /** Number of Halton jitter samples. */
    readonly samples: number;
    /** Reset to the current frame whenever the camera moves. */
    disableOnCameraMove: boolean;
    /** Recompute and upload the blend pass uniforms from current settings. */
    updateUniforms(): void;
}

interface TaaTaskInternal extends TaaPostProcessTask {
    _blend: PostProcessTask;
    _present: PostProcessTask;
    _historyUpdate: PostProcessTask;
    _history: RenderTarget;
    _temp: RenderTarget;
    _sourceRenderTask: RenderTask;
    /** Raw Halton offsets in [-0.5, 0.5): [x0,y0, x1,y1, ...]. Scaled per-frame by source size. */
    _halton: Float32Array;
    _haltonIndex: number;
    _jitterScratch: Float32Array;
    _firstUpdate: boolean;
    _lastCamVer: number;
    _factor: number;
}

const TAA_HISTORY_TEXTURE_WGSL = `@group(0) @binding(2) var taaHistory:texture_2d<f32>;`;

const TAA_UNIFORM_WGSL = `struct TaaParams{factor:f32,p0:f32,p1:f32,p2:f32}
@group(0) @binding(3) var<uniform> taaParams:TaaParams;`;

// mix(history, current, factor): factor=1 -> current only (first frame / reset).
const TAA_FRAGMENT_WGSL = `fn applyPostProcess(color:vec4f, uv:vec2f)->vec4f{let h=textureSample(taaHistory,sourceSampler,uv);return mix(h,color,taaParams.factor);}`;

// Identity passthrough used by the present + history-update copies.
const TAA_COPY_FRAGMENT_WGSL = `fn applyPostProcess(color:vec4f, uv:vec2f)->vec4f{return color;}`;

/**
 * Create a Temporal Anti-Aliasing post-process task.
 * @param config - Source texture + source render task, blend factor, sample count.
 * @param engine - The owning engine.
 * @param scene - Optional owning scene.
 * @returns The TAA post-process task. Add it at the end of the frame-graph chain.
 */
export function createTaaPostProcessTask(config: TaaPostProcessTaskConfig, engine: EngineContext, scene?: SceneContext): TaaPostProcessTask {
    const name = config.name ?? "taa";
    const source = config.sourceTexture;
    const target = config.targetTexture ?? null;
    // Clamp to >= 1: a zero/negative sample count would make `generateHalton` return an
    // empty sequence and `advanceJitter` write NaN jitter offsets into the source UBO.
    const samples = Math.max(1, Math.floor(config.samples ?? 8));
    const sizeRef = source._descriptor.size;

    // History accumulates at RGBA16F so the 0.05 moving average does not band on
    // an 8-bit buffer (matches BJS half-float history).
    const history = createRenderTarget({ lbl: `${name}-history`, format: "rgba16float", samples: 1, size: sizeRef });
    const temp = createRenderTarget({ lbl: `${name}-temp`, format: "rgba16float", samples: 1, size: sizeRef });

    const blend = createPostProcessTask(
        {
            name: `${name}-blend`,
            sourceTexture: source,
            // Nearest sampling reads the exact co-located texel of both the current
            // frame and the history (all three targets share a resolution).
            sourceSamplingMode: "nearest",
            targetTexture: temp,
            _shader: {
                extraTextureWGSL: TAA_HISTORY_TEXTURE_WGSL,
                extraTextures: [history],
                uniformWGSL: TAA_UNIFORM_WGSL,
                uniformBinding: 3,
                uniformByteLength: 16,
                writeUniforms(data) {
                    data[0] = task._factor;
                },
                fragmentWGSL: TAA_FRAGMENT_WGSL,
            },
        },
        engine,
        scene
    );
    const present = createPostProcessTask(
        {
            name: `${name}-present`,
            sourceTexture: temp,
            sourceSamplingMode: "nearest",
            targetTexture: target ?? engine.scRT,
            _shader: { fragmentWGSL: TAA_COPY_FRAGMENT_WGSL },
        },
        engine,
        scene
    );
    const historyUpdate = createPostProcessTask(
        {
            name: `${name}-history-update`,
            sourceTexture: temp,
            sourceSamplingMode: "nearest",
            targetTexture: history,
            _shader: { fragmentWGSL: TAA_COPY_FRAGMENT_WGSL },
        },
        engine,
        scene
    );

    const task: TaaTaskInternal = {
        name,
        engine,
        scene,
        _passes: [],
        sourceTexture: source,
        targetTexture: target,
        outputTexture: target ?? engine.scRT,
        factor: config.factor ?? 0.05,
        samples,
        disableOnCameraMove: config.disableOnCameraMove ?? true,
        _blend: blend,
        _present: present,
        _historyUpdate: historyUpdate,
        _history: history,
        _temp: temp,
        _sourceRenderTask: config.sourceRenderTask,
        _halton: generateHalton(samples),
        _haltonIndex: 0,
        _jitterScratch: new F32(16),
        _firstUpdate: true,
        _lastCamVer: -1,
        _factor: 1,
        record(): void {
            // History + temp are persistent ping-pong buffers: allocate them once
            // (eager), sized to the source, and only reallocate on a real size change.
            // Marking them eager makes the sub-tasks' internal `buildRenderTarget`
            // no-op on them — critical because `historyUpdate` targets `history`, and a
            // rebuild there would destroy the texture `blend`'s bind group references.
            const { width: w, height: h } = resolveSourceSize(task.sourceTexture);
            ensurePersistentTarget(history, engine, w, h);
            ensurePersistentTarget(temp, engine, w, h);
            blend.record();
            present.record();
            historyUpdate.record();
            task._firstUpdate = true;
            task._haltonIndex = 0;
            task._lastCamVer = -1;
        },
        execute(): number {
            const cam = task._sourceRenderTask.scene.camera;
            const camVer = cam ? cam.worldMatrixVersion : 0;
            const moved = camVer !== task._lastCamVer;
            task._lastCamVer = camVer;

            // factor=1 on the first frame and on camera-move reset: take the current
            // (un-jittered) frame verbatim, discarding stale history.
            const reset = task._firstUpdate || (moved && task.disableOnCameraMove);
            task._factor = reset ? 1 : task.factor;
            blend.updateUniforms();

            let draws = blend.execute?.() ?? 0;
            draws += present.execute?.() ?? 0;
            draws += historyUpdate.execute?.() ?? 0;

            task._firstUpdate = false;

            // Prepare the NEXT frame's jitter: advance the Halton sequence and write the
            // jittered viewProjection into the source task's UBO. Always done — even on a
            // reset frame — so accumulation starts immediately on the following frame.
            // The blend `factor` reset already prevents stale-history bleed, and a still-
            // moving camera re-packs a clean matrix next frame anyway (overwriting this).
            advanceJitter(task);
            return draws;
        },
        updateUniforms(): void {
            blend.updateUniforms();
        },
        dispose(): void {
            task._passes.length = 0;
            blend.dispose();
            present.dispose();
            historyUpdate.dispose();
            // Clear the eager flag so the persistent buffers are actually freed.
            history._eager = false;
            temp._eager = false;
            disposeRenderTarget(history);
            disposeRenderTarget(temp);
        },
    };
    return task;
}

/** Allocate (or, on a size change, reallocate) a persistent ping-pong target sized
 *  `width`×`height`. The target is marked `_eager` so the post-process sub-tasks'
 *  internal `buildRenderTarget` no-ops on it, keeping accumulated history alive across
 *  frames and preventing a rebuild from destroying a texture still bound elsewhere. */
function ensurePersistentTarget(rt: RenderTarget, engine: EngineContext, width: number, height: number): void {
    if (rt._eager && rt._width === width && rt._height === height) {
        return;
    }
    rt._eager = false;
    disposeRenderTarget(rt);
    rt._descriptor.size = { width, height };
    buildRenderTarget(rt, engine);
    rt._eager = true;
}

/** Resolve a render target's pixel size: prefer its allocated dimensions, falling back
 *  to the descriptor's surface (multi-surface safe — does not assume the engine canvas)
 *  or explicit pixel size before the target has been built. */
function resolveSourceSize(source: RenderTarget): { width: number; height: number } {
    if (source._width > 0 && source._height > 0) {
        return { width: source._width, height: source._height };
    }
    const size = source._descriptor.size;
    if ("canvas" in size) {
        return { width: size.canvas.width, height: size.canvas.height };
    }
    return { width: size.width, height: size.height };
}

/** Generate `samples` 2D Halton offsets (base 2 / base 3) centered on [-0.5, 0.5). */
function generateHalton(samples: number): Float32Array {
    const seq = new F32(samples * 2);
    for (let i = 1; i <= samples; i++) {
        seq[(i - 1) * 2] = halton(i, 2) - 0.5;
        seq[(i - 1) * 2 + 1] = halton(i, 3) - 0.5;
    }
    return seq;
}

function halton(index: number, base: number): number {
    let fraction = 1;
    let result = 0;
    while (index > 0) {
        fraction /= base;
        result += fraction * (index % base);
        index = Math.floor(index / base);
    }
    return result;
}

/** Advance the Halton sequence and overwrite the source task's viewProjection
 *  (column-major bytes 0..63 of its scene UBO) with a sub-pixel jittered matrix. */
function advanceJitter(task: TaaTaskInternal): void {
    const src = task._sourceRenderTask;
    const clean = src._suData;
    const w = task.sourceTexture._width;
    const h = task.sourceTexture._height;
    if (w <= 0 || h <= 0) {
        return;
    }

    // NDC sub-pixel offset: one pixel spans 2/size in NDC, so size/2 is the denominator.
    const jx = task._halton[task._haltonIndex]! / (w / 2);
    const jy = task._halton[task._haltonIndex + 1]! / (h / 2);
    task._haltonIndex += 2;
    if (task._haltonIndex >= task._halton.length) {
        task._haltonIndex = 0;
    }

    // Translate the projected image by (jx, jy) in NDC: clip.xy += (jx,jy)*clip.w.
    // Column-major: row r, col c lives at c*4+r. Add j*row3 to row0 / row1.
    const out = task._jitterScratch;
    for (let c = 0; c < 4; c++) {
        const b = c * 4;
        const w3 = clean[b + 3]!;
        out[b] = clean[b]! + jx * w3;
        out[b + 1] = clean[b + 1]! + jy * w3;
        out[b + 2] = clean[b + 2]!;
        out[b + 3] = w3;
    }
    task.engine._device.queue.writeBuffer(src._sceneUBO, 0, out as Float32Array<ArrayBuffer>);
}
