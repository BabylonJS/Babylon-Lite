import { describe, expect, it } from "vitest";

import type { GlyphCurves } from "../../../packages/babylon-lite/src/text/glyph-storage";
import { createSharedAtlas, packAppendGlyph, TEX_WIDTH } from "../../../packages/babylon-lite/src/text/glyph-storage";
import slugFragment from "../../../packages/babylon-lite/src/text/shaders/slug.frag.wgsl?raw";

describe("Slug band-reference row wrapping", () => {
    it("wraps every horizontal and vertical band-reference read to the next texture row", () => {
        const glyph: GlyphCurves = {
            glyphId: 1,
            curves: [
                { p0x: 0, p0y: 0, p1x: 1, p1y: 1, p2x: 2, p2y: 0 },
                { p0x: 2, p0y: 0, p1x: 3, p1y: 1, p2x: 4, p2y: 0 },
                { p0x: 4, p0y: 0, p1x: 5, p1y: 1, p2x: 6, p2y: 0 },
            ],
            bounds: { xMin: 0, yMin: 0, xMax: 6, yMax: 1 },
            _bands: {
                _hBands: [{ _curveIndices: [0, 1] }],
                _vBands: [{ _curveIndices: [2] }],
                _hBandCount: 1,
                _vBandCount: 1,
            },
        };
        const atlas = createSharedAtlas();
        atlas._bandTexelsUsed = TEX_WIDTH - 3;

        packAppendGlyph(atlas, glyph);

        const bandRef = (texel: number) => Array.from(atlas._bandTexData.subarray(texel * 4, texel * 4 + 2));
        expect(bandRef(TEX_WIDTH - 1)).toEqual([0, 0]);
        expect(bandRef(TEX_WIDTH)).toEqual([2, 0]);
        const normalizedSlugFragment = slugFragment.replace(/\s+/g, "");
        expect(normalizedSlugFragment).toContain("textureLoad(bandTex,calcBandLoc(hbandLoc,ci),0)");
        expect(normalizedSlugFragment).toContain("textureLoad(bandTex,calcBandLoc(vbandLoc,ci),0)");
    });
});
