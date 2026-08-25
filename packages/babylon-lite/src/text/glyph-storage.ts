/** Glyph storage: per-curve-set CPU outline catalog plus the GPU atlas packed from it.
 *
 *  Layered:
 *    - `GlyphStorage` is the opaque public handle. Holds one or more curve-sets keyed by
 *      `CurveSetId` (typically a font family name). Each curve-set owns its glyph
 *      outlines plus the `SharedAtlas` packed from them.
 *    - `SharedAtlas` is the CPU staging: two `rgba32float`-shaped `Float32Array`s holding
 *      quadratic curve control points and per-band curve-index lists, both append-only.
 *    - Atlas packing (`packAppendGlyph`) and spatial-band partitioning (`buildGlyphBands`)
 *      live here as internal helpers — they implement the storage's invariants and are
 *      not callable from outside the module.
 *    - GPU creation/upload (`SharedAtlasGpu`, `ensureSharedAtlasGpu`) lives in
 *      `_gpu/text-textures.ts`; the shared types are exported from here. GPU teardown
 *      is performed inline in `disposeGlyphStorage` to avoid a circular import edge.
 *
 *  Lifetime is caller-owned (matches `Texture2D` semantics):
 *    - `createGlyphStorage(initial?)` allocates a fresh storage, optionally seeded.
 *    - `updateGlyphStorage(storage, curveSetId, curves)` adds glyphs (creating the
 *      curve-set on demand). Glyph ids already present are skipped.
 *    - `disposeGlyphStorage(storage)` releases every atlas. The caller must ensure no
 *      `TextData` is still drawing from it — using a disposed storage is undefined
 *      behavior. Idempotent.
 */

declare const glyphStorageBrand: unique symbol;

// ─── Glyph outline geometry (public value types) ──────────────────────
//
// These describe the input contract for `updateGlyphStorage` /
// `createGlyphStorage`. Live here (not with the default extraction module) so a
// caller bringing their own outline source (DirectWrite, FreeType, hand-rolled)
// can produce `GlyphCurves` values without importing `glyph-extraction.ts` or
// pulling `text-shaper` into their bundle.

/** Quadratic Bézier curve describing one segment of a glyph outline in font units. */
export type QuadCurve = {
    readonly p0x: number;
    readonly p0y: number;
    readonly p1x: number;
    readonly p1y: number;
    readonly p2x: number;
    readonly p2y: number;
};

/** Axis-aligned glyph extents in font units, used to size the rendered quad and spatial curve bands. */
export type GlyphBounds = {
    readonly xMin: number;
    readonly yMin: number;
    readonly xMax: number;
    readonly yMax: number;
};

/** Complete outline data for one glyph id, ready to be packed into a `GlyphStorage` atlas. */
export type GlyphCurves = {
    readonly glyphId: number;
    readonly curves: readonly QuadCurve[];
    readonly bounds: GlyphBounds;
    /** @internal Lazily-computed band partitioning (memoized by `buildGlyphBands`). */
    _bands?: GlyphBands;
};

// ─── Public types ─────────────────────────────────────────────────────────

/** Identifier for a curve set (a font's glyph-curves map). Strings let callers use a
 *  human-readable key (e.g. the font face name) for easy debugging. */
export type CurveSetId = string;

/** Opaque bundle of glyph outlines (organized by curve-set) and the GPU atlases packed
 *  from them. Holds an arbitrary number of curve-sets — each curve-set gets its own atlas.
 *  Shared by reference across any number of `TextData`s that need the same glyph catalog. */
export interface GlyphStorage {
    readonly [glyphStorageBrand]: true;
    /** @internal Per-curve-set glyph outlines + the SharedAtlas they're packed into. */
    _curveSets: Map<CurveSetId, GlyphStorageCurveSet>;
}

// ─── Internal supporting types ────────────────────────────────────────────
// Tagged `@internal` on the type itself so the d.ts trim pass strips them from the
// published types. Fields still use `_` prefixes so production property mangling can
// shorten them.

/** @internal Width of the curve / band textures (texels). */
export const TEX_WIDTH = 4096;

