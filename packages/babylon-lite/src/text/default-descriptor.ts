/** Default convenience descriptor: shapes text + extracts curves into a fresh map. */

import type { DefaultTextDescriptor, Font } from "./internal.js";
import { setDefaultDescriptorInternals, getDefaultDescriptorInternals } from "./internal.js";
import type { GlyphCurves, GlyphRun, TextLayoutOptions } from "./public-types.js";
import { extractGlyphCurves } from "./curves.js";
import { layoutText } from "./layout.js";

function brandedDescriptor(curves: ReadonlyMap<number, GlyphCurves>, run: GlyphRun): DefaultTextDescriptor {
    const d = { curves, run } as { curves: ReadonlyMap<number, GlyphCurves>; run: GlyphRun };
    return d as DefaultTextDescriptor;
}

/** Shape `text` with the default layout, extract glyph curves, and bundle into a `DefaultTextDescriptor`. */
export function createDefaultTextDescriptor(font: Font, text: string, fontSizePx: number, options?: TextLayoutOptions): DefaultTextDescriptor {
    const run = layoutText(font, text, fontSizePx, options);
    const curves = new Map<number, GlyphCurves>();
    const ids = new Set<number>();
    for (const g of run.glyphs) {
        ids.add(g.glyphId);
    }
    extractGlyphCurves(font, ids, curves);
    const out = brandedDescriptor(curves, run);
    setDefaultDescriptorInternals(out, { font, fontSizePx, options });
    return out;
}

/** Build a new descriptor for an updated text string. Reuses `prior`'s curve map and only grows it. */
export function updateDefaultTextDescriptor(prior: DefaultTextDescriptor, text: string): DefaultTextDescriptor {
    const state = getDefaultDescriptorInternals(prior);
    if (!state) {
        throw new Error("updateDefaultTextDescriptor: invalid descriptor (was it produced by createDefaultTextDescriptor?).");
    }
    const run = layoutText(state.font, text, state.fontSizePx, state.options);
    const curves = prior.curves as Map<number, GlyphCurves>;
    const ids = new Set<number>();
    for (const g of run.glyphs) {
        ids.add(g.glyphId);
    }
    extractGlyphCurves(state.font, ids, curves);
    const out = brandedDescriptor(curves, run);
    setDefaultDescriptorInternals(out, state);
    return out;
}
