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
// published types. Fields therefore don't need `_` prefixes.

/** @internal Width of the curve / band textures (texels). */
export const TEX_WIDTH = 4096;

/** @internal Per-curve-set entry within a GlyphStorage. */
export type GlyphStorageCurveSet = {
    curves: Map<number, GlyphCurves>;
    atlas: SharedAtlas;
};

/** @internal Atlas slot for a single glyph inside a SharedAtlas. */
export type AtlasSlot = {
    /** Index of the first curve texel for this glyph. */
    curveTexelStart: number;
    /** Texel coordinates of the band header block for this glyph. */
    glyphLocX: number;
    glyphLocY: number;
    /** vBandCount - 1, hBandCount - 1 (matching the fragment shader expectations). */
    bandMaxX: number;
    bandMaxY: number;
    /** Number of bands per axis used when packing (≤ 8). */
    vBandCount: number;
    hBandCount: number;
};

/** @internal CPU + (lazy) GPU staging packed from a `GlyphStorage`'s glyph outlines.
 *  One `SharedAtlas` per curve-set; lifetime is bound to the storage. */
export type SharedAtlas = {
    /** Pooled curve texel staging (rgba32float, width 4096). */
    curveTexData: Float32Array;
    /** Number of curve texels actually used. */
    curveTexelsUsed: number;
    /** Pooled band texel staging (rgba32float, width 4096). */
    bandTexData: Float32Array;
    /** Number of band texels actually used. */
    bandTexelsUsed: number;
    /** Per-glyph atlas slot lookup. Slots are append-only and never moved. */
    glyphSlots: Map<number, AtlasSlot>;
    /** Monotonic version bumped whenever a new glyph is appended. */
    version: number;
    /** Lazy GPU resources (one set per SharedAtlas; recreated only on capacity grow). */
    gpu: SharedAtlasGpu | null;
};

/** @internal GPU-side companion to a `SharedAtlas`; populated lazily by
 *  `ensureSharedAtlasGpu` in `_gpu/text-textures.ts`. */
export type SharedAtlasGpu = {
    device: GPUDevice;
    curveTex: GPUTexture;
    bandTex: GPUTexture;
    curveTexRows: number;
    bandTexRows: number;
    uploadedVersion: number;
};

/** @internal Spatial-band partitioning for a glyph's curves. Memoized per `GlyphCurves`
 *  via `GlyphCurves._bands`. */
export type GlyphBands = {
    hBands: BandEntry[];
    vBands: BandEntry[];
    hBandCount: number;
    vBandCount: number;
};

/** @internal */
export type BandEntry = { curveIndices: number[] };

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
        if (cs.curves.has(glyphId)) {
            continue;
        }
        cs.curves.set(glyphId, glyph);
        cs.atlas.glyphSlots.set(glyphId, packAppendGlyph(cs.atlas, glyph));
    }
}

/** Release every GPU atlas owned by `storage`. Idempotent. The caller is responsible for
 *  ensuring no `TextData` is still drawing from this storage. */
export function disposeGlyphStorage(storage: GlyphStorage): void {
    for (const cs of storage._curveSets.values()) {
        const gpu = cs.atlas.gpu;
        if (gpu) {
            gpu.curveTex.destroy();
            gpu.bandTex.destroy();
            cs.atlas.gpu = null;
        }
    }
    storage._curveSets.clear();
}

// ─── Internal: SharedAtlas construction + glyph packing ───────────────────

const ROW_FLOATS = TEX_WIDTH * 4;

/** @internal Create an empty `SharedAtlas`. */
export function createSharedAtlas(): SharedAtlas {
    return {
        curveTexData: new Float32Array(ROW_FLOATS),
        curveTexelsUsed: 0,
        bandTexData: new Float32Array(ROW_FLOATS),
        bandTexelsUsed: 0,
        glyphSlots: new Map(),
        version: 0,
        gpu: null,
    };
}

function makeCurveSet(curves: Map<number, GlyphCurves>): GlyphStorageCurveSet {
    const atlas = createSharedAtlas();
    for (const [glyphId, glyph] of curves) {
        atlas.glyphSlots.set(glyphId, packAppendGlyph(atlas, glyph));
    }
    return { curves, atlas };
}

function ensureCurveCapacity(atlas: SharedAtlas, neededTexels: number): void {
    const neededFloats = neededTexels * 4;
    if (atlas.curveTexData.length >= neededFloats) {
        return;
    }
    let newFloats = Math.max(atlas.curveTexData.length * 2, ROW_FLOATS);
    while (newFloats < neededFloats) {
        newFloats *= 2;
    }
    // Round up to a whole row to keep texel math aligned.
    newFloats = Math.ceil(newFloats / ROW_FLOATS) * ROW_FLOATS;
    const grown = new Float32Array(newFloats);
    grown.set(atlas.curveTexData);
    atlas.curveTexData = grown;
}

