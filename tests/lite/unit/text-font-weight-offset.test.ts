import { describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { GlyphCurves, QuadCurve } from "../../../packages/babylon-lite/src/text/glyph-storage";
import { createTextData, updateTextData, TEXT_INSTANCE_FLOATS, TEXT_STYLE_FLOATS, _textStyleSeam } from "../../../packages/babylon-lite/src/text/text-data";
import type { GlyphRun } from "../../../packages/babylon-lite/src/text/text-data";
import { buildGlyphBands, createGlyphStorage } from "../../../packages/babylon-lite/src/text/glyph-storage";
import { setFontWeightOffset } from "../../../packages/babylon-lite/src/text/set-font-weight-offset";
import { createFontFromBuffer } from "../../../packages/babylon-lite/src/text/font";
import { createDefaultTextData, disposeDefaultTextData, updateDefaultTextData } from "../../../packages/babylon-lite/src/text/default-text-data";
import { _textPipelineKey, _textVariantResolver } from "../../../packages/babylon-lite/src/text/_gpu/text-pipeline";
import { composeSlugShader } from "../../../packages/babylon-lite/src/text/shaders/slug-shader";
import { WEIGHT_SHADER_FRAGMENT } from "../../../packages/babylon-lite/src/text/shaders/weight-shader-fragment";

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
const STYLE_PARAMS_Y_OFFSET = 5; // params.y in the 8-float TextStyle struct

/** Read the style params.y for instance `i`. */
function instanceWeightOffset(data: ReturnType<typeof createTextData>, i: number): number {
    const styleIdx = data._instancesU32[i * TEXT_INSTANCE_FLOATS + PACKED_OFFSET]! >>> 16;
    return data._styles[styleIdx * TEXT_STYLE_FLOATS + STYLE_PARAMS_Y_OFFSET]!;
}

/** The style parameter `text-data` would pack for a run (0 when no feature is installed). */
function styleParam(run: GlyphRun): number {
    return _textStyleSeam?._param(run) ?? 0;
}

const SETTER_STORAGE = createGlyphStorage(
    new Map([
        [
            "f",
            new Map<number, GlyphCurves>([
                [1, makeGlyph(1)],
                [2, makeGlyph(2)],
            ]),
        ],
    ])
);

/** One packed, live single-run TextData — the state every setter call now operates on. */
function makeLiveData(): { data: ReturnType<typeof createTextData>; run: GlyphRun } {
    const run: GlyphRun = { curveSet: "f", glyphs: [{ glyphId: 1, x: 0, y: 0 }], pixelsPerFontUnit: 1 };
    return { data: createTextData(SETTER_STORAGE, [run]), run };
}

describe("setFontWeightOffset", () => {
    it("weights a run that is already packed, updating its group key and params.y", () => {
        const { data, run } = makeLiveData();
        expect(data._groups[0]!._groupKey).toBe("f");

        setFontWeightOffset(data, run, 10);

        expect(styleParam(run)).toBe(10);
        expect(data._groups.length).toBe(1);
        expect(data._groups[0]!._groupKey).not.toBe("f");
        expect(data._groups[0]!._curveSetId).toBe("f");
        expect(instanceWeightOffset(data, 0)).toBe(Math.fround(10));
    });

    it("accepts the run's index as well as its reference", () => {
        const { data, run } = makeLiveData();
        setFontWeightOffset(data, 0, 10);
        expect(styleParam(run)).toBe(10);
        expect(data._groups[0]!._groupKey).not.toBe("f");
        expect(instanceWeightOffset(data, 0)).toBe(Math.fround(10));
    });

    it("returns 0 for a run with no offset set", () => {
        const { run } = makeLiveData();
        expect(styleParam(run)).toBe(0);
    });

    it("overwrites on repeated calls", () => {
        const { data, run } = makeLiveData();
        setFontWeightOffset(data, run, 10);
        setFontWeightOffset(data, run, 5);
        expect(styleParam(run)).toBe(5);
        expect(instanceWeightOffset(data, 0)).toBe(Math.fround(5));
    });

    it("zero removes the offset and returns the group to the base key and style", () => {
        const { data, run } = makeLiveData();
        setFontWeightOffset(data, run, 10);
        setFontWeightOffset(data, run, 0);
        expect(styleParam(run)).toBe(0);
        expect(data._groups.length).toBe(1);
        expect(data._groups[0]!._groupKey).toBe("f");
        expect(instanceWeightOffset(data, 0)).toBe(0);
    });

    it("is a no-op when the run already has the requested offset", () => {
        const { data, run } = makeLiveData();
        setFontWeightOffset(data, run, 10);
        const version = data._version;
        const layoutVersion = data._layoutVersion;
        const styleVersion = data._styleVersion;

        setFontWeightOffset(data, run, 10);

        expect(data._version).toBe(version);
        expect(data._layoutVersion).toBe(layoutVersion);
        expect(data._styleVersion).toBe(styleVersion);
    });

    it("is a no-op when clearing a run that was never weighted", () => {
        const { data, run } = makeLiveData();
        const version = data._version;
        const layoutVersion = data._layoutVersion;

        setFontWeightOffset(data, run, 0);

        expect(data._version).toBe(version);
        expect(data._layoutVersion).toBe(layoutVersion);
        expect(data._groups[0]!._groupKey).toBe("f");
    });

    it("rejects NaN with a console.error and repacks nothing", () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        const { data, run } = makeLiveData();
        const version = data._version;
        setFontWeightOffset(data, run, NaN);
        expect(spy).toHaveBeenCalledOnce();
        expect(styleParam(run)).toBe(0);
        expect(data._version).toBe(version);
        spy.mockRestore();
    });

    it("rejects Infinity with a console.error", () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        const { data, run } = makeLiveData();
        setFontWeightOffset(data, run, Infinity);
        expect(spy).toHaveBeenCalledOnce();
        expect(styleParam(run)).toBe(0);
        spy.mockRestore();
    });

    it("clamps values outside 0–100 with a console.warn", () => {
        const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const { data, run } = makeLiveData();
        setFontWeightOffset(data, run, 150);
        expect(styleParam(run)).toBe(100);
        expect(instanceWeightOffset(data, 0)).toBe(100);
        setFontWeightOffset(data, run, -10);
        expect(styleParam(run)).toBe(0);
        expect(instanceWeightOffset(data, 0)).toBe(0);
        expect(spy).toHaveBeenCalledTimes(2);
        spy.mockRestore();
    });

    it("throws on an out-of-range index", () => {
        const { data } = makeLiveData();
        expect(() => setFontWeightOffset(data, 1, 10)).toThrow(/run index 1 out of range/);
        expect(() => setFontWeightOffset(data, -1, 10)).toThrow(/run index -1 out of range/);
    });

    it("throws on a GlyphRun that is not in this TextData", () => {
        const { data } = makeLiveData();
        const foreign: GlyphRun = { curveSet: "f", glyphs: [{ glyphId: 2, x: 0, y: 0 }], pixelsPerFontUnit: 1 };
        expect(() => setFontWeightOffset(data, foreign, 10)).toThrow(/GlyphRun reference is not in this TextData/);
    });

    it("rolls back the offset map to its exact prior value when the reset repack throws, so a retry with the same offset actually repacks", () => {
        const { data, run } = makeLiveData();
        // Start from an already-weighted run so the rollback path is exercised against a real
        // *previous value* (5), not just "no entry" — the setter must restore 5, not delete it.
        setFontWeightOffset(data, run, 5);
        expect(styleParam(run)).toBe(5);
        const groupsBeforeFailure = data._groups;

        // Break the run/storage relationship so the reset the setter drives is guaranteed to
        // throw: `data._storage` no longer has an entry for the run's curve set "f".
        const goodStorage = data._storage;
        data._storage = createGlyphStorage();

        expect(() => setFontWeightOffset(data, run, 10)).toThrow(/storage does not contain curveSet "f"/);

        // The map must be restored to exactly its pre-call state (5), not left at the rejected
        // 10 and not cleared to 0 — either would desync the map from what was actually packed.
        expect(styleParam(run)).toBe(5);
        // The data's own groups/styles were never touched by the failed attempt.
        expect(data._groups).toBe(groupsBeforeFailure);
        expect(instanceWeightOffset(data, 0)).toBe(Math.fround(5));

        // Fix the cause of the failure and retry the identical offset (10) that failed above.
        // If the map were left at 10 by a buggy rollback, this call's no-op guard would compare
        // 10 === 10 and return without repacking — proving the retry must actually run the
        // repack, not silently no-op.
        data._storage = goodStorage;
        setFontWeightOffset(data, run, 10);

        expect(styleParam(run)).toBe(10);
        expect(data._groups.length).toBe(1);
        expect(data._groups[0]!._groupKey).not.toBe("f");
        expect(instanceWeightOffset(data, 0)).toBe(Math.fround(10));
    });
});