/** @internal Per-curve-set entry within a GlyphStorage. */
export type GlyphStorageCurveSet = {
    /** @internal */
    _curves: Map<number, GlyphCurves>;
    /** @internal */
    _atlas: SharedAtlas;
};

/** @internal Atlas slot for a single glyph inside a SharedAtlas. */
export type AtlasSlot = {
    /** @internal Dense index of this glyph's entry in `SharedAtlas._metaData`, and the value the vertex
     *  shader uses to look it up in the GPU metadata buffer. Slots are append-only and never
     *  moved, so an index stays valid for the atlas's lifetime. */
    _index: number;
};

/** @internal Floats per glyph in `SharedAtlas._metaData`, laid out as three `vec4<f32>` to match
 *  the shader's `GlyphMetadata`: bounds (xMin, yMin, xMax, yMax), atlas (glyphLocX, glyphLocY,
 *  bandMaxX, bandMaxY), band (bandScaleX, bandScaleY, bandOffsetX, bandOffsetY).
 *
 *  All twelve depend only on the glyph, so they live here — written once when the glyph is
 *  appended — instead of being copied into every instance that references the glyph. */
export const GLYPH_METADATA_FLOATS = 12;

/** @internal CPU + (lazy) GPU staging packed from a `GlyphStorage`'s glyph outlines.
 *  One `SharedAtlas` per curve-set; lifetime is bound to the storage. */
export type SharedAtlas = {
    /** @internal Pooled curve texel staging (rgba32float, width 4096). */
    _curveTexData: Float32Array;
    /** @internal Number of curve texels actually used. */
    _curveTexelsUsed: number;
    /** @internal Pooled band texel staging (rgba32float, width 4096). */
    _bandTexData: Float32Array;
    /** @internal Number of band texels actually used. */
    _bandTexelsUsed: number;
    /** @internal Per-glyph atlas slot lookup. Slots are append-only and never moved. */
    _glyphSlots: Map<number, AtlasSlot>;
    /** @internal Glyph-invariant shader data, `GLYPH_METADATA_FLOATS` per slot, indexed by `AtlasSlot._index`.
     *  Uploaded verbatim as the shader's `array<GlyphMetadata>` storage buffer. */
    _metaData: Float32Array;
    /** @internal Number of slots appended so far; also the next `AtlasSlot._index`. */
    _slotCount: number;
    /** @internal Monotonic version bumped whenever a new glyph is appended. */
    _version: number;
    /** @internal Lazy GPU resources (one set per SharedAtlas; recreated only on capacity grow). */
    _gpu: SharedAtlasGpu | null;
};

/** @internal GPU-side companion to a `SharedAtlas`; populated lazily by
 *  `ensureSharedAtlasGpu` in `_gpu/text-textures.ts`. */
export type SharedAtlasGpu = {
    /** @internal */
    _device: GPUDevice;
    /** @internal */
    _curveTex: GPUTexture;
    /** @internal */
    _bandTex: GPUTexture;
    /** @internal */
    _curveTexRows: number;
    /** @internal */
    _bandTexRows: number;
    /** @internal Storage buffer holding `SharedAtlas._metaData`, read by the vertex shader. */
    _metaBuf: GPUBuffer;
    /** @internal Slots the current `_metaBuf` can hold. */
    _metaCap: number;
    /** @internal */
    _uploadedVersion: number;
};

/** @internal Spatial-band partitioning for a glyph's curves. Memoized per `GlyphCurves`
 *  via `GlyphCurves._bands`. */
export type GlyphBands = {
    /** @internal */
    _hBands: BandEntry[];
    /** @internal */
    _vBands: BandEntry[];
    /** @internal */
    _hBandCount: number;
    /** @internal */
    _vBandCount: number;
};

/** @internal */
export type BandEntry = {
    /** @internal */
    _curveIndices: number[];
};

// ─── Public API ───────────────────────────────────────────────────────────

