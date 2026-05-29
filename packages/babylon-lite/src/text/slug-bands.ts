/** Spatial-band partitioning for a glyph's curves. Memoized per `GlyphCurves`. */

import type { GlyphCurves, QuadCurve } from "./public-types.js";
import { getBandsCache } from "./internal.js";

export type BandEntry = { curveIndices: number[] };
export type GlyphBands = {
    hBands: BandEntry[];
    vBands: BandEntry[];
    hBandCount: number;
    vBandCount: number;
};

function curveAt(curves: readonly QuadCurve[], i: number): QuadCurve {
    const c = curves[i];
    if (!c) {
        throw new Error("buildGlyphBands: invalid curve index");
    }
    return c;
}

function buildBandsInternal(g: GlyphCurves): GlyphBands {
    const { curves, bounds } = g;
    const numBands = Math.max(1, Math.min(8, Math.floor(curves.length / 2)));
    const { xMin, yMin, xMax, yMax } = bounds;
    const width = xMax - xMin;
    const height = yMax - yMin;
    const bandH = height / numBands;
    const bandW = width / numBands;

    const hBands: BandEntry[] = [];
    const vBands: BandEntry[] = [];
    for (let i = 0; i < numBands; i++) {
        hBands.push({ curveIndices: [] });
        vBands.push({ curveIndices: [] });
    }

    for (let ci = 0; ci < curves.length; ci++) {
        const c = curveAt(curves, ci);
        const cyMin = Math.min(c.p0y, c.p1y, c.p2y);
        const cyMax = Math.max(c.p0y, c.p1y, c.p2y);
        const cxMin = Math.min(c.p0x, c.p1x, c.p2x);
        const cxMax = Math.max(c.p0x, c.p1x, c.p2x);
        if (height > 0) {
            for (let b = 0; b < numBands; b++) {
                const bMinY = yMin + b * bandH;
                const bMaxY = yMin + (b + 1) * bandH;
                if (cyMax >= bMinY && cyMin <= bMaxY) {
                    hBands[b]!.curveIndices.push(ci);
                }
            }
        }
        if (width > 0) {
            for (let b = 0; b < numBands; b++) {
                const bMinX = xMin + b * bandW;
                const bMaxX = xMin + (b + 1) * bandW;
                if (cxMax >= bMinX && cxMin <= bMaxX) {
                    vBands[b]!.curveIndices.push(ci);
                }
            }
        }
    }

    // Sort curves: h-bands by descending max x, v-bands by descending max y (early-exit in shader).
    for (const band of hBands) {
        band.curveIndices.sort((a, b) => {
            const ca = curveAt(curves, a);
            const cb = curveAt(curves, b);
            return Math.max(cb.p0x, cb.p1x, cb.p2x) - Math.max(ca.p0x, ca.p1x, ca.p2x);
        });
    }
    for (const band of vBands) {
        band.curveIndices.sort((a, b) => {
            const ca = curveAt(curves, a);
            const cb = curveAt(curves, b);
            return Math.max(cb.p0y, cb.p1y, cb.p2y) - Math.max(ca.p0y, ca.p1y, ca.p2y);
        });
    }

    return { hBands, vBands, hBandCount: numBands, vBandCount: numBands };
}

/** Get (and memoize) the band partitioning for a glyph's curves. */
export function buildGlyphBands(g: GlyphCurves): GlyphBands {
    const cache = getBandsCache();
    let bands = cache.get(g);
    if (!bands) {
        bands = buildBandsInternal(g);
        cache.set(g, bands);
    }
    return bands;
}