describe("font-weight-offset style packing", () => {
    const inner = new Map<number, GlyphCurves>([
        [1, makeGlyph(1)],
        [2, makeGlyph(2)],
    ]);
    const storage = createGlyphStorage(new Map([["f", inner]]));

    it("packs the offset into params.y for a weighted run", () => {
        const run: GlyphRun = { curveSet: "f", glyphs: [{ glyphId: 1, x: 0, y: 0 }], pixelsPerFontUnit: 1 };
        const data = createTextData(storage, [run]);
        setFontWeightOffset(data, run, 15);
        expect(instanceWeightOffset(data, 0)).toBe(Math.fround(15));
    });

    it("packs 0 into params.y for a base run", () => {
        const run: GlyphRun = { curveSet: "f", glyphs: [{ glyphId: 1, x: 0, y: 0 }], pixelsPerFontUnit: 1 };
        const data = createTextData(storage, [run]);
        expect(instanceWeightOffset(data, 0)).toBe(0);
    });
});

describe("font-weight-offset variant grouping", () => {
    const inner = new Map<number, GlyphCurves>([
        [1, makeGlyph(1)],
        [2, makeGlyph(2)],
    ]);
    const storage = createGlyphStorage(new Map([["f", inner]]));

    function glyph(glyphId: number, x: number) {
        return { glyphId, x, y: 0 };
    }

    it("separates base and weighted runs into distinct groups", () => {
        const baseRun: GlyphRun = { curveSet: "f", glyphs: [glyph(1, 0)], pixelsPerFontUnit: 1 };
        const weightedRun: GlyphRun = { curveSet: "f", glyphs: [glyph(2, 10)], pixelsPerFontUnit: 1 };
        const data = createTextData(storage, [baseRun, weightedRun]);
        expect(data._groups.length).toBe(1);

        setFontWeightOffset(data, weightedRun, 10);

        expect(data._groups.length).toBe(2);
        // The base group is keyed by the curve set itself; the weighted group is not — which
        // is exactly the test the draw paths use to pick the composed pipeline.
        expect(data._groups[0]!._groupKey).toBe("f");
        expect(data._groups[1]!._groupKey).not.toBe("f");
        expect(data._groups[0]!._curveSetId).toBe("f");
        expect(data._groups[1]!._curveSetId).toBe("f");
    });

    it("batches weighted runs with different offsets in one group", () => {
        const run1: GlyphRun = { curveSet: "f", glyphs: [glyph(1, 0)], pixelsPerFontUnit: 1 };
        const run2: GlyphRun = { curveSet: "f", glyphs: [glyph(2, 10)], pixelsPerFontUnit: 1 };
        const data = createTextData(storage, [run1, run2]);
        setFontWeightOffset(data, run1, 10);
        setFontWeightOffset(data, run2, 25);
        expect(data._groups.length).toBe(1);
        expect(data._groups[0]!._groupKey).not.toBe("f");
        expect(instanceWeightOffset(data, 0)).toBe(Math.fround(10));
        expect(instanceWeightOffset(data, 1)).toBe(Math.fround(25));
    });

    it("addRun routes a weighted run into its own group and removeRun retires it", () => {
        const baseRun: GlyphRun = { curveSet: "f", glyphs: [glyph(1, 0)], pixelsPerFontUnit: 1 };
        const data = createTextData(storage, [baseRun]);
        expect(data._groups.length).toBe(1);

        const weightedRun: GlyphRun = { curveSet: "f", glyphs: [glyph(2, 10)], pixelsPerFontUnit: 1 };
        updateTextData(data, { update: "addRun", run: weightedRun });
        expect(data._groups.length).toBe(1);
        setFontWeightOffset(data, weightedRun, 8);
        expect(data._groups.length).toBe(2);
        expect(data._groups[1]!._groupKey).not.toBe("f");

        // A second weighted run on the same curve set reuses the same group — here through
        // `addRun`, which reads the run's key that the setter already installed.
        const weighted2: GlyphRun = { curveSet: "f", glyphs: [glyph(1, 20)], pixelsPerFontUnit: 1 };
        updateTextData(data, { update: "addRun", run: weighted2 });
        setFontWeightOffset(data, weighted2, 3);
        expect(data._groups.length).toBe(2);

        updateTextData(data, { update: "removeRun", run: weightedRun });
        updateTextData(data, { update: "removeRun", run: weighted2 });
        expect(data._groups.length).toBe(1);
        expect(data._groups[0]!._groupKey).toBe("f");
    });

    it("moves a run across the base/weighted boundary and back", () => {
        const baseRun: GlyphRun = { curveSet: "f", glyphs: [glyph(1, 0)], pixelsPerFontUnit: 1 };
        const data = createTextData(storage, [baseRun]);

        setFontWeightOffset(data, baseRun, 12);
        expect(data._groups.length).toBe(1);
        expect(data._groups[0]!._groupKey).not.toBe("f");
        expect(instanceWeightOffset(data, 0)).toBe(Math.fround(12));

        // A `replaceRun` swaps in a *new* descriptor, and offsets are keyed by run identity —
        // so the block falls back to the base group until the offset is re-applied.
        const replacement: GlyphRun = { curveSet: "f", glyphs: [glyph(2, 0)], pixelsPerFontUnit: 1 };
        updateTextData(data, { update: "replaceRun", previous: baseRun, run: replacement });
        expect(data.runs).toEqual([replacement]);
        expect(data._groups.length).toBe(1);
        expect(data._groups[0]!._groupKey).toBe("f");
        expect(instanceWeightOffset(data, 0)).toBe(0);

        // Re-applying by index (the reference changed) weights the new run.
        setFontWeightOffset(data, 0, 4);
        expect(data._groups[0]!._groupKey).not.toBe("f");
        expect(instanceWeightOffset(data, 0)).toBe(Math.fround(4));

        setFontWeightOffset(data, 0, 0);
        expect(data._groups[0]!._groupKey).toBe("f");
        expect(instanceWeightOffset(data, 0)).toBe(0);
    });

    it("reuses the group object when a weighted run's offset changes", () => {
        const run1: GlyphRun = { curveSet: "f", glyphs: [glyph(1, 0)], pixelsPerFontUnit: 1 };
        const data = createTextData(storage, [run1]);
        setFontWeightOffset(data, run1, 10);
        const before = data._groups[0]!;

        setFontWeightOffset(data, run1, 20);

        expect(data._groups.length).toBe(1);
        expect(data._groups[0]!).toBe(before);
        expect(instanceWeightOffset(data, 0)).toBe(Math.fround(20));
    });
});

