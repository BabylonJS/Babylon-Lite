export const OCEAN_TEXTURE_SIZE = 256;
export const OCEAN_LENGTH_SCALES: readonly [number, number, number] = [250, 17, 5];
export const OCEAN_PATCH_LENGTH = OCEAN_LENGTH_SCALES[0];
export const OCEAN_GRID_SEGMENTS = 128;
export const OCEAN_WORKGROUP_SIZE = 8;
export const OCEAN_FFT_TWIDDLE_WORKGROUP_Y = 8;
export const OCEAN_CASCADE_COUNT = 3;

export const OCEAN_GRAVITY = 9.81;
export const OCEAN_DEPTH = 3;
export const OCEAN_LAMBDA = 1;

export const OCEAN_SUN_DIRECTION: readonly [number, number, number] = [0.35, 0.82, 0.45];

export function oceanFftStageCount(size: number): number {
    const stages = Math.log2(size);
    if (!Number.isInteger(stages)) {
        throw new Error(`Ocean FFT size must be a power of two, received ${size}.`);
    }
    return stages;
}
