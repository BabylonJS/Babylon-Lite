import type { GaussianSplattingMesh } from "../mesh/GaussianSplatting/gaussian-splatting-mesh.js";
import type { GaussianSplatStream } from "../loader-splat-stream/splat-stream-types.js";

/** Accumulation progress for the most recently rendered view. */
export interface GaussianPointSplattingProgress {
    /** Frames dispatched since accumulation was last invalidated; stops growing once converged. */
    readonly renderedFrameCount: number;
    /** Completed per-pixel samples, saturating at maxAccumFrames when accumulation converges and compute stops. */
    readonly accumulatedSamples: number;
    readonly accumulationVersion: number;
    readonly pixelCycleLength: number;
}

/** Mutable options for the opt-in WebGPU stochastic Gaussian renderer. */
export interface GaussianPointSplatting {
    colorRenderMode: boolean;
    depthRenderMode: boolean;
    /**
     * Equivalent of gsLinearDepthFragment / gsAlphaBlendedDepthFragment; match the mesh's classic fragments. Used when depthRenderMode is enabled.
     * Linear mode renders opaque discs at full resolution, independently of pointScale/renderScale; alphaBlended retains the stochastic weighted depth mean.
     */
    depthVisualization: "none" | "linear" | "alphaBlended";
    pointScale: number;
    renderScale: number | "auto";
    occlusionCulling: boolean;
    /** Per-pixel samples after which accumulation stops; changing it resumes or stops without invalidating samples. */
    maxAccumFrames: number;
    /** Experimental: reproject accumulated samples when the camera or target moves instead of restarting, so noise is confined to disocclusions. */
    temporalReprojection: boolean;
    readonly progress: GaussianPointSplattingProgress | null;
    /** @internal */
    _progress: GaussianPointSplattingProgress | null;
    /** @internal */
    _target: GaussianSplattingMesh | GaussianSplatStream;
    /** @internal */
    _disabled: boolean;
    /** @internal */
    _dataVersion: number;
    /** @internal */
    _dispose: (() => void) | null;
}

/** @internal */
export function gpsRenderScale(points: number, budget: number, current = 0): number {
    const exact = Math.sqrt(Math.max(0, points) / Math.max(1, budget));
    const scale = Math.max(1, Math.min(8, Math.ceil(exact)));
    // Refining only once the estimate is clearly lower keeps noisy estimates from reallocating and resetting every few frames.
    return current > scale && exact > current - 1.25 ? Math.min(8, current) : scale;
}

/** @internal */
export function gpsPointBudget(userAgent: string, touchPoints = 0): number {
    return /iPad|iPhone|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && touchPoints > 1) ? 9_000_000 : /Android|Mobile/.test(userAgent) ? 6_000_000 : 15_000_000;
}

/** @internal */
export function gpsOptionsKey(
    gps: Pick<
        GaussianPointSplatting,
        "colorRenderMode" | "depthRenderMode" | "depthVisualization" | "pointScale" | "renderScale" | "occlusionCulling" | "maxAccumFrames" | "temporalReprojection"
    >
): string {
    if (!Number.isFinite(gps.pointScale) || gps.pointScale < 0) {
        throw new RangeError("Gaussian pointScale must be finite and nonnegative");
    }
    if (gps.renderScale !== "auto" && (!Number.isInteger(gps.renderScale) || gps.renderScale < 1 || gps.renderScale > 8)) {
        throw new RangeError("Gaussian renderScale must be 'auto' or an integer in 1..8");
    }
    if (!Number.isInteger(gps.maxAccumFrames) || gps.maxAccumFrames < 1 || gps.maxAccumFrames > 65535) {
        throw new RangeError("Gaussian maxAccumFrames must be an integer in 1..65535");
    }
    if (gps.depthVisualization !== "none" && gps.depthVisualization !== "linear" && gps.depthVisualization !== "alphaBlended") {
        throw new RangeError("Gaussian depthVisualization must be 'none', 'linear' or 'alphaBlended'");
    }
    return `${+gps.colorRenderMode}/${+gps.depthRenderMode}/${gps.depthVisualization}/${gps.pointScale}/${gps.renderScale}/${+gps.occlusionCulling}/${+gps.temporalReprojection}`;
}

/** @internal State shared by the CPU invalidation tests and each GPU view. */
export interface GpsAccumulation {
    key: string;
    generation: number;
    frames: number;
}

/** @internal Returns whether the next resolve must overwrite the whole pixel cycle. */
export function gpsUpdateGeneration(state: GpsAccumulation, key: string): boolean {
    if (state.key === key) {
        return false;
    }
    state.key = key;
    state.generation = (state.generation + 1) & 65535;
    state.frames = 0;
    return true;
}

/** @internal History kept when streamed content changes under a still camera, so refinement blends in without a flash. */
export const GPS_SOFT_RESET_SAMPLES = 8;

/** @internal History cap applied to reprojected samples, so stale view-dependent color and resampling error fade out. */
export const GPS_REPROJECTION_SAMPLES = 16;

/** @internal Bounds history after a content change or reprojection without discarding the accumulated image. */
export function gpsSoftReset(state: GpsAccumulation, cycle: number, samples = GPS_SOFT_RESET_SAMPLES): void {
    if (state.frames > samples * cycle) {
        // Keep the sub-pixel phase so the jitter cycle still visits every pixel once.
        state.frames = samples * cycle + (state.frames % cycle);
    }
}

/** @internal Samples kept by a reprojection; always below maxAccumFrames so a moved view resumes accumulating. */
export function gpsReprojectionSamples(maxAccumFrames: number): number {
    return Math.min(GPS_REPROJECTION_SAMPLES, maxAccumFrames - 1);
}

/** @internal Completed per-pixel samples; accumulation is converged once this reaches maxAccumFrames. */
export function gpsAccumulatedSamples(frames: number, cycle: number, maxAccumFrames: number): number {
    return Math.min(maxAccumFrames, Math.floor(frames / cycle));
}

/** @internal Running-mean history cap, leaving room for the incoming sample (zero history at a one-sample limit). */
export function gpsHistoryCap(frames: number, cycle: number, maxAccumFrames: number): number {
    return Math.min(maxAccumFrames - 1, Math.floor(frames / cycle) + 1);
}

/** @internal Exact inverse-CDF Poisson at small means, normal asymptotics at large means. */
export function gpsPoisson(lambda: number, uniform: number, normal = 0): number {
    if (!(lambda > 0)) {
        return 0;
    }
    if (lambda < 12) {
        let probability = Math.exp(-lambda);
        let cumulative = probability;
        let k = 0;
        while (uniform >= cumulative && !(k > lambda && probability < 1e-7)) {
            probability *= lambda / ++k;
            cumulative += probability;
        }
        return k;
    }
    const w2 = normal * normal;
    const correction = (w2 * (w2 / 270 + 7 / 810) - 8 / 405) / lambda;
    return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * normal + (w2 - 1) / 6 - (normal * (w2 + 2)) / (72 * Math.sqrt(lambda)) + correction));
}

/** @internal Finest-first packed Hi-Z mip layout, including odd trailing rows and columns. */
export function gpsHiZLevels(width: number, height: number): { offset: number; width: number; height: number }[] {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
        throw new RangeError("Gaussian Hi-Z dimensions must be positive integers");
    }
    const levels = [];
    let offset = 0;
    for (;;) {
        levels.push({ offset, width, height });
        offset += width * height;
        if (width === 1 && height === 1) {
            return levels;
        }
        width = Math.max(1, width >> 1);
        height = Math.max(1, height >> 1);
    }
}
