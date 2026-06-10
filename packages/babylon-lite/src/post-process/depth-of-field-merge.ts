import type { EngineContext } from "../engine/engine.js";
import type { RenderTarget } from "../engine/render-target.js";
import { createPostProcessTask, type PostProcessTask, type PostProcessTaskConfig } from "../frame-graph/post-process-task.js";
import type { SceneContext } from "../scene/scene-core.js";

/**
 * Configuration for `createDepthOfFieldMergePostProcessTask`.
 *
 * Models Babylon.js's `ThinDepthOfFieldMergePostProcess` +
 * `depthOfFieldMerge.fragment`: blends the original image with progressively
 * blurred copies, selected per pixel by the circle-of-confusion.
 *
 * @internal
 */
export interface DepthOfFieldMergePostProcessTaskConfig extends Omit<PostProcessTaskConfig, "_shader"> {
    /** Grayscale circle-of-confusion texture (`.r`), 0 = in focus, 1 = max blur. */
    circleOfConfusionTexture: RenderTarget;
    /** Blurred copies in increasing-blur (decreasing-resolution) push order:
     *  `[least-blurred, …, most-blurred]`. Length 1..3 selects the blur level. */
    blurSteps: readonly RenderTarget[];
}

/** @internal A post-process task that merges the original image with the depth-of-field blur steps. */
export type DepthOfFieldMergePostProcessTask = PostProcessTask;

// Binds `dofCocTexture` then `blurStep0..N`, where `blurStep0` is the MOST
// blurred step (matches the BJS reverse binding in `depthOfFieldMergeTask`).
function buildMergeExtraTextureWGSL(blurLevel: number): string {
    let wgsl = `@group(0) @binding(2) var dofCocTexture:texture_2d<f32>;@group(0) @binding(3) var blurStep0:texture_2d<f32>;`;
    if (blurLevel > 0) {
        wgsl += `@group(0) @binding(4) var blurStep1:texture_2d<f32>;`;
    }
    if (blurLevel > 1) {
        wgsl += `@group(0) @binding(5) var blurStep2:texture_2d<f32>;`;
    }
    return wgsl;
}

// Ports `depthOfFieldMerge.fragment.fx`. `color` is the original image (the
// framework already sampled the source). All other reads use
// `textureSampleLevel(..., 0.0)` like BJS.
function buildMergeFragmentWGSL(blurLevel: number): string {
    const head =
        `fn applyPostProcess(color:vec4f,uv:vec2f)->vec4f{` +
        `let coc=textureSampleLevel(dofCocTexture,sourceSampler,uv,0.0).r;` +
        `let blurred0=textureSampleLevel(blurStep0,sourceSampler,uv,0.0);`;
    if (blurLevel === 0) {
        return head + `return mix(color,blurred0,coc);}`;
    }
    if (blurLevel === 1) {
        return (
            head +
            `let blurred1=textureSampleLevel(blurStep1,sourceSampler,uv,0.0);` +
            `if(coc<0.5){return mix(color,blurred1,coc/0.5);}` +
            `return mix(blurred1,blurred0,(coc-0.5)/0.5);}`
        );
    }
    return (
        head +
        `let blurred1=textureSampleLevel(blurStep1,sourceSampler,uv,0.0);` +
        `let blurred2=textureSampleLevel(blurStep2,sourceSampler,uv,0.0);` +
        `if(coc<0.33){return mix(color,blurred2,coc/0.33);}` +
        `if(coc<0.66){return mix(blurred2,blurred1,(coc-0.33)/0.33);}` +
        `return mix(blurred1,blurred0,(coc-0.66)/0.34);}`
    );
}

/**
 * Create a depth-of-field merge post-process task. For each pixel it picks the
 * appropriate blur step(s) based on the circle-of-confusion and blends them
 * with the sharp original, giving a smooth transition from in-focus to fully
 * blurred. The blur level (0/1/2) is derived from `blurSteps.length - 1`.
 *
 * @internal
 * @param config - Original source, CoC texture, blur steps, and target settings.
 * @param engine - The owning engine.
 * @param scene - Optional owning scene. Omit for scene-less standalone frame graphs.
 * @returns The depth-of-field merge post-process task.
 */
export function createDepthOfFieldMergePostProcessTask(
    config: DepthOfFieldMergePostProcessTaskConfig,
    engine: EngineContext,
    scene?: SceneContext
): DepthOfFieldMergePostProcessTask {
    const blurLevel = config.blurSteps.length - 1;
    // Extra textures in binding order: CoC, then blur steps reversed so that
    // binding 3 (`blurStep0`) is the most-blurred step.
    const extraTextures: RenderTarget[] = [config.circleOfConfusionTexture];
    for (let i = config.blurSteps.length - 1; i >= 0; i--) {
        extraTextures.push(config.blurSteps[i]!);
    }
    return createPostProcessTask(
        {
            name: config.name ?? "depth-of-field-merge",
            sourceTexture: config.sourceTexture,
            sourceSamplingMode: config.sourceSamplingMode ?? "linear",
            targetTexture: config.targetTexture,
            alphaMode: config.alphaMode,
            viewport: config.viewport,
            clear: config.clear,
            _shader: {
                extraTextureWGSL: buildMergeExtraTextureWGSL(blurLevel),
                extraTextures,
                fragmentWGSL: buildMergeFragmentWGSL(blurLevel),
            },
        },
        engine,
        scene
    );
}
