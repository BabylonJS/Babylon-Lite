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
 *  the largest chunk ever shaped (see `BATCH_CODEPOINTS`). `layoutText` is synchronous and
 *  never re-enters, so a single shared set is safe.
 *
 *  Lazily initialised: a module-level `new` would be an import-time side effect and would
 *  defeat tree-shaking for callers that drive their own layout. */
let scratchInput: UnicodeBuffer | null = null;
let scratchOutput: GlyphBuffer | null = null;
/** Per-chunk paragraph end clusters; see the batching notes in `layoutText`. */
let scratchEnds: Int32Array | null = null;

/** Paragraphs shaped per `shapeInto` call once batching is enabled.
 *
 *  `shapeInto` carries a fixed per-call cost (buffer reset, codepoint init, script detection,
 *  GSUB/GPOS driver setup) that is independent of the text length, so shaping one paragraph at
 *  a time makes a block of N paragraphs pay it N times. Batching amortises it, but the benefit
 *  saturates quickly: measured against an 840-paragraph grid, going from 840 calls to ~26 (this
 *  chunk size) recovers essentially the whole win, while halving the call count again lands
 *  inside run-to-run noise. Chunking rather than shaping the whole block keeps the window that
 *  any cross-paragraph shaping effect could reach small and bounds retained scratch memory. */
const BATCH_PARAGRAPHS = 32;

/** Soft codepoint cap per chunk, so the retained scratch buffers stay bounded when paragraphs
 *  are long. Checked before appending, so a chunk may overshoot by its final paragraph. */
const BATCH_CODEPOINTS = 4096;

/** Batching is limited to text whose code units all fall below this.
 *
 *  Below it lie Latin, Greek, Cyrillic, Armenian, punctuation and symbols — all simple LTR.
 *  At and above it begin Hebrew, Arabic, the Indic blocks and the other complex scripts, whose
 *  shaping is decided for the buffer as a whole: `shapeInto` samples only the head of the
 *  buffer to select complex shaping, and reverses the entire buffer for RTL. Batching those
 *  would let one paragraph decide its neighbours' treatment, so they keep one shape call per
 *  paragraph.
 *
 *  The test is on UTF-16 code units, so surrogates (0xD800-0xDFFF) also fall outside and any
 *  text beyond the BMP takes the per-paragraph path too. That is intended — astral sequences
 *  carry their own shaping rules — and falling back is always correct, only slower. */
const SIMPLE_SCRIPT_LIMIT = 0x0590;

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
    const ends = (scratchEnds ??= new Int32Array(BATCH_PARAGRAPHS));

    const paraCount = paragraphs.length;
    let batchSize = 1;
    if (paraCount >= 8) {
        batchSize = BATCH_PARAGRAPHS;
        for (let i = 0; i < collapsed.length; i++) {
            if (collapsed.charCodeAt(i) >= SIMPLE_SCRIPT_LIMIT) {
                batchSize = 1;
                break;
            }
        }
    }

    for (let base = 0; base < paraCount;) {
        // Fill one chunk, separating paragraphs with "\n" so shaping cannot run across them.
        // `addStr` restarts its cluster counter at the `startCluster` argument on every call, so
        // pass the running codepoint count to keep clusters chunk-global. Deriving the range
        // from the buffer's own counter means no offset arithmetic against `text`/`collapsed`
        // (which the collapse and per-paragraph trim have already shifted) and no surrogate-pair
        // handling — `length` counts codepoints, exactly what a cluster indexes.
        input.clear();
        let count = 0;
        while (base + count < paraCount && count < batchSize && (count === 0 || input.length < BATCH_CODEPOINTS)) {
            if (count > 0) {
                input.addStr("\n", input.length);
            }
            input.addStr(paragraphs[base + count]!.trim(), input.length);
            ends[count] = input.length;
            count++;
        }
        shapeInto(rawFont, input, output);

        // Read straight off the shaped buffer — the glyphs of this chunk are fully consumed into
        // `lines` before the next chunk overwrites `output`.
        const infos = output.infos;
        const positions = output.positions;
        const shapedCount = infos.length;

        let gi = 0;
        for (let k = 0; k < count; k++) {
            // A paragraph starts one cluster past its predecessor's end (that gap is the
            // separator) and runs to its own end. Clusters are non-decreasing here — the guard
            // above excludes the RTL scripts that would reverse the buffer — so one forward walk
            // partitions the chunk, and separator glyphs land in no paragraph's range.
            const clusterEnd = ends[k]!;
            const clusterStart = k === 0 ? 0 : ends[k - 1]! + 1;
            while (gi < shapedCount && infos[gi]!.cluster < clusterStart) {
                gi++;
            }
            const paraStart = gi;
            while (gi < shapedCount && infos[gi]!.cluster < clusterEnd) {
                gi++;
            }
            const paraEnd = gi;
            if (paraStart === paraEnd) {
                lines.push([]);
                lineWidths.push(0);
                continue;
            }

            let currentLine: LayoutGlyph[] = [];
            let lineCursorX = 0;
            let i = paraStart;
            while (i < paraEnd) {
                // Eat leading spaces (consume into current line — gets trimmed on wrap).
                // `codepoint` is the pre-shaping character and survives GSUB (substitutions
                // rewrite `glyphId` only), so it stays aligned with the glyph even when
                // shaping is not one glyph per character.
                while (i < paraEnd && infos[i]!.codepoint === 32) {
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
                while (i < paraEnd && infos[i]!.codepoint !== 32) {
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
        base += count;
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
