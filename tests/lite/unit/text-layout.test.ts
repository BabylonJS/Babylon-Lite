/** Guards the shaping-buffer-reuse optimization in `layoutText`.
 *
 *  `layoutText` used to call `shape()` once per paragraph. `shape()` is literally
 *  `shapeInto()` plus a `_glyphBufferPool.pop()` that always misses — nothing in the
 *  package ever calls `releaseBuffer()`, and it isn't even exported — so every paragraph
 *  allocated a fresh `GlyphBuffer` with cold object pools, then one `GlyphInfo` plus one
 *  `GlyphPosition` per codepoint. Layout now drives `shapeInto` with module-scoped scratch
 *  buffers whose pools stay warm across calls.
 *
 *  That is a pure allocation change, so the bar is exact output equality against a verbatim
 *  copy of the previous implementation (`layoutTextReference` below) rather than a golden
 *  snapshot — a snapshot would only re-encode whatever the new code happens to do.
 *
 *  The one deliberate behavioural change is `isSpace`, which the old code derived by
 *  incrementing a character index once per *glyph*. That desyncs the moment shaping is not
 *  one glyph per character, so it is asserted separately. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// text-shaper is a dependency of `packages/babylon-lite`, not of the workspace root, so
// under pnpm's strict layout a bare specifier does not resolve from `tests/`. Point at the
// package entry directly — `dist/index.d.ts` sits beside it, so `tsc` resolves it too.
import { GlyphBuffer, UnicodeBuffer, shape, shapeInto } from "../../../packages/babylon-lite/node_modules/text-shaper/dist/index.js";

import type { Font } from "../../../packages/babylon-lite/src/text/font";
import { createFontFromBuffer } from "../../../packages/babylon-lite/src/text/font";
import type { TextLayoutOptions } from "../../../packages/babylon-lite/src/text/layout";
import { layoutText } from "../../../packages/babylon-lite/src/text/layout";

function loadTestFont(fileName: string): Font {
    const bytes = readFileSync(join(__dirname, "../../../lab/public/fonts", fileName));
    // Copy into a standalone ArrayBuffer — Node pools small Buffers into a shared one.
    return createFontFromBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
}

const inter = loadTestFont("Inter.ttf");
const roboto = loadTestFont("Roboto-Regular.ttf");

// ---------------------------------------------------------------------------------------
// Verbatim copy of the pre-optimization implementation. Do not "clean up" — its value is
// that it is byte-for-byte the algorithm that shipped, including the `charIdx` bug.
// ---------------------------------------------------------------------------------------

interface RefShapedEntry {
    glyphId: number;
    xAdvance: number;
    xOffset: number;
    yOffset: number;
    isSpace: boolean;
}

interface RefLayoutGlyph {
    glyphId: number;
    x: number;
    line: number;
    xAdvance: number;
    xOffset: number;
    yOffset: number;
}

function layoutTextReference(font: Font, text: string, fontSizePx: number, options?: TextLayoutOptions) {
    const rawFont = font._font;
    const maxWidth = options?.maxWidth ?? Infinity;
    const lineHeightMult = options?.lineHeight ?? 1.2;
    const textAlign = options?.align ?? "left";
    const letterSpacing = options?.letterSpacing ?? 0;
    const tabSize = options?.tabSize ?? 4;

    const scale = rawFont.scaleForSize(fontSizePx);
    const lineHeightPx = fontSizePx * lineHeightMult;
    const spaceGid = rawFont.glyphId(32);

    const collapsed = text.replace(/\t/g, " ".repeat(tabSize)).replace(/ +/g, " ");
    const paragraphs = collapsed.split("\n");

    const lines: RefLayoutGlyph[][] = [];
    const lineWidths: number[] = [];

    for (const para of paragraphs) {
        const trimmed = para.trim();
        if (trimmed.length === 0) {
            lines.push([]);
            lineWidths.push(0);
            continue;
        }

        const buf = new UnicodeBuffer();
        buf.addStr(trimmed);
        const glyphBuffer = shape(rawFont, buf);

        const shaped: RefShapedEntry[] = [];
        let charIdx = 0;
        for (const { info, position } of glyphBuffer) {
            const isSpace = charIdx < trimmed.length && trimmed.charCodeAt(charIdx) === 32;
            shaped.push({
                glyphId: info.glyphId,
                xAdvance: position.xAdvance + letterSpacing,
                xOffset: position.xOffset,
                yOffset: position.yOffset,
                isSpace,
            });
            charIdx++;
        }

        let currentLine: RefLayoutGlyph[] = [];
        let lineCursorX = 0;
        let i = 0;
        while (i < shaped.length) {
            while (i < shaped.length && shaped[i]!.isSpace) {
                const s = shaped[i]!;
                const adv = s.xAdvance * scale;
                currentLine.push({ glyphId: s.glyphId, x: lineCursorX, line: lines.length, xAdvance: s.xAdvance, xOffset: s.xOffset, yOffset: s.yOffset });
                lineCursorX += adv;
                i++;
            }
            const wordGlyphs: RefShapedEntry[] = [];
            let wordWidth = 0;
            while (i < shaped.length && !shaped[i]!.isSpace) {
                const s = shaped[i]!;
                wordGlyphs.push(s);
                wordWidth += s.xAdvance * scale;
                i++;
            }
            if (lineCursorX + wordWidth > maxWidth && currentLine.length > 0) {
                while (currentLine.length > 0 && currentLine[currentLine.length - 1]!.glyphId === spaceGid) {
                    currentLine.pop();
                }
                const last = currentLine[currentLine.length - 1];
                const lw = last ? last.x + last.xAdvance * scale : 0;
                lines.push(currentLine);
                lineWidths.push(lw);
                currentLine = [];
                lineCursorX = 0;
            }
            for (const g of wordGlyphs) {
                currentLine.push({ glyphId: g.glyphId, x: lineCursorX, line: lines.length, xAdvance: g.xAdvance, xOffset: g.xOffset, yOffset: g.yOffset });
                lineCursorX += g.xAdvance * scale;
            }
        }
        if (currentLine.length > 0) {
            lines.push(currentLine);
            lineWidths.push(lineCursorX);
        }
    }

    let totalWidth = 0;
    for (const w of lineWidths) {
        if (w > totalWidth) {
            totalWidth = w;
        }
    }
    const totalHeight = lines.length * lineHeightPx;

    const placed: { glyphId: number; x: number; y: number }[] = [];
    for (let li = 0; li < lines.length; li++) {
        const line = lines[li]!;
        const lw = lineWidths[li]!;
        let alignOffset = 0;
        if (textAlign === "center") {
            alignOffset = (totalWidth - lw) * 0.5;
        } else if (textAlign === "right") {
            alignOffset = totalWidth - lw;
        }
        const lineY = -li * lineHeightPx;
        for (const g of line) {
            placed.push({ glyphId: g.glyphId, x: g.x + alignOffset + g.xOffset * scale, y: lineY + g.yOffset * scale });
        }
    }

    return { glyphs: placed, pixelsPerFontUnit: scale, width: totalWidth, height: totalHeight };
}

// ---------------------------------------------------------------------------------------

/** True when shaping `text` is one glyph per UTF-16 code unit for every paragraph, i.e. the
 *  old `charIdx`-per-glyph counter stayed aligned and both implementations must agree. */