// ---------------------------------------------------------------------------
// Regression: shader transfer-function direction (no GPU).
//
// Mirrors the WGSL math in the weight fragment's `CO` slot so the test catches
// offset-direction errors and a finalization that lets emboldening remove coverage.
// ---------------------------------------------------------------------------

/** Pure-JS replica of the weighted-shader coverage transfer function. */
function weightedCoverage(distance: number, weightOffset: number, aaScale: number): number {
    return Math.min(Math.max((weightOffset - distance) * aaScale + 0.5, 0), 1);
}

/** Pure-JS replica of the `CO` slot as a whole, including the monotone finalization. */
function finalCoverage(baseCoverage: number, distance: number, weightOffset: number, aaScale: number): number {
    if (weightOffset === 0) {
        return baseCoverage;
    }
    return Math.max(baseCoverage, weightedCoverage(distance, weightOffset, aaScale));
}

describe("font-weight-offset shader-math direction", () => {
    const AA = 100; // large aaScale so boundary is sharp

    it("a point beyond the contour has no weighted coverage at zero offset", () => {
        expect(weightedCoverage(0.1, 0, AA)).toBeCloseTo(0, 1);
    });

    it("positive offset expands fill: exterior pixel becomes covered", () => {
        expect(weightedCoverage(0.02, 0.05, AA)).toBeGreaterThan(0.9);
    });

    it("a point on the contour at zero offset yields ~0.5", () => {
        expect(weightedCoverage(0, 0, AA)).toBeCloseTo(0.5, 5);
    });

    it("a zero offset leaves the analytic base coverage untouched", () => {
        for (const base of [0, 0.25, 0.5, 0.75, 1]) {
            expect(finalCoverage(base, 0.37, 0, AA)).toBe(base);
        }
    });

    it("a positive offset can only add coverage, never remove it", () => {
        // Overestimated distance (nearest contour missed / beyond the search radius) must not
        // punch a hole in a filled interior.
        expect(finalCoverage(1, 5, 0.05, AA)).toBe(1);
        for (const distance of [0, 0.02, 0.5, 5]) {
            expect(finalCoverage(0.6, distance, 0.05, AA)).toBeGreaterThanOrEqual(0.6);
        }
    });

    it("matches the WGSL emitted by the weight fragment's coverage slot", () => {
        // Keeps the JS replica honest: the shader must use unsigned distance, guard on a zero
        // offset, and combine only with max.
        const co = WEIGHT_SHADER_FRAGMENT._fragmentSlots!.CO!.replace(/\s+/g, "");
        expect(co).toContain("if(in.wo!=0.0){");
        expect(co).toContain("letd=wdst(rc,gp,bm,in.bn,in.wo+1.0/aas)");
        expect(co).toContain("letwc=clamp((in.wo-d)*aas+0.5,0.0,1.0)");
        expect(co).toContain("cov=max(cov,wc)");
        expect(co).not.toContain("select(");
        expect(co).not.toContain("min(cov,wc)");
    });
});

