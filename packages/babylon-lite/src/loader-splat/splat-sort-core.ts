import { F32, U32 } from "../engine/typed-arrays.js";

/** Adaptive-precision counting sort for Gaussian-splat back-to-front ordering.
 *
 *  Pure logic shared by `splat-sort-worker.ts` (the runtime consumer) and the
 *  unit tests (which exercise it directly, since the worker module touches
 *  `self` at import time).
 *
 *  Technique (in the spirit of PlayCanvas' gsplat sort, re-derived for Lite):
 *    1. One linear pass computes each splat's view depth
 *       `cameraForward · (world · localPos − cameraPos)` — collapsed to an
 *       affine kernel `a·x + b·y + c·z + d` — and tracks the finite min/max.
 *    2. A 32-bin coarse histogram measures splat density across the depth
 *       range, and each coarse bin is granted a slice of the key space
 *       proportional to its population (never less than one key), so depth
 *       precision concentrates where splats actually are instead of being
 *       spent uniformly across mostly-empty range.
 *    3. Key-space size adapts to the cloud: `2^clamp(round(log2(n/4)), 10, 20)`
 *       buckets — small clouds don't pay for a large count table, huge clouds
 *       keep enough precision to avoid visible popping.
 *    4. A stable counting sort scatters indices in descending-depth (back-to-
 *       front) order: O(n) instead of the O(n·log n) comparison sort (with
 *       BigInt compares) this replaces.
 *
 *  Splats whose quantized keys collide keep their original relative order
 *  (the scatter is stable); the quantization error is bounded by the widest
 *  per-bin bucket, which the density-proportional allocation keeps small
 *  exactly where it matters. Non-finite depths (NaN/Inf centres) map to the
 *  far end of the range, so corrupt splats draw first, behind everything. */

/** Coarse histogram resolution for the adaptive key allocation. */
const COARSE_BINS = 32;

/** Per-cloud scratch reused across sorts. Sized once per `positions` upload. */
export interface SplatSortScratch {
    /** Per-splat view depth (pass 1), then reused to hold each splat's
     *  integer sort key (pass 3) — keys are < 2^20 so f32 stores them exactly. */
    depths: Float32Array;
    /** Counting-sort table, `2^bits` entries. Lazily (re)allocated because the
     *  bit count depends on the vertex count. */
    counts: Uint32Array | null;
    /** Coarse density histogram. */
    hist: Uint32Array;
    /** First key of each coarse bin's slice of the key space. */
    binBase: Uint32Array;
    /** Number of keys granted to each coarse bin. */
    binBuckets: Uint32Array;
}

/** Allocate the scratch for a cloud of `vertexCount` splats. */
export function createSplatSortScratch(vertexCount: number): SplatSortScratch {
    return {
        depths: new F32(vertexCount),
        counts: null,
        hist: new U32(COARSE_BINS),
        binBase: new U32(COARSE_BINS),
        binBuckets: new U32(COARSE_BINS),
    };
}

/** Sort-key bit width for a cloud: `clamp(round(log2(n / 4)), 10, 20)`. */
export function splatSortBucketBits(vertexCount: number): number {
    return Math.max(10, Math.min(20, Math.round(Math.log2(vertexCount / 4))));
}

/** Write the back-to-front splat order into `order[0..vertexCount)`.
 *
 *  `m` is the mesh's world matrix (column-major, affine), `cf` the camera's
 *  world-space forward vector, `cp` the camera's world-space position —
 *  the same three inputs the previous BigInt64 sort consumed, producing the
 *  same ordering up to key-quantization ties. */
