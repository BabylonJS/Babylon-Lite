const MIN_KEY_BITS = 8;
const MAX_KEY_BITS = 24;
const RADIX_BITS = 4;
const MAX_SORT_KEY_COUNT = 1024 * 64 * 256;
const MAX_FLOAT_EXACT_SPLAT_COUNT = 1 << 24;
const DEFAULT_MAX_STORAGE_BUFFER_SIZE = 134217728;
const MIN_DEPTH_RANGE = 1e-12;

export function clampGaussianSplattingGpuSortKeyBits(keyBits: number): number {
    return Math.min(MAX_KEY_BITS, Math.max(MIN_KEY_BITS, Math.round(keyBits)));
}

export function getGaussianSplattingGpuSortPassCount(keyBits: number): number {
    return Math.ceil(clampGaussianSplattingGpuSortKeyBits(keyBits) / RADIX_BITS);
}

export function getGaussianSplattingGpuSortPaddedCount(activeCount: number): number {
    return Math.max((activeCount + 15) & ~15, 16);
}

export function packGaussianSplattingGpuSortIntervals(intervals: ArrayLike<number>, vertexCount: number): { data: Uint32Array; count: number; total: number } {
    const data = new Uint32Array(Math.max(intervals.length & ~1, 2));
    let count = 0;
    let total = 0;
    for (let index = 0; index + 1 < intervals.length; index += 2) {
        const start = Math.min(Math.max(intervals[index] ?? 0, 0), vertexCount);
        const length = Math.min(Math.max(intervals[index + 1] ?? 0, 0), vertexCount - start);
        if (length > 0) {
            data[count * 2] = total;
            data[count * 2 + 1] = start;
            count++;
            total += length;
        }
    }
    return { data, count, total };
}

export function computeGaussianSplattingGpuSortDepthCoefficients(
    world: ArrayLike<number>,
    view: ArrayLike<number>,
    depthSign: number,
    cameraPosition: ArrayLike<number> | null,
    out: Float32Array,
    offset: number,
    worldOffset = 0
): void {
    const fx = view[2] ?? 0;
    const fy = view[6] ?? 0;
    const fz = view[10] ?? 0;
    out[offset] = (fx * (world[worldOffset] ?? 0) + fy * (world[worldOffset + 1] ?? 0) + fz * (world[worldOffset + 2] ?? 0)) * depthSign;
    out[offset + 1] = (fx * (world[worldOffset + 4] ?? 0) + fy * (world[worldOffset + 5] ?? 0) + fz * (world[worldOffset + 6] ?? 0)) * depthSign;
    out[offset + 2] = (fx * (world[worldOffset + 8] ?? 0) + fy * (world[worldOffset + 9] ?? 0) + fz * (world[worldOffset + 10] ?? 0)) * depthSign;
    const translation = fx * (world[worldOffset + 12] ?? 0) + fy * (world[worldOffset + 13] ?? 0) + fz * (world[worldOffset + 14] ?? 0);
    const distance = cameraPosition ? translation - (fx * (cameraPosition[0] ?? 0) + fy * (cameraPosition[1] ?? 0) + fz * (cameraPosition[2] ?? 0)) : translation + (view[14] ?? 0);
    out[offset + 3] = distance * depthSign;
}

export function computeGaussianSplattingGpuSortDepthRange(
    coefficients: ArrayLike<number>,
    setCount: number,
    boundsMin: ArrayLike<number>,
    boundsMax: ArrayLike<number>,
    result: { min: number; max: number } = { min: 0, max: 0 }
): { min: number; max: number } {
    let min = Infinity;
    let max = -Infinity;
    for (let set = 0; set < setCount; set++) {
        let setMin = coefficients[set * 4 + 3] ?? 0;
        let setMax = setMin;
        for (let axis = 0; axis < 3; axis++) {
            const coefficient = coefficients[set * 4 + axis] ?? 0;
            const a = coefficient * (boundsMin[axis] ?? 0);
            const b = coefficient * (boundsMax[axis] ?? 0);
            setMin += Math.min(a, b);
            setMax += Math.max(a, b);
        }
        min = Math.min(min, setMin);
        max = Math.max(max, setMax);
    }
    result.min = min;
    result.max = max;
    return result;
}

export function computeGaussianSplattingGpuSortKeyScale(depthMin: number, depthMax: number, keyBits: number): number {
    const range = depthMax - depthMin;
    return range > MIN_DEPTH_RANGE ? (2 ** clampGaussianSplattingGpuSortKeyBits(keyBits) - 1) / range : 0;
}

export function decodeGaussianSplattingGpuSortSogMean(value: number): number {
    return Math.sign(value) * (Math.exp(Math.abs(value)) - 1);
}

export function getGaussianSplattingGpuSorterMaxSplatCount(maxStorageBufferBindingSize?: number, maxBufferSize?: number): number {
    const maxBytes = Math.min(maxStorageBufferBindingSize ?? DEFAULT_MAX_STORAGE_BUFFER_SIZE, maxBufferSize ?? DEFAULT_MAX_STORAGE_BUFFER_SIZE);
    return Math.min(MAX_FLOAT_EXACT_SPLAT_COUNT, MAX_SORT_KEY_COUNT, Math.floor(maxBytes / Float32Array.BYTES_PER_ELEMENT) & ~15);
}