// ---------------------------------------------------------------------------
// Regression: the weight fragment's band scan must be complete within its radius.
//
// The pre-fix implementation folded a running minimum distance into the *base*
// coverage loops, which (a) only ever visit the single h-band containing the
// pixel and (b) `break` on a coverage-specific bound that discards every curve
// left of the pixel. Both are unsound for a nearest-contour query. These tests
// replicate the candidate selection of each strategy against the real band data
// produced by `buildGlyphBands` and assert the new one finds the true nearest
// curve where the old one does not.
// ---------------------------------------------------------------------------

/** A square-ish glyph with enough curves to force multiple bands. */
function squareGlyph(): GlyphCurves {
    const seg = (p0x: number, p0y: number, p2x: number, p2y: number): QuadCurve => ({
        p0x,
        p0y,
        p1x: (p0x + p2x) / 2,
        p1y: (p0y + p2y) / 2,
        p2x,
        p2y,
    });
    // Counter-clockwise unit square subdivided into 4 segments per side (16 curves → 8 bands).
    const curves: QuadCurve[] = [];
    const pts: [number, number][] = [];
    const N = 4;
    for (let i = 0; i < N; i++) {
        pts.push([(i / N) * 100, 0]);
    }
    for (let i = 0; i < N; i++) {
        pts.push([100, (i / N) * 100]);
    }
    for (let i = 0; i < N; i++) {
        pts.push([100 - (i / N) * 100, 100]);
    }
    for (let i = 0; i < N; i++) {
        pts.push([0, 100 - (i / N) * 100]);
    }
    for (let i = 0; i < pts.length; i++) {
        const a = pts[i]!;
        const b = pts[(i + 1) % pts.length]!;
        curves.push(seg(a[0], a[1], b[0], b[1]));
    }
    return { glyphId: 1, curves, bounds: { xMin: 0, yMin: 0, xMax: 100, yMax: 100 } };
}

function curveMaxX(c: QuadCurve): number {
    return Math.max(c.p0x, c.p1x, c.p2x);
}