/** Build a `GlyphStorage`. If `initial` is provided, each curve-set is packed into its
 *  own atlas synchronously. The passed inner maps are *adopted* by the storage — the
 *  caller must not mutate them directly afterward (use `updateGlyphStorage` instead). */
export function createGlyphStorage(initial?: Map<CurveSetId, Map<number, GlyphCurves>>): GlyphStorage {
    const _curveSets = new Map<CurveSetId, GlyphStorageCurveSet>();
    if (initial) {
        for (const [curveSetId, curves] of initial) {
            _curveSets.set(curveSetId, makeCurveSet(curves));
        }
    }
    return { _curveSets } as unknown as GlyphStorage;
}

/** Add glyphs to the named curve-set, creating it if it doesn't exist yet. Glyph ids
 *  already present in the curve-set are skipped (the existing outline + atlas slot wins).
 *  Safe to call between frames: the atlas grows in place and the next render uploads the
 *  new glyphs. */
export function updateGlyphStorage(storage: GlyphStorage, curveSetId: CurveSetId, curves: ReadonlyMap<number, GlyphCurves>): void {
    let cs = storage._curveSets.get(curveSetId);
    if (!cs) {
        cs = makeCurveSet(new Map());
        storage._curveSets.set(curveSetId, cs);
    }
    for (const [glyphId, glyph] of curves) {
        if (cs._curves.has(glyphId)) {
            continue;
        }
        cs._curves.set(glyphId, glyph);
        cs._atlas._glyphSlots.set(glyphId, packAppendGlyph(cs._atlas, glyph));
    }
}

/** Release every GPU atlas owned by `storage`. Idempotent. The caller is responsible for
 *  ensuring no `TextData` is still drawing from this storage. */
export function disposeGlyphStorage(storage: GlyphStorage): void {
    for (const cs of storage._curveSets.values()) {
        const gpu = cs._atlas._gpu;
        if (gpu) {
            gpu._curveTex.destroy();
            gpu._bandTex.destroy();
            gpu._metaBuf.destroy();
            cs._atlas._gpu = null;
        }
    }
    storage._curveSets.clear();
}

// ─── Internal: SharedAtlas construction + glyph packing ───────────────────

const ROW_FLOATS = TEX_WIDTH * 4;

/** @internal Create an empty `SharedAtlas`. */
export function createSharedAtlas(): SharedAtlas {
    return {
        _curveTexData: new Float32Array(ROW_FLOATS),
        _curveTexelsUsed: 0,
        _bandTexData: new Float32Array(ROW_FLOATS),
        _bandTexelsUsed: 0,
        _glyphSlots: new Map(),
        _metaData: new Float32Array(GLYPH_METADATA_FLOATS * 16),
        _slotCount: 0,
        _version: 0,
        _gpu: null,
    };
}

function makeCurveSet(curves: Map<number, GlyphCurves>): GlyphStorageCurveSet {
    const atlas = createSharedAtlas();
    for (const [glyphId, glyph] of curves) {
        atlas._glyphSlots.set(glyphId, packAppendGlyph(atlas, glyph));
    }
    return { _curves: curves, _atlas: atlas };
}

/** Grow a texel-staging array to hold at least `neededTexels` texels (4 floats each),
 *  rounded up to a whole 4096-texel row. Returns the same array when already large enough. */
function ensureTexelCapacity(current: Float32Array, neededTexels: number): Float32Array {
    const neededFloats = neededTexels * 4;
    if (current.length >= neededFloats) {
        return current;
    }
    let newFloats = Math.max(current.length * 2, ROW_FLOATS);
    while (newFloats < neededFloats) {
        newFloats *= 2;
    }
    // Round up to a whole row to keep texel math aligned.
    newFloats = Math.ceil(newFloats / ROW_FLOATS) * ROW_FLOATS;
    const grown = new Float32Array(newFloats);
    grown.set(current);
    return grown;
}

/** @internal Append `glyph` to `atlas`. Returns the new slot. Caller must guarantee
 *  glyph is not already present. */
