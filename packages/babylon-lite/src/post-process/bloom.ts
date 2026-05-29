import type { EngineContext, EngineContextInternal } from "../engine/engine.js";
import type { RenderTarget, RenderTargetDescriptor } from "../engine/render-target.js";
import { createRenderTarget, disposeRenderTarget } from "../engine/render-target.js";
import { createPostProcessTask, type PostProcessTask, type PostProcessTaskSettings } from "../frame-graph/post-process-task.js";
import type { Task } from "../frame-graph/task.js";
import type { SceneContext, SceneContextInternal } from "../scene/scene-core.js";
import { createBlurPostProcessTask, type BlurPostProcessTask } from "./blur.js";
import { createExtractHighlightsPostProcessTask, type ExtractHighlightsPostProcessTask } from "./extract-highlights.js";

export interface BloomPostProcessTaskConfig extends PostProcessTaskSettings {
    weight?: number;
    kernel?: number;
    threshold?: number;
    exposure?: number;
    bloomScale?: number;
}

export interface BloomPostProcessTask extends Task, PostProcessTaskSettings {
    readonly name: string;
    sourceTexture: RenderTarget;
    targetTexture: RenderTarget | null;
    outputTexture: RenderTarget;
    weight: number;
    kernel: number;
    threshold: number;
    exposure: number;
    readonly bloomScale: number;
    updateUniforms(): void;
}

interface BloomTaskInternal extends BloomPostProcessTask {
    _extract: ExtractHighlightsPostProcessTask;
    _blurX: BlurPostProcessTask;
    _blurY: BlurPostProcessTask;
    _merge: PostProcessTask;
    _extractTarget: RenderTarget;
    _blurXTarget: RenderTarget;
    _blurYTarget: RenderTarget;
}

const BLOOM_MERGE_EXTRA_TEXTURE_WGSL = `@group(0) @binding(2) var bloomBlur:texture_2d<f32>;`;

const BLOOM_MERGE_UNIFORM_WGSL = `struct BloomMergeParams{weight:f32,p0:f32,p1:f32,p2:f32}
@group(0) @binding(3) var<uniform> bloomMergeParams:BloomMergeParams;`;

const BLOOM_MERGE_FRAGMENT_WGSL = `fn applyPostProcess(color:vec4f, uv:vec2f)->vec4f{let blurred=textureSampleLevel(bloomBlur,sourceSampler,clamp(uv,vec2f(0),vec2f(1)),0).rgb;return vec4f(color.rgb+blurred*bloomMergeParams.weight,color.a);}`;

const scaledKernel = (kernel: number, scale: number): number => kernel * scale;

