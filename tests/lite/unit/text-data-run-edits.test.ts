import { describe, expect, it } from "vitest";

import type { GlyphCurves } from "../../../packages/babylon-lite/src/text/glyph-storage";
import type { GlyphRun } from "../../../packages/babylon-lite/src/text/text-data";
import { createTextData, TEXT_INSTANCE_FLOATS, TEXT_STYLE_FLOATS, updateTextData } from "../../../packages/babylon-lite/src/text/text-data";
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

const ANCHOR_X_OFFSET = 0;

/** Read the packed anchor X of instance `i` — a cheap proxy for "this glyph's position was rewritten". */
function instanceAnchorX(data: ReturnType<typeof createTextData>, i: number): number {
    return data._instances[i * TEXT_INSTANCE_FLOATS + ANCHOR_X_OFFSET]!;
}

function makeStorage() {
    const f = new Map<number, GlyphCurves>([
        [1, makeGlyph(1)],
        [2, makeGlyph(2)],
        [3, makeGlyph(3)],
    ]);
    const g = new Map<number, GlyphCurves>([[1, makeGlyph(1)]]);
    return createGlyphStorage(
        new Map([
            ["f", f],
            ["g", g],
        ])
    );
}

function run(curveSet: string, x: number, glyphIds: number[] = [1, 2]): GlyphRun {
    return {
        curveSet,
        glyphs: glyphIds.map((glyphId, i) => ({ glyphId, x: x + i, y: 0 })),
        pixelsPerFontUnit: 1,
    };
}

function styledRun(x: number, withOverride: boolean): GlyphRun {
    return {
        curveSet: "f",
        glyphs: [{ glyphId: 1, x, y: 0 }, withOverride ? { glyphId: 2, x: x + 1, y: 0, color: [0.25, 0.5, 0.75, 1] } : { glyphId: 2, x: x + 1, y: 0 }],
        pixelsPerFontUnit: 1,
    };
}

