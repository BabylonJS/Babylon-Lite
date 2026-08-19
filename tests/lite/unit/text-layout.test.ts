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
import { UnicodeBuffer, shape } from "../../../packages/babylon-lite/node_modules/text-shaper/dist/index.js";

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