function shapesOneGlyphPerCodeUnit(font: Font, text: string, tabSize = 4): boolean {
    const collapsed = text.replace(/\t/g, " ".repeat(tabSize)).replace(/ +/g, " ");
    for (const para of collapsed.split("\n")) {
        const trimmed = para.trim();
        if (trimmed.length === 0) {
            continue;
        }
        const buf = new UnicodeBuffer();
        buf.addStr(trimmed);
        if (shape(font._font, buf).length !== trimmed.length) {
            return false;
        }
    }
    return true;
}

const GRID_TEXT = Array.from({ length: 28 }, (_, r) => Array.from({ length: 30 }, (_, c) => `R${r}C${c}`).join(" ")).join("\n");

const CORPUS: { name: string; text: string }[] = [
    { name: "empty", text: "" },
    { name: "single glyph", text: "A" },
    { name: "plain word", text: "hello" },
    { name: "ligature candidates", text: "office ffi flag fjord" },
    { name: "kerning pairs", text: "AVATAR To Wa Ye P." },
    { name: "mixed sentence", text: "The quick brown fox jumps over the lazy dog." },
    { name: "leading and trailing spaces", text: "   padded   " },
    { name: "collapsed space runs", text: "a     b          c" },
    { name: "tabs", text: "col\tvalue\tunit" },
    { name: "empty paragraphs", text: "first\n\n\nlast" },
    { name: "whitespace-only paragraph", text: "first\n   \nlast" },
    { name: "trailing newline", text: "line\n" },
    { name: "leading newline", text: "\nline" },
    { name: "only newlines", text: "\n\n" },
    { name: "digits and punctuation", text: "1,234.56 (78%) [9] {0} -1e-9" },
    { name: "cjk", text: "\u4f60\u597d\u4e16\u754c \u65e5\u672c\u8a9e" },
    { name: "accented latin", text: "na\u00efve caf\u00e9 \u00fcber Stra\u00dfe" },
    { name: "astral plane", text: "a\u{1f600}b\u{1f4a9}c" },
    { name: "long unbreakable word", text: "supercalifragilisticexpialidocious" },
    { name: "grid", text: GRID_TEXT },
];

