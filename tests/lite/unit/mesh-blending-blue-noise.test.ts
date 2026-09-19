import { describe, expect, it } from "vitest";

import { createMeshBlendingBlueNoiseData } from "../../../packages/babylon-lite/src/post-process/mesh-blending-blue-noise";

const SIZE = 128;
const PIXEL_COUNT = SIZE * SIZE;

function fnv1a(bytes: Uint8Array): number {
    let hash = 0x811c9dc5;
    for (const value of bytes) {
        hash ^= value;
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash;
}

function averagePower(data: Uint8Array, frequencies: readonly (readonly [number, number])[], channel: 0 | 1): number {
    let totalPower = 0;
    for (const [frequencyX, frequencyY] of frequencies) {
        let real = 0;
        let imaginary = 0;
        for (let y = 0; y < SIZE; y++) {
            for (let x = 0; x < SIZE; x++) {
                const value = data[(y * SIZE + x) * 2 + channel]! - 127.5;
                const angle = (2 * Math.PI * (frequencyX * x + frequencyY * y)) / SIZE;
                real += value * Math.cos(angle);
                imaginary -= value * Math.sin(angle);
            }
        }
        totalPower += (real * real + imaginary * imaginary) / PIXEL_COUNT;
    }
    return totalPower / frequencies.length;
}

describe("mesh-blending blue noise", () => {
    it("is deterministic byte-for-byte with the exact documented dimensions and two channels", () => {
        const first = createMeshBlendingBlueNoiseData();
        const second = createMeshBlendingBlueNoiseData();

        expect(first).toHaveLength(SIZE * SIZE * 2);
        expect(second).toEqual(first);
        expect(fnv1a(first)).toBe(0x965547cd);
    });

    it("has the exact uniform 64-occurrence histogram in each channel", () => {
        const data = createMeshBlendingBlueNoiseData();
        for (const component of [0, 1] as const) {
            const histogram = new Uint16Array(256);
            for (let index = component; index < data.length; index += 2) {
                const value = data[index]!;
                histogram[value] = histogram[value]! + 1;
            }
            expect(Array.from(histogram)).toEqual(new Array<number>(256).fill(64));
        }
    });

    it("uses independent seeds for the two channels", () => {
        const data = createMeshBlendingBlueNoiseData();
        let equalPixelCount = 0;
        for (let pixel = 0; pixel < PIXEL_COUNT; pixel++) {
            if (data[pixel * 2] === data[pixel * 2 + 1]) {
                equalPixelCount++;
            }
        }
        expect(equalPixelCount).toBeLessThan(PIXEL_COUNT / 50);
    });

    it("matches Babylon.js's low-frequency spectral requirement", () => {
        const data = createMeshBlendingBlueNoiseData();
        const lowFrequencies = [
            [1, 0],
            [0, 1],
            [1, 1],
            [2, 0],
            [0, 2],
            [2, 1],
            [1, 2],
        ] as const;
        const highFrequencies = [
            [32, 0],
            [0, 32],
            [32, 32],
            [48, 0],
            [0, 48],
            [48, 16],
            [16, 48],
        ] as const;

        for (const component of [0, 1] as const) {
            expect(averagePower(data, lowFrequencies, component)).toBeLessThan(averagePower(data, highFrequencies, component) * 0.1);
        }
    });
});
