import { describe, expect, it } from "vitest";

import { oceanFftStageCount } from "../../../lab/lite/src/demos/ocean/constants";
import { createOceanFftStageOrder } from "../../../lab/lite/src/demos/ocean/fft";
import { createOceanPlaneGeometry } from "../../../lab/lite/src/demos/ocean/geometry";
import { decodeOceanGaussianNoise, oceanTurbulenceOutputIndex } from "../../../lab/lite/src/demos/ocean/simulation";
import { createOceanSpectrumBuffer, DEFAULT_OCEAN_SPECTRUM } from "../../../lab/lite/src/demos/ocean/spectrum";

describe("Ocean demo math", () => {
    it("validates FFT dimensions and orders horizontal stages before vertical stages", () => {
        expect(oceanFftStageCount(256)).toBe(8);
        expect(() => oceanFftStageCount(300)).toThrow(/power of two/);
        expect(createOceanFftStageOrder(2)).toEqual([
            { axis: "horizontal", step: 0 },
            { axis: "horizontal", step: 1 },
            { axis: "vertical", step: 0 },
            { axis: "vertical", step: 1 },
        ]);
        expect(() => createOceanFftStageOrder(-1)).toThrow(/non-negative integer/);
    });

    it("packs both display spectra into the expected uniform layout", () => {
        const data = createOceanSpectrumBuffer();

        expect(data).toHaveLength(16);
        expect(data[0]).toBe(DEFAULT_OCEAN_SPECTRUM.local.scale);
        expect(data[1]).toBeCloseTo((DEFAULT_OCEAN_SPECTRUM.local.windDirection * Math.PI) / 180);
        expect(data[3]).toBeCloseTo(DEFAULT_OCEAN_SPECTRUM.local.swell);
        expect(data[8]).toBe(DEFAULT_OCEAN_SPECTRUM.swell.scale);
        expect(data[9]).toBeCloseTo((DEFAULT_OCEAN_SPECTRUM.swell.windDirection * Math.PI) / 180);
        expect(data[12]).toBeGreaterThan(0);
        expect(data[13]).toBeGreaterThan(0);
    });

    it("builds a complete indexed grid with upward normals", () => {
        const geometry = createOceanPlaneGeometry(2, 1, 3);

        expect(geometry.positions).toHaveLength(18);
        expect(geometry.normals).toHaveLength(18);
        expect(geometry.uvs).toHaveLength(12);
        expect(geometry.indices).toHaveLength(12);
        expect(Math.max(...geometry.indices)).toBeLessThan(6);
        for (let vertex = 0; vertex < 6; vertex++) {
            expect(Array.from(geometry.normals.subarray(vertex * 3, vertex * 3 + 3))).toEqual([0, 1, 0]);
        }
        expect(Array.from(geometry.positions.subarray(3, 6))).toEqual([3, 0, 0]);
    });

    it("alternates turbulence output textures deterministically", () => {
        expect([0, 1, 2, 3].map(oceanTurbulenceOutputIndex)).toEqual([1, 0, 1, 0]);
    });

    it.each([32, 64, 128, 256])("decodes the reference Gaussian source prefix at %i", (size) => {
        const bytes = createGaussianFixture();
        const noise = decodeOceanGaussianNoise(bytes, size);
        const last = size * size - 1;

        expect(noise).toHaveLength(size * size * 2);
        expect(noise[0]).toBeCloseTo(0.5);
        expect(noise[1]).toBeCloseTo(0.25);
        expect(noise[last * 2]).toBeCloseTo(last + 0.5);
        expect(noise[last * 2 + 1]).toBeCloseTo(last + 0.25);
    });
});

function createGaussianFixture(): Uint8Array {
    const rowBytes = 8 + 256 * 8 + 256 * 8;
    const bytes = new Uint8Array(0x094b + 256 * rowBytes);
    const view = new DataView(bytes.buffer);
    let offset = 0x094b;
    for (let row = 0; row < 256; row++) {
        offset += 8 + 256 * 8;
        for (let column = 0; column < 256; column++) {
            view.setFloat32(offset + column * 4, row * 256 + column + 0.25, true);
        }
        offset += 256 * 4;
        for (let column = 0; column < 256; column++) {
            view.setFloat32(offset + column * 4, row * 256 + column + 0.5, true);
        }
        offset += 256 * 4;
    }
    return bytes;
}
