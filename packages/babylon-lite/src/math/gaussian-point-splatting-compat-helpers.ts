import type { Mat4 } from "./types.js";

export function hasGaussianPointSplattingProjectedDepth(projection: Mat4): boolean {
    return projection[2] !== 0 || projection[6] !== 0 || projection[3] !== 0 || projection[7] !== 0;
}

export function getGaussianPointSplattingPackedShBytesPerSplat(shDegree: number): number {
    if (shDegree < 1) {
        return 0;
    }
    const shDimension = shDegree === 1 ? 3 : shDegree === 2 ? 8 : shDegree === 3 ? 15 : 24;
    return Math.ceil((shDimension * 3) / 4) * 4;
}