/** Exact distance from a point to a quadratic Bézier, by dense sampling (reference value). */
function sampledDistance(c: QuadCurve, px: number, py: number): number {
    let best = Infinity;
    for (let i = 0; i <= 400; i++) {
        const t = i / 400;
        const mt = 1 - t;
        const x = mt * mt * c.p0x + 2 * mt * t * c.p1x + t * t * c.p2x;
        const y = mt * mt * c.p0y + 2 * mt * t * c.p1y + t * t * c.p2y;
        best = Math.min(best, Math.hypot(x - px, y - py));
    }
    return best;
}

/** Index of the curve genuinely nearest the sample point. */
function nearestCurveIndex(curves: readonly QuadCurve[], px: number, py: number): number {
    let bestI = -1;
    let best = Infinity;
    for (let i = 0; i < curves.length; i++) {
        const d = sampledDistance(curves[i]!, px, py);
        if (d < best) {
            best = d;
            bestI = i;
        }
    }
    return bestI;
}

/** Every curve genuinely within `rad` of the sample point — the exact set `wdst` promises to
 *  consider (curves farther than `rad` cannot change the weighted coverage). */
function curveIndicesWithin(curves: readonly QuadCurve[], px: number, py: number, rad: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < curves.length; i++) {
        if (sampledDistance(curves[i]!, px, py) <= rad) {
            out.push(i);
        }
    }
    return out;
}

/** Candidate curve indices the *new* `wdst` scan visits (see `weight-shader-fragment.ts`). */
function wdstCandidates(g: GlyphCurves, px: number, py: number, rad: number): Set<number> {
    const bands = buildGlyphBands(g);
    const { yMin, yMax } = g.bounds;
    const scaleY = yMax - yMin > 0 ? bands._hBandCount / (yMax - yMin) : 0;
    const offsetY = -yMin * scaleY;
    const bandMaxY = bands._hBandCount - 1;
    const clampBand = (v: number) => Math.min(Math.max(Math.trunc(v), 0), bandMaxY);
    const y0 = clampBand((py - rad) * scaleY + offsetY);
    const y1 = clampBand((py + rad) * scaleY + offsetY);
    const xl = px - rad;
    const out = new Set<number>();
    for (let b = y0; b <= y1; b++) {
        for (const ci of bands._hBands[b]!._curveIndices) {
            if (curveMaxX(g.curves[ci]!) < xl) {
                break; // sorted by descending max-x
            }
            out.add(ci);
        }
    }
    return out;
}

/** Candidate curve indices the *pre-fix* "accumulate inside the base h/v loops" strategy
 *  visited: one h-band and one v-band, each truncated by the base coverage break. */
function baseLoopCandidates(g: GlyphCurves, px: number, py: number, pixelsPerFontUnit: number): Set<number> {
    const bands = buildGlyphBands(g);
    const { xMin, yMin, xMax, yMax } = g.bounds;
    const scaleY = yMax - yMin > 0 ? bands._hBandCount / (yMax - yMin) : 0;
    const scaleX = xMax - xMin > 0 ? bands._vBandCount / (xMax - xMin) : 0;
    const hb = Math.min(Math.max(Math.trunc(py * scaleY - yMin * scaleY), 0), bands._hBandCount - 1);
    const vb = Math.min(Math.max(Math.trunc(px * scaleX - xMin * scaleX), 0), bands._vBandCount - 1);
    const out = new Set<number>();
    for (const ci of bands._hBands[hb]!._curveIndices) {
        const c = g.curves[ci]!;
        if ((curveMaxX(c) - px) * pixelsPerFontUnit < -0.5) {
            break;
        }
        out.add(ci);
    }
    for (const ci of bands._vBands[vb]!._curveIndices) {
        const c = g.curves[ci]!;
        if ((Math.max(c.p0y, c.p1y, c.p2y) - py) * pixelsPerFontUnit < -0.5) {
            break;
        }
        out.add(ci);
    }
    return out;
}

