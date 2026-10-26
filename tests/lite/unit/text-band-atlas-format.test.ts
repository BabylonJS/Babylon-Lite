import { describe, expect, it, vi } from "vitest";

import type { GlyphCurves } from "../../../packages/babylon-lite/src/text/glyph-storage";
import { createSharedAtlas, packAppendGlyph, TEX_WIDTH } from "../../../packages/babylon-lite/src/text/glyph-storage";
import { ensureSharedAtlasGpu } from "../../../packages/babylon-lite/src/text/_gpu/text-textures";
import { composeSlugShader } from "../../../packages/babylon-lite/src/text/shaders/slug-shader";
import { WEIGHT_SHADER_FRAGMENT } from "../../../packages/babylon-lite/src/text/shaders/weight-shader-fragment";

const glyph: GlyphCurves = {
    glyphId: 1,
    curves: [
        { p0x: 0, p0y: 0, p1x: 1, p1y: 1, p2x: 2, p2y: 0 },
        { p0x: 2, p0y: 0, p1x: 3, p1y: 1, p2x: 4, p2y: 0 },
    ],
    bounds: { xMin: 0, yMin: 0, xMax: 4, yMax: 1 },
    _bands: { _hBands: [{ _curveIndices: [0, 1] }], _vBands: [{ _curveIndices: [1] }], _hBandCount: 1, _vBandCount: 1 },
};

function fakeDevice(): {
    device: GPUDevice;
    textures: { format: string; width: number; height: number }[];
    writes: { bytesPerRow: number | undefined; height: number | undefined }[];
} {
    const textures: { format: string; width: number; height: number }[] = [];
    const writes: { bytesPerRow: number | undefined; height: number | undefined }[] = [];
    const device = {
        createTexture: (d: { format: string; size: { width: number; height: number } }) => {
            textures.push({ format: d.format, width: d.size.width, height: d.size.height });
            return { destroy: vi.fn() } as unknown as GPUTexture;
        },
        createBuffer: () => ({ destroy: vi.fn() }) as unknown as GPUBuffer,
        queue: {
            writeTexture: (_dst: unknown, _data: unknown, layout: { bytesPerRow?: number }, size: { height?: number }) => {
                writes.push({ bytesPerRow: layout.bytesPerRow, height: size.height });
            },
            writeBuffer: vi.fn(),
        },
    } as unknown as GPUDevice;
    return { device, textures, writes };
}

describe("Slug band atlas as rg32uint", () => {
    it("stages band headers and curve references as two-component uint32 texels", () => {
        const atlas = createSharedAtlas();
        packAppendGlyph(atlas, glyph);

        expect(atlas._bandTexData).toBeInstanceOf(Uint32Array);
        expect(atlas._bandTexData.length % (TEX_WIDTH * 2)).toBe(0);
        // Header texel 0: [curve count, list offset]; texel 1 is the vertical band header.
        const texel = (i: number) => Array.from(atlas._bandTexData.subarray(i * 2, i * 2 + 2));
        expect(texel(0)[0]).toBe(2);
        expect(texel(1)[0]).toBe(1);
        expect(atlas._bandTexelsUsed).toBe(2 + 2 + 1);
    });

    it("keeps curve data as four-component float texels while growing the band staging by whole rows", () => {
        const atlas = createSharedAtlas();
        atlas._bandTexelsUsed = TEX_WIDTH * 3 - 4;
        packAppendGlyph(atlas, glyph);

        expect(atlas._curveTexData).toBeInstanceOf(Float32Array);
        expect(atlas._bandTexData.length).toBeGreaterThanOrEqual(atlas._bandTexelsUsed * 2);
        expect(atlas._bandTexData.length % (TEX_WIDTH * 2)).toBe(0);
    });

    it("creates the curve texture as rgba32float and the band texture as rg32uint, with matching upload strides", () => {
        const atlas = createSharedAtlas();
        packAppendGlyph(atlas, glyph);
        const { device, textures, writes } = fakeDevice();

        ensureSharedAtlasGpu(device, atlas);

        expect(textures.map((t) => t.format)).toEqual(["rgba32float", "rg32uint"]);
        expect(textures.every((t) => t.width === TEX_WIDTH)).toBe(true);
        // 4096 texels x 4 components x 4 bytes for curves; x 2 components for bands.
        expect(writes.map((w) => w.bytesPerRow)).toEqual([TEX_WIDTH * 16, TEX_WIDTH * 8]);
    });

    it("recreates only the band texture as rg32uint when it needs more rows", () => {
        const atlas = createSharedAtlas();
        packAppendGlyph(atlas, glyph);
        const { device, textures } = fakeDevice();
        ensureSharedAtlasGpu(device, atlas);
        textures.length = 0;

        atlas._bandTexelsUsed = TEX_WIDTH * 4 + 1;
        atlas._version++;
        const { _rebuilt } = ensureSharedAtlasGpu(device, atlas);

        expect(_rebuilt).toBe(true);
        expect(textures.map((t) => t.format)).toEqual(["rg32uint"]);
        expect(textures[0]!.height).toBe(8);
    });
});

describe("Slug shaders read the band atlas as integers", () => {
    const strip = (s: string) => s.replace(/\s+/g, "");

    it("declares the band texture as texture_2d<u32> and drops the +0.5 float rounding", () => {
        for (const frag of [composeSlugShader(null)._frag, composeSlugShader(WEIGHT_SHADER_FRAGMENT)._frag]) {
            const code = strip(frag);
            expect(code).toContain("varbt:texture_2d<u32>");
            expect(code).not.toContain("hr.x+0.5");
            expect(code).not.toContain("lr.x+0.5");
            expect(code).toContain("i32(hr.x)");
            expect(code).toContain("vec2i(lr.xy)");
        }
    });

    it("premultiplies blended RGB by the effective alpha and keeps straight RGB for alpha-to-coverage", () => {
        const code = strip(composeSlugShader(null)._frag);
        expect(code).toContain("letrw=select(in.cl.a*cov,1.0,a2c);");
        expect(code).toContain("returnvec4f(in.cl.rgb*rw,in.cl.a*cov);");
    });
});
