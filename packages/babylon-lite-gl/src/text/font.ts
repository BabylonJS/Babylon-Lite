/** GLFont loading. Wraps text-shaper behind a branded opaque type.
 *
 *  A `GLFont` is the boundary between Babylon Lite and the text-shaper library. It is
 *  consumed by the default-layout pipeline (`layoutText` in `layout.ts`) and by the
 *  default-curve-extraction pipeline (`extractGlyphCurves` in `glyph-extraction.ts`).
 *  Callers driving their own text layout and outline extraction never need a `GLFont`. */

import { Font as TextShaperFont } from "text-shaper";
import type { GLGlyphCurves } from "./glyph-storage.js";

declare const fontBrand: unique symbol;

/** Opaque handle for a loaded TrueType/OpenType font used by the default text layout and glyph extraction helpers. */
export interface GLFont {
    readonly [fontBrand]: true;
    /** @internal Underlying text-shaper font handle. */
    readonly _font: TextShaperFont;
    /** @internal Lazily-allocated per-font glyph-curves cache. */
    _curvesCache: Map<number, GLGlyphCurves> | null;
}

/** Load a TTF or OTF font from a URL. */
export async function loadFont(url: string): Promise<GLFont> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`loadFont: failed to fetch ${url} (${response.status})`);
    }
    const data = await response.arrayBuffer();
    return createFontFromBuffer(data);
}

/** Build a `GLFont` from an in-memory TTF/OTF buffer. */
export function createFontFromBuffer(data: ArrayBuffer): GLFont {
    return {
        _font: TextShaperFont.load(data),
        _curvesCache: null,
    } as unknown as GLFont;
}