const OPTION_SETS: { name: string; options?: TextLayoutOptions }[] = [
    { name: "defaults", options: undefined },
    { name: "no wrap", options: { maxWidth: Infinity } },
    { name: "wrap 40 left", options: { maxWidth: 40, align: "left" } },
    { name: "wrap 40 center", options: { maxWidth: 40, align: "center" } },
    { name: "wrap 40 right", options: { maxWidth: 40, align: "right" } },
    { name: "wrap 120 center", options: { maxWidth: 120, align: "center" } },
    { name: "wrap 7 tight", options: { maxWidth: 7 } },
    { name: "wrap 0", options: { maxWidth: 0 } },
    { name: "letterSpacing 25", options: { letterSpacing: 25 } },
    { name: "letterSpacing -15 wrap 60", options: { letterSpacing: -15, maxWidth: 60 } },
    { name: "tabSize 1", options: { tabSize: 1 } },
    { name: "tabSize 8 wrap 100", options: { tabSize: 8, maxWidth: 100 } },
    { name: "lineHeight 2", options: { lineHeight: 2 } },
];

describe("layoutText shaping-buffer reuse", () => {
    for (const font of [
        { name: "Inter", font: inter },
        { name: "Roboto", font: roboto },
    ]) {
        for (const entry of CORPUS) {
            for (const opt of OPTION_SETS) {
                const wraps = (opt.options?.maxWidth ?? Infinity) !== Infinity;
                const aligned = shapesOneGlyphPerCodeUnit(font.font, entry.text, opt.options?.tabSize);

                // `isSpace` only feeds the wrap decision and trailing-space trim, so when
                // nothing wraps the old bug provably cannot reach the output.
                const mustMatch = !wraps || aligned;

                it(`${mustMatch ? "matches" : "is compared against"} the previous implementation — ${font.name} / ${entry.name} / ${opt.name}`, () => {
                    const actual = layoutText(font.font, entry.text, 16, opt.options);
                    const expected = layoutTextReference(font.font, entry.text, 16, opt.options);

                    // Geometry-independent invariants hold in every case, including the ones
                    // where the `isSpace` fix legitimately moves a wrap point.
                    expect(actual.pixelsPerFontUnit).toBe(expected.pixelsPerFontUnit);
                    expect(actual.glyphs.map((g) => g.glyphId)).toEqual(expected.glyphs.map((g) => g.glyphId));

                    if (mustMatch) {
                        expect(actual.glyphs).toEqual(expected.glyphs);
                        expect(actual.width).toBe(expected.width);
                        expect(actual.height).toBe(expected.height);
                    }
                });
            }
        }
    }
});

