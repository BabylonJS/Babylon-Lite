import type { EngineContext } from "../engine/engine.js";
import type { RenderTarget } from "../engine/render-target.js";
import { createPostProcessTask, type PostProcessTask, type PostProcessTaskConfig } from "../frame-graph/post-process-task.js";
import type { SceneContext } from "../scene/scene-core.js";

/** Configuration for `createAnaglyphPostProcessTask`; `leftTexture` is the left-eye image combined with the source (right eye). */
export interface AnaglyphPostProcessTaskConfig extends Omit<PostProcessTaskConfig, "_shader"> {
    leftTexture: RenderTarget;
}

/** A post-process task that combines a left-eye and right-eye image into a red/cyan anaglyph 3D image. */
export interface AnaglyphPostProcessTask extends PostProcessTask {
    leftTexture: RenderTarget;
}

const ANAGLYPH_EXTRA_TEXTURE_WGSL = `@group(0) @binding(2) var leftTextureSampler:texture_2d<f32>;`;

const ANAGLYPH_FRAGMENT_WGSL = `fn applyPostProcess(color:vec4f, uv:vec2f)->vec4f{let l=textureSampleLevel(leftTextureSampler,sourceSampler,clamp(uv,vec2f(0),vec2f(1)),0);let left=vec4f(1,l.g,l.b,1);let right=vec4f(color.r,1,1,1);return vec4f(right.rgb*left.rgb,1);}`;

/**
 * Create a post-process task that merges a left-eye texture with the source (right eye) into a red/cyan anaglyph.
 * @param config - Source/target settings and the left-eye `leftTexture`.
 * @param engine - The owning engine.
 * @param scene - Optional owning scene. Omit for scene-less standalone frame graphs.
 * @returns The anaglyph post-process task.
 */
export function createAnaglyphPostProcessTask(config: AnaglyphPostProcessTaskConfig, engine: EngineContext, scene?: SceneContext): AnaglyphPostProcessTask {
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
