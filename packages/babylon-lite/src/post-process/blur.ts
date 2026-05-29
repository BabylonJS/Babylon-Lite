import type { EngineContext } from "../engine/engine.js";
import { createPostProcessTask, type PostProcessShaderConfig, type PostProcessTask, type PostProcessTaskConfig } from "../frame-graph/post-process-task.js";
import type { SceneContext } from "../scene/scene-core.js";

export interface PostProcessVec2 {
    x: number;
    y: number;
}

export interface BlurPostProcessTaskConfig extends Omit<PostProcessTaskConfig, "_shader"> {
    direction?: PostProcessVec2;
    kernel?: number;
}

export interface BlurPostProcessTask extends PostProcessTask {
    direction: PostProcessVec2;
    kernel: number;
}

const MAX_VERTEX_BLUR_SAMPLES = 8;

const BLUR_UNIFORM_WGSL = `struct BlurParams{delta:vec2f,p0:f32,p1:f32}
@group(0) @binding(2) var<uniform> blurParams:BlurParams;`;

interface BlurSample {
    offset: number;
    weight: number;
}

interface BlurPostProcessTaskInternal extends BlurPostProcessTask {
    readonly _shader: PostProcessShaderConfig;
}

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

function updateBlurShader(shader: PostProcessShaderConfig, kernel: number): void {
    const samples = getOptimizedBlurSamples(kernel);
    const varyingCount = Math.min(samples.length, MAX_VERTEX_BLUR_SAMPLES);
    shader.vertexOutputWGSL = "";
    shader.vertexMainWGSL = "";
    for (let i = 0; i < varyingCount; i++) {
        shader.vertexOutputWGSL += `,@location(${i + 1}) sampleCoord${i}:vec2f`;
        shader.vertexMainWGSL += `out.sampleCoord${i}=out.uv+blurParams.delta*${wgslFloat(samples[i]!.offset)};`;
    }
    let body = "var blend=vec4f(0);";
    for (let i = 0; i < varyingCount; i++) {
        body += `blend+=textureSample(sourceTextureSampler,sourceSampler,input.sampleCoord${i})*${wgslFloat(samples[i]!.weight)};`;
    }
    for (let i = varyingCount; i < samples.length; i++) {
        const sample = samples[i]!;
        body += `blend+=samplePostProcessSource(input.uv+blurParams.delta*${wgslFloat(sample.offset)})*${wgslFloat(sample.weight)};`;
    }
    body += "return blend;";
    shader.fragmentWGSL = "";
    shader.fragmentWrapperWGSL = `@fragment fn postProcessFragment(input:PostProcessVertexOutput)->@location(0) vec4f{${body}}`;
}

export function createBlurPostProcessTask(config: BlurPostProcessTaskConfig, engine: EngineContext, scene: SceneContext): BlurPostProcessTask {
    const params = { direction: config.direction ?? { x: 1, y: 0 }, kernel: config.kernel ?? 9 };
    const shader: PostProcessShaderConfig = {
        uniformWGSL: BLUR_UNIFORM_WGSL,
        uniformByteLength: 16,
        writeUniforms(data) {
            const width = Math.max(1, task.outputTexture._width || config.sourceTexture._width);
            const height = Math.max(1, task.outputTexture._height || config.sourceTexture._height);
            data[0] = params.direction.x / width;
            data[1] = params.direction.y / height;
        },
        fragmentWGSL: "",
    };
    updateBlurShader(shader, params.kernel);
    const task = createPostProcessTask(
        {
            name: config.name ?? "blur",
            sourceTexture: config.sourceTexture,
            sourceSamplingMode: config.sourceSamplingMode,
            targetTexture: config.targetTexture,
            alphaMode: config.alphaMode,
            viewport: config.viewport,
            clear: config.clear,
            _shader: shader,
        },
        engine,
        scene
    ) as BlurPostProcessTaskInternal;
    const baseUpdateUniforms = task.updateUniforms;
    let shaderKernel = params.kernel;
    task.updateUniforms = () => {
        if (shaderKernel !== params.kernel) {
            shaderKernel = params.kernel;
            updateBlurShader(task._shader, params.kernel);
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
