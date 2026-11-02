import { PNG } from "pngjs";

export function encodeAoFloats(values: Float32Array): Buffer {
    const bytes = Buffer.alloc(values.length * 4);
    for (let i = 0; i < values.length; i++) bytes.writeFloatLE(values[i]!, i * 4);
    return bytes;
}
export function decodeAoFloats(bytes: Buffer): Float32Array {
    if (bytes.length % 4 !== 0) throw new Error("AO f32 buffer length must be divisible by four");
    const values = new Float32Array(bytes.length / 4);
    for (let i = 0; i < values.length; i++) values[i] = bytes.readFloatLE(i * 4);
    return values;
}
export function compareAoValues(actual: Float32Array, expected: Float32Array, mask?: Uint8Array): { meanAbsolute: number; maximumAbsolute: number; pixels: number } {
    if (actual.length === 0 || actual.length !== expected.length || (mask && mask.length !== actual.length)) {
        throw new Error("AO comparison requires nonempty buffers with identical dimensions");
    }
    let total = 0;
    let maximumAbsolute = 0;
    let pixels = 0;
    for (let i = 0; i < actual.length; i++) {
        if (!Number.isFinite(actual[i]) || !Number.isFinite(expected[i])) throw new Error(`Non-finite AO value at pixel ${i}`);
        if (mask && mask[i] !== 0 && mask[i] !== 1) throw new Error(`Invalid receiver mask at pixel ${i}`);
        if (mask && mask[i] === 0) continue;
        const delta = Math.abs(actual[i]! - expected[i]!);
        total += delta;
        maximumAbsolute = Math.max(maximumAbsolute, delta);
        pixels++;
    }
    if (pixels === 0) throw new Error("AO comparison receiver mask is empty");
    return { meanAbsolute: total / pixels, maximumAbsolute, pixels };
}
export function encodeAoPreview(values: Float32Array, width: number, height: number): Buffer {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || values.length !== width * height) {
        throw new Error("AO preview requires an exact positive pixel size");
    }
    const png = new PNG({ width, height });
    for (let i = 0; i < values.length; i++) {
        const value = values[i]!;
        if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`Invalid AO visibility at pixel ${i}: ${value}`);
        const gray = Math.round(value * 255);
        png.data[i * 4] = png.data[i * 4 + 1] = png.data[i * 4 + 2] = gray;
        png.data[i * 4 + 3] = 255;
    }
    return PNG.sync.write(png);
}
