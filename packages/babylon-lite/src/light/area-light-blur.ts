/** @internal Gaussian coefficients preserve upstream's double-sum / Float32-storage rounding. */
export function areaLightGaussian(distance: number): Float32Array {
    const length = 7 + 2 * distance;
    const half = (length - 1) / 2;
    const sigma = length / 4;
    const coefficients = new Float32Array(length);
    let total = 0;
    for (let i = 0; i < length; i++) {
        const offset = i - half;
        const weight = Math.exp(-(offset * offset) / (2 * sigma * sigma));
        coefficients[i] = weight;
        total += weight;
    }
    for (let i = 0; i < length; i++) {
        coefficients[i] = coefficients[i]! / total;
    }
    return coefficients;
}

/** @internal Separable RGB blur, with nearest-byte quantization between axes and unchanged alpha. */
export function blurAreaLightPixels(input: Uint8Array, size = 1024): Uint8Array<ArrayBuffer> {
    const start = Math.floor(size / 8);
    const end = Math.floor((size * 7) / 8);
    const kernels = Array.from({ length: Math.max(start, size - 1 - end) + 1 }, (_, i) => areaLightGaussian(i));
    const first = new Uint8Array(input.length);
    const output = new Uint8Array(input.length);
    const axis = (source: Uint8Array, target: Uint8Array, vertical: boolean): void => {
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const distance = Math.max(start - x, start - y, x - end, y - end, 0);
                const kernel = kernels[distance]!;
                const half = (kernel.length - 1) / 2;
                const center = vertical ? y : x;
                let r = 0;
                let g = 0;
                let b = 0;
                for (let i = 0; i < kernel.length; i++) {
                    let p = center + i - half;
                    if (p < 0) {
                        p = -p;
                    }
                    if (p >= size) {
                        p = 2 * size - 2 - p;
                    }
                    const index = (vertical ? p * size + x : y * size + p) * 4;
                    const weight = kernel[i]!;
                    r += source[index]! * weight;
                    g += source[index + 1]! * weight;
                    b += source[index + 2]! * weight;
                }
                const index = (y * size + x) * 4;
                target[index] = Math.min(255, Math.max(0, Math.round(r)));
                target[index + 1] = Math.min(255, Math.max(0, Math.round(g)));
                target[index + 2] = Math.min(255, Math.max(0, Math.round(b)));
                target[index + 3] = source[index + 3]!;
            }
        }
    };
    axis(input, first, false);
    axis(first, output, true);
    return output;
}
