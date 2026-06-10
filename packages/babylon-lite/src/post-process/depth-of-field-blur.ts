import type { EngineContext } from "../engine/engine.js";
import type { RenderTarget } from "../engine/render-target.js";
import { createPostProcessTask, type PostProcessShaderConfig, type PostProcessTask, type PostProcessTaskConfig } from "../frame-graph/post-process-task.js";
import type { SceneContext } from "../scene/scene-core.js";

/** @internal A 2-component vector `{ x, y }` used for the blur direction. */
export interface PostProcessVec2 {
    x: number;
    y: number;
}

/**
 * Configuration for `createDepthOfFieldBlurPostProcessTask`.
 *
 * Models Babylon.js's `ThinDepthOfFieldBlurPostProcess` (the `#define DOF`
 * variant of `ThinBlurPostProcess`): a separable Gaussian blur whose per-tap
 * weight is modulated by the circle-of-confusion so that in-focus pixels stay
 * sharp (bokeh weighting).
 *
 * @internal
 */
export interface DepthOfFieldBlurPostProcessTaskConfig extends Omit<PostProcessTaskConfig, "_shader"> {
    /** Grayscale circle-of-confusion texture, sampled per tap (`.r`) to weight the blur. */
    circleOfConfusionTexture: RenderTarget;
    /** Blur axis: `{ x: 1, y: 0 }` horizontal, `{ x: 0, y: 1 }` vertical. */
    direction?: PostProcessVec2;
    /** Length in pixels of the blur sample region. */
    kernel?: number;
}

/** @internal A separable depth-of-field blur pass along a single `direction`, weighted by the CoC. */
export interface DepthOfFieldBlurPostProcessTask extends PostProcessTask {
    direction: PostProcessVec2;
    kernel: number;
}

const MAX_VERTEX_BLUR_SAMPLES = 8;

const DOF_BLUR_EXTRA_TEXTURE_WGSL = `@group(0) @binding(2) var dofCocTexture:texture_2d<f32>;`;

const DOF_BLUR_UNIFORM_WGSL = `struct DofBlurParams{delta:vec2f,p0:f32,p1:f32}
@group(0) @binding(3) var<uniform> dofBlurParams:DofBlurParams;`;

// Samples the CoC at `uv` with the shared (bilinear) source sampler — matches
// BJS `sampleCoC` in `ShadersInclude/kernelBlur*Fragment.fx`.
const DOF_BLUR_COC_SAMPLE_WGSL = `fn sampleCoC(uv:vec2f)->f32{return textureSample(dofCocTexture,sourceSampler,uv).r;}`;

interface BlurSample {
    offset: number;
    weight: number;
}

// The following three helpers are byte-identical to `blur.ts` (BJS
// `ThinBlurPostProcess` weight generation, linear-sampled Gaussian). They are
// duplicated rather than shared so the standalone blur path stays untouched.
function nearestBestKernel(kernel: number): number {
    const value = Math.max(1, Math.round(kernel));
    for (const k of [value, value - 1, value + 1, value - 2, value + 2]) {
        if (k > 0 && k % 2 !== 0 && Math.floor(k / 2) % 2 === 0) {
            return Math.max(k, 3);
        }
    }
    return Math.max(value, 3);
}

function gaussianWeight(x: number): number {
    const sigma = 1 / 3;
    return Math.exp(-(x * x) / (2 * sigma * sigma)) / (Math.sqrt(2 * Math.PI) * sigma);
}

function getOptimizedBlurSamples(kernel: number): BlurSample[] {
    const n = nearestBestKernel(kernel);
    const centerIndex = (n - 1) / 2;
    const offsets: number[] = [];
    const weights: number[] = [];
    let totalWeight = 0;
    for (let i = 0; i < n; i++) {
        const weight = gaussianWeight((i / (n - 1)) * 2 - 1);
        offsets[i] = i - centerIndex;
        weights[i] = weight;
        totalWeight += weight;
    }
    for (let i = 0; i < weights.length; i++) {
        weights[i]! /= totalWeight;
    }
    const samples: BlurSample[] = [];
    for (let i = 0; i <= centerIndex; i += 2) {
        const j = Math.min(i + 1, Math.floor(centerIndex));
        if (i === j) {
            samples.push({ offset: offsets[i]!, weight: weights[i]! });
            continue;
        }
        const sharedCell = j === centerIndex;
        const weight = weights[i]! + weights[j]! * (sharedCell ? 0.5 : 1);
        const offset = offsets[i]! + 1 / (1 + weights[i]! / weights[j]!);
        if (offset === 0) {
            samples.push({ offset: offsets[i]!, weight: weights[i]! }, { offset: offsets[i + 1]!, weight: weights[i + 1]! });
        } else {
            samples.push({ offset, weight }, { offset: -offset, weight });
        }
    }
    return samples;
}

function wgslFloat(value: number): string {
    return value.toFixed(7).replace(/0+$/, "").replace(/\.$/, ".0");
}