describe("layoutText scratch-buffer isolation", () => {
    it("is unaffected by the text laid out before it", () => {
        const solo = layoutText(inter, "office ffi", 16, { maxWidth: 40 });

        layoutText(inter, GRID_TEXT, 16);
        layoutText(inter, "\u4f60\u597d\u4e16\u754c", 32, { letterSpacing: 40 });
        layoutText(inter, "", 16);
        const after = layoutText(inter, "office ffi", 16, { maxWidth: 40 });

        expect(after).toEqual(solo);
    });

    it("keeps two fonts independent when interleaved", () => {
        const interSolo = layoutText(inter, "AVATAR Wa", 16, { maxWidth: 30 });
        const robotoSolo = layoutText(roboto, "AVATAR Wa", 16, { maxWidth: 30 });

        for (let i = 0; i < 3; i++) {
            expect(layoutText(inter, "AVATAR Wa", 16, { maxWidth: 30 })).toEqual(interSolo);
            expect(layoutText(roboto, "AVATAR Wa", 16, { maxWidth: 30 })).toEqual(robotoSolo);
        }

        // Guards against the reuse accidentally making the two fonts converge.
        expect(robotoSolo).not.toEqual(interSolo);
    });

    it("does not retain glyphs from a longer preceding layout", () => {
        layoutText(inter, GRID_TEXT, 16);
        const short = layoutText(inter, "ab", 16);
        expect(short.glyphs).toHaveLength(2);
    });
});

// ---------------------------------------------------------------------------------------
// Chunked batched shaping (1B).
//
// `layoutText` now shapes up to BATCH_PARAGRAPHS paragraphs per `shapeInto` call, separated
// by "\n" so shaping cannot run across a paragraph, and slices the result back apart by
// cluster range. The bar is exact equality against a verbatim copy of the committed
// per-paragraph implementation it replaces (`layoutTextPerParagraph`) — batching is a pure
// call-count optimization and must not move a single glyph.
// ---------------------------------------------------------------------------------------

/** Verbatim copy of the per-paragraph implementation that batching replaces (one `shapeInto`
 *  per paragraph). Do not "clean up" — its value is that it is the algorithm that shipped. */
function layoutTextPerParagraph(font: Font, text: string, fontSizePx: number, options?: TextLayoutOptions) {
    const rawFont = font._font;
    const maxWidth = options?.maxWidth ?? Infinity;
    const lineHeightMult = options?.lineHeight ?? 1.2;
    const textAlign = options?.align ?? "left";
    const letterSpacing = options?.letterSpacing ?? 0;
    const tabSize = options?.tabSize ?? 4;

    const scale = rawFont.scaleForSize(fontSizePx);
    const lineHeightPx = fontSizePx * lineHeightMult;
    const spaceGid = rawFont.glyphId(32);

    const collapsed = text.replace(/\t/g, " ".repeat(tabSize)).replace(/ +/g, " ");
    const paragraphs = collapsed.split("\n");

    const lines: RefLayoutGlyph[][] = [];
    const lineWidths: number[] = [];

    const input = new UnicodeBuffer();
    const output = new GlyphBuffer();

    for (const para of paragraphs) {
        const trimmed = para.trim();
        if (trimmed.length === 0) {
            lines.push([]);
            lineWidths.push(0);
            continue;
        }

        input.clear();
        input.addStr(trimmed);
        shapeInto(rawFont, input, output);

        const infos = output.infos;
        const positions = output.positions;
        const shapedCount = infos.length;

        let currentLine: RefLayoutGlyph[] = [];
        let lineCursorX = 0;
        let i = 0;
        while (i < shapedCount) {
            while (i < shapedCount && infos[i]!.codepoint === 32) {
                const pos = positions[i]!;
                const xAdvance = pos.xAdvance + letterSpacing;
                currentLine.push({ glyphId: infos[i]!.glyphId, x: lineCursorX, line: lines.length, xAdvance, xOffset: pos.xOffset, yOffset: pos.yOffset });
                lineCursorX += xAdvance * scale;
                i++;
            }
            const wordStart = i;
            let wordWidth = 0;
            while (i < shapedCount && infos[i]!.codepoint !== 32) {
                wordWidth += (positions[i]!.xAdvance + letterSpacing) * scale;
                i++;
            }
            const wordEnd = i;
            if (lineCursorX + wordWidth > maxWidth && currentLine.length > 0) {
                while (currentLine.length > 0 && currentLine[currentLine.length - 1]!.glyphId === spaceGid) {
                    currentLine.pop();
                }
                const last = currentLine[currentLine.length - 1];
                const lw = last ? last.x + last.xAdvance * scale : 0;
                lines.push(currentLine);
                lineWidths.push(lw);
                currentLine = [];
                lineCursorX = 0;
            }
            for (let w = wordStart; w < wordEnd; w++) {
                const pos = positions[w]!;
                const xAdvance = pos.xAdvance + letterSpacing;
                currentLine.push({ glyphId: infos[w]!.glyphId, x: lineCursorX, line: lines.length, xAdvance, xOffset: pos.xOffset, yOffset: pos.yOffset });
                lineCursorX += xAdvance * scale;
            }
        }
        if (currentLine.length > 0) {
            lines.push(currentLine);
            lineWidths.push(lineCursorX);
        }
    }

    let totalWidth = 0;
    for (const w of lineWidths) {
        if (w > totalWidth) {
            totalWidth = w;
        }
    }
    const totalHeight = lines.length * lineHeightPx;

    const placed: { glyphId: number; x: number; y: number }[] = [];
    for (let li = 0; li < lines.length; li++) {
        const line = lines[li]!;
        const lw = lineWidths[li]!;
        let alignOffset = 0;
        if (textAlign === "center") {
            alignOffset = (totalWidth - lw) * 0.5;
        } else if (textAlign === "right") {
            alignOffset = totalWidth - lw;
        }
        const lineY = -li * lineHeightPx;
        for (const g of line) {
            placed.push({ glyphId: g.glyphId, x: g.x + alignOffset + g.xOffset * scale, y: lineY + g.yOffset * scale });
        }
    }

    return { glyphs: placed, pixelsPerFontUnit: scale, width: totalWidth, height: totalHeight };
}

