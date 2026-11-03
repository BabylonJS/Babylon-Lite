import { describe, expect, it } from "vitest";
import { createGLEngine } from "../../../packages/babylon-lite-gl/src/index";
import type { GLGlyphCurves } from "../../../packages/babylon-lite-gl/src/text/glyph-storage";
import { createSharedAtlas, packAppendGlyph, TEX_WIDTH } from "../../../packages/babylon-lite-gl/src/text/glyph-storage";
import { composeSlugShader } from "../../../packages/babylon-lite-gl/src/text/shaders/slug-shader";
import { createTextTexture, ensureSharedAtlasGpu } from "../../../packages/babylon-lite-gl/src/text/_gpu/text-textures";
import { createMockCanvas, createMockGL, type MockGL } from "./_lite-gl-mock";

const glyph: GLGlyphCurves = {
    glyphId: 1,
    curves: [
        { p0x: 0, p0y: 0, p1x: 1, p1y: 1, p2x: 2, p2y: 0 },
        { p0x: 2, p0y: 0, p1x: 3, p1y: 1, p2x: 4, p2y: 0 },
    ],
    bounds: { xMin: 0, yMin: 0, xMax: 4, yMax: 1 },
    _bands: { _hBands: [{ _curveIndices: [0, 1] }], _vBands: [{ _curveIndices: [1] }], _hBandCount: 1, _vBandCount: 1 },
};

function texImageCalls(mock: MockGL): { internalFormat: unknown; width: unknown; height: unknown; format: unknown; type: unknown }[] {
    return mock.log.filter((c) => c.name === "texImage2D").map((c) => ({ internalFormat: c.args[2], width: c.args[3], height: c.args[4], format: c.args[6], type: c.args[7] }));
}

describe("lite-gl Slug atlas layout", () => {
    it("stages the band atlas as two-component uint32 texels and the curves as float texels", () => {
        const atlas = createSharedAtlas();
        packAppendGlyph(atlas, glyph);

        expect(atlas._curveTexData).toBeInstanceOf(Float32Array);
        expect(atlas._bandTexData).toBeInstanceOf(Uint32Array);
        expect(atlas._bandTexData.length % (TEX_WIDTH * 2)).toBe(0);
        const texel = (i: number) => Array.from(atlas._bandTexData.subarray(i * 2, i * 2 + 2));
        expect(texel(0)[0]).toBe(2);
        expect(texel(1)[0]).toBe(1);
    });

    it("moves a band block that would straddle a row to the start of the next row", () => {
        const atlas = createSharedAtlas();
        atlas._bandTexelsUsed = TEX_WIDTH - 1;
        packAppendGlyph(atlas, glyph);

        expect(atlas._bandTexelsUsed).toBeGreaterThan(TEX_WIDTH);
        const texel = (i: number) => Array.from(atlas._bandTexData.subarray(i * 2, i * 2 + 2));
        expect(texel(TEX_WIDTH)[0]).toBe(2);
    });
});

describe("lite-gl Slug textures", () => {
    it("uploads Uint32Array tables as nearest-filtered RG32UI and Float32Array tables as RGBA32F", () => {
        const mock = createMockGL();
        const engine = createGLEngine(createMockCanvas(mock));
        mock.clear();

        createTextTexture(engine, new Uint32Array(TEX_WIDTH * 2), TEX_WIDTH, 1);
        createTextTexture(engine, new Float32Array(TEX_WIDTH * 4), TEX_WIDTH, 1);

        const [band, curve] = texImageCalls(mock);
        expect(band).toMatchObject({ internalFormat: mock.gl.RG32UI, format: mock.gl.RG_INTEGER, type: mock.gl.UNSIGNED_INT });
        expect(curve).toMatchObject({ internalFormat: mock.gl.RGBA32F, format: mock.gl.RGBA, type: mock.gl.FLOAT });
        const nearest = mock.log.filter((c) => c.name === "texParameteri" && (c.args[1] === mock.gl.TEXTURE_MIN_FILTER || c.args[1] === mock.gl.TEXTURE_MAG_FILTER));
        expect(nearest.length).toBeGreaterThan(0);
        expect(nearest.every((c) => c.args[2] === mock.gl.NEAREST)).toBe(true);
    });

    it("rejects tables larger than MAX_TEXTURE_SIZE", () => {
        const engine = createGLEngine(createMockCanvas(createMockGL()));
        const tooTall = engine.caps.maxTextureSize + 1;

        expect(() => createTextTexture(engine, new Uint32Array(2), 1, tooTall)).toThrow(/exceeds MAX_TEXTURE_SIZE/);
    });

    it("creates the shared atlas textures once per engine and refuses a second engine", () => {
        const atlas = createSharedAtlas();
        packAppendGlyph(atlas, glyph);
        const engine = createGLEngine(createMockCanvas(createMockGL()));
        const gpu = ensureSharedAtlasGpu(engine, atlas);

        expect(ensureSharedAtlasGpu(engine, atlas)).toBe(gpu);
        const other = createGLEngine(createMockCanvas(createMockGL()));
        expect(() => ensureSharedAtlasGpu(other, atlas)).toThrow(/multiple engines/);
    });
});

describe("lite-gl Slug shaders", () => {
    it("reads the band atlas through an unsigned-integer sampler without float rounding", () => {
        const source = composeSlugShader(null)._frag;

        expect(source).toContain("usampler2D");
        expect(source).toContain("texelFetch(bandTex");
        expect(source).not.toMatch(/header\.[xy]\s*\+\s*0\.5/);
    });
});