describe("updateTextData replaceRun", () => {
    it("swaps the new run into the previous run's position when given an object reference", () => {
        const data = createTextData(makeStorage(), [run("f", 0), run("f", 10), run("f", 20)]);
        const prev = data.runs[1]!;
        const next = run("f", 99);

        updateTextData(data, { update: "replaceRun", previous: prev, run: next });

        expect(data.runs.length).toBe(3);
        expect(data.runs[1]).toBe(next);
        expect(data.runs.indexOf(prev)).toBe(-1);
        expect(data._runRecords.has(prev)).toBe(false);
        expect(data._runRecords.has(next)).toBe(true);
        expect(instanceAnchorX(data, 2)).toBe(99);
    });

    it("resolves a numeric `previous` to the same run an object reference would", () => {
        const data = createTextData(makeStorage(), [run("f", 0), run("f", 10), run("f", 20)]);
        const prev = data.runs[1]!;
        const next = run("f", 99);

        updateTextData(data, { update: "replaceRun", previous: 1, run: next });

        expect(data.runs[0]).not.toBe(next);
        expect(data.runs[1]).toBe(next);
        expect(data.runs[2]).not.toBe(next);
        expect(data._runRecords.has(prev)).toBe(false);
        expect(instanceAnchorX(data, 2)).toBe(99);
    });

    it("throws when a numeric `previous` is out of range", () => {
        const data = createTextData(makeStorage(), [run("f", 0)]);
        expect(() => updateTextData(data, { update: "replaceRun", previous: 5, run: run("f", 1) })).toThrow(/out of range/);
    });

    it("accepts the same run reference for `previous` and `run`, re-reading its mutated glyphs", () => {
        const data = createTextData(makeStorage(), [run("f", 0), run("f", 10)]);
        const target = data.runs[1]!;

        // Callers avoiding per-edit allocation mutate the run in place, then hand the same
        // reference back as both `previous` and `run`.
        (target.glyphs[0] as { x: number }).x = 77;
        updateTextData(data, { update: "replaceRun", previous: target, run: target });

        expect(data.runs.length).toBe(2);
        expect(data.runs[1]).toBe(target);
        expect(data._runRecords.size).toBe(2);
        expect(data._runRecords.get(target)!._slots).toEqual([2, 3]);
        expect(instanceAnchorX(data, 2)).toBe(77);
    });

    it("still rejects a new run that is already in the TextData", () => {
        const data = createTextData(makeStorage(), [run("f", 0), run("f", 10)]);
        expect(() => updateTextData(data, { update: "replaceRun", previous: data.runs[0]!, run: data.runs[1]! })).toThrow(/already in this TextData/);
    });

    it("keeps the run's position when the glyph count changes (reslotted in place)", () => {
        const data = createTextData(makeStorage(), [run("f", 0), run("f", 10), run("f", 20)]);
        const prev = data.runs[1]!;
        const next = run("f", 50, [1, 2, 3]);

        updateTextData(data, { update: "replaceRun", previous: prev, run: next });

        expect(data.runs.length).toBe(3);
        expect(data.runs[1]).toBe(next);
        expect(data._runRecords.get(next)!._slots.length).toBe(3);
    });

    // A same-curve-set glyph-count change is now reslotted in place, so these guard the
    // bookkeeping the remove + re-add path used to do for free.
    it.each([
        ["grows", [1, 2, 3]],
        ["shrinks", [1]],
        ["stays the same", [1, 2]],
    ])("keeps every run's glyphs addressable when the middle run %s", (_label, glyphIds) => {
        const data = createTextData(makeStorage(), [run("f", 0), run("f", 10), run("f", 20)]);
        const first = data.runs[0]!;
        const last = data.runs[2]!;
        const next = run("f", 50, glyphIds);

        updateTextData(data, { update: "replaceRun", previous: data.runs[1]!, run: next });

        expect(data.runs).toEqual([first, next, last]);
        const group = data._groups[0]!;
        // Every run's slots must be live, in range, and disjoint from every other run's.
        const seen = new Set<number>();
        for (const r of data.runs) {
            const slots = data._runRecords.get(r)!._slots;
            expect(slots.length).toBe(r.glyphs.length);
            for (const s of slots) {
                expect(s).toBeGreaterThanOrEqual(group._slotStart);
                expect(s).toBeLessThan(group._slotStart + group._slotCount);
                expect(seen.has(s)).toBe(false);
                expect(group._freeSlots.includes(s)).toBe(false);
                seen.add(s);
            }
        }
        expect(group._liveCount).toBe(seen.size);
        expect(seen.size).toBe(2 + glyphIds.length + 2);
        // Anchor X is written per glyph, so it proves each run's slots hold *its* glyphs.
        for (const r of data.runs) {
            const slots = data._runRecords.get(r)!._slots;
            slots.forEach((s, i) => expect(instanceAnchorX(data, s)).toBe(r.glyphs[i]!.x));
        }
    });

    // Instances are drawn in slot order, so a run's glyphs have to land on ascending slots or
    // overlapping glyphs composite in the wrong order. Reclaiming a resized run's slots through
    // the group free list hands them back LIFO, which is what this guards against.
    it.each([
        ["grows", [1, 2, 3]],
        ["shrinks", [1]],
    ])("keeps a run's glyphs in ascending slot order when it %s", (_label, glyphIds) => {
        const data = createTextData(makeStorage(), [run("f", 0), run("f", 10), run("f", 20)]);
        const next = run("f", 50, glyphIds);

        updateTextData(data, { update: "replaceRun", previous: data.runs[1]!, run: next });

        const slots = data._runRecords.get(next)!._slots;
        expect(slots).toEqual([...slots].sort((a, b) => a - b));
    });

    it("keeps every run's glyphs in ascending slot order across repeated resizes", () => {
        const data = createTextData(makeStorage(), [run("f", 0), run("f", 10), run("f", 20)]);
        for (let i = 0; i < 40; i++) {
            const len = 1 + (i % 3);
            updateTextData(data, { update: "replaceRun", previous: data.runs[i % 3]!, run: run("f", i, [1, 2, 3].slice(0, len)) });
            for (const r of data.runs) {
                const slots = data._runRecords.get(r)!._slots;
                expect(slots).toEqual([...slots].sort((a, b) => a - b));
            }
        }
    });

    it("reuses styles across alternating non-tail replacements", () => {
        let first = styledRun(0, false);
        let second = styledRun(10, false);
        const data = createTextData(makeStorage(), [first, second, run("f", 20, [3])]);

        for (let i = 0; i < 101; i++) {
            const replaceFirst = i % 2 === 0;
            const withOverride = Math.floor(i / 2) % 2 === 0;
            const replacement = styledRun(replaceFirst ? 0 : 10, withOverride);
            updateTextData(data, { update: "replaceRun", previous: replaceFirst ? first : second, run: replacement });
            if (replaceFirst) {
                first = replacement;
            } else {
                second = replacement;
            }
            expect(data._styleCount).toBeLessThanOrEqual(5);
            // Bounding the high-water mark only proves slots are recycled; it says nothing about
            // whether a recycled slot was rewritten. Follow the second glyph's packed index into
            // the palette so a stale entry surfaces as a wrong colour rather than passing silently.
            const record = data._runRecords.get(replacement)!;
            const styleIndex = data._instancesU32[record._slots[1]! * TEXT_INSTANCE_FLOATS + 2]! >>> 16;
            expect(Array.from(data._styles.subarray(styleIndex * TEXT_STYLE_FLOATS, styleIndex * TEXT_STYLE_FLOATS + 4))).toEqual(
                withOverride ? [0.25, 0.5, 0.75, 1] : [1, 1, 1, 1]
            );
        }
    });

    it("reuses individual style entries at the packed-index limit", () => {
        const first = styledRun(0, false);
        const last: GlyphRun = { ...run("f", 10, [3]), defaultColor: [0.125, 0.25, 0.5, 1] };
        const data = createTextData(makeStorage(), [first, last]);
        data._styleCount = 0xffff;
        data._freeStyleSlots.push(10);

        const replacement = styledRun(0, true);
        updateTextData(data, { update: "replaceRun", previous: first, run: replacement });

        expect(data._styleCount).toBe(0xffff);
        const survivingRecord = data._runRecords.get(last)!;
        const survivingStyle = data._instancesU32[survivingRecord._slots[0]! * TEXT_INSTANCE_FLOATS + 2]! >>> 16;
        expect(survivingStyle).toBe(1);
        expect(Array.from(data._styles.subarray(survivingStyle * TEXT_STYLE_FLOATS, survivingStyle * TEXT_STYLE_FLOATS + 4))).toEqual([0.125, 0.25, 0.5, 1]);
        const replacementRecord = data._runRecords.get(replacement)!;
        expect(replacementRecord._styleSlots).toEqual([0, 10]);
        const overrideStyle = data._instancesU32[replacementRecord._slots[1]! * TEXT_INSTANCE_FLOATS + 2]! >>> 16;
        expect(overrideStyle).toBe(10);
        expect(Array.from(data._styles.subarray(overrideStyle * TEXT_STYLE_FLOATS, overrideStyle * TEXT_STYLE_FLOATS + 4))).toEqual([0.25, 0.5, 0.75, 1]);
    });

    // The free list is shared by every path that allocates, so an added run reuses a removed
    // run's slots through the same LIFO pop that reverses a resize.
    it("keeps an added run's glyphs in ascending slot order when it reuses freed slots", () => {
        const data = createTextData(makeStorage(), [run("f", 0), run("f", 10), run("f", 20)]);
        // Frees slots 2 and 3 onto the group's free list, in that order.
        updateTextData(data, { update: "removeRun", run: 1 });
        const added = run("f", 50);

        updateTextData(data, { update: "addRun", run: added });

        expect(data._runRecords.get(added)!._slots).toEqual([2, 3]);
    });

    it("routes an empty replacement through the remove path so its slots are reclaimed", () => {
        const data = createTextData(makeStorage(), [run("f", 0), run("g", 10, [1])]);
        const empty: GlyphRun = { curveSet: "g", glyphs: [], pixelsPerFontUnit: 1 };

        updateTextData(data, { update: "replaceRun", previous: data.runs[1]!, run: empty });

        expect(data.runs[1]).toBe(empty);
        expect(data._runRecords.get(empty)!._slots).toEqual([]);
        // The group is retired and immediately re-created empty by the add half, so the buffer
        // tail is compacted back to just the "f" run's two glyphs.
        expect(data._groups.map((g) => g._curveSetId)).toEqual(["f", "g"]);
        expect(data._groups[1]!._slotCount).toBe(0);
        expect(data._instanceCount).toBe(2);
    });

    it("survives repeated grow/shrink cycles without leaking or double-booking slots", () => {
        const data = createTextData(makeStorage(), [run("f", 0), run("f", 10), run("f", 20)]);
        for (let i = 0; i < 40; i++) {
            const len = 1 + (i % 3);
            updateTextData(data, { update: "replaceRun", previous: data.runs[i % 3]!, run: run("f", i, [1, 2, 3].slice(0, len)) });
        }
        const group = data._groups[0]!;
        const live = new Set<number>();
        for (const r of data.runs) {
            for (const s of data._runRecords.get(r)!._slots) {
                expect(live.has(s)).toBe(false);
                live.add(s);
            }
        }
        expect(group._liveCount).toBe(live.size);
        // Free list and live set must partition the group's slot range exactly — no slot lost,
        // none handed out twice.
        expect(new Set(group._freeSlots).size).toBe(group._freeSlots.length);
        expect(live.size + group._freeSlots.length).toBe(group._slotCount);
        for (const s of group._freeSlots) {
            expect(live.has(s)).toBe(false);
        }
    });

    it("keeps the run's position when the curve set changes (different draw group)", () => {
        const data = createTextData(makeStorage(), [run("f", 0), run("f", 10), run("f", 20)]);
        const next = run("g", 50, [1]);

        updateTextData(data, { update: "replaceRun", previous: 1, run: next });

        expect(data.runs.length).toBe(3);
        expect(data.runs[1]).toBe(next);
        expect(data._groups.length).toBe(2);
        expect(data._groups[data._runRecords.get(next)!._groupIdx]!._curveSetId).toBe("g");
    });
});

