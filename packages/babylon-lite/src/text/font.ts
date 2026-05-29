/** Font loading and glyph-id lookup. Wraps text-shaper behind branded opaque types. */

import { Font as TextShaperFont } from "text-shaper";
import type { Font } from "./internal.js";
import { getFontInternals, setFontInternals } from "./internal.js";

function makeBrandedFont(): Font {
    return Object.create(null) as Font;
}

/** Load a TTF or OTF font from a URL. */
export async function loadFont(url: string): Promise<Font> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error("loadFont: failed to fetch " + url + " (" + response.status + ")");
    }
    const data = await response.arrayBuffer();
    return createFontFromBuffer(data);
}

/** Build a `Font` from an in-memory TTF/OTF buffer. */
export function createFontFromBuffer(data: ArrayBuffer): Font {
    const font = TextShaperFont.load(data);
    const handle = makeBrandedFont();
    setFontInternals(handle, { font });
    return handle;
}

/** @internal Access the underlying text-shaper Font. */
export function getRawFont(handle: Font): TextShaperFont {
    const state = getFontInternals(handle);
    if (!state) {
        throw new Error("Font: invalid handle (was it produced by loadFont/createFontFromBuffer?).");
    }
    return state.font;
}

/** Look up the glyph id for a Unicode code point. */
export function getGlyphId(font: Font, charCode: number): number {
    return getRawFont(font).glyphId(charCode);
}

/** Convenience: map every code point in `text` to its glyph id and return the unique set.
 *  Raw code-point → glyph mapping — does not shape. */
export function getGlyphIds(font: Font, text: string): Set<number> {
    const raw = getRawFont(font);
    const out = new Set<number>();
    for (const ch of text) {
        const cp = ch.codePointAt(0);
        if (cp != null) {
            out.add(raw.glyphId(cp));
        }
    }
    return out;
}
