import type { EngineContext } from "../engine/engine.js";
import { getOrCreateSampler, type TextureSamplerDescriptor } from "./texture-sampler-pool.js";

// Static descriptors for the canned sampler helpers — declared once at module
// scope so each call to getXxxSampler reuses the same object (no per-call alloc).
const _nearestDesc: TextureSamplerDescriptor = { magFilter: "nearest", minFilter: "nearest" };
const _bilinearDesc: TextureSamplerDescriptor = { magFilter: "linear", minFilter: "linear" };
const _trilinearDesc: TextureSamplerDescriptor = { magFilter: "linear", minFilter: "linear", mipmapFilter: "linear" };

/** Nearest-neighbor sampler (mag/min: nearest, no mipmap). All other descriptor fields use WebGPU defaults. */
export function getNearestSampler(engine: EngineContext): GPUSampler {
    return getOrCreateSampler(engine, _nearestDesc);
}

/** Bilinear sampler (mag/min: linear, no mipmap). All other descriptor fields use WebGPU defaults. */
export function getBilinearSampler(engine: EngineContext): GPUSampler {
    return getOrCreateSampler(engine, _bilinearDesc);
}

/** Trilinear sampler (mag/min/mipmap: linear). All other descriptor fields use WebGPU defaults. */
export function getTrilinearSampler(engine: EngineContext): GPUSampler {
    return getOrCreateSampler(engine, _trilinearDesc);
}
