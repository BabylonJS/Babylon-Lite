import { afterEach, describe, expect, it, vi } from "vitest";
import { areaLightGaussian, blurAreaLightPixels } from "../../../packages/babylon-lite/src/light/area-light-blur.js";
import { readTexturePixels } from "../../../packages/babylon-lite/src/texture/read-texture-pixels.js";
import { validateAreaLightSource, validateAreaLightImage } from "../../../packages/babylon-lite/src/light/area-light-image.js";
import { acquireTexture } from "../../../packages/babylon-lite/src/resource/texture-acquire.js";
import { releaseTexture } from "../../../packages/babylon-lite/src/resource/texture-release.js";
import { cloneTexture2D } from "../../../packages/babylon-lite/src/texture/texture-2d.js";
import type { Texture2D } from "../../../packages/babylon-lite/src/texture/texture-2d.js";

function gaussianOracle(distance: number): number[] {
    const radius = distance + 3;
    const variance = ((2 * radius + 1) / 4) ** 2;
    const values = Array.from({ length: 2 * radius + 1 }, (_, i) => Math.exp(-((i - radius) ** 2) / (2 * variance)));
    const sum = values.reduce((total, value) => total + value, 0);
    return values.map((value) => Math.fround(Math.fround(value) / sum));
}

function blurOracle(source: Uint8Array, size: number): Uint8Array {
    let data = source;
    for (const vertical of [false, true]) {
        const next = new Uint8Array(data.length);
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const distance = Math.max(Math.floor(size / 8) - Math.min(x, y), Math.max(x, y) - Math.floor((size * 7) / 8), 0);
                const weights = gaussianOracle(distance);
                const radius = (weights.length - 1) / 2;
                for (let c = 0; c < 3; c++) {
                    let value = 0;
                    weights.forEach((weight, k) => {
                        const index = Math.abs((vertical ? y : x) + k - radius);
                        const reflected = index < size ? index : 2 * (size - 1) - index;
                        const sx = vertical ? x : reflected;
                        const sy = vertical ? reflected : y;
                        value += data[(sy * size + sx) * 4 + c]! * weight;
                    });
                    next[(y * size + x) * 4 + c] = Math.min(255, Math.max(0, Math.round(value)));
                }
                next[(y * size + x) * 4 + 3] = data[(y * size + x) * 4 + 3]!;
            }
        }
        data = next;
    }
    return data;
}

afterEach(() => vi.unstubAllGlobals());

