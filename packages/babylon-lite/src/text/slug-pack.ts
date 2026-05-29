/** Append a glyph's curve + band data into a SharedAtlas's Float32 staging arrays.
 *  Existing glyph slots are never moved; growth is in-place with doubling capacity. */

import type { GlyphCurves } from "./public-types.js";
import { TEX_WIDTH } from "./internal.js";
import type { AtlasSlot, SharedAtlas } from "./internal.js";
import { buildGlyphBands } from "./slug-bands.js";

const ROW_FLOATS = TEX_WIDTH * 4;

function ensureCurveCapacity(atlas: SharedAtlas, neededTexels: number): void {
    const neededFloats = neededTexels * 4;
    if (atlas.curveTexData.length >= neededFloats) {
        return;
    }
    let newFloats = Math.max(atlas.curveTexData.length * 2, ROW_FLOATS);
    while (newFloats < neededFloats) {
        newFloats *= 2;
    }
    // Round up to a whole row to keep texel math aligned.
    newFloats = Math.ceil(newFloats / ROW_FLOATS) * ROW_FLOATS;
    const grown = new Float32Array(newFloats);
    grown.set(atlas.curveTexData);
    atlas.curveTexData = grown;
}

function ensureBandCapacity(atlas: SharedAtlas, neededTexels: number): void {
    const neededFloats = neededTexels * 4;
    if (atlas.bandTexData.length >= neededFloats) {
        return;
    }
    let newFloats = Math.max(atlas.bandTexData.length * 2, ROW_FLOATS);
    while (newFloats < neededFloats) {
        newFloats *= 2;
    }
    newFloats = Math.ceil(newFloats / ROW_FLOATS) * ROW_FLOATS;
    const grown = new Float32Array(newFloats);
    grown.set(atlas.bandTexData);
    atlas.bandTexData = grown;
}

/** Append `glyph` to `atlas`. Returns the new slot. Caller must guarantee glyph not already present. */
export function packAppendGlyph(atlas: SharedAtlas, glyph: GlyphCurves): AtlasSlot {
    const bands = buildGlyphBands(glyph);
    const curves = glyph.curves;

    // ── Curve texels: 2 texels per curve, must not straddle a row boundary. ──
    let curveTexel = atlas.curveTexelsUsed;
    const startTexel = curveTexel;
    // Pre-compute curve-texel positions, snapping past any row that can't fit a curve.
    const curveTexelPositions: number[] = new Array(curves.length);
    for (let i = 0; i < curves.length; i++) {
        const row0 = (curveTexel / TEX_WIDTH) | 0;
        const row1 = ((curveTexel + 1) / TEX_WIDTH) | 0;
        if (row0 !== row1) {
            curveTexel = row1 * TEX_WIDTH;
        }
        curveTexelPositions[i] = curveTexel;
        curveTexel += 2;
    }
    const curveTexelsEnd = curveTexel;
    ensureCurveCapacity(atlas, curveTexelsEnd);

    const curveData = atlas.curveTexData;
    for (let i = 0; i < curves.length; i++) {
        const c = curves[i]!;
        const tl = curveTexelPositions[i]!;
        const o0 = tl * 4;
        curveData[o0] = c.p0x;
        curveData[o0 + 1] = c.p0y;
        curveData[o0 + 2] = c.p1x;
        curveData[o0 + 3] = c.p1y;
        const o1 = (tl + 1) * 4;
        curveData[o1] = c.p2x;
        curveData[o1 + 1] = c.p2y;
        // (.zw left zero; padded.)
    }
    atlas.curveTexelsUsed = curveTexelsEnd;

    // ── Band block: headers must not straddle a row; followed by curve-index lists. ──
    const headerCount = bands.hBandCount + bands.vBandCount;
    let bandStart = atlas.bandTexelsUsed;
    const curX = bandStart % TEX_WIDTH;
    if (curX + headerCount > TEX_WIDTH) {
        bandStart = (((bandStart / TEX_WIDTH) | 0) + 1) * TEX_WIDTH;
    }
    const glyphLocX = bandStart % TEX_WIDTH;
    const glyphLocY = (bandStart / TEX_WIDTH) | 0;

    const allBands = [...bands.hBands, ...bands.vBands];
    let curveListOffset = headerCount;
    const bandOffsets: number[] = new Array(allBands.length);
    for (let i = 0; i < allBands.length; i++) {
        bandOffsets[i] = curveListOffset;
        curveListOffset += allBands[i]!.curveIndices.length;
    }
    const bandTexelsEnd = bandStart + curveListOffset;
    ensureBandCapacity(atlas, bandTexelsEnd);

    const bandData = atlas.bandTexData;
    // Headers.
    for (let i = 0; i < allBands.length; i++) {
        const tl = bandStart + i;
        const di = tl * 4;
        bandData[di] = allBands[i]!.curveIndices.length;
        bandData[di + 1] = bandOffsets[i]!;
    }
    // Curve refs.
    for (let i = 0; i < allBands.length; i++) {
        const band = allBands[i]!;
        const listStart = bandStart + bandOffsets[i]!;
        for (let j = 0; j < band.curveIndices.length; j++) {
            const ci = band.curveIndices[j]!;
            const curveTexelAbs = curveTexelPositions[ci]!;
            void startTexel; // (kept to make the curve-start anchor obvious for future code).
            const cTexX = curveTexelAbs % TEX_WIDTH;
            const cTexY = (curveTexelAbs / TEX_WIDTH) | 0;
            const tl = listStart + j;
            const di = tl * 4;
            bandData[di] = cTexX;
            bandData[di + 1] = cTexY;
        }
    }
    atlas.bandTexelsUsed = bandTexelsEnd;

    atlas.version++;

    return {
        curveTexelStart: startTexel,
        glyphLocX,
        glyphLocY,
        bandMaxX: bands.vBandCount - 1,
        bandMaxY: bands.hBandCount - 1,
        vBandCount: bands.vBandCount,
        hBandCount: bands.hBandCount,
    };
}

/** Create an empty SharedAtlas. */
export function createSharedAtlas(): SharedAtlas {
    return {
        curveTexData: new Float32Array(ROW_FLOATS),
        curveTexelsUsed: 0,
        bandTexData: new Float32Array(ROW_FLOATS),
        bandTexelsUsed: 0,
        glyphSlots: new Map(),
        version: 0,
        _gpu: null,
    };
}