export function sortSplatsBackToFront(
    positions: Float32Array,
    vertexCount: number,
    m: Float32Array,
    cf: Float32Array,
    cp: Float32Array,
    order: Uint32Array,
    scratch: SplatSortScratch
): void {
    // Collapse cameraForward · (world · localPos - cameraPos) into (a*x + b*y + c*z + d).
    // Lite column-major: world's column k lives at indices [4k, 4k+1, 4k+2, 4k+3]
    // (the 4th row is always [0,0,0,1] for an affine matrix, so we skip m[3,7,11,15]).
    const camDot = cf[0]! * cp[0]! + cf[1]! * cp[1]! + cf[2]! * cp[2]!;
    const a = cf[0]! * m[0]! + cf[1]! * m[1]! + cf[2]! * m[2]!;
    const b = cf[0]! * m[4]! + cf[1]! * m[5]! + cf[2]! * m[6]!;
    const c = cf[0]! * m[8]! + cf[1]! * m[9]! + cf[2]! * m[10]!;
    const d = cf[0]! * m[12]! + cf[1]! * m[13]! + cf[2]! * m[14]! - camDot;

    // ── Pass 1: depths + finite min/max (NaN fails both compares, Inf is kept
    // out by the isFinite guard so a single corrupt splat can't destroy the
    // range for everyone else). Track min/max from the value ROUND-TRIPPED
    // through `depths` (a Float32Array) — not the f64 `dj` — so the range is
    // consistent with the exact bytes passes 2/3 read back. Otherwise the
    // nearest splat's f32-truncated depth can land just below an f64 `min`,
    // making `t < 0` and mis-routing it to the far end (drawn behind
    // everything instead of in front). ──────────────────────────────────────
    const depths = scratch.depths;
    let min = Infinity;
    let max = -Infinity;
    for (let j = 0; j < vertexCount; j++) {
        depths[j] = a * positions[3 * j]! + b * positions[3 * j + 1]! + c * positions[3 * j + 2]! + d;
        const sj = depths[j]!;
        if (Number.isFinite(sj)) {
            if (sj < min) {
                min = sj;
            }
            if (sj > max) {
                max = sj;
            }
        }
    }

    // Degenerate range: 0/1 splats, all depths equal, or nothing finite —
    // any order is correct, use identity.
    const range = max - min;
    if (!(range > 1e-12)) {
        for (let j = 0; j < vertexCount; j++) {
            order[j] = j;
        }
        return;
    }

    // ── Pass 2: coarse density histogram over the depth range. ─────────────
    const hist = scratch.hist;
    hist.fill(0);
    const coarseScale = COARSE_BINS / range;
    for (let j = 0; j < vertexCount; j++) {
        const t = (depths[j]! - min) * coarseScale;
        // Non-finite → far end; `t >= COARSE_BINS` also catches depth == max.
        const bin = t >= 0 ? (t >= COARSE_BINS ? COARSE_BINS - 1 : t | 0) : COARSE_BINS - 1;
        hist[bin] = hist[bin]! + 1;
    }

    // ── Allocate key space per coarse bin ∝ density (≥1 key each, so the
    // depth → key map stays strictly monotonic across bins). ────────────────
    const bits = splatSortBucketBits(vertexCount);
    const bucketCount = 1 << bits;
    let counts = scratch.counts;
    if (!counts || counts.length !== bucketCount) {
        counts = scratch.counts = new U32(bucketCount);
    } else {
        counts.fill(0);
    }
    const binBase = scratch.binBase;
    const binBuckets = scratch.binBuckets;
    const spare = bucketCount - COARSE_BINS;
    let keyTotal = 0;
    for (let i = 0; i < COARSE_BINS; i++) {
        binBase[i] = keyTotal;
        const share = 1 + (((hist[i]! / vertexCount) * spare) | 0);
        binBuckets[i] = share;
        keyTotal += share;
    }

    // ── Pass 3: per-splat adaptive key (ascending with depth) + counts.
    // Keys overwrite `depths` in place — they are < 2^20, exact in f32. ─────
    for (let j = 0; j < vertexCount; j++) {
        const t = (depths[j]! - min) * coarseScale;
        let key: number;
        if (t >= 0 && t < COARSE_BINS) {
            const bin = t | 0;
            let q = (binBuckets[bin]! * (t - bin)) | 0;
            if (q >= binBuckets[bin]!) {
                q = binBuckets[bin]! - 1;
            }
            key = binBase[bin]! + q;
        } else {
            // depth == max, or non-finite: far end of the key space.
            key = keyTotal - 1;
        }
        depths[j] = key;
        counts[key] = counts[key]! + 1;
    }

    // ── Pass 4: suffix scan (highest key writes first ⇒ back-to-front) and
    // stable scatter (equal keys keep original splat order). ────────────────
    let pos = 0;
    for (let k = keyTotal - 1; k >= 0; k--) {
        const n = counts[k]!;
        counts[k] = pos;
        pos += n;
    }
    for (let j = 0; j < vertexCount; j++) {
        const key = depths[j]!;
        order[counts[key]!++] = j;
    }
}