export function packAppendGlyph(atlas: SharedAtlas, glyph: GlyphCurves): AtlasSlot {
    const bands = buildGlyphBands(glyph);
    const curves = glyph.curves;

    // ── Curve texels: 2 texels per curve, must not straddle a row boundary. ──
    let curveTexel = atlas._curveTexelsUsed;
    const curveTexelPositions: number[] = new Array(curves.length);
    for (let i = 0; i < curves.length; i++) {
        const row0 = (curveTexel / TEX_WIDTH) | 0;
        const row1 = ((curveTexel + 1) / TEX_WIDTH) | 0;
        if (row0 !== row1) {
            curveTexel = row1 * TEX_WIDTH;
        }
        curveTexelPositions[i] = curveTexel;
        curveTexel += 2;
    }
    const curveTexelsEnd = curveTexel;
    atlas._curveTexData = ensureTexelCapacity(atlas._curveTexData, curveTexelsEnd);

    const curveData = atlas._curveTexData;
    for (let i = 0; i < curves.length; i++) {
        const c = curves[i]!;
        const tl = curveTexelPositions[i]!;
        const o0 = tl * 4;
        curveData[o0] = c.p0x;
        curveData[o0 + 1] = c.p0y;
        curveData[o0 + 2] = c.p1x;
        curveData[o0 + 3] = c.p1y;
        const o1 = (tl + 1) * 4;
        curveData[o1] = c.p2x;
        curveData[o1 + 1] = c.p2y;
        // (.zw left zero; padded.)
    }
    atlas._curveTexelsUsed = curveTexelsEnd;

    // ── Band block: headers must not straddle a row; followed by curve-index lists. ──
    const headerCount = bands._hBandCount + bands._vBandCount;
    let bandStart = atlas._bandTexelsUsed;
    const curX = bandStart % TEX_WIDTH;
    if (curX + headerCount > TEX_WIDTH) {
        bandStart = (((bandStart / TEX_WIDTH) | 0) + 1) * TEX_WIDTH;
    }
    const glyphLocX = bandStart % TEX_WIDTH;
    const glyphLocY = (bandStart / TEX_WIDTH) | 0;

    const allBands = [...bands._hBands, ...bands._vBands];
    let curveListOffset = headerCount;
    const bandOffsets: number[] = new Array(allBands.length);
    for (let i = 0; i < allBands.length; i++) {
        bandOffsets[i] = curveListOffset;
        curveListOffset += allBands[i]!._curveIndices.length;
    }
    const bandTexelsEnd = bandStart + curveListOffset;
    atlas._bandTexData = ensureTexelCapacity(atlas._bandTexData, bandTexelsEnd);

    const bandData = atlas._bandTexData;
    // Headers.
    for (let i = 0; i < allBands.length; i++) {
        const tl = bandStart + i;
        const di = tl * 4;
        bandData[di] = allBands[i]!._curveIndices.length;
        bandData[di + 1] = bandOffsets[i]!;
    }
    // Curve refs.
    for (let i = 0; i < allBands.length; i++) {
        const band = allBands[i]!;
        const listStart = bandStart + bandOffsets[i]!;
        for (let j = 0; j < band._curveIndices.length; j++) {
            const ci = band._curveIndices[j]!;
            const curveTexelAbs = curveTexelPositions[ci]!;
            const cTexX = curveTexelAbs % TEX_WIDTH;
            const cTexY = (curveTexelAbs / TEX_WIDTH) | 0;
            const tl = listStart + j;
            const di = tl * 4;
            bandData[di] = cTexX;
            bandData[di + 1] = cTexY;
        }
    }
    atlas._bandTexelsUsed = bandTexelsEnd;

    atlas._version++;

    const { xMin, yMin, xMax, yMax } = glyph.bounds;
    const widthFu = xMax - xMin;
    const heightFu = yMax - yMin;
    const bandScaleX = widthFu > 0 ? bands._vBandCount / widthFu : 0;
    const bandScaleY = heightFu > 0 ? bands._hBandCount / heightFu : 0;

    // ── Glyph metadata: written once here, read by every instance that uses this glyph. ──
    const index = atlas._slotCount++;
    const needMetaFloats = atlas._slotCount * GLYPH_METADATA_FLOATS;
    if (atlas._metaData.length < needMetaFloats) {
        const grown = new Float32Array(Math.max(atlas._metaData.length * 2, needMetaFloats));
        grown.set(atlas._metaData);
        atlas._metaData = grown;
    }
    const m = index * GLYPH_METADATA_FLOATS;
    const meta = atlas._metaData;
    meta[m] = xMin;
    meta[m + 1] = yMin;
    meta[m + 2] = xMax;
    meta[m + 3] = yMax;
    meta[m + 4] = glyphLocX;
    meta[m + 5] = glyphLocY;
    meta[m + 6] = bands._vBandCount - 1;
    meta[m + 7] = bands._hBandCount - 1;
    meta[m + 8] = bandScaleX;
    meta[m + 9] = bandScaleY;
    meta[m + 10] = -xMin * bandScaleX;
    meta[m + 11] = -yMin * bandScaleY;

    return { _index: index };
}