function ensureBandCapacity(atlas: SharedAtlas, neededTexels: number): void {
    const neededFloats = neededTexels * 4;
    if (atlas.bandTexData.length >= neededFloats) {
        return;
    }
    let newFloats = Math.max(atlas.bandTexData.length * 2, ROW_FLOATS);
    while (newFloats < neededFloats) {
        newFloats *= 2;
    }
    newFloats = Math.ceil(newFloats / ROW_FLOATS) * ROW_FLOATS;
    const grown = new Float32Array(newFloats);
    grown.set(atlas.bandTexData);
    atlas.bandTexData = grown;
}

/** @internal Append `glyph` to `atlas`. Returns the new slot. Caller must guarantee
 *  glyph is not already present. */
export function packAppendGlyph(atlas: SharedAtlas, glyph: GlyphCurves): AtlasSlot {
    const bands = buildGlyphBands(glyph);
    const curves = glyph.curves;

    // ── Curve texels: 2 texels per curve, must not straddle a row boundary. ──
    let curveTexel = atlas.curveTexelsUsed;
    const startTexel = curveTexel;
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
    ensureCurveCapacity(atlas, curveTexelsEnd);

    const curveData = atlas.curveTexData;
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
    atlas.curveTexelsUsed = curveTexelsEnd;

    // ── Band block: headers must not straddle a row; followed by curve-index lists. ──
    const headerCount = bands.hBandCount + bands.vBandCount;
    let bandStart = atlas.bandTexelsUsed;
    const curX = bandStart % TEX_WIDTH;
    if (curX + headerCount > TEX_WIDTH) {
        bandStart = (((bandStart / TEX_WIDTH) | 0) + 1) * TEX_WIDTH;
    }
    const glyphLocX = bandStart % TEX_WIDTH;
    const glyphLocY = (bandStart / TEX_WIDTH) | 0;

    const allBands = [...bands.hBands, ...bands.vBands];
    let curveListOffset = headerCount;
    const bandOffsets: number[] = new Array(allBands.length);
    for (let i = 0; i < allBands.length; i++) {
        bandOffsets[i] = curveListOffset;
        curveListOffset += allBands[i]!.curveIndices.length;
    }
    const bandTexelsEnd = bandStart + curveListOffset;
    ensureBandCapacity(atlas, bandTexelsEnd);

    const bandData = atlas.bandTexData;
    // Headers.
    for (let i = 0; i < allBands.length; i++) {
        const tl = bandStart + i;
        const di = tl * 4;
        bandData[di] = allBands[i]!.curveIndices.length;
        bandData[di + 1] = bandOffsets[i]!;
    }
    // Curve refs.
    for (let i = 0; i < allBands.length; i++) {
        const band = allBands[i]!;
        const listStart = bandStart + bandOffsets[i]!;
        for (let j = 0; j < band.curveIndices.length; j++) {
            const ci = band.curveIndices[j]!;
            const curveTexelAbs = curveTexelPositions[ci]!;
            void startTexel; // (kept to make the curve-start anchor obvious for future code).
            const cTexX = curveTexelAbs % TEX_WIDTH;
            const cTexY = (curveTexelAbs / TEX_WIDTH) | 0;
            const tl = listStart + j;
            const di = tl * 4;
            bandData[di] = cTexX;
            bandData[di + 1] = cTexY;
        }
    }
    atlas.bandTexelsUsed = bandTexelsEnd;

    atlas.version++;

    return {
        curveTexelStart: startTexel,
        glyphLocX,
        glyphLocY,
        bandMaxX: bands.vBandCount - 1,
        bandMaxY: bands.hBandCount - 1,
        vBandCount: bands.vBandCount,
        hBandCount: bands.hBandCount,
    };
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
        hBands.push({ curveIndices: [] });
        vBands.push({ curveIndices: [] });
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
                    hBands[b]!.curveIndices.push(ci);
                }
            }
        }
        if (width > 0) {
            for (let b = 0; b < numBands; b++) {
                const bMinX = xMin + b * bandW;
                const bMaxX = xMin + (b + 1) * bandW;
                if (cxMax >= bMinX && cxMin <= bMaxX) {
                    vBands[b]!.curveIndices.push(ci);
                }
            }
        }
    }

    // Sort curves: h-bands by descending max x, v-bands by descending max y (early-exit in shader).
    for (const band of hBands) {
        band.curveIndices.sort((a, b) => {
            const ca = curveAt(curves, a);
            const cb = curveAt(curves, b);
            return Math.max(cb.p0x, cb.p1x, cb.p2x) - Math.max(ca.p0x, ca.p1x, ca.p2x);
        });
    }
    for (const band of vBands) {
        band.curveIndices.sort((a, b) => {
            const ca = curveAt(curves, a);
            const cb = curveAt(curves, b);
            return Math.max(cb.p0y, cb.p1y, cb.p2y) - Math.max(ca.p0y, ca.p1y, ca.p2y);
        });
    }

    return { hBands, vBands, hBandCount: numBands, vBandCount: numBands };
}

/** @internal Get (and memoize) the band partitioning for a glyph's curves. */
export function buildGlyphBands(g: GlyphCurves): GlyphBands {
    return (g._bands ??= buildBandsInternal(g));
}
