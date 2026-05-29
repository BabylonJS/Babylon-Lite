import type { EngineContext } from "../engine/engine.js";
import type { RenderTarget } from "../engine/render-target.js";
import { createPostProcessTask, type PostProcessTask, type PostProcessTaskConfig } from "../frame-graph/post-process-task.js";
import type { SceneContext } from "../scene/scene-core.js";

export interface AnaglyphPostProcessTaskConfig extends Omit<PostProcessTaskConfig, "_shader"> {
    leftTexture: RenderTarget;
}

export interface AnaglyphPostProcessTask extends PostProcessTask {
    leftTexture: RenderTarget;
}

const ANAGLYPH_EXTRA_TEXTURE_WGSL = `@group(0) @binding(2) var leftTextureSampler:texture_2d<f32>;`;

const ANAGLYPH_FRAGMENT_WGSL = `fn applyPostProcess(color:vec4f, uv:vec2f)->vec4f{let l=textureSampleLevel(leftTextureSampler,sourceSampler,clamp(uv,vec2f(0),vec2f(1)),0);let left=vec4f(1,l.g,l.b,1);let right=vec4f(color.r,1,1,1);return vec4f(right.rgb*left.rgb,1);}`;

export function createAnaglyphPostProcessTask(config: AnaglyphPostProcessTaskConfig, engine: EngineContext, scene: SceneContext): AnaglyphPostProcessTask {
    const task = createPostProcessTask(
        {
            name: config.name ?? "anaglyph",
            sourceTexture: config.sourceTexture,
            sourceSamplingMode: config.sourceSamplingMode,
            targetTexture: config.targetTexture,
            alphaMode: config.alphaMode,
            viewport: config.viewport,
            clear: config.clear,
            _shader: {
                extraTextureWGSL: ANAGLYPH_EXTRA_TEXTURE_WGSL,
                extraTextures: [config.leftTexture],
                fragmentWGSL: ANAGLYPH_FRAGMENT_WGSL,
            },
        },
        engine,
        scene
    ) as AnaglyphPostProcessTask;
    task.leftTexture = config.leftTexture;
    return task;
}
