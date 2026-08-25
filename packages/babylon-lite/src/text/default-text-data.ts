/** Default convenience TextData: shapes text + extracts curves into a fresh GlyphStorage. */

import type { Font } from "./font.js";
import { extractGlyphCurves } from "./glyph-extraction.js";
import type { CurveSetId, GlyphCurves, GlyphStorage } from "./glyph-storage.js";
import { createGlyphStorage, disposeGlyphStorage, updateGlyphStorage } from "./glyph-storage.js";
import type { GlyphRun, PlacedGlyph, TextData } from "./text-data.js";
import { createTextData, disposeTextData, updateTextData } from "./text-data.js";
import type { TextLayoutOptions } from "./layout.js";
import { layoutText } from "./layout.js";
import { getFontFamily } from "text-shaper";

declare const defaultTextDataBrand: unique symbol;

/** Convenience text-data variant that owns its `GlyphStorage` and exposes the laid-out
 *  pixel-space `width` / `height` of the text block. Produced by `createDefaultTextData`. */
export interface DefaultTextData extends TextData {
    readonly [defaultTextDataBrand]: true;
    /** Pixel-space width of the laid-out run (max line width). */
    readonly width: number;
    /** Pixel-space height of the laid-out run (lines × line-height). */
    readonly height: number;
    /** @internal Font used to shape this data. */
    readonly _font: Font;
    /** @internal Font size in pixels used to shape this data. */
    readonly _fontSizePx: number;
    /** @internal Layout options captured at create-time. */
    readonly _options: TextLayoutOptions | undefined;
    /** @internal Curve-set id derived from the font's family name. */
    readonly _curveSetId: CurveSetId;
    /** @internal GlyphStorage owned by this DefaultTextData. Disposed by `disposeDefaultTextData`. */
    readonly _storage: GlyphStorage;
    /** @internal Glyph ids already offered to `_storage`, indexed by glyph id. Sized to the
     *  font's glyph count, and necessarily per-instance because `_storage` is per-instance —
     *  so this costs `numGlyphs` bytes per `DefaultTextData` (~3 KB for a Latin font, ~65 KB
     *  for a full CJK one). */
    readonly _seenGlyphs: Uint8Array;
}

/** Mark every glyph in `glyphs` as seen, returning only the ids not seen before, or `null`
 *  when there are none.
 *
 *  Re-shaped text almost always reuses the repertoire it already had — an 840-cell grid of
 *  changing numbers is ~37 distinct glyphs across 5,466 placements — so the common answer is
 *  "nothing new". Answering that with a typed-array probe per glyph keeps the steady state
 *  allocation free and lets the caller skip extraction and storage update entirely. That
 *  matters more than it looks: `extractGlyphCurves` only early-outs on ids already in the
 *  target map, so passing it a fresh map every call made it re-walk the whole repertoire, and
 *  glyphs with no outline (space) were re-extracted forever because an absent outline is
 *  never cached.
 *
 *  A glyph id at or beyond `seen.length` reads `undefined`, which is not `=== 0`, so it is
 *  treated as already seen and never reaches extraction. That matches the old behaviour
 *  observably: `extractGlyphCurves` asks `extractOne` for such an id, gets `null`, and skips
 *  it without recording anything. */
function collectNewGlyphs(seen: Uint8Array, glyphs: readonly PlacedGlyph[]): Set<number> | null {
    let added: Set<number> | null = null;
    for (const g of glyphs) {
        const id = g.glyphId;
        if (seen[id] === 0) {
            seen[id] = 1;
            (added ??= new Set()).add(id);
        }
    }
    return added;
}

/** Derive the curve-set id from the font's family name (e.g. "Inter", "Roboto"). Falls back
 *  to `"font"` for fonts that lack a usable name table. */
function familyCurveSetId(font: Font): CurveSetId {
    return (font._font.name && getFontFamily(font._font.name)) || "font";
}

/** Shape `text` with the default layout, extract glyph curves, and bundle into a
 *  `DefaultTextData`. `textColor` is applied as the run's defaultColor (per-glyph color
 *  overrides remain available via direct `updateTextData(replaceRun)` calls).
 *
 *  The returned `DefaultTextData` owns its underlying `GlyphStorage` — release both with
 *  `disposeDefaultTextData(data)`. */
export function createDefaultTextData(
    font: Font,
    fontSizePx: number,
    text: string,
    textColor?: readonly [number, number, number, number],
    options?: TextLayoutOptions
): DefaultTextData {
    const laid = layoutText(font, text, fontSizePx, options);
    const innerCurves = new Map<number, GlyphCurves>();
    const seenGlyphs = new Uint8Array(font._font.numGlyphs);
    const ids = collectNewGlyphs(seenGlyphs, laid._glyphs);
    if (ids) {
        extractGlyphCurves(font, ids, innerCurves);
    }
    const curveSetId = familyCurveSetId(font);
    const storage = createGlyphStorage(new Map([[curveSetId, innerCurves]]));
    const run: GlyphRun = {
        curveSet: curveSetId,
        glyphs: laid._glyphs,
        pixelsPerFontUnit: laid._pixelsPerFontUnit,
        defaultColor: textColor,
    };
    return Object.assign(createTextData(storage, [run]), {
        width: laid._width,
        height: laid._height,
        _font: font,
        _fontSizePx: fontSizePx,
        _options: options,
        _curveSetId: curveSetId,
        _storage: storage,
        _seenGlyphs: seenGlyphs,
    }) as DefaultTextData;
}

/** Re-shape `text` and apply the new run via `updateTextData(replaceRun)`. New glyphs are
 *  added to the storage in place. When `textColor` is omitted, the live run's existing
 *  `defaultColor` is preserved (so any caller-driven color override survives a text re-shape). */
export function updateDefaultTextData(data: DefaultTextData, text: string, textColor?: readonly [number, number, number, number]): void {
    const laid = layoutText(data._font, text, data._fontSizePx, data._options);
    // Extract any glyph outlines this data has not offered to the storage before. Text that
    // reuses its existing repertoire — the overwhelmingly common case — does no work here.
    const ids = collectNewGlyphs(data._seenGlyphs, laid._glyphs);
    if (ids) {
        const innerCurves = new Map<number, GlyphCurves>();
        extractGlyphCurves(data._font, ids, innerCurves);
        updateGlyphStorage(data._storage, data._curveSetId, innerCurves);
    }
    // Always use the current `data.runs[0]` as the previous reference; a DefaultTextData
    // owns exactly one run and the caller may have swapped it out via their own ops.
    const previousRun = data.runs[0]!;
    const newRun: GlyphRun = {
        curveSet: data._curveSetId,
        glyphs: laid._glyphs,
        pixelsPerFontUnit: laid._pixelsPerFontUnit,
        defaultColor: textColor ?? previousRun.defaultColor,
    };
    updateTextData(data, { update: "replaceRun", previous: previousRun, run: newRun });
    // Refresh the cached width/height on the branded object.
    Object.assign(data, { width: laid._width, height: laid._height });
}

/** Release the per-block GPU resources AND the underlying `GlyphStorage` owned by `data`. */
export function disposeDefaultTextData(data: DefaultTextData): void {
    disposeTextData(data);
    disposeGlyphStorage(data._storage);
}
