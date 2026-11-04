import type { EngineContext } from "../engine/engine.js";
import type { RenderTarget } from "../engine/render-target.js";
import { createPostProcessTask, type PostProcessTask, type PostProcessTaskSettings } from "../frame-graph/post-process-task.js";
import type { SceneContext } from "../scene/scene-core.js";
import type { WgslSource } from "../shader/wgsl.js";

/** Application-defined fullscreen color pass, using the built-in post-process binding convention. */
export interface CustomPostProcessTaskConfig extends PostProcessTaskSettings {
    /** WGSL defining `fn applyPostProcess(color: vec4f, uv: vec2f) -> vec4f`. */
    fragmentWGSL: WgslSource;
    /** Uniform declarations at group 0 / binding `2 + extraTextures.length` (2 without extras). */
    uniformWGSL?: WgslSource;
    /** Uniform payload size in bytes; allocation is rounded up to 16 bytes. */
    uniformByteLength?: number;
    /** Fill reusable, zeroed float storage on record and `task.updateUniforms()`. */
    writeUniforms?: (data: Float32Array) => void;
    /** Declare additional `texture_2d<f32>` inputs at group 0 / bindings `2 + i`. */
    extraTextureWGSL?: WgslSource;
    /** Borrowed, filterable single-sample color targets, in binding order. */
    extraTextures?: readonly RenderTarget[];
}

/**
 * Create a custom fullscreen task over RenderTarget inputs. Schedule all input producers before it;
 * rebuild the graph after attachment replacement or resize. Shader/layout configuration is fixed for
 * the task's lifetime. Disposal preserves input targets and a caller-supplied output target.
 */
export function createCustomPostProcessTask(config: CustomPostProcessTaskConfig, engine: EngineContext, scene?: SceneContext): PostProcessTask {
    return createPostProcessTask({ ...config, _shader: config }, engine, scene);
}
