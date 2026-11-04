import type { Mat4 } from "./types.js";

/** @internal Babylon.js compat bridge; not part of the public Lite API. */
export function _hasGaussianPointSplattingProjectedDepth(projection: Mat4): boolean {
    return projection[2] !== 0 || projection[6] !== 0 || projection[3] !== 0 || projection[7] !== 0;
}

/** @internal Babylon.js compat bridge; not part of the public Lite API. */
export function _getGaussianPointSplattingPackedShBytesPerSplat(shDegree: number): number {
    if (shDegree < 1) {
        return 0;
    }
    const shDimension = shDegree === 1 ? 3 : shDegree === 2 ? 8 : shDegree === 3 ? 15 : 24;
    return Math.ceil((shDimension * 3) / 4) * 4;
}