// ─── Internal: spatial-band partitioning ──────────────────────────────────

function curveAt(curves: readonly QuadCurve[], i: number): QuadCurve {
    const c = curves[i];
    if (!c) {
        throw new Error("buildGlyphBands: invalid curve index");
    }
    return c;
}

function buildBandsInternal(g: GlyphCurves): GlyphBands {
    const { curves, bounds } = g;
    const numBands = Math.max(1, Math.min(8, Math.floor(curves.length / 2)));
    const { xMin, yMin, xMax, yMax } = bounds;
    const width = xMax - xMin;
    const height = yMax - yMin;
    const bandH = height / numBands;
    const bandW = width / numBands;

    const hBands: BandEntry[] = [];
    const vBands: BandEntry[] = [];
    for (let i = 0; i < numBands; i++) {
        hBands.push({ _curveIndices: [] });
        vBands.push({ _curveIndices: [] });
    }

    for (let ci = 0; ci < curves.length; ci++) {
        const c = curveAt(curves, ci);
        const cyMin = Math.min(c.p0y, c.p1y, c.p2y);
        const cyMax = Math.max(c.p0y, c.p1y, c.p2y);
        const cxMin = Math.min(c.p0x, c.p1x, c.p2x);
        const cxMax = Math.max(c.p0x, c.p1x, c.p2x);
        if (height > 0) {
            for (let b = 0; b < numBands; b++) {
                const bMinY = yMin + b * bandH;
                const bMaxY = yMin + (b + 1) * bandH;
                if (cyMax >= bMinY && cyMin <= bMaxY) {
                    hBands[b]!._curveIndices.push(ci);
                }
            }
        }
        if (width > 0) {
            for (let b = 0; b < numBands; b++) {
                const bMinX = xMin + b * bandW;
                const bMaxX = xMin + (b + 1) * bandW;
                if (cxMax >= bMinX && cxMin <= bMaxX) {
                    vBands[b]!._curveIndices.push(ci);
                }
            }
        }
    }

    // Sort curves: h-bands by descending max x, v-bands by descending max y (early-exit in shader).
    for (const band of hBands) {
        band._curveIndices.sort((a, b) => {
            const ca = curveAt(curves, a);
            const cb = curveAt(curves, b);
            return Math.max(cb.p0x, cb.p1x, cb.p2x) - Math.max(ca.p0x, ca.p1x, ca.p2x);
        });
    }
    for (const band of vBands) {
        band._curveIndices.sort((a, b) => {
            const ca = curveAt(curves, a);
            const cb = curveAt(curves, b);
            return Math.max(cb.p0y, cb.p1y, cb.p2y) - Math.max(ca.p0y, ca.p1y, ca.p2y);
        });
    }

    return { _hBands: hBands, _vBands: vBands, _hBandCount: numBands, _vBandCount: numBands };
}

/** @internal Get (and memoize) the band partitioning for a glyph's curves. */
export function buildGlyphBands(g: GlyphCurves): GlyphBands {
    return (g._bands ??= buildBandsInternal(g));
}