// Builds the DOF blur shader. The last optimized sample is the centre tap
// (offset 0): it is added unconditionally with its raw weight (`CENTER_WEIGHT`,
// no CoC factor) and seeds `sumOfWeights`. Every other tap is weighted by the
// CoC sampled at that tap, then the accumulated colour is divided by the total
// weight. Mirrors `ShadersWGSL/kernelBlur.fragment.fx` with `#define DOF`.
function updateDofBlurShader(shader: PostProcessShaderConfig, kernel: number): void {
    const samples = getOptimizedBlurSamples(kernel);
    const center = samples[samples.length - 1]!;
    const offsetSamples = samples.slice(0, samples.length - 1);
    const varyingCount = Math.min(offsetSamples.length, MAX_VERTEX_BLUR_SAMPLES);
    shader.vertexOutputWGSL = "";
    shader.vertexMainWGSL = "";
    for (let i = 0; i < varyingCount; i++) {
        shader.vertexOutputWGSL += `,@location(${i + 1}) sampleCoord${i}:vec2f`;
        shader.vertexMainWGSL += `out.sampleCoord${i}=out.uv+dofBlurParams.delta*${wgslFloat(offsetSamples[i]!.offset)};`;
    }
    let body = `var blend=textureSample(sourceTextureSampler,sourceSampler,input.uv)*${wgslFloat(center.weight)};`;
    body += `var sumOfWeights=${wgslFloat(center.weight)};`;
    for (let i = 0; i < offsetSamples.length; i++) {
        const sample = offsetSamples[i]!;
        const coord = i < varyingCount ? `input.sampleCoord${i}` : `(input.uv+dofBlurParams.delta*${wgslFloat(sample.offset)})`;
        body += `let f${i}=sampleCoC(${coord});let w${i}=${wgslFloat(sample.weight)}*f${i};sumOfWeights=sumOfWeights+w${i};`;
        body += `blend=blend+textureSample(sourceTextureSampler,sourceSampler,${coord})*w${i};`;
    }
    body += `return blend/sumOfWeights;`;
    shader.fragmentWGSL = DOF_BLUR_COC_SAMPLE_WGSL;
    shader.fragmentWrapperWGSL = `@fragment fn postProcessFragment(input:PostProcessVertexOutput)->@location(0) vec4f{${body}}`;
}

/**
 * Create a depth-of-field blur post-process task. Apply twice (vertical then
 * horizontal) per blur level for a full 2D blur. Unlike the plain Gaussian
 * blur, each non-centre tap is weighted by the circle-of-confusion sampled at
 * that tap, so sharp (in-focus) neighbours barely contribute — producing the
 * characteristic depth-of-field bokeh.
 *
 * @internal
 * @param config - Blur direction, kernel, CoC texture, and source/target settings.
 * @param engine - The owning engine.
 * @param scene - Optional owning scene. Omit for scene-less standalone frame graphs.
 * @returns The depth-of-field blur post-process task.
 */
export function createDepthOfFieldBlurPostProcessTask(config: DepthOfFieldBlurPostProcessTaskConfig, engine: EngineContext, scene?: SceneContext): DepthOfFieldBlurPostProcessTask {
    const params = { direction: config.direction ?? { x: 1, y: 0 }, kernel: config.kernel ?? 9 };
    const shader: PostProcessShaderConfig = {
        extraTextureWGSL: DOF_BLUR_EXTRA_TEXTURE_WGSL,
        extraTextures: [config.circleOfConfusionTexture],
        uniformWGSL: DOF_BLUR_UNIFORM_WGSL,
        uniformBinding: 3,
        uniformByteLength: 16,
        writeUniforms(data) {
            // delta = direction / outputSize (BJS `ThinBlurPostProcess.bind` uses
            // the OUTPUT texture size via `FrameGraphBlurTask`).
            const width = Math.max(1, task.outputTexture._width || config.sourceTexture._width);
            const height = Math.max(1, task.outputTexture._height || config.sourceTexture._height);
            data[0] = params.direction.x / width;
            data[1] = params.direction.y / height;
        },
        fragmentWGSL: "",
    };
    updateDofBlurShader(shader, params.kernel);
    const task = createPostProcessTask(
        {
            name: config.name ?? "depth-of-field-blur",
            sourceTexture: config.sourceTexture,
            sourceSamplingMode: config.sourceSamplingMode ?? "linear",
            targetTexture: config.targetTexture,
            alphaMode: config.alphaMode,
            viewport: config.viewport,
            clear: config.clear,
            _shader: shader,
        },
        engine,
        scene
    ) as DepthOfFieldBlurPostProcessTask;
    const baseUpdateUniforms = task.updateUniforms;
    let shaderKernel = params.kernel;
    task.updateUniforms = () => {
        if (shaderKernel !== params.kernel) {
            shaderKernel = params.kernel;
            updateDofBlurShader(task._shader, params.kernel);
            task.record();
        }
        baseUpdateUniforms();
    };
    Object.defineProperties(task, {
        direction: {
            get: () => params.direction,
            set: (value: PostProcessVec2) => {
                params.direction = value;
            },
        },
        kernel: {
            get: () => params.kernel,
            set: (value: number) => {
                params.kernel = value;
            },
        },
    });
    return task;
}
