import { describe, expect, it } from "vitest";

import type { GlyphCurves } from "../../../packages/babylon-lite/src/text/glyph-storage";
import type { GlyphRun } from "../../../packages/babylon-lite/src/text/text-data";
import { createTextData, TEXT_INSTANCE_FLOATS, updateTextData } from "../../../packages/babylon-lite/src/text/text-data";
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

const ANCHOR_X_OFFSET = 4;

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
        expect(data._runRecords.get(target)!.slots).toEqual([2, 3]);
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
        expect(data._runRecords.get(next)!.slots.length).toBe(3);
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
            const slots = data._runRecords.get(r)!.slots;
            expect(slots.length).toBe(r.glyphs.length);
            for (const s of slots) {
                expect(s).toBeGreaterThanOrEqual(group.slotStart);
                expect(s).toBeLessThan(group.slotStart + group.slotCount);
                expect(seen.has(s)).toBe(false);
                expect(group.freeSlots.includes(s)).toBe(false);
                seen.add(s);
            }
        }
        expect(group.liveCount).toBe(seen.size);
        expect(seen.size).toBe(2 + glyphIds.length + 2);
        // Anchor X is written per glyph, so it proves each run's slots hold *its* glyphs.
        for (const r of data.runs) {
            const slots = data._runRecords.get(r)!.slots;
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

        const slots = data._runRecords.get(next)!.slots;
        expect(slots).toEqual([...slots].sort((a, b) => a - b));
    });

    it("keeps every run's glyphs in ascending slot order across repeated resizes", () => {
        const data = createTextData(makeStorage(), [run("f", 0), run("f", 10), run("f", 20)]);
        for (let i = 0; i < 40; i++) {
            const len = 1 + (i % 3);
            updateTextData(data, { update: "replaceRun", previous: data.runs[i % 3]!, run: run("f", i, [1, 2, 3].slice(0, len)) });
            for (const r of data.runs) {
                const slots = data._runRecords.get(r)!.slots;
                expect(slots).toEqual([...slots].sort((a, b) => a - b));
            }
        }
    });

    // The free list is shared by every path that allocates, so an added run reuses a removed
    // run's slots through the same LIFO pop that reverses a resize.
    it("keeps an added run's glyphs in ascending slot order when it reuses freed slots", () => {
        const data = createTextData(makeStorage(), [run("f", 0), run("f", 10), run("f", 20)]);
        // Frees slots 2 and 3 onto the group's free list, in that order.
        updateTextData(data, { update: "removeRun", run: 1 });
        const added = run("f", 50);

        updateTextData(data, { update: "addRun", run: added });

        expect(data._runRecords.get(added)!.slots).toEqual([2, 3]);
    });

    it("routes an empty replacement through the remove path so its slots are reclaimed", () => {
        const data = createTextData(makeStorage(), [run("f", 0), run("g", 10, [1])]);
        const empty: GlyphRun = { curveSet: "g", glyphs: [], pixelsPerFontUnit: 1 };

        updateTextData(data, { update: "replaceRun", previous: data.runs[1]!, run: empty });

        expect(data.runs[1]).toBe(empty);
        expect(data._runRecords.get(empty)!.slots).toEqual([]);
        // The group is retired and immediately re-created empty by the add half, so the buffer
        // tail is compacted back to just the "f" run's two glyphs.
        expect(data._groups.map((g) => g.curveSetId)).toEqual(["f", "g"]);
        expect(data._groups[1]!.slotCount).toBe(0);
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
            for (const s of data._runRecords.get(r)!.slots) {
                expect(live.has(s)).toBe(false);
                live.add(s);
            }
        }
        expect(group.liveCount).toBe(live.size);
        // Free list and live set must partition the group's slot range exactly — no slot lost,
        // none handed out twice.
        expect(new Set(group.freeSlots).size).toBe(group.freeSlots.length);
        expect(live.size + group.freeSlots.length).toBe(group.slotCount);
        for (const s of group.freeSlots) {
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
        expect(data._groups[data._runRecords.get(next)!.groupIdx]!.curveSetId).toBe("g");
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
});

/** Glyph id absent from every curve set in `makeStorage()`, so it can never be packed. */
const MISSING = 99;
const DEAD_FLAG_OFFSET = 7;

function isDead(data: ReturnType<typeof createTextData>, slot: number): boolean {
    return data._instances[slot * TEXT_INSTANCE_FLOATS + DEAD_FLAG_OFFSET] === 1;
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

        expect(data._runRecords.get(r)!.slots).toEqual(expectedLiveSlots);
        expect(group.liveCount).toBe(expectedLiveSlots.length);
        for (let slot = 0; slot < glyphIds.length; slot++) {
            expect(isDead(data, slot)).toBe(!expectedLiveSlots.includes(slot));
            expect(group.freeSlots.includes(slot)).toBe(!expectedLiveSlots.includes(slot));
        }
    });

    it("shrinks the live slot list in place when an edit makes a glyph unpackable", () => {
        const r = run("f", 0, [1, 2, 3]);
        const data = createTextData(makeStorage(), [r]);
        const group = data._groups[0]!;
        const recBefore = data._runRecords.get(r)!;
        expect(recBefore.slots).toEqual([0, 1, 2]);

        (r.glyphs[1] as { glyphId: number }).glyphId = MISSING;
        updateTextData(data, { update: "replaceRun", previous: r, run: r });

        // Same-reference replace reuses the existing record rather than rehashing a new one.
        expect(data._runRecords.get(r)).toBe(recBefore);
        expect(recBefore.slots).toEqual([0, 2]);
        expect(group.liveCount).toBe(2);
        expect(isDead(data, 1)).toBe(true);
    });

    it("reclaims the slot once the glyph becomes packable again", () => {
        const r = run("f", 0, [1, 2, 3]);
        const data = createTextData(makeStorage(), [r]);
        (r.glyphs[1] as { glyphId: number }).glyphId = MISSING;
        updateTextData(data, { update: "replaceRun", previous: r, run: r });

        (r.glyphs[1] as { glyphId: number }).glyphId = 2;
        updateTextData(data, { update: "replaceRun", previous: r, run: r });

        expect(data._runRecords.get(r)!.slots).toHaveLength(3);
        expect(data._groups[0]!.liveCount).toBe(3);
        expect(data.runs).toEqual([r]);
    });
});
