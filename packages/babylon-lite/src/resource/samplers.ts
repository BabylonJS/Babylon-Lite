import type { EngineContextInternal } from "../engine/engine.js";
import { getOrCreateSampler } from "./gpu-pool.js";

// Static descriptors for the canned sampler helpers — declared once at module
// scope so each call to getXxxSampler reuses the same object (no per-call alloc).
const _nearestDesc: GPUSamplerDescriptor = { magFilter: "nearest", minFilter: "nearest" };
const _bilinearDesc: GPUSamplerDescriptor = { magFilter: "linear", minFilter: "linear" };
const _trilinearDesc: GPUSamplerDescriptor = { magFilter: "linear", minFilter: "linear", mipmapFilter: "linear" };

/** Nearest-neighbor sampler (mag/min: nearest, no mipmap). All other descriptor fields use WebGPU defaults. */
export function getNearestSampler(engine: EngineContextInternal): GPUSampler {
    return getOrCreateSampler(engine, _nearestDesc);
}

/** Bilinear sampler (mag/min: linear, no mipmap). All other descriptor fields use WebGPU defaults. */
export function getBilinearSampler(engine: EngineContextInternal): GPUSampler {
    return getOrCreateSampler(engine, _bilinearDesc);
}

/** Trilinear sampler (mag/min/mipmap: linear). All other descriptor fields use WebGPU defaults. */
export function getTrilinearSampler(engine: EngineContextInternal): GPUSampler {
    return getOrCreateSampler(engine, _trilinearDesc);
}
