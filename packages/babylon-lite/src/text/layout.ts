/** Default LTR + word-wrap + align layout, backed by text-shaper.
 *
 *  Public surface: `TextLayoutOptions` (the options bag, public) and `layoutText` (the
 *  internal implementation; not exported from `src/index.ts`). Callers driving their own
 *  layout don't import this module and pay zero bytes for it. */

import { UnicodeBuffer, shape } from "text-shaper";
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

interface ShapedEntry {
    glyphId: number;
    xAdvance: number;
    xOffset: number;
    yOffset: number;
    isSpace: boolean;
}

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

        const shaped: ShapedEntry[] = [];
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

        let currentLine: LayoutGlyph[] = [];
        let lineCursorX = 0;
        let i = 0;
        while (i < shaped.length) {
            // Eat leading spaces (consume into current line — gets trimmed on wrap).
            while (i < shaped.length && shaped[i]!.isSpace) {
                const s = shaped[i]!;
                const adv = s.xAdvance * scale;
                currentLine.push({
                    glyphId: s.glyphId,
                    x: lineCursorX,
                    line: lines.length,
                    xAdvance: s.xAdvance,
                    xOffset: s.xOffset,
                    yOffset: s.yOffset,
                });
                lineCursorX += adv;
                i++;
            }
            const wordGlyphs: ShapedEntry[] = [];
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
