import { describe, expect, it } from "vitest";

import type { GlyphCurves } from "../../../packages/babylon-lite/src/text/glyph-storage";
import { createTextData, TEXT_INSTANCE_FLOATS, TEXT_STYLE_FLOATS } from "../../../packages/babylon-lite/src/text/text-data";
import { createGlyphStorage } from "../../../packages/babylon-lite/src/text/glyph-storage";

function makeGlyph(glyphId: number): GlyphCurves {
    return {
        glyphId,
        curves: [
            { p0x: 0, p0y: 0, p1x: 50, p1y: 100, p2x: 100, p2y: 0 },
            { p0x: 100, p0y: 0, p1x: 50, p1y: -20, p2x: 0, p2y: 0 },
        ],
        bounds: { xMin: 0, yMin: -20, xMax: 100, yMax: 100 },
    };
}

const PACKED_OFFSET = 2;

/** Read the effective RGBA color of instance `i`: the instance stores only a style index in the
 *  high 16 bits of its packed word, so follow that into the TextData's style palette. */
function instanceColor(data: ReturnType<typeof createTextData>, i: number): [number, number, number, number] {
    const styleIdx = data._instancesU32[i * TEXT_INSTANCE_FLOATS + PACKED_OFFSET]! >>> 16;
    const base = styleIdx * TEXT_STYLE_FLOATS;
    const a = data._styles;
    return [a[base]!, a[base + 1]!, a[base + 2]!, a[base + 3]!];
}

describe("text per-glyph color", () => {
    const inner = new Map<number, GlyphCurves>([
        [1, makeGlyph(1)],
        [2, makeGlyph(2)],
        [3, makeGlyph(3)],
    ]);
    const storage = createGlyphStorage(new Map([["f", inner]]));

    it("defaults to white when neither glyph nor run specify a color", () => {
        const data = createTextData(storage, [{ curveSet: "f", glyphs: [{ glyphId: 1, x: 0, y: 0 }], pixelsPerFontUnit: 1 }]);
        expect(instanceColor(data, 0)).toEqual([1, 1, 1, 1]);
    });

    it("applies the run defaultColor to every glyph in the run", () => {
        const data = createTextData(storage, [
            {
                curveSet: "f",
                glyphs: [
                    { glyphId: 1, x: 0, y: 0 },
                    { glyphId: 2, x: 10, y: 0 },
                ],
                pixelsPerFontUnit: 1,
                defaultColor: [1, 0, 0, 1] as const,
            },
        ]);
        expect(instanceColor(data, 0)).toEqual([1, 0, 0, 1]);
        expect(instanceColor(data, 1)).toEqual([1, 0, 0, 1]);
    });

    it("lets a per-glyph color override the run defaultColor", () => {
        const data = createTextData(storage, [
            {
                curveSet: "f",
                glyphs: [
                    { glyphId: 1, x: 0, y: 0 },
                    { glyphId: 2, x: 10, y: 0, color: [0, 1, 0, 1] as const },
                    { glyphId: 3, x: 20, y: 0 },
                ],
                pixelsPerFontUnit: 1,
                defaultColor: [1, 0, 0, 1] as const,
            },
        ]);
        expect(instanceColor(data, 0)).toEqual([1, 0, 0, 1]); // run default
        expect(instanceColor(data, 1)).toEqual([0, 1, 0, 1]); // glyph override
        expect(instanceColor(data, 2)).toEqual([1, 0, 0, 1]); // run default
    });

    it("uses a per-glyph color even when the run has no defaultColor", () => {
        const data = createTextData(storage, [
            {
                curveSet: "f",
                glyphs: [{ glyphId: 1, x: 0, y: 0, color: [0, 0, 1, 0.5] as const }],
                pixelsPerFontUnit: 1,
            },
        ]);
        expect(instanceColor(data, 0)).toEqual([0, 0, 1, 0.5]);
    });
});
