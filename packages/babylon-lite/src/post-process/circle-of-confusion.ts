import type { Camera } from "../camera/camera.js";
import type { EngineContext } from "../engine/engine.js";
import type { RenderTarget } from "../engine/render-target.js";
import { createPostProcessTask, type PostProcessTask, type PostProcessTaskConfig } from "../frame-graph/post-process-task.js";
import type { SceneContext } from "../scene/scene-core.js";

/**
 * Configuration for `createCircleOfConfusionPostProcessTask`.
 *
 * Models Babylon.js's `FrameGraphCircleOfConfusionTask` +
 * `ThinCircleOfConfusionPostProcess`.
 */
export interface CircleOfConfusionPostProcessTaskConfig extends Omit<PostProcessTaskConfig, "_shader"> {
    /** Depth texture supplying per-pixel scene depth. With `depthNotNormalized`
     *  it must store **camera-space (view) depth** (the geometry renderer's
     *  VIEW_DEPTH attachment); otherwise it stores normalized [0,1] view depth. */
    depthTexture: RenderTarget;
    /** Camera used to read minZ/maxZ when the depth is normalized. */
    camera: Camera;
    /** Max lens size in scene units / 1000 (e.g. mm). Standard cameras are 50mm. Default 50. */
    lensSize?: number;
    /** F-Stop of the camera. Aperture diameter = lensSize / fStop. Default 1.4. */
    fStop?: number;
    /** Distance from the camera to focus on, in scene units / 1000. Default 2000. */
    focusDistance?: number;
    /** Focal length of the camera in scene units / 1000. Default 50. */
    focalLength?: number;
    /** When true the depth texture stores camera-space depth (0..maxZ) rather
     *  than normalized [0,1] depth, skipping the `cameraMinMaxZ` reconstruction. */
    depthNotNormalized?: boolean;
}

/** A post-process task that writes the per-pixel circle-of-confusion (grayscale)
 *  derived from scene depth and the lens focus parameters. */
export interface CircleOfConfusionPostProcessTask extends PostProcessTask {
    lensSize: number;
    fStop: number;
    focusDistance: number;
    focalLength: number;
}

const COC_EXTRA_TEXTURE_WGSL = `@group(0) @binding(2) var cocDepthTexture:texture_2d<f32>;`;

const COC_UNIFORM_WGSL = `struct CircleOfConfusionParams{focusDistance:f32,cocPrecalculation:f32,minZ:f32,maxZRange:f32}
@group(0) @binding(3) var<uniform> cocParams:CircleOfConfusionParams;`;

/** Builds the fragment body. The only difference between normalized and
 *  camera-space depth is how `pixelDistance` is reconstructed. See the BJS
 *  `circleOfConfusion.fragment` shader. */
function cocFragmentWGSL(depthNotNormalized: boolean): string {
    const pixelDistance = depthNotNormalized ? `depth*1000.0` : `(cocParams.minZ+cocParams.maxZRange*depth)*1000.0`;
    return `fn applyPostProcess(color:vec4f, uv:vec2f)->vec4f{let depth=textureSample(cocDepthTexture,sourceSampler,uv).r;let pixelDistance=${pixelDistance};var coc=abs(cocParams.cocPrecalculation*((cocParams.focusDistance-pixelDistance)/pixelDistance));coc=clamp(coc,0.0,1.0);return vec4f(coc,coc,coc,1.0);}`;
}

/**
 * Create a circle-of-confusion post-process task. The output is a grayscale map
 * where 0 = in focus and 1 = maximally out of focus, computed from the supplied
 * depth texture and the lens parameters (the usual first stage of a depth-of-field
 * pipeline). See https://developer.nvidia.com/gpugems/GPUGems/gpugems_ch23.html.
 *
 * @param config - Depth texture, camera, lens parameters and source/target settings.
 * @param engine - The owning engine.
 * @param scene - Optional owning scene. Omit for scene-less standalone frame graphs.
 * @returns The circle-of-confusion post-process task.
 */
export function createCircleOfConfusionPostProcessTask(
    config: CircleOfConfusionPostProcessTaskConfig,
    engine: EngineContext,
    scene?: SceneContext
): CircleOfConfusionPostProcessTask {
    const params = {
        lensSize: config.lensSize ?? 50,
        fStop: config.fStop ?? 1.4,
        focusDistance: config.focusDistance ?? 2000,
        focalLength: config.focalLength ?? 50,
    };
    const camera = config.camera;
    const depthNotNormalized = config.depthNotNormalized ?? false;
    const task = createPostProcessTask(
        {
            name: config.name ?? "circle-of-confusion",
            sourceTexture: config.sourceTexture,
            sourceSamplingMode: config.sourceSamplingMode ?? "linear",
            targetTexture: config.targetTexture,
            alphaMode: config.alphaMode,
            viewport: config.viewport,
            clear: config.clear,
            _shader: {
                extraTextures: [config.depthTexture],
                extraTextureWGSL: COC_EXTRA_TEXTURE_WGSL,
                uniformWGSL: COC_UNIFORM_WGSL,
                uniformByteLength: 16,
                writeUniforms(data) {
                    // aperture = lensSize / fStop; cocPrecalculation =
                    // (aperture * focalLength) / (focusDistance - focalLength).
                    const aperture = params.lensSize / params.fStop;
                    data[0] = params.focusDistance;
                    data[1] = (aperture * params.focalLength) / (params.focusDistance - params.focalLength);
                    data[2] = camera.nearPlane;
                    data[3] = camera.farPlane - camera.nearPlane;
                },
                fragmentWGSL: cocFragmentWGSL(depthNotNormalized),
            },
        },
        engine,
        scene
    ) as CircleOfConfusionPostProcessTask;
    Object.defineProperties(task, {
        lensSize: { get: () => params.lensSize, set: (v: number) => (params.lensSize = v) },
        fStop: { get: () => params.fStop, set: (v: number) => (params.fStop = v) },
        focusDistance: { get: () => params.focusDistance, set: (v: number) => (params.focusDistance = v) },
        focalLength: { get: () => params.focalLength, set: (v: number) => (params.focalLength = v) },
    });
    return task;
}
