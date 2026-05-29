import type { EngineContext } from "../engine/engine.js";
import { createPostProcessTask, type PostProcessTask, type PostProcessTaskConfig } from "../frame-graph/post-process-task.js";
import type { SceneContext } from "../scene/scene-core.js";

export interface ExtractHighlightsPostProcessTaskConfig extends Omit<PostProcessTaskConfig, "_shader"> {
    threshold?: number;
    exposure?: number;
}

export interface ExtractHighlightsPostProcessTask extends PostProcessTask {
    threshold: number;
    exposure: number;
}

const TO_GAMMA_SPACE = 1 / 2.2;

const EXTRACT_HIGHLIGHTS_UNIFORM_WGSL = `struct ExtractHighlightsParams{threshold:f32,exposure:f32,p0:f32,p1:f32}
@group(0) @binding(2) var<uniform> extractHighlightsParams:ExtractHighlightsParams;`;

const EXTRACT_HIGHLIGHTS_FRAGMENT_WGSL = `fn applyPostProcess(color:vec4f, uv:vec2f)->vec4f{let luma=dot(vec3f(0.2126,0.7152,0.0722),color.rgb*extractHighlightsParams.exposure);return vec4f(step(extractHighlightsParams.threshold,luma)*color.rgb,color.a);}`;

export function createExtractHighlightsPostProcessTask(
    config: ExtractHighlightsPostProcessTaskConfig,
    engine: EngineContext,
    scene: SceneContext
): ExtractHighlightsPostProcessTask {
    const params = {
        threshold: config.threshold ?? 0.9,
        exposure: config.exposure ?? 1,
    };
    const task = createPostProcessTask(
        {
            name: config.name ?? "extract-highlights",
            sourceTexture: config.sourceTexture,
            sourceSamplingMode: config.sourceSamplingMode,
            targetTexture: config.targetTexture,
            alphaMode: config.alphaMode,
            viewport: config.viewport,
            clear: config.clear,
            _shader: {
                uniformWGSL: EXTRACT_HIGHLIGHTS_UNIFORM_WGSL,
                uniformByteLength: 16,
                writeUniforms(data) {
                    data[0] = Math.pow(params.threshold, TO_GAMMA_SPACE);
                    data[1] = params.exposure;
                },
                fragmentWGSL: EXTRACT_HIGHLIGHTS_FRAGMENT_WGSL,
            },
        },
        engine,
        scene
    ) as ExtractHighlightsPostProcessTask;
    Object.defineProperties(task, {
        threshold: {
            get: () => params.threshold,
            set: (value: number) => {
                params.threshold = value;
            },
        },
        exposure: {
            get: () => params.exposure,
            set: (value: number) => {
                params.exposure = value;
            },
        },
    });
    return task;
}