describe("font-weight-offset band scan completeness", () => {
    const g = squareGlyph();
    const OFFSET = 6; // font units
    const PIXELS_PER_FONT_UNIT = 1;
    const RAD = OFFSET + 1 / PIXELS_PER_FONT_UNIT;

    // Sample points just outside every side and every corner of the square, within the
    // emboldening radius (this is exactly where a positive offset must add coverage).
    const samples: [string, number, number][] = [
        ["left", -3, 50],
        ["right", 103, 50],
        ["below", 50, -3],
        ["above", 50, 103],
        ["corner bottom-left", -3, -3],
        ["corner bottom-right", 103, -3],
        ["corner top-left", -3, 103],
        ["corner top-right", 103, 103],
    ];

    it.each(samples)("wdst considers the true nearest curve %s the glyph", (_name, px, py) => {
        const nearest = nearestCurveIndex(g.curves, px, py);
        expect(wdstCandidates(g, px, py, RAD).has(nearest)).toBe(true);
    });

    it.each(samples)("wdst considers every curve within the search radius %s the glyph", (_name, px, py) => {
        const candidates = wdstCandidates(g, px, py, RAD);
        for (const ci of curveIndicesWithin(g.curves, px, py, RAD)) {
            expect(candidates.has(ci)).toBe(true);
        }
    });

    it("the pre-fix base-loop strategy misses the nearest curve on at least one side/corner", () => {
        const missed = samples.filter(([, px, py]) => !baseLoopCandidates(g, px, py, PIXELS_PER_FONT_UNIT).has(nearestCurveIndex(g.curves, px, py)));
        // Regression guard: if this ever becomes empty, the sided/cornered assertions above no
        // longer distinguish the fixed scan from the broken one.
        expect(missed.length).toBeGreaterThan(0);
    });

    it("wdst also covers interior pixels straddling a band boundary", () => {
        const bands = buildGlyphBands(g);
        const bandH = 100 / bands._hBandCount;
        // Just inside the left edge, so the nearest contour is within the search radius, and
        // exactly on each interior band boundary — where a single-band scan sees only half the
        // neighbourhood.
        for (let b = 1; b < bands._hBandCount; b++) {
            for (const py of [b * bandH - 1e-3, b * bandH + 1e-3]) {
                const candidates = wdstCandidates(g, 3, py, RAD);
                expect(candidates.has(nearestCurveIndex(g.curves, 3, py))).toBe(true);
                for (const ci of curveIndicesWithin(g.curves, 3, py, RAD)) {
                    expect(candidates.has(ci)).toBe(true);
                }
            }
        }
    });

    it("band transform is monotone non-decreasing and never negative (wdst range invariant)", () => {
        for (const glyph of [g, makeGlyph(1), { ...g, bounds: { xMin: 0, yMin: 5, xMax: 100, yMax: 5 } }]) {
            const bands = buildGlyphBands(glyph as GlyphCurves);
            const h = glyph.bounds.yMax - glyph.bounds.yMin;
            const scaleY = h > 0 ? bands._hBandCount / h : 0;
            expect(scaleY).toBeGreaterThanOrEqual(0);
            expect(Number.isFinite(scaleY)).toBe(true);
            expect(Number.isFinite(-glyph.bounds.yMin * scaleY)).toBe(true);
        }
    });
});

describe("font-weight-offset group-key collision regression", () => {
    // Regression for a composite-string-key bug: grouping used to key draw groups by
    // `curveSetId + (variant ? ':w' : '')`. That collides whenever one curve set's raw id
    // already ends in the literal suffix used for the other variant — e.g. the *unweighted*
    // group for curve set "X:w" produced the exact same string key ("X:w") as the *weighted*
    // group for curve set "X". Use exactly that pair to prove groups stay distinct and each
    // one references its own curve set, both on initial creation and across a reset that must
    // reuse (not conflate) the previous groups.
    const glyphsX = new Map<number, GlyphCurves>([[1, makeGlyph(1)]]);
    const glyphsXw = new Map<number, GlyphCurves>([[2, makeGlyph(2)]]);
    const storage = createGlyphStorage(
        new Map([
            ["X", glyphsX],
            ["X:w", glyphsXw],
        ])
    );

    function makeCollidingData(): { data: ReturnType<typeof createTextData>; unweightedOnXw: GlyphRun; weightedOnX: GlyphRun } {
        // Unweighted run on curve set "X:w" — legacy key: "X:w".
        const unweightedOnXw: GlyphRun = { curveSet: "X:w", glyphs: [{ glyphId: 2, x: 0, y: 0 }], pixelsPerFontUnit: 1 };
        // Weighted run on curve set "X" — legacy key: "X" + ":w" === "X:w" (the collision).
        const weightedOnX: GlyphRun = { curveSet: "X", glyphs: [{ glyphId: 1, x: 10, y: 0 }], pixelsPerFontUnit: 1 };
        const data = createTextData(storage, [unweightedOnXw, weightedOnX]);
        setFontWeightOffset(data, weightedOnX, 12);
        return { data, unweightedOnXw, weightedOnX };
    }

    it("keeps the colliding pair in distinct groups with the correct curve set", () => {
        const { data } = makeCollidingData();

        expect(data._groups.length).toBe(2);

        const groupXw = data._groups.find((g) => g._curveSetId === "X:w")!;
        const groupX = data._groups.find((g) => g._curveSetId === "X")!;
        expect(groupXw).toBeDefined();
        expect(groupX).toBeDefined();

        // The unweighted group's key is its own curve-set id; the weighted group's is the
        // interned non-string token, which can never equal any curve-set id.
        expect(groupXw._groupKey).toBe("X:w");
        expect(typeof groupX._groupKey).toBe("object");
        expect(groupX._groupKey).not.toBe(groupXw._groupKey);

        // Each group's curve set must be the storage entry matching its own curveSetId,
        // never the other curve set's atlas (the failure mode a collision would produce).
        expect(groupXw._curveSet).toBe(storage._curveSets.get("X:w"));
        expect(groupX._curveSet).toBe(storage._curveSets.get("X"));
    });

    it("preserves distinct group identity (reuse, not conflation) across a reset", () => {
        const { data, unweightedOnXw, weightedOnX } = makeCollidingData();

        const groupXwBefore = data._groups.find((g) => g._curveSetId === "X:w")!;
        const groupXBefore = data._groups.find((g) => g._curveSetId === "X")!;

        updateTextData(data, { update: "reset", runs: [unweightedOnXw, weightedOnX] });

        expect(data._groups.length).toBe(2);
        const groupXwAfter = data._groups.find((g) => g._curveSetId === "X:w")!;
        const groupXAfter = data._groups.find((g) => g._curveSetId === "X")!;

        // Object identity is reused per draw-group key — proving the reset's previous-group
        // lookup did not cross-match the colliding pair.
        expect(groupXwAfter).toBe(groupXwBefore);
        expect(groupXAfter).toBe(groupXBefore);
        expect(groupXwAfter._groupKey).toBe("X:w");
        expect(groupXAfter._groupKey).not.toBe("X:w");
    });
});

