/** Guards the glyph-repertoire tracking in `createDefaultTextData` / `updateDefaultTextData`.
 *
 *  Both used to rebuild a `Set` of every placed glyph id on every call — 5,466 hash inserts
 *  on an 840-cell grid to discover a repertoire of ~37 — and then hand that set to
 *  `extractGlyphCurves` against a *fresh* `Map`. Because the map was always empty, the
 *  "already extracted" early-out never fired: the curve cache was re-walked and
 *  `updateGlyphStorage` was re-run with the full repertoire every frame, discarding all of it.
 *  Glyphs with no outline were worse still — an absent outline is never cached, so they were
 *  re-extracted forever.
 *
 *  That is now a persistent `Uint8Array` probe per glyph, and extraction/storage update are
 *  skipped entirely when nothing is new. The risk that buys is a *stale* bitmap: a glyph
 *  marked seen but never actually given an atlas slot renders as garbage, silently.
 *
 *  So the bar here is the invariant, not the implementation: after any sequence of updates,
 *  every glyph placed in the live run must have a slot in the atlas. `expectedRepertoire`
 *  independently recomputes what the old always-extract path would have produced, so the two
 *  are cross-checked rather than the new code being compared against itself. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { Font } from "../../../packages/babylon-lite/src/text/font";
import { createFontFromBuffer } from "../../../packages/babylon-lite/src/text/font";
import type { DefaultTextData } from "../../../packages/babylon-lite/src/text/default-text-data";
import { createDefaultTextData, disposeDefaultTextData, updateDefaultTextData } from "../../../packages/babylon-lite/src/text/default-text-data";
import { extractGlyphCurves } from "../../../packages/babylon-lite/src/text/glyph-extraction";
import type { GlyphCurves } from "../../../packages/babylon-lite/src/text/glyph-storage";

function loadFont(file: string): Font {
    const buf = readFileSync(join(process.cwd(), "lab", "public", "fonts", file));
    return createFontFromBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
}

const inter = loadFont("Inter.ttf");

/** Glyph ids currently placed by the live run. */
function placedIds(data: DefaultTextData): number[] {
    return [...new Set(data.runs[0]!.glyphs.map((g) => g.glyphId))].sort((a, b) => a - b);
}

/** Ids that have an atlas slot, i.e. are actually renderable. */
function slottedIds(data: DefaultTextData): Set<number> {
    return new Set(data._storage._curveSets.get(data._curveSetId)!._atlas._glyphSlots.keys());
}

/** Independently compute which of `ids` carry an outline, the way the old always-extract
 *  path discovered it: hand the whole set to `extractGlyphCurves` against an empty map. */
function outlinedIds(font: Font, ids: Iterable<number>): Set<number> {
    const curves = new Map<number, GlyphCurves>();
    extractGlyphCurves(font, new Set(ids), curves);
    return new Set(curves.keys());
}

/** The invariant: every placed glyph that has an outline is renderable, and nothing without
 *  an outline was invented. Returns the placed ids so callers can assert on them too. */
function expectRenderable(data: DefaultTextData): number[] {
    const placed = placedIds(data);
    const slotted = slottedIds(data);
    const expected = outlinedIds(data._font, placed);
    for (const id of expected) {
        expect(slotted.has(id), `glyph ${id} is placed and has an outline but has no atlas slot`).toBe(true);
    }
    for (const id of slotted) {
        expect(outlinedIds(data._font, [id]).has(id), `glyph ${id} has a slot but no outline`).toBe(true);
    }
    return placed;
}

