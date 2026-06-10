import type { Camera } from "../camera/camera.js";
import type { EngineContext } from "../engine/engine.js";
import type { RenderTarget } from "../engine/render-target.js";
import { createRenderTarget, disposeRenderTarget } from "../engine/render-target.js";
import { type PostProcessTaskSettings } from "../frame-graph/post-process-task.js";
import type { Task } from "../frame-graph/task.js";
import type { SceneContext } from "../scene/scene-core.js";
import { createCircleOfConfusionPostProcessTask, type CircleOfConfusionPostProcessTask } from "./circle-of-confusion.js";
import { createDepthOfFieldBlurPostProcessTask, type DepthOfFieldBlurPostProcessTask } from "./depth-of-field-blur.js";
import { createDepthOfFieldMergePostProcessTask, type DepthOfFieldMergePostProcessTask } from "./depth-of-field-merge.js";

/** Quality of the depth-of-field blur. Models BJS `ThinDepthOfFieldEffectBlurLevel`. */
export enum DepthOfFieldBlurLevel {
    /** Subtle blur — 1 blur level, kernel 15. */
    Low = 0,
    /** Medium blur — 2 blur levels, kernel 31. */
    Medium = 1,
    /** Large blur — 3 blur levels, kernel 51. */
    High = 2,
}

/**
 * Configuration for `createDepthOfFieldPostProcessTask`.
 *
 * Models Babylon.js's `FrameGraphDepthOfFieldTask` + `ThinDepthOfFieldEffect`:
 * a circle-of-confusion pass feeds a stack of CoC-weighted separable blurs,
 * which are merged back over the sharp image for a physically-plausible
 * depth-of-field effect.
 */
export interface DepthOfFieldPostProcessTaskConfig extends PostProcessTaskSettings {
    /** Depth texture. With `depthNotNormalized` it stores camera-space (view)
     *  depth; otherwise normalized [0,1] view depth. */
    depthTexture: RenderTarget;
    /** Camera used to read minZ/maxZ when the depth is normalized. */
    camera: Camera;
    /** Max lens size in scene units / 1000. Default 50. */
    lensSize?: number;
    /** F-Stop of the camera. Default 1.4. */
    fStop?: number;
    /** Distance from the camera to focus on, in scene units / 1000. Default 2000. */
    focusDistance?: number;
    /** Focal length of the camera in scene units / 1000. Default 50. */
    focalLength?: number;
    /** Blur quality. Default {@link DepthOfFieldBlurLevel.Low}. */
    blurLevel?: DepthOfFieldBlurLevel;
    /** When true the depth texture stores camera-space depth (0..maxZ). */
    depthNotNormalized?: boolean;
}

/** A composite depth-of-field post-process task: circle-of-confusion → CoC-weighted blur pyramid → merge. */
export interface DepthOfFieldPostProcessTask extends Task, PostProcessTaskSettings {
    readonly name: string;
    sourceTexture: RenderTarget;
    targetTexture: RenderTarget | null;
    outputTexture: RenderTarget;
    lensSize: number;
    fStop: number;
    focusDistance: number;
    focalLength: number;
    /** Recompute and upload the uniforms of every sub-pass (CoC, blurs, merge). */
    updateUniforms(): void;
}

interface DepthOfFieldTaskInternal extends DepthOfFieldPostProcessTask {
    _coc: CircleOfConfusionPostProcessTask;
    _blurX: DepthOfFieldBlurPostProcessTask[];
    _blurY: DepthOfFieldBlurPostProcessTask[];
    _merge: DepthOfFieldMergePostProcessTask;
    _cocTarget: RenderTarget;
    _blurXTargets: RenderTarget[];
    _blurYTargets: RenderTarget[];
}

interface BlurLevelConfig {
    blurCount: number;
    kernel: number;
}

function blurLevelConfig(level: DepthOfFieldBlurLevel): BlurLevelConfig {
    switch (level) {
        case DepthOfFieldBlurLevel.High:
            return { blurCount: 3, kernel: 51 };
        case DepthOfFieldBlurLevel.Medium:
            return { blurCount: 2, kernel: 31 };
        default:
            return { blurCount: 1, kernel: 15 };
    }
}

function resolveSourceSize(source: RenderTarget, engine: EngineContext): { width: number; height: number } {
    if (source._width > 0 && source._height > 0) {
        return { width: source._width, height: source._height };
    }
    if (source._descriptor.size === "canvas") {
        return { width: engine.canvas.width, height: engine.canvas.height };
    }
    return source._descriptor.size;
}