export function createBloomPostProcessTask(config: BloomPostProcessTaskConfig, engine: EngineContext, scene: SceneContext): BloomPostProcessTask {
    const eng = engine as EngineContextInternal;
    const sc = scene as SceneContextInternal;
    const params = {
        sourceTexture: config.sourceTexture,
        targetTexture: config.targetTexture ?? null,
        sourceSamplingMode: config.sourceSamplingMode ?? "linear",
        alphaMode: config.alphaMode ?? 0,
        viewport: config.viewport ?? null,
        clear: config.clear ?? true,
        weight: config.weight ?? 0.25,
        kernel: config.kernel ?? 64,
        threshold: config.threshold ?? 0.2,
        exposure: config.exposure ?? 1,
        bloomScale: config.bloomScale ?? 0.5,
    };
    const name = config.name ?? "bloom";
    const extractTarget = createScaledBloomTarget(`${name}-extract-output`, params.sourceTexture, params.bloomScale, eng);
    const blurXTarget = createScaledBloomTarget(`${name}-blur-x-output`, params.sourceTexture, params.bloomScale, eng);
    const blurYTarget = createScaledBloomTarget(`${name}-blur-y-output`, params.sourceTexture, params.bloomScale, eng);

    const extract = createExtractHighlightsPostProcessTask(
        {
            name: `${name}-extract-highlights`,
            sourceTexture: params.sourceTexture,
            sourceSamplingMode: "linear",
            targetTexture: extractTarget,
            threshold: params.threshold,
            exposure: params.exposure,
        },
        engine,
        scene
    );
    const blurX = createBlurPostProcessTask(
        {
            name: `${name}-blur-x`,
            sourceTexture: extractTarget,
            sourceSamplingMode: "linear",
            targetTexture: blurXTarget,
            direction: { x: 1, y: 0 },
            kernel: scaledKernel(params.kernel, params.bloomScale),
        },
        engine,
        scene
    );
    const blurY = createBlurPostProcessTask(
        {
            name: `${name}-blur-y`,
            sourceTexture: blurXTarget,
            sourceSamplingMode: "linear",
            targetTexture: blurYTarget,
            direction: { x: 0, y: 1 },
            kernel: scaledKernel(params.kernel, params.bloomScale),
        },
        engine,
        scene
    );
    const merge = createPostProcessTask(
        {
            name: `${name}-merge`,
            sourceTexture: params.sourceTexture,
            sourceSamplingMode: params.sourceSamplingMode,
            targetTexture: params.targetTexture,
            alphaMode: params.alphaMode,
            viewport: params.viewport,
            clear: params.clear,
            _shader: {
                extraTextureWGSL: BLOOM_MERGE_EXTRA_TEXTURE_WGSL,
                extraTextures: [blurYTarget],
                uniformWGSL: BLOOM_MERGE_UNIFORM_WGSL,
                uniformBinding: 3,
                uniformByteLength: 16,
                writeUniforms(data) {
                    data[0] = params.weight;
                },
                fragmentWGSL: BLOOM_MERGE_FRAGMENT_WGSL,
            },
        },
        engine,
        scene
    );

    const task: BloomTaskInternal = {
        name,
        engine: eng,
        scene: sc,
        _passes: [],
        sourceTexture: params.sourceTexture,
        sourceSamplingMode: params.sourceSamplingMode,
        targetTexture: params.targetTexture,
        alphaMode: params.alphaMode,
        viewport: params.viewport,
        clear: params.clear,
        outputTexture: merge.outputTexture,
        _extract: extract,
        _blurX: blurX,
        _blurY: blurY,
        _merge: merge,
        _extractTarget: extractTarget,
        _blurXTarget: blurXTarget,
        _blurYTarget: blurYTarget,
        record(): void {
            resizeScaledBloomTarget(task._extractTarget, params.sourceTexture, params.bloomScale, eng);
            resizeScaledBloomTarget(task._blurXTarget, params.sourceTexture, params.bloomScale, eng);
            resizeScaledBloomTarget(task._blurYTarget, params.sourceTexture, params.bloomScale, eng);
            extract.record();
            blurX.record();
            blurY.record();
            merge.record();
            task.outputTexture = merge.outputTexture;
        },
        execute(): number {
            return (extract.execute?.() ?? 0) + (blurX.execute?.() ?? 0) + (blurY.execute?.() ?? 0) + (merge.execute?.() ?? 0);
        },
        updateUniforms(): void {
            extract.updateUniforms();
            blurX.updateUniforms();
            blurY.updateUniforms();
            merge.updateUniforms();
        },
        dispose(): void {
            extract.dispose();
            blurX.dispose();
            blurY.dispose();
            merge.dispose();
            disposeRenderTarget(task._extractTarget);
            disposeRenderTarget(task._blurXTarget);
            disposeRenderTarget(task._blurYTarget);
        },
        get weight() {
            return params.weight;
        },
        set weight(value: number) {
            params.weight = value;
        },
        get kernel() {
            return params.kernel;
        },
        set kernel(value: number) {
            params.kernel = value;
            blurX.kernel = scaledKernel(value, params.bloomScale);
            blurY.kernel = scaledKernel(value, params.bloomScale);
        },
        get threshold() {
            return extract.threshold;
        },
        set threshold(value: number) {
            params.threshold = value;
            extract.threshold = value;
        },
        get exposure() {
            return extract.exposure;
        },
        set exposure(value: number) {
            params.exposure = value;
            extract.exposure = value;
        },
        get bloomScale() {
            return params.bloomScale;
        },
    };
    Object.defineProperties(task, {
        sourceTexture: {
            get: () => params.sourceTexture,
            set: (value: RenderTarget) => {
                params.sourceTexture = value;
                extract.sourceTexture = value;
                merge.sourceTexture = value;
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

function createScaledBloomTarget(label: string, source: RenderTarget, scale: number, engine: EngineContextInternal): RenderTarget {
    const srcDesc = source._descriptor;
    if (!srcDesc.colorFormat) {
        throw new Error(`BloomPostProcessTask "${label}": sourceTexture must have a colorFormat.`);
    }
    const sourceSize = resolveSourceSize(source, engine);
    return createRenderTarget({
        label,
        colorFormat: srcDesc.colorFormat,
        sampleCount: 1,
        size: {
            width: Math.max(1, Math.floor(sourceSize.width * scale)),
            height: Math.max(1, Math.floor(sourceSize.height * scale)),
        },
    });
}

function resizeScaledBloomTarget(target: RenderTarget, source: RenderTarget, scale: number, engine: EngineContextInternal): void {
    const colorFormat = source._descriptor.colorFormat;
    if (!colorFormat) {
        throw new Error(`BloomPostProcessTask "${target._descriptor.label ?? "target"}": sourceTexture must have a colorFormat.`);
    }
    const sourceSize = resolveSourceSize(source, engine);
    target._descriptor.colorFormat = colorFormat;
    target._descriptor.size = {
        width: Math.max(1, Math.floor(sourceSize.width * scale)),
        height: Math.max(1, Math.floor(sourceSize.height * scale)),
    };
}

function resolveSourceSize(source: RenderTarget, engine: EngineContextInternal): { width: number; height: number } {
    if (source._width > 0 && source._height > 0) {
        return { width: source._width, height: source._height };
    }
    const desc: RenderTargetDescriptor = source._descriptor;
    if (desc.size === "canvas") {
        return { width: engine.canvas.width, height: engine.canvas.height };
    }
    return desc.size;
}
