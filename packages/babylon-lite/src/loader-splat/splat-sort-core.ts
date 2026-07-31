import { F32, U32 } from "../engine/typed-arrays.js";

/** Uniform-key counting (radix) sort for Gaussian-splat back-to-front ordering.
 *
 *  Pure logic shared by `splat-sort-worker.ts` (the runtime consumer) and the
 *  unit tests (which exercise it directly, since the worker module touches
 *  `self` at import time).
 *
 *  Technique (the counting sort Babylon.js ships in
 *  `gaussianSplattingSortWorker.ts`, re-derived for Lite's lean order buffer):
 *    1. One linear pass computes each splat's view depth
 *       `cameraForward · (world · localPos − cameraPos)` — collapsed to an
 *       affine kernel `a·x + b·y + c·z + d` — and tracks the finite min/max.
 *    2. Depth is quantized to an integer key by a single uniform scale across
 *       `2^clamp(round(log2(n/4)), 10, 20)` buckets. Every key is the same
 *       width — `range / bucketCount` — so the worst-case ordering error is
 *       uniformly tiny everywhere, independent of where the splats sit in the
 *       depth range.
 *    3. A stable counting sort scatters indices in descending-depth (back-to-
 *       front) order: O(n) instead of the O(n·log n) comparison sort (with
 *       BigInt compares) this replaces.
 *
 *  Why uniform, not density-weighted: an earlier revision granted each of 32
 *  coarse depth bins a slice of the key space proportional to its population,
 *  to concentrate precision where splats are. Benchmarking all three candidates
 *  (legacy BigInt sort, this uniform sort, and the density-weighted variant)
 *  showed the density weighting is the same speed class but gives a *sparse*
 *  coarse bin only one key — spanning 1/32 ≈ 3.1 % of the depth range — so a
 *  splat crossing an empty gap in a clustered (i.e. real captured) scene can
 *  pop by up to ~3 %. The uniform mapping is marginally faster (one fewer pass)
 *  and keeps the worst-case error below 0.01 % on every scene, so
 *  it is the ordering the runtime uses. See PR #446 for the full comparison.
 *
 *  Splats whose quantized keys collide keep their original relative order (the
 *  scatter is stable). Non-finite depths (NaN/Inf centres) map to the far end of
 *  the range, so corrupt splats draw first, behind everything. */

/** Per-cloud scratch reused across sorts: per-splat depth/key storage followed
 *  by the counting table. Both are sized once per `positions` upload. */
export type SplatSortScratch = [depths: Float32Array, counts: Uint32Array];

/** Allocate the scratch for a cloud of `vertexCount` splats. */
export function createSplatSortScratch(vertexCount: number): SplatSortScratch {
    return [new F32(vertexCount), new U32(1 << splatSortBucketBits(vertexCount))];
}

/** Sort-key bit width for a cloud: `clamp(round(log2(n / 4)), 10, 20)`. */
export function splatSortBucketBits(vertexCount: number): number {
    return Math.max(10, Math.min(20, Math.round(Math.log2(vertexCount / 4))));
}

/** Write the back-to-front splat order into `order[0..vertexCount)`.
 *
 *  `depthTransform` is the four-coefficient affine kernel `(a,b,c,d)` for
 *  `cameraForward · (world · localPos − cameraPos)`. */
export function sortSplatsBackToFront(positions: Float32Array, vertexCount: number, depthTransform: Float32Array, order: Uint32Array, scratch: SplatSortScratch): void {
    const a = depthTransform[0]!;
    const b = depthTransform[1]!;
    const c = depthTransform[2]!;
    const d = depthTransform[3]!;

    // ── Pass 1: depths + finite min/max (NaN fails both compares, Inf is kept
    // out by the isFinite guard so a single corrupt splat can't destroy the
    // range for everyone else). Track min/max from the value ROUND-TRIPPED
    // through `depths` (a Float32Array) — not the f64 `dj` — so the range is
    // consistent with the exact bytes pass 2 reads back. Otherwise the
    // nearest splat's f32-truncated depth can land just below an f64 `min`,
    // making `t < 0` and mis-routing it to the far end (drawn behind
    // everything instead of in front). ──────────────────────────────────────
    const depths = scratch[0];
    let min = Infinity;
    let max = -Infinity;
    for (let j = 0; j < vertexCount; j++) {
        depths[j] = a * positions[3 * j]! + b * positions[3 * j + 1]! + c * positions[3 * j + 2]! + d;
        const sj = depths[j]!;
        if (sj - sj === 0) {
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

    // Key space: 2^bits uniform buckets across the depth range.
    const counts = scratch[1];
    counts.fill(0);

    // ── Pass 2: per-splat uniform key (ascending with depth) + counts. Keys
    // overwrite `depths` in place — they are < 2^20, exact in f32. The nearest
    // splat maps to key 0 and the farthest to the top key, so the descending
    // scatter below yields back-to-front order. ─────────────────────────────
    const maxKey = counts.length - 1;
    const scale = maxKey / range;
    for (let j = 0; j < vertexCount; j++) {
        const sj = depths[j]!;
        // Non-finite (NaN/Inf) → far end of the key space, drawn first (behind
        // everything). Finite depths quantize uniformly; clamp guards against a
        // depth == max (or float rounding) producing key > maxKey.
        let key: number;
        if (sj - sj === 0) {
            key = ((sj - min) * scale) | 0;
            if (key > maxKey) {
                key = maxKey;
            }
        } else {
            key = maxKey;
        }
        depths[j] = key;
        counts[key] = counts[key]! + 1;
    }

    // ── Pass 3: suffix scan (highest key writes first ⇒ back-to-front) and
    // stable scatter (equal keys keep original splat order). ────────────────
    let pos = 0;
    for (let k = maxKey; k >= 0; k--) {
        const n = counts[k]!;
        counts[k] = pos;
        pos += n;
    }
    for (let j = 0; j < vertexCount; j++) {
        const key = depths[j]!;
        order[counts[key]!++] = j;
    }
}
