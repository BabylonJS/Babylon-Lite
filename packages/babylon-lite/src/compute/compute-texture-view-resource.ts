import type { EngineContext } from "../engine/engine.js";
import type { Texture2D } from "../texture/texture-2d.js";
import type { ComputeTextureResource, ComputeTextureSampleType } from "./compute-texture-resource.js";
import { _createComputeTextureViewResource } from "./compute-texture-resource.js";

/** Options for adapting a non-default sampled texture view to compute. */
export interface ComputeTextureViewResourceOptions {
    readonly viewDimension: GPUTextureViewDimension;
    readonly sampleType?: ComputeTextureSampleType;
    readonly multisampled?: boolean;
}

/** Validate and adapt a 1D, array, cube, cube-array, 3D, or explicit 2D view. */
export function createComputeTextureViewResource(engine: EngineContext, texture: Texture2D, options: ComputeTextureViewResourceOptions): Promise<ComputeTextureResource> {
    return _createComputeTextureViewResource(engine, texture, options);
}