describe("updateTextData removeRun", () => {
    it("removes the run identified by a numeric index", () => {
        const data = createTextData(makeStorage(), [run("f", 0), run("f", 10), run("f", 20)]);
        const first = data.runs[0]!;
        const target = data.runs[1]!;
        const last = data.runs[2]!;

        updateTextData(data, { update: "removeRun", run: 1 });

        expect(data.runs).toEqual([first, last]);
        expect(data._runRecords.has(target)).toBe(false);
    });

    it("removes the run identified by an object reference", () => {
        const data = createTextData(makeStorage(), [run("f", 0), run("f", 10), run("f", 20)]);
        const first = data.runs[0]!;
        const target = data.runs[1]!;
        const last = data.runs[2]!;

        updateTextData(data, { update: "removeRun", run: target });

        expect(data.runs).toEqual([first, last]);
        expect(data._runRecords.has(target)).toBe(false);
    });

    it("reuses style entries across repeated add/remove cycles", () => {
        const base = run("f", 10, [3]);
        const data = createTextData(makeStorage(), [base]);

        for (let i = 0; i < 100; i++) {
            const added = styledRun(0, true);
            updateTextData(data, { update: "addRun", run: added, insertBefore: 0 });
            updateTextData(data, { update: "removeRun", run: added });
            expect(data._styleCount).toBeLessThanOrEqual(3);
        }
    });
});