/** Mirrors the batching guard in `layout.ts`, so a test can state which path it exercises. */
function isBatched(text: string, tabSize = 4): boolean {
    const collapsed = text.replace(/\t/g, " ".repeat(tabSize)).replace(/ +/g, " ");
    if (collapsed.split("\n").length < 8) {
        return false;
    }
    for (let i = 0; i < collapsed.length; i++) {
        if (collapsed.charCodeAt(i) >= 0x0590) {
            return false;
        }
    }
    return true;
}

function paragraphs(count: number, make: (i: number) => string): string {
    return Array.from({ length: count }, (_, i) => make(i)).join("\n");
}

/** Per-glyph advances straight off the shaper, for asserting what shaping does and does not
 *  do across a paragraph separator. */
function shapedAdvances(text: string): number[] {
    const buf = new UnicodeBuffer();
    buf.addStr(text, 0);
    const out = new GlyphBuffer();
    shapeInto(inter._font, buf, out);
    return out.positions.slice(0, out.infos.length).map((p) => p.xAdvance);
}

const BATCH_OPTIONS: { name: string; options?: TextLayoutOptions }[] = [
    { name: "defaults", options: undefined },
    { name: "wrap 40 left", options: { maxWidth: 40, align: "left" } },
    { name: "wrap 40 center", options: { maxWidth: 40, align: "center" } },
    { name: "wrap 7 right letterSpacing 25", options: { maxWidth: 7, align: "right", letterSpacing: 25 } },
];