describe("area emission exact preprocessing mathematics", () => {
    it.each([0, 1, 17, 127, 128])("matches double-sum / Float32-storage kernel at exterior distance %i", (distance) => {
        const actual = areaLightGaussian(distance);
        expect(actual.length).toBe(7 + 2 * distance);
        expect(Array.from(actual)).toEqual(gaussianOracle(distance));
        expect(actual[0]).toBe(actual.at(-1));
    });

    it("matches independent separable byte oracle, including exterior corners, interior kernel, alpha and axis rounding", () => {
        const size = 32;
        const data = Uint8Array.from({ length: size * size * 4 }, (_, i) => (i * 17 + Math.floor(i / 128) * 31) % 256);
        const original = data.slice();
        const actual = blurAreaLightPixels(data, size);
        expect(actual).toEqual(blurOracle(data, size));
        expect(data).toEqual(original);
        for (let i = 3; i < actual.length; i += 4) {
            expect(actual[i]).toBe(data[i]);
        }
        expect(actual.subarray(0, 4)).not.toEqual(actual.subarray((size - 1) * size * 4, (size - 1) * size * 4 + 4));
    });

    // Full-resolution CPU filtering exceeds the default timeout on shared CI runners.
    it("preserves exact constant bytes across the full 1024 image and does not retain input storage", () => {
        const input = new Uint8Array(1024 * 1024 * 4);
        for (let i = 0; i < input.length; i += 4) {
            input.set([97, 31, 241, (i / 4) % 256], i);
        }
        const result = blurAreaLightPixels(input);
        expect(result).toEqual(input);
        expect(result.buffer).not.toBe(input.buffer);
    }, 30_000);

    it("readback unpads storage rows without Y flipping or alpha loss and destroys its staging buffer", async () => {
        vi.stubGlobal("GPUMapMode", { READ: 1 });
        const bytes = new Uint8Array(512);
        bytes.set([1, 2, 3, 4, 5, 6, 7, 8]);
        bytes.set([9, 10, 11, 12, 13, 14, 15, 16], 256);
        const staging = { mapAsync: vi.fn(async () => {}), getMappedRange: vi.fn(() => bytes.buffer), unmap: vi.fn(), destroy: vi.fn() };
        const encoder = { copyTextureToBuffer: vi.fn(), finish: vi.fn() };
        const device = { createBuffer: vi.fn(() => staging), createCommandEncoder: vi.fn(() => encoder), queue: { submit: vi.fn() } };
        const texture = { width: 2, height: 2 };
        expect(await readTexturePixels(device as unknown as GPUDevice, texture as GPUTexture)).toEqual(Uint8Array.from({ length: 16 }, (_, i) => i + 1));
        expect(encoder.copyTextureToBuffer.mock.calls[0]![1]).toMatchObject({ bytesPerRow: 256, rowsPerImage: 2 });
        expect(staging.destroy).toHaveBeenCalledTimes(1);
        staging.mapAsync.mockRejectedValueOnce(new Error("map failed"));
        await expect(readTexturePixels(device as unknown as GPUDevice, texture as GPUTexture)).rejects.toThrow("map failed");
        expect(staging.destroy).toHaveBeenCalledTimes(2);
    });
});

function image(): Texture2D {
    const texture = {
        width: 1024,
        height: 1024,
        dimension: "2d",
        depthOrArrayLayers: 1,
        sampleCount: 1,
        usage: 7,
        format: "rgba8unorm",
        mipLevelCount: 11,
        destroy: vi.fn(),
    } as unknown as GPUTexture;
    const result = { texture, width: 1024, height: 1024, view: {}, sampler: {} } as Texture2D;
    acquireTexture(result);
    return result;
}

describe("area emission input contract", () => {
    it.each([{ width: 0 }, { height: Number.NaN }, { width: 3.5 }, { _sampleType: "depth" }, { view: null }, { sampler: null }])("rejects malformed wrapper %j", (change) => {
        const source = image();
        Object.assign(source, change);
        expect(() => validateAreaLightSource(source)).toThrow(/Texture2D/);
        releaseTexture(source);
    });
    it.each([{ dimension: "3d" }, { depthOrArrayLayers: 2 }, { sampleCount: 4 }, { usage: 2 }, { format: "r32float" }, { format: "rgba8uint" }, { width: 8 }])(
        "rejects incompatible GPU shape %j",
        (change) => {
            const source = image();
            Object.assign(source.texture, change);
            expect(() => validateAreaLightSource(source)).toThrow(/Texture2D/);
            releaseTexture(source);
        }
    );
    it("requires processor provenance and current device, permits shared-image clones, and rejects released images", () => {
        const source = image();
        const device = {} as GPUDevice;
        expect(() => validateAreaLightImage(source, device)).toThrow(/processAreaLightTexture/);
        source._areaLightImage = { texture: source.texture, device };
        expect(() => validateAreaLightImage(source, device)).not.toThrow();
        expect(() => validateAreaLightImage(source, {} as GPUDevice)).toThrow(/different device/);
        const clone = cloneTexture2D(source, { vScale: -1, vOffset: 1 });
        expect(clone._areaLightImage).toBe(source._areaLightImage);
        expect(() => validateAreaLightImage(clone, device)).not.toThrow();
        releaseTexture(source);
        expect(() => validateAreaLightImage(clone, device)).toThrow(/released/);
    });
});