/** A run whose palette entry is entirely zero — `[0, 0, 0, 0]` with `invScale` 0, since a
 *  `pixelsPerFontUnit` of 0 maps to 0. Writing it into a never-used slot changes nothing, so
 *  `writeStyle` stays silent and any `_styleVersion` movement must come from the allocator. */
function zeroStyleRun(x: number): GlyphRun {
    return { curveSet: "f", glyphs: [{ glyphId: 1, x, y: 0 }], pixelsPerFontUnit: 0, defaultColor: [0, 0, 0, 0] };
}

// `ensureStyleGpu` skips the palette upload entirely while `_styleVersion` is unchanged, and
// uploads exactly `_styleCount` entries when it moves. Both halves of that contract need pinning:
// a version that moves too eagerly costs a redundant upload every edit, and one that moves too
// rarely leaves the GPU holding a short or stale palette. Neither shows up in a content
// assertion, so only these tests stand between the two failure modes.
describe("TextData _styleVersion", () => {
    it("does not move when an edit is satisfied entirely from recycled slots", () => {
        const data = createTextData(makeStorage(), [run("f", 0), run("f", 10)]);
        updateTextData(data, { update: "removeRun", run: 1 });
        const before = data._styleVersion;
        const highWater = data._styleCount;

        // Same curve set, same default colour and `pixelsPerFontUnit` as the run just removed, so
        // the recycled entry is rewritten with the bytes it already holds.
        updateTextData(data, { update: "addRun", run: run("f", 20) });

        expect(data._styleCount).toBe(highWater);
        expect(data._styleVersion).toBe(before);
    });

    it("moves when an allocation grows the palette past its high-water mark", () => {
        const data = createTextData(makeStorage(), [run("f", 0)]);
        const before = data._styleVersion;
        const highWater = data._styleCount;

        updateTextData(data, { update: "addRun", run: zeroStyleRun(10) });

        // `writeStyle` is a no-op here, so a version that has not moved means the lengthened
        // palette would never reach the GPU.
        expect(data._styleCount).toBeGreaterThan(highWater);
        expect(data._styleVersion).toBeGreaterThan(before);
    });

    it("moves when a reset shrinks the palette", () => {
        const data = createTextData(makeStorage(), [run("f", 0), styledRun(10, true), styledRun(20, true)]);
        const highWater = data._styleCount;
        const before = data._styleVersion;

        // The surviving run reproduces entry 0 exactly, so `writeStyle` stays silent and the
        // shorter upload length is the only thing left to report.
        updateTextData(data, { update: "reset", runs: [run("f", 5)] });

        expect(data._styleCount).toBeLessThan(highWater);
        expect(data._styleVersion).toBeGreaterThan(before);
    });
});

