/** Default LTR + word-wrap + align layout, backed by text-shaper.
 *
 *  Public surface: `TextLayoutOptions` (the options bag, public) and `layoutText` (the
 *  internal implementation; not exported from `src/index.ts`). Callers driving their own
 *  layout don't import this module and pay zero bytes for it. */

import { GlyphBuffer, UnicodeBuffer, shapeInto } from "text-shaper";
import type { Font } from "./font.js";
import type { PlacedGlyph } from "./text-data.js";

/** Options for the default text layout helper, expressed in output pixels with simple LTR word wrapping. */
export type TextLayoutOptions = {
    /** Max line width in pixels before word-wrap. Default: Infinity. */
    readonly maxWidth?: number;
    /** Line-height multiplier. Default: 1.2. */
    readonly lineHeight?: number;
    /** Horizontal alignment. Default: "left". */
    readonly align?: "left" | "center" | "right";
    /** Extra spacing in font units. Default: 0. */
    readonly letterSpacing?: number;
    /** Tab size in spaces. Default: 4. */
    readonly tabSize?: number;
};

interface LayoutGlyph {
    glyphId: number;
    /** Pixel x at line start (line-relative). */
    x: number;
    /** Line index — used to bake the Y after alignment. */
    line: number;
    xAdvance: number;
    xOffset: number;
    yOffset: number;
}

/** Shaping scratch buffers, reused across every `layoutText` call.
 *
 *  `shape()` pulls from a pool inside text-shaper that is only refilled by `releaseBuffer()`
 *  — which the package does not export — so every `shape()` call allocates a fresh
 *  `GlyphBuffer` whose object pools start empty, then allocates one `GlyphInfo` and one
 *  `GlyphPosition` per codepoint. Because layout shapes one paragraph per call, a block of
 *  N paragraphs pays that N times per frame.
 *
 *  Holding the buffers here and driving `shapeInto` keeps the pools warm across calls, so
 *  after the first block the shaping stage allocates nothing. Retained memory is bounded by
 *  the longest single paragraph ever laid out. `layoutText` is synchronous and never
 *  re-enters, so a single shared pair is safe.
 *
 *  Lazily initialised: a module-level `new` would be an import-time side effect and would
 *  defeat tree-shaking for callers that drive their own layout. */
let scratchInput: UnicodeBuffer | null = null;
let scratchOutput: GlyphBuffer | null = null;

/** @internal Default LTR + word-wrap + align layout. Returns placed glyphs, the layout scale,
 *  and the run's pixel-space bounding size. Caller wraps into a `GlyphRun` with the appropriate `curveSet`. */
export function layoutText(font: Font, text: string, fontSizePx: number, options?: TextLayoutOptions) {
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

    const lines: LayoutGlyph[][] = [];
    const lineWidths: number[] = [];

    const input = (scratchInput ??= new UnicodeBuffer());
    const output = (scratchOutput ??= new GlyphBuffer());

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

        // Read straight off the shaped buffer — the glyphs of this paragraph are fully
        // consumed into `lines` before the next paragraph overwrites `output`.
        const infos = output.infos;
        const positions = output.positions;
        const shapedCount = infos.length;

        let currentLine: LayoutGlyph[] = [];
        let lineCursorX = 0;
        let i = 0;
        while (i < shapedCount) {
            // Eat leading spaces (consume into current line — gets trimmed on wrap).
            // `codepoint` is the pre-shaping character and survives GSUB (substitutions
            // rewrite `glyphId` only), so it stays aligned with the glyph even when
            // shaping is not one glyph per character.
            while (i < shapedCount && infos[i]!.codepoint === 32) {
                const pos = positions[i]!;
                const xAdvance = pos.xAdvance + letterSpacing;
                currentLine.push({
                    glyphId: infos[i]!.glyphId,
                    x: lineCursorX,
                    line: lines.length,
                    xAdvance,
                    xOffset: pos.xOffset,
                    yOffset: pos.yOffset,
                });
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

    const placed: PlacedGlyph[] = [];
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
            placed.push({
                glyphId: g.glyphId,
                x: g.x + alignOffset + g.xOffset * scale,
                // Y up in pixel space: line 0 sits at y=0, subsequent lines go negative.
                // Pairs naturally with em-space y-up glyph bounds so 3D scenes with a
                // Y-up camera render text upright with no extra transform.
                y: lineY + g.yOffset * scale,
            });
        }
    }

    return { glyphs: placed, pixelsPerFontUnit: scale, width: totalWidth, height: totalHeight };
}
