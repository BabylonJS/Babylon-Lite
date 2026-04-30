import type { Camera, NormalizedViewport } from "./camera.js";
export { getEffectiveAspectRatio } from "./camera.js";

export interface PixelViewport {
    x: number;
    y: number;
    width: number;
    height: number;
}

export const FULL_VIEWPORT: NormalizedViewport = { x: 0, y: 0, width: 1, height: 1 };

function clamp01(value: number): number {
    return Math.max(0, Math.min(1, value));
}

/** Resolve a Babylon-style normalized viewport to integer render-target pixels.
 *  Babylon viewport y is normalized from the bottom; WebGPU viewport/scissor y is from the top. */
export function resolveCameraViewport(camera: Camera | null | undefined, targetWidth: number, targetHeight: number): PixelViewport {
    const v = camera?.viewport ?? FULL_VIEWPORT;
    const x0 = clamp01(v.x);
    const y0 = clamp01(1 - v.y - v.height);
    const x1 = clamp01(v.x + v.width);
    const y1 = clamp01(1 - v.y);
    const x = Math.floor(x0 * targetWidth);
    const y = Math.floor(y0 * targetHeight);
    const width = Math.max(0, Math.ceil(x1 * targetWidth) - x);
    const height = Math.max(0, Math.ceil(y1 * targetHeight) - y);
    return { x, y, width, height };
}