describe("default text data glyph repertoire", () => {
    it("gives every outlined glyph a slot at create time", () => {
        const data = createDefaultTextData(inter, 16, "The quick brown fox");
        expect(expectRenderable(data).length).toBeGreaterThan(10);
        disposeDefaultTextData(data);
    });

    it("extracts glyphs that appear for the first time in a later update", () => {
        // Each step introduces characters absent from every previous step. A bitmap that
        // over-reports "seen" would leave these unslotted.
        const steps = ["aaa", "aaa bbb", "aaa bbb 12345", "AAA BBB", "?!@#$%", "\u00e9\u00e8\u00ea\u00eb", "\u0416\u0414\u041b", "\u03b1\u03b2\u03b3"];
        const data = createDefaultTextData(inter, 16, steps[0]!);
        expectRenderable(data);

        const seenSoFar = new Set(placedIds(data));
        for (const step of steps.slice(1)) {
            updateDefaultTextData(data, step);
            const placed = expectRenderable(data);
            // The atlas is cumulative: earlier repertoire must survive later updates.
            const slotted = slottedIds(data);
            for (const id of outlinedIds(inter, seenSoFar)) {
                expect(slotted.has(id), `glyph ${id} lost its slot after updating to "${step}"`).toBe(true);
            }
            for (const id of placed) {
                seenSoFar.add(id);
            }
        }
        disposeDefaultTextData(data);
    });

    it("keeps the atlas stable when the repertoire repeats with different text", () => {
        // The benchmark's shape: content changes every frame, repertoire does not.
        const data = createDefaultTextData(inter, 10, "0123456789");
        const before = slottedIds(data);
        for (let i = 0; i < 20; i++) {
            updateDefaultTextData(data, `${i}${(i * 37) % 10}${(i * 91) % 10}`);
        }
        const after = slottedIds(data);
        expect([...after].sort((a, b) => a - b)).toEqual([...before].sort((a, b) => a - b));
        expectRenderable(data);
        disposeDefaultTextData(data);
    });

    it("does not invent slots for glyphs that have no outline", () => {
        // Space is the common case: it is placed every frame and has no outline. The old path
        // re-ran extraction on it forever because an absent outline is never cached.
        const data = createDefaultTextData(inter, 16, "a b c");
        const slotted = slottedIds(data);
        for (const g of data.runs[0]!.glyphs) {
            if (!outlinedIds(inter, [g.glyphId]).has(g.glyphId)) {
                expect(slotted.has(g.glyphId), `outline-less glyph ${g.glyphId} should not occupy a slot`).toBe(false);
            }
        }
        updateDefaultTextData(data, "a b c");
        expect([...slottedIds(data)]).toEqual([...slotted]);
        disposeDefaultTextData(data);
    });

    it("tracks repertoire per DefaultTextData, not per font", () => {
        // Two datas share `inter` but own separate storages; one seeing a glyph must not
        // convince the other that its own storage already has it.
        const a = createDefaultTextData(inter, 16, "xyz");
        const b = createDefaultTextData(inter, 16, "xyz");
        updateDefaultTextData(a, "xyz QWERTY");
        expectRenderable(a);
        updateDefaultTextData(b, "xyz QWERTY");
        expectRenderable(b);
        expect([...slottedIds(b)].sort((x, y) => x - y)).toEqual([...slottedIds(a)].sort((x, y) => x - y));
        disposeDefaultTextData(a);
        disposeDefaultTextData(b);
    });

    it("still refreshes width/height and preserves the run color across updates", () => {
        const color: readonly [number, number, number, number] = [0.25, 0.5, 0.75, 1];
        const data = createDefaultTextData(inter, 16, "short", color);
        const narrow = data.width;
        updateDefaultTextData(data, "a considerably longer line of text");
        expect(data.width).toBeGreaterThan(narrow);
        expect(data.height).toBeGreaterThan(0);
        expect(data.runs[0]!.defaultColor).toEqual(color);
        disposeDefaultTextData(data);
    });

    it("survives an 840-cell grid of changing content", () => {
        const cell = (r: number, c: number, f: number) =>
            c % 3 === 0 ? `${((r * 30 + c + f) * 37.11).toFixed(2)}` : c % 3 === 1 ? `Item-${r * 30 + c + f}` : `Q${(r % 4) + 1} FY${20 + ((r + f) % 6)}`;
        const grid = (f: number) => {
            const cells: string[] = [];
            for (let r = 0; r < 28; r++) {
                for (let c = 0; c < 30; c++) {
                    cells.push(cell(r, c, f));
                }
            }
            return cells.join("\n");
        };
        const data = createDefaultTextData(inter, 10, grid(0));
        const first = slottedIds(data);
        for (let f = 1; f < 6; f++) {
            updateDefaultTextData(data, grid(f));
        }
        expectRenderable(data);
        // Digits/letters/punctuation are all present from frame 0, so nothing should be added.
        expect([...slottedIds(data)].sort((a, b) => a - b)).toEqual([...first].sort((a, b) => a - b));
        disposeDefaultTextData(data);
    });
});
