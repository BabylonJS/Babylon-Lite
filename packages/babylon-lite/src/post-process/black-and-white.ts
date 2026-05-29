import type { EngineContext } from "../engine/engine.js";
import { createPostProcessTask, type PostProcessTask, type PostProcessTaskConfig } from "../frame-graph/post-process-task.js";
import type { SceneContext } from "../scene/scene-core.js";

export interface BlackAndWhitePostProcessTaskConfig extends Omit<PostProcessTaskConfig, "_shader"> {
    degree?: number;
}

export interface BlackAndWhitePostProcessTask extends PostProcessTask {
    degree: number;
}

const BLACK_AND_WHITE_UNIFORM_WGSL = `struct BlackAndWhiteParams{degree:f32,p0:f32,p1:f32,p2:f32}
@group(0) @binding(2) var<uniform> blackAndWhiteParams:BlackAndWhiteParams;`;

const BLACK_AND_WHITE_FRAGMENT_WGSL = `fn applyPostProcess(color:vec4f, uv:vec2f)->vec4f{let luminance=dot(color.rgb,vec3f(0.3,0.59,0.11));let gray=vec3f(luminance);return vec4f(mix(color.rgb,gray,clamp(blackAndWhiteParams.degree,0,1)),color.a);}`;

export function createBlackAndWhitePostProcessTask(config: BlackAndWhitePostProcessTaskConfig, engine: EngineContext, scene: SceneContext): BlackAndWhitePostProcessTask {
    const params = { degree: config.degree ?? 1 };
    const task = createPostProcessTask(
        {
            name: config.name ?? "black-and-white",
            sourceTexture: config.sourceTexture,
            sourceSamplingMode: config.sourceSamplingMode,
            targetTexture: config.targetTexture,
            alphaMode: config.alphaMode,
            viewport: config.viewport,
            clear: config.clear,
            _shader: {
                uniformWGSL: BLACK_AND_WHITE_UNIFORM_WGSL,
                uniformByteLength: 16,
                writeUniforms(data) {
                    data[0] = params.degree;
                },
                fragmentWGSL: BLACK_AND_WHITE_FRAGMENT_WGSL,
            },
        },
        engine,
        scene
    ) as BlackAndWhitePostProcessTask;
    Object.defineProperty(task, "degree", {
        get: () => params.degree,
        set: (value: number) => {
            params.degree = value;
        },
    });
    return task;
}