describe("layoutText chunked batched shaping", () => {
    // BATCH_PARAGRAPHS is 32, so these straddle the chunk boundary from both sides and land
    // on exact multiples — the arithmetic that decides where a chunk restarts.
    const COUNTS = [1, 7, 8, 9, 31, 32, 33, 63, 64, 65, 96, 97];

    for (const count of COUNTS) {
        const text = paragraphs(count, (i) => `R${i} office ffi AVATAR To Wa ${i * 7}`);
        it(`matches per-paragraph shaping at ${count} paragraph(s) (batched: ${isBatched(text)})`, () => {
            for (const opt of BATCH_OPTIONS) {
                expect(layoutText(inter, text, 16, opt.options)).toEqual(layoutTextPerParagraph(inter, text, 16, opt.options));
            }
        });
    }

    it("shapes the 840-cell grid identically to per-paragraph", () => {
        const grid = paragraphs(840, (i) => `R${Math.floor(i / 30)}C${i % 30} ${(i * 37.11).toFixed(2)}`);
        expect(isBatched(grid)).toBe(true);
        for (const font of [inter, roboto]) {
            expect(layoutText(font, grid, 10)).toEqual(layoutTextPerParagraph(font, grid, 10));
        }
    });

    it("does not let shaping bleed across a paragraph boundary", () => {
        // Each adjacent pair kerns when the characters are adjacent in one buffer, so if the
        // separator failed to interrupt shaping these advances would change.
        const text = ["A", "V", "T", "o", "W", "a", "Y", "e", "P", ".", "F", ","].join("\n");
        expect(isBatched(text)).toBe(true);
        expect(layoutText(inter, text, 16)).toEqual(layoutTextPerParagraph(inter, text, 16));

        // Positive control, so the assertion above is not vacuous: "AV" in one buffer kerns
        // (1273) while "A" alone does not (1413), and a "\n" between them restores the
        // unkerned advance. That is precisely the property batching depends on.
        const joined = shapedAdvances("AV");
        const separate = [...shapedAdvances("A"), ...shapedAdvances("V")];
        expect(joined).not.toEqual(separate);
        const acrossSeparator = shapedAdvances("A\nV");
        expect([acrossSeparator[0], acrossSeparator[2]]).toEqual(separate);
    });

    it("keeps empty and whitespace-only paragraphs in a batched block", () => {
        const text = ["first", "", "  ", "second", "", "", "third", "   ", "fourth", "", "fifth", ""].join("\n");
        expect(isBatched(text)).toBe(true);
        const actual = layoutText(inter, text, 16);
        expect(actual).toEqual(layoutTextPerParagraph(inter, text, 16));
        // Blank paragraphs must still occupy a line, or every following line shifts up.
        expect(actual.height).toBe(12 * 16 * 1.2);
    });

    it("handles a paragraph longer than the codepoint cap", () => {
        // Forces a chunk to close early on the 4,096-codepoint soft cap.
        const text = paragraphs(12, (i) => (i === 3 ? "x".repeat(5000) : `row ${i}`));
        expect(layoutText(inter, text, 16)).toEqual(layoutTextPerParagraph(inter, text, 16));
    });

    it("keeps mixed simple scripts in one chunk independent", () => {
        // All below 0x0590, so these batch together. Script *selection* is buffer-global in
        // text-shaper, so this pins that mixing Latin/Greek/Cyrillic in a chunk changes nothing.
        const text = [
            "Latin text",
            "\u0395\u03bb\u03bb\u03b7\u03bd\u03b9\u03ba\u03ac",
            "\u0420\u0443\u0441\u0441\u043a\u0438\u0439",
            "\u0540\u0561\u0575\u0565\u0580\u0565\u0576",
            "more latin",
            "\u03a3\u03c6\u03af\u03b3\u03be",
            "\u0414\u0430",
            "mixed \u03b1\u03b2 \u0430\u0431",
            "last",
        ].join("\n");
        expect(isBatched(text)).toBe(true);
        expect(layoutText(inter, text, 16)).toEqual(layoutTextPerParagraph(inter, text, 16));
    });

    for (const rtl of [
        { name: "Hebrew", text: paragraphs(12, (i) => `\u05e9\u05dc\u05d5\u05dd ${i}`) },
        { name: "Arabic", text: paragraphs(12, (i) => `\u0645\u0631\u062d\u0628\u0627 ${i}`) },
        { name: "Latin with one Hebrew paragraph", text: paragraphs(12, (i) => (i === 5 ? "\u05e9\u05dc\u05d5\u05dd" : `row ${i}`)) },
    ]) {
        it(`falls back to per-paragraph shaping for ${rtl.name}`, () => {
            // The guard must reject these: shapeInto picks complex shaping from the head of the
            // buffer and reverses the whole buffer for RTL, both of which are buffer-global.
            expect(isBatched(rtl.text)).toBe(false);
            expect(layoutText(inter, rtl.text, 16)).toEqual(layoutTextPerParagraph(inter, rtl.text, 16));
        });
    }

    it("falls back to per-paragraph shaping for astral-plane text", () => {
        // Surrogate code units (0xD800-0xDFFF) sit above the guard's limit, so any text
        // outside the BMP — emoji included — takes the per-paragraph path. That is
        // deliberately conservative: astral sequences carry their own shaping rules (ZWJ
        // sequences, variation selectors, regional-indicator pairs) and falling back is
        // always correct, only slower.
        const text = paragraphs(12, (i) => (i % 2 === 0 ? `a\u{1f600}b ${i}` : `plain ${i}`));
        expect(isBatched(text)).toBe(false);
        expect(layoutText(inter, text, 16)).toEqual(layoutTextPerParagraph(inter, text, 16));
    });
});