describe("text pipeline cache key", () => {
    it("is fixed arity: six fields, all always present", () => {
        expect(_textPipelineKey("bgra8unorm", 1, null, false, false, "-").split(":")).toEqual(["bgra8unorm", "1", "-", "r", "-", "-"]);
    });

    it("cannot alias a base alpha-to-coverage pipeline with a variant whose id is 'a'", () => {
        const baseA2c = _textPipelineKey("bgra8unorm", 4, "depth24plus", true, true, "-");
        const variantA = _textPipelineKey("bgra8unorm", 4, "depth24plus", true, false, "a");
        expect(baseA2c).not.toBe(variantA);
    });

    it("separates base and variant, and one variant id from another", () => {
        const base = _textPipelineKey("bgra8unorm", 1, null, false, false, "-");
        const w = _textPipelineKey("bgra8unorm", 1, null, false, false, "w");
        const other = _textPipelineKey("bgra8unorm", 1, null, false, false, "x");
        expect(new Set([base, w, other]).size).toBe(3);
    });
});

describe("font-weight-offset variant registration", () => {
    it("installs the styling seam and the variant resolver when the setter runs", () => {
        const { data, run } = makeLiveData();
        setFontWeightOffset(data, run, 1);
        expect(_textStyleSeam).not.toBeNull();
        expect(_textVariantResolver).not.toBeNull();
    });

    it("composes and compiles one module pair per device, memoized", () => {
        const { data, run } = makeLiveData();
        setFontWeightOffset(data, run, 1);
        const created: { label: string; code: string }[] = [];
        const device = { createShaderModule: (d: { label: string; code: string }) => (created.push(d), d) } as unknown as GPUDevice;
        const first = _textVariantResolver!(device);
        const second = _textVariantResolver!(device);
        expect(second).toBe(first);
        expect(created.length).toBe(2);
        expect(first._id).toBe(WEIGHT_SHADER_FRAGMENT._id);
        expect(created[1]!.code).toContain("fn wdst(");
        // The compiled variant is composed from the shared template, not a second copy.
        expect(created[1]!.code.split("fn rcode(").length - 1).toBe(1);
    });

    it("carries no copy of the base shader inside the fragment's own WGSL", () => {
        const all = [...Object.values(WEIGHT_SHADER_FRAGMENT._vertexSlots ?? {}), ...Object.values(WEIGHT_SHADER_FRAGMENT._fragmentSlots ?? {})].join("\n");
        // Base-only helpers / structure must never appear in the incremental fragment.
        for (const baseOnly of ["fn rcode(", "fn solveH(", "fn solveV(", "fn bloc(", "@vertex", "@fragment", "struct VOut", "struct FIn"]) {
            expect(all).not.toContain(baseOnly);
        }
    });
});

// ---------------------------------------------------------------------------
// Composition — the base template is the single source of truth and the weight
// feature contributes only incremental WGSL the composer interpolates into it.
// ---------------------------------------------------------------------------

/** Significant (non-blank, non-comment) trimmed lines of a WGSL source. */
function codeLines(src: string): string[] {
    return src
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith("//"));
}

function count(haystack: string, needle: string): number {
    return haystack.split(needle).length - 1;
}

