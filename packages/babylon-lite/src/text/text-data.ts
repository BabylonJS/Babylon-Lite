/** TextData — owns the packed glyph atlas (shared across same-curves descriptors) and the
 *  per-instance vertex buffer for a single text block. Mutates in place under streaming. */

import type { GlyphCurves, TextDescriptor } from "./public-types.js";
import type { SharedAtlas, TextData, TextDataInternals } from "./internal.js";
import { getSharedAtlasForCurves, setSharedAtlasForCurves, getTextDataInternals, setTextDataInternals } from "./internal.js";
import { createSharedAtlas, packAppendGlyph } from "./slug-pack.js";

/** Bytes per instance: 4 vec4 attributes (slugBounds, slugAnchor, slugAtlas, slugBand). */
export const TEXT_INSTANCE_FLOATS = 16;
export const TEXT_INSTANCE_BYTES = TEXT_INSTANCE_FLOATS * 4;

function getOrCreateAtlas(descriptor: TextDescriptor): SharedAtlas {
    let atlas = getSharedAtlasForCurves(descriptor.curves);
    if (!atlas) {
        atlas = createSharedAtlas();
        setSharedAtlasForCurves(descriptor.curves, atlas);
    }
    return atlas;
}

/** Append any glyphs referenced by `descriptor.curves` that aren't yet in the atlas. */
function syncAtlasGlyphs(atlas: SharedAtlas, descriptor: TextDescriptor, knownByThisData: Set<number>): void {
    for (const [glyphId, glyph] of descriptor.curves) {
        if (!atlas.glyphSlots.has(glyphId)) {
            atlas.glyphSlots.set(glyphId, packAppendGlyph(atlas, glyph));
        }
        knownByThisData.add(glyphId);
    }
}

/** Resolve a glyph descriptor by id from the descriptor (covers the case where it has no atlas slot — e.g. an absent outline). */
function buildInstances(internals: TextDataInternals, descriptor: TextDescriptor): void {
    const atlas = internals.atlas;
    const glyphs = descriptor.run.glyphs;
    const required = glyphs.length * TEXT_INSTANCE_FLOATS;
    if (internals.instances.length < required) {
        let newLen = Math.max(internals.instances.length * 2, TEXT_INSTANCE_FLOATS);
        while (newLen < required) {
            newLen *= 2;
        }
        internals.instances = new Float32Array(newLen);
    }
    const out = internals.instances;
    let w = 0;
    let count = 0;
    const scale = descriptor.run.pixelsPerFontUnit;
    const invScale = scale !== 0 ? 1 / scale : 0;
    for (const pg of glyphs) {
        const glyph: GlyphCurves | undefined = descriptor.curves.get(pg.glyphId);
        const slot = atlas.glyphSlots.get(pg.glyphId);
        if (!glyph || !slot) {
            continue;
        }
        const { xMin, yMin, xMax, yMax } = glyph.bounds;
        const widthFu = xMax - xMin;
        const heightFu = yMax - yMin;
        const bandScaleX = widthFu > 0 ? slot.vBandCount / widthFu : 0;
        const bandScaleY = heightFu > 0 ? slot.hBandCount / heightFu : 0;
        const bandOffsetX = -xMin * bandScaleX;
        const bandOffsetY = -yMin * bandScaleY;
        // slugBounds (em-space).
        out[w] = xMin;
        out[w + 1] = yMin;
        out[w + 2] = xMax;
        out[w + 3] = yMax;
        // slugAnchor (object-space anchor + invScale + reserved).
        out[w + 4] = pg.x;
        out[w + 5] = pg.y;
        out[w + 6] = invScale;
        out[w + 7] = 0;
        // slugAtlas (glyphLocX, glyphLocY, bandMaxX, bandMaxY).
        out[w + 8] = slot.glyphLocX;
        out[w + 9] = slot.glyphLocY;
        out[w + 10] = slot.bandMaxX;
        out[w + 11] = slot.bandMaxY;
        // slugBand.
        out[w + 12] = bandScaleX;
        out[w + 13] = bandScaleY;
        out[w + 14] = bandOffsetX;
        out[w + 15] = bandOffsetY;
        w += TEXT_INSTANCE_FLOATS;
        count++;
    }
    internals.instanceCount = count;
}

function brandedTextData(width: number, height: number): TextData {
    return { width, height } as unknown as TextData;
}

export function createTextData(descriptor: TextDescriptor): TextData {
    const atlas = getOrCreateAtlas(descriptor);
    const known = new Set<number>();
    syncAtlasGlyphs(atlas, descriptor, known);
    const data = brandedTextData(descriptor.run.width, descriptor.run.height);
    const internals: TextDataInternals = {
        atlas,
        instances: new Float32Array(TEXT_INSTANCE_FLOATS),
        instanceCount: 0,
        lastCurvesSize: descriptor.curves.size,
        lastCurvesRef: descriptor.curves,
        knownGlyphIds: known,
        version: 1,
        _gpu: null,
    };
    buildInstances(internals, descriptor);
    setTextDataInternals(data, internals);
    return data;
}

export function updateTextData(data: TextData, descriptor: TextDescriptor): void {
    const internals = getTextDataInternals(data);
    if (!internals) {
        throw new Error("updateTextData: invalid TextData (was it produced by createTextData?).");
    }
    // Atlas-update fast path: same curves reference + same size → no new glyphs.
    const sameRef = internals.lastCurvesRef === descriptor.curves;
    const grew = !sameRef || descriptor.curves.size !== internals.lastCurvesSize;
    if (grew) {
        const atlas = getOrCreateAtlas(descriptor);
        if (atlas !== internals.atlas) {
            // Switched to a different curves map → switch atlases and re-track known ids.
            internals.atlas = atlas;
            internals.knownGlyphIds = new Set();
        }
        // Append any glyphs not yet in the atlas (and not yet known to this TextData).
        for (const [glyphId, glyph] of descriptor.curves) {
            if (!internals.atlas.glyphSlots.has(glyphId)) {
                internals.atlas.glyphSlots.set(glyphId, packAppendGlyph(internals.atlas, glyph));
            }
            internals.knownGlyphIds.add(glyphId);
        }
        internals.lastCurvesRef = descriptor.curves;
        internals.lastCurvesSize = descriptor.curves.size;
    }
    buildInstances(internals, descriptor);
    internals.version++;
    // Mutate the public branded shape's read-only fields (this is the documented
    // mutation point — TextData is intentionally mutable internally even though
    // the public type marks the fields readonly).
    (data as unknown as { width: number; height: number }).width = descriptor.run.width;
    (data as unknown as { width: number; height: number }).height = descriptor.run.height;
}

export function disposeTextData(data: TextData): void {
    const internals = getTextDataInternals(data);
    if (!internals) {
        return;
    }
    if (internals._gpu) {
        internals._gpu.instanceBuf.destroy();
        internals._gpu = null;
    }
    internals.instanceCount = 0;
    // Note: SharedAtlas is kept — it may still be in use by other TextData blocks.
    // It is naturally reclaimed when the user drops the `curves` Map (WeakMap key).
}

/** @internal Read TextData internals from a renderable. */
export function getTextDataInternalsOrThrow(data: TextData): TextDataInternals {
    const i = getTextDataInternals(data);
    if (!i) {
        throw new Error("Text: TextData has no internals (invalid handle).");
    }
    return i;
}