describe("text-shaper cluster contract relied on by batching", () => {
    it("restarts clusters at the startCluster argument on every addStr", () => {
        // This is why batching must pass `input.length` explicitly. If a refactor ever drops
        // that argument on the assumption that the buffer keeps counting, this fails loudly
        // instead of silently producing overlapping paragraph ranges.
        const naive = new UnicodeBuffer();
        naive.addStr("ab");
        naive.addStr("\n");
        naive.addStr("cd");
        expect(Array.from(naive.clusters)).toEqual([0, 1, 0, 0, 1]);

        const explicit = new UnicodeBuffer();
        explicit.addStr("ab", explicit.length);
        explicit.addStr("\n", explicit.length);
        explicit.addStr("cd", explicit.length);
        expect(Array.from(explicit.clusters)).toEqual([0, 1, 2, 3, 4]);
    });

    it("counts codepoints, not UTF-16 code units, so surrogate pairs need no special casing", () => {
        const buf = new UnicodeBuffer();
        buf.addStr("a\u{1f600}b", buf.length); // 4 UTF-16 units, 3 codepoints
        expect(buf.length).toBe(3);
        buf.addStr("\n", buf.length);
        buf.addStr("z", buf.length);
        expect(Array.from(buf.clusters)).toEqual([0, 1, 2, 3, 4]);
    });

    it("shapes an empty buffer to zero glyphs", () => {
        // Batching relies on this: an all-blank chunk yields no glyphs, so every paragraph's
        // range is empty and each pushes a blank line without any special case.
        const buf = new UnicodeBuffer();
        const out = new GlyphBuffer();
        shapeInto(inter._font, buf, out);
        expect(out.infos).toHaveLength(0);
    });
});

describe("layoutText isSpace derivation", () => {
    /** The bug: the old code advanced a character index once per glyph, so a single N-to-1
     *  substitution shifted every later space test by one character for the rest of the
     *  paragraph. `GlyphInfo.codepoint` carries the pre-shaping character and GSUB rewrites
     *  only `glyphId`, so testing it is both exact and free. */
    it("classifies spaces correctly after a ligature substitution", () => {
        const text = "office ab cd";
        const collapsed = text.trim();
        const buf = new UnicodeBuffer();
        buf.addStr(collapsed);
        const shaped = shape(inter._font, buf);

        // Only meaningful if this font actually contracts "ffi" — otherwise there is no desync.
        if (shaped.length === collapsed.length) {
            return;
        }

        const newIsSpace: boolean[] = [];
        const oldIsSpace: boolean[] = [];
        for (let i = 0; i < shaped.length; i++) {
            newIsSpace.push(shaped.infos[i]!.codepoint === 32);
            oldIsSpace.push(i < collapsed.length && collapsed.charCodeAt(i) === 32);
        }

        // Ground truth: a glyph is a space iff the character it came from is a space.
        const truth = shaped.infos.map((info) => collapsed.charCodeAt(info.cluster) === 32);

        expect(newIsSpace).toEqual(truth);
        expect(oldIsSpace).not.toEqual(truth);
    });

    it("wraps a ligature-bearing line at the real word boundaries", () => {
        // Wide enough for one short word per line, so every wrap point is observable.
        const result = layoutText(inter, "office ab cd", 16, { maxWidth: 40 });
        const reference = layoutTextReference(inter, "office ab cd", 16, { maxWidth: 40 });

        // Same glyphs either way — only where the lines break can differ.
        expect(result.glyphs.map((g) => g.glyphId)).toEqual(reference.glyphs.map((g) => g.glyphId));

        // Every line must start at a word boundary: the first glyph of each line is never a space.
        const spaceGid = inter._font.glyphId(32);
        const lineStarts = new Map<number, number>();
        for (const g of result.glyphs) {
            if (!lineStarts.has(g.y)) {
                lineStarts.set(g.y, g.glyphId);
            }
        }
        for (const gid of lineStarts.values()) {
            expect(gid).not.toBe(spaceGid);
        }
    });
});