describe("Slug shader composition", () => {
    const base = composeSlugShader(null);
    const variant = composeSlugShader(WEIGHT_SHADER_FRAGMENT);

    it("keys the base variant with an empty id and the composed variant with the fragment id", () => {
        expect(base._key).toBe("");
        expect(variant._key).toBe(WEIGHT_SHADER_FRAGMENT._id);
    });

    it("emits no weight varying, helper or coverage override in the base shader", () => {
        const vert = codeLines(base._vert).join("\n");
        const frag = codeLines(base._frag).join("\n");
        expect(vert).not.toContain("wo");
        expect(vert).not.toContain("sb");
        expect(frag).not.toContain("wo");
        expect(frag).not.toContain("dq(");
        expect(frag).not.toContain("wdst");
        expect(frag).not.toContain("dot2");
        // The base coverage flows straight into the gamma with nothing in between.
        expect(frag.replace(/\s+/g, "")).toContain("cov=clamp(cov,0.0,1.0);cov=pow(cov,tu.col.x);");
    });

    it("leaves both base band loops free of injected per-curve work in either variant", () => {
        // The band loops end with the root-solve block and nothing else — the regression that
        // rode a distance accumulation past the coverage `break` cannot come back through a
        // slot, because there is no slot there in either composed source.
        const squash = (s: string) => codeLines(s).join("").replace(/\s+/g, "");
        for (const src of [base._frag, variant._frag]) {
            const s = squash(src);
            expect(s).toContain("xw=max(xw,cwgt(r.y));}}}");
            expect(s).toContain("yw=max(yw,cwgt(r.y));}}}");
        }
    });

    it("emits every weight contribution in the composed variant", () => {
        expect(variant._vert).toContain("@location(4) @interpolate(flat) wo:f32,");
        expect(variant._vert).toContain("out.wo=wo;");
        expect(variant._vert).toContain("d.wo=0.0;");
        // Shaped bounds replace the glyph's own bounds only in the composed variant.
        expect(variant._vert).toContain("let sb=vec4f(");
        expect(variant._vert).toContain("mix(sb.xy,sb.zw,im)");
        expect(base._vert).toContain("mix(md.b.xy,md.b.zw,im)");

        expect(variant._frag).toContain("@location(4) @interpolate(flat) wo:f32,");
        expect(variant._frag).toContain("fn dq(");
        expect(variant._frag).toContain("fn wdst(");
        expect(variant._frag).toContain("if(in.wo!=0.0){");
        // The distance scan is declared once, as a helper, and called once from the override.
        expect(count(variant._frag, "fn wdst(")).toBe(1);
        expect(count(variant._frag, "wdst(rc,gp,bm,in.bn,")).toBe(1);
    });

    it("reuses the base source rather than duplicating it", () => {
        // Every significant line of the base fragment shader also appears in the composed
        // variant: the variant is the base plus insertions, never a divergent copy.
        const variantFragLines = new Set(codeLines(variant._frag));
        for (const line of codeLines(base._frag)) {
            expect(variantFragLines.has(line)).toBe(true);
        }
        // Same for the vertex stage, except the one line the `VB` slot re-points at the
        // shaped bounds it declares.
        const variantVertLines = new Set(codeLines(variant._vert));
        for (const line of codeLines(base._vert)) {
            if (line.startsWith("let tx=mix(")) {
                continue;
            }
            expect(variantVertLines.has(line)).toBe(true);
        }
        // Base helpers are declared exactly once in each composed source.
        for (const helper of ["fn rcode(", "fn solveH(", "fn solveV(", "fn bloc("]) {
            expect(count(base._frag, helper)).toBe(1);
            expect(count(variant._frag, helper)).toBe(1);
        }
        expect(count(variant._vert, "@vertex")).toBe(1);
        expect(count(variant._frag, "@fragment")).toBe(1);
    });

    it("keeps the alpha-to-coverage override on both variants", () => {
        expect(base._frag).toContain("@id(0) override a2c:bool=false;");
        expect(variant._frag).toContain("@id(0) override a2c:bool=false;");
    });
});

describe("Slug shader source of truth", () => {
    const textDir = resolve(__dirname, "../../../packages/babylon-lite/src/text");

    function walk(dir: string, out: string[] = []): string[] {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
            const p = join(dir, e.name);
            if (e.isDirectory()) {
                walk(p, out);
            } else {
                out.push(p);
            }
        }
        return out;
    }

    it("has no standalone .wgsl shader files left in the text module", () => {
        expect(walk(textDir).filter((f) => f.endsWith(".wgsl"))).toEqual([]);
    });

    it("declares the base Slug logic in exactly one source file", () => {
        const owners = walk(textDir).filter((f) => readFileSync(f, "utf8").includes("fn rcode("));
        expect(owners.map((f) => f.slice(textDir.length + 1).replace(/\\/g, "/"))).toEqual(["shaders/slug-shader.ts"]);
    });
});

describe("font-weight-offset on DefaultTextData", () => {
    const buf = readFileSync(join(process.cwd(), "lab", "public", "fonts", "Inter.ttf"));
    const inter = createFontFromBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);

    it("weights the run immediately after createDefaultTextData", () => {
        // `createDefaultTextData` packs its run synchronously, so this is the case the
        // pre-fix run-only setter could not serve at all.
        const data = createDefaultTextData(inter, 32, "Bold");
        expect(data._groups[0]!._groupKey).toBe(data._curveSetId);

        setFontWeightOffset(data, data.runs[0]!, 10);

        expect(data._groups.length).toBe(1);
        expect(data._groups[0]!._groupKey).not.toBe(data._curveSetId);
        expect(data._groups[0]!._curveSetId).toBe(data._curveSetId);
        expect(instanceWeightOffset(data, 0)).toBe(Math.fround(10));

        setFontWeightOffset(data, 0, 0);
        expect(data._groups[0]!._groupKey).toBe(data._curveSetId);
        expect(instanceWeightOffset(data, 0)).toBe(0);

        disposeDefaultTextData(data);
    });

    it("drops the offset when updateDefaultTextData replaces the run, and re-applies by index", () => {
        const data = createDefaultTextData(inter, 32, "Bold");
        setFontWeightOffset(data, data.runs[0]!, 10);
        const weightedRun = data.runs[0]!;

        updateDefaultTextData(data, "Bolder");

        expect(data.runs[0]).not.toBe(weightedRun);
        expect(data._groups.length).toBe(1);
        expect(data._groups[0]!._groupKey).toBe(data._curveSetId);
        expect(instanceWeightOffset(data, 0)).toBe(0);

        setFontWeightOffset(data, 0, 10);
        expect(data._groups[0]!._groupKey).not.toBe(data._curveSetId);
        expect(instanceWeightOffset(data, 0)).toBe(Math.fround(10));

        disposeDefaultTextData(data);
    });
});