function blurTargetSize(source: RenderTarget, ratio: number, engine: EngineContext): { width: number; height: number } {
    const size = resolveSourceSize(source, engine);
    return { width: Math.max(1, Math.floor(size.width * ratio)), height: Math.max(1, Math.floor(size.height * ratio)) };
}

/**
 * Create a depth-of-field post-process task. The source image is first reduced
 * to a circle-of-confusion map (from the depth texture + lens parameters), then
 * blurred at one to three decreasing resolutions with CoC-weighted blurs, and
 * finally merged so each pixel transitions smoothly from sharp to blurred based
 * on how far out of focus it is.
 *
 * @param config - Source/depth textures, camera, lens parameters, blur level, and target settings.
 * @param engine - The owning engine.
 * @param scene - Optional owning scene. Omit for scene-less standalone frame graphs.
 * @returns The depth-of-field post-process task.
 */
export function createDepthOfFieldPostProcessTask(config: DepthOfFieldPostProcessTaskConfig, engine: EngineContext, scene?: SceneContext): DepthOfFieldPostProcessTask {
    const eng = engine as EngineContext;
    const params = {
        sourceTexture: config.sourceTexture,
        targetTexture: config.targetTexture ?? null,
        sourceSamplingMode: config.sourceSamplingMode ?? "linear",
        alphaMode: config.alphaMode ?? 0,
        viewport: config.viewport ?? null,
        clear: config.clear ?? true,
        lensSize: config.lensSize ?? 50,
        fStop: config.fStop ?? 1.4,
        focusDistance: config.focusDistance ?? 2000,
        focalLength: config.focalLength ?? 50,
    };
    const name = config.name ?? "depth-of-field";
    const { blurCount, kernel } = blurLevelConfig(config.blurLevel ?? DepthOfFieldBlurLevel.Low);
    const adjustedKernel = kernel / Math.pow(2, blurCount - 1);
    // BJS sizes BOTH blurY[i] and blurX[i] targets at the blurX[i] ratio = 0.75 / 2^i.
    const blurRatios: number[] = [];
    for (let i = 0; i < blurCount; i++) {
        blurRatios.push(0.75 / Math.pow(2, i));
    }

    const sourceFormat = params.sourceTexture._descriptor.format;
    if (!sourceFormat) {
        throw new Error(`DepthOfFieldPostProcessTask "${name}": sourceTexture must have a format.`);
    }

    // Circle-of-confusion target (single-channel, filterable), full source size.
    const cocTarget = createRenderTarget({ lbl: `${name}-coc`, format: "r16float", samples: 1, size: "canvas" });
    const coc = createCircleOfConfusionPostProcessTask(
        {
            name: `${name}-coc`,
            sourceTexture: params.sourceTexture, // not used by the CoC shader
            sourceSamplingMode: "linear",
            depthTexture: config.depthTexture,
            camera: config.camera,
            lensSize: params.lensSize,
            fStop: params.fStop,
            focusDistance: params.focusDistance,
            focalLength: params.focalLength,
            depthNotNormalized: config.depthNotNormalized,
            targetTexture: cocTarget,
        },
        engine,
        scene
    );

    const blurY: DepthOfFieldBlurPostProcessTask[] = [];
    const blurX: DepthOfFieldBlurPostProcessTask[] = [];
    const blurYTargets: RenderTarget[] = [];
    const blurXTargets: RenderTarget[] = [];
    const blurSteps: RenderTarget[] = [];
    for (let i = 0; i < blurCount; i++) {
        const size = blurTargetSize(params.sourceTexture, blurRatios[i]!, eng);
        const yTarget = createRenderTarget({ lbl: `${name}-blur-y-${i}`, format: sourceFormat, samples: 1, size });
        const xTarget = createRenderTarget({ lbl: `${name}-blur-x-${i}`, format: sourceFormat, samples: 1, size });
        const yTask = createDepthOfFieldBlurPostProcessTask(
            {
                name: `${name}-blur-y-${i}`,
                sourceTexture: i === 0 ? params.sourceTexture : blurXTargets[i - 1]!,
                sourceSamplingMode: "linear",
                circleOfConfusionTexture: cocTarget,
                direction: { x: 0, y: 1 },
                kernel: adjustedKernel,
                targetTexture: yTarget,
            },
            engine,
            scene
        );
        const xTask = createDepthOfFieldBlurPostProcessTask(
            {
                name: `${name}-blur-x-${i}`,
                sourceTexture: yTarget,
                sourceSamplingMode: "linear",
                circleOfConfusionTexture: cocTarget,
                direction: { x: 1, y: 0 },
                kernel: adjustedKernel,
                targetTexture: xTarget,
            },
            engine,
            scene
        );
        blurY.push(yTask);
        blurX.push(xTask);
        blurYTargets.push(yTarget);
        blurXTargets.push(xTarget);
        blurSteps.push(xTarget);
    }

    const merge = createDepthOfFieldMergePostProcessTask(
        {
            name: `${name}-merge`,
            sourceTexture: params.sourceTexture,
            sourceSamplingMode: params.sourceSamplingMode,
            targetTexture: params.targetTexture,
            alphaMode: params.alphaMode,
            viewport: params.viewport,
            clear: params.clear,
            circleOfConfusionTexture: cocTarget,
            blurSteps,
        },
        engine,
        scene
    );

    const task: DepthOfFieldTaskInternal = {
        name,
        engine: eng,
        scene,
        _passes: [],
        sourceTexture: params.sourceTexture,
        sourceSamplingMode: params.sourceSamplingMode,
        targetTexture: params.targetTexture,
        alphaMode: params.alphaMode,
        viewport: params.viewport,
        clear: params.clear,
        outputTexture: merge.outputTexture,
        _coc: coc,
        _blurX: blurX,
        _blurY: blurY,
        _merge: merge,
        _cocTarget: cocTarget,
        _blurXTargets: blurXTargets,
        _blurYTargets: blurYTargets,
        record(): void {
            for (let i = 0; i < blurCount; i++) {
                const size = blurTargetSize(params.sourceTexture, blurRatios[i]!, eng);
                blurYTargets[i]!._descriptor.size = size;
                blurXTargets[i]!._descriptor.size = size;
            }
            coc.record();
            for (let i = 0; i < blurCount; i++) {
                blurY[i]!.record();
                blurX[i]!.record();
            }
            merge.record();
            task.outputTexture = merge.outputTexture;
        },
        execute(): number {
            let n = coc.execute?.() ?? 0;
            for (let i = 0; i < blurCount; i++) {
                n += blurY[i]!.execute?.() ?? 0;
                n += blurX[i]!.execute?.() ?? 0;
            }
            n += merge.execute?.() ?? 0;
            return n;
        },
        updateUniforms(): void {
            coc.updateUniforms();
            for (let i = 0; i < blurCount; i++) {
                blurY[i]!.updateUniforms();
                blurX[i]!.updateUniforms();
            }
            merge.updateUniforms();
        },
        dispose(): void {
            coc.dispose();
            for (let i = 0; i < blurCount; i++) {
                blurY[i]!.dispose();
                blurX[i]!.dispose();
            }
            merge.dispose();
            disposeRenderTarget(cocTarget);
            for (const t of blurYTargets) {
                disposeRenderTarget(t);
            }
            for (const t of blurXTargets) {
                disposeRenderTarget(t);
            }
        },
        get lensSize() {
            return coc.lensSize;
        },
        set lensSize(value: number) {
            coc.lensSize = value;
        },
        get fStop() {
            return coc.fStop;
        },
        set fStop(value: number) {
            coc.fStop = value;
        },
        get focusDistance() {
            return coc.focusDistance;
        },
        set focusDistance(value: number) {
            coc.focusDistance = value;
        },
        get focalLength() {
            return coc.focalLength;
        },
        set focalLength(value: number) {
            coc.focalLength = value;
        },
    };
    Object.defineProperties(task, {
        sourceTexture: {
            get: () => params.sourceTexture,
            set: (value: RenderTarget) => {
                params.sourceTexture = value;
                coc.sourceTexture = value;
                merge.sourceTexture = value;
                blurY[0]!.sourceTexture = value;
            },
        },
        sourceSamplingMode: {
            get: () => params.sourceSamplingMode,
            set: (value: "nearest" | "linear") => {
                params.sourceSamplingMode = value;
                merge.sourceSamplingMode = value;
            },
        },
        targetTexture: {
            get: () => params.targetTexture,
            set: (value: RenderTarget | null) => {
                params.targetTexture = value;
                merge.targetTexture = value;
                task.outputTexture = merge.outputTexture;
            },
        },
        alphaMode: {
            get: () => params.alphaMode,
            set: (value: 0 | 1 | 2 | 7) => {
                params.alphaMode = value;
                merge.alphaMode = value;
            },
        },
        viewport: {
            get: () => params.viewport,
            set: (value) => {
                params.viewport = value;
                merge.viewport = value;
            },
        },
        clear: {
            get: () => params.clear,
            set: (value: boolean) => {
                params.clear = value;
                merge.clear = value;
            },
        },
    });
    return task;
}