/** Glyph id absent from every curve set in `makeStorage()`, so it can never be packed. */
const MISSING = 99;
const DEAD_GLYPH_OFFSET = 2;

function isDead(data: ReturnType<typeof createTextData>, slot: number): boolean {
    return data._instancesU32[slot * TEXT_INSTANCE_FLOATS + DEAD_GLYPH_OFFSET] === 0xffffffff;
}

describe("glyphs that miss the atlas", () => {
    // `writeRunToSlots` returns the caller's `slots` array untouched when every glyph lands, and
    // only materializes a trimmed copy on the first miss — seeded with the prefix that did land.
    // Misses at the first/last/every position exercise the boundaries of that prefix.
    it.each([
        ["the first glyph", [MISSING, 1, 2], [1, 2]],
        ["a middle glyph", [1, MISSING, 2], [0, 2]],
        ["the last glyph", [1, 2, MISSING], [0, 1]],
        ["every glyph", [MISSING, MISSING], []],
    ])("drops only %s", (_label, glyphIds, expectedLiveSlots) => {
        const r = run("f", 0, glyphIds);
        const data = createTextData(makeStorage(), [r]);
        const group = data._groups[0]!;

        expect(data._runRecords.get(r)!._slots).toEqual(expectedLiveSlots);
        expect(group._liveCount).toBe(expectedLiveSlots.length);
        for (let slot = 0; slot < glyphIds.length; slot++) {
            expect(isDead(data, slot)).toBe(!expectedLiveSlots.includes(slot));
            expect(group._freeSlots.includes(slot)).toBe(!expectedLiveSlots.includes(slot));
        }
    });

    it("shrinks the live slot list in place when an edit makes a glyph unpackable", () => {
        const r = run("f", 0, [1, 2, 3]);
        const data = createTextData(makeStorage(), [r]);
        const group = data._groups[0]!;
        const recBefore = data._runRecords.get(r)!;
        expect(recBefore._slots).toEqual([0, 1, 2]);

        (r.glyphs[1] as { glyphId: number }).glyphId = MISSING;
        updateTextData(data, { update: "replaceRun", previous: r, run: r });

        // Same-reference replace reuses the existing record rather than rehashing a new one.
        expect(data._runRecords.get(r)).toBe(recBefore);
        expect(recBefore._slots).toEqual([0, 2]);
        expect(group._liveCount).toBe(2);
        expect(isDead(data, 1)).toBe(true);
    });

    it("reclaims the slot once the glyph becomes packable again", () => {
        const r = run("f", 0, [1, 2, 3]);
        const data = createTextData(makeStorage(), [r]);
        (r.glyphs[1] as { glyphId: number }).glyphId = MISSING;
        updateTextData(data, { update: "replaceRun", previous: r, run: r });

        (r.glyphs[1] as { glyphId: number }).glyphId = 2;
        updateTextData(data, { update: "replaceRun", previous: r, run: r });

        expect(data._runRecords.get(r)!._slots).toHaveLength(3);
        expect(data._groups[0]!._liveCount).toBe(3);
        expect(data.runs).toEqual([r]);
    });
});
