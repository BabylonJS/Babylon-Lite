/**
 * Sprite sort indirection — Uint32 per-instance buffer of indices ordered
 * back-to-front by squared camera distance for blended sprite layers.
 *
 * Per blocker 4 of docs/architecture/26-sprites.md, the renderable produces a
 * separate `Uint32Array` indirection buffer (one u32 per active sprite) and
 * uploads it to a per-instance vertex buffer at `@location(0)`. The packed
 * sprite data buffer (storage buffer at `@group(1) @binding(3)`) is never
 * reordered — only the indirection buffer changes per frame, so the cost is
 * O(N) per re-sort, not O(N × stride).
 *
 * Re-sort triggers:
 *   - `_sortVersion` changed (add / remove / position update)
 *   - camera world-position moved
 *
 * Cutout layers don't need back-to-front ordering (depth-write handles it),
 * but they still consume a sequential indirection buffer (0..N-1) so the
 * shader path stays uniform.
 *
 * The per-instance world centroid is also computed here in the same walk —
 * it drives the engine-wide transparent sort via `Renderable._worldCenter`.
 */

import type { EngineContextInternal } from "../../engine/engine.js";
import type { SpriteStorage } from "./sprite-gpu.js";

/** Persistent state cached by each renderable. */
export interface SpriteSortState {
    /** GPU buffer of u32 indices (length = capacity). Recreated when capacity grows. */
    indexBuffer: GPUBuffer | null;
    /** CPU-side scratch — same length as storage capacity. */
    indices: Uint32Array;
    /** Scratch parallel array of squared camera distances (used only for back-to-front). */
    distances: Float32Array;
    /** Last sprite-version observed (drives re-pack of indices). */
    lastSortVersion: number;
    /** Last camera position observed (drives back-to-front re-sort even when sprite version is unchanged). */
    lastCamX: number;
    lastCamY: number;
    lastCamZ: number;
    /** Last count of indices uploaded — bumped to detect layout changes. */
    lastUploadedCount: number;
    /** Whether to do the back-to-front sort each frame (false for cutout / opaque sprites). */
    blended: boolean;
    /** Reusable centroid scratch — written by `computeSpriteCentroid`, read by the renderable. */
    centroid: [number, number, number];
}

/** Allocate sort state. Buffer is created lazily on first sync. */
export function createSpriteSortState(blended: boolean): SpriteSortState {
    return {
        indexBuffer: null,
        indices: new Uint32Array(0),
        distances: new Float32Array(0),
        lastSortVersion: -1,
        lastCamX: Number.NaN,
        lastCamY: Number.NaN,
        lastCamZ: Number.NaN,
        lastUploadedCount: -1,
        blended,
        centroid: [0, 0, 0],
    };
}

/** Reallocate scratch arrays + GPU buffer to fit the storage capacity. */
function ensureCapacity(engine: EngineContextInternal, state: SpriteSortState, storage: SpriteStorage, label: string): void {
    if (state.indices.length < storage.capacity) {
        state.indices = new Uint32Array(storage.capacity);
        state.distances = new Float32Array(storage.capacity);
    }
    const requiredBytes = Math.max(4, storage.capacity * 4);
    if (!state.indexBuffer || state.indexBuffer.size < requiredBytes) {
        if (state.indexBuffer) {
            state.indexBuffer.destroy();
        }
        state.indexBuffer = engine.device.createBuffer({
            label,
            size: requiredBytes,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        // Force re-upload after reallocation.
        state.lastUploadedCount = -1;
        state.lastSortVersion = -1;
    }
}

/**
 * Recompute and upload the sort indirection if the camera or sprite version
 * changed. Reads world positions from the first three floats of each slot
 * (offsets 0..2 in both anchored + billboard layouts).
 */
export function syncSpriteSortIndices(
    engine: EngineContextInternal,
    state: SpriteSortState,
    storage: SpriteStorage,
    sortVersion: number,
    camX: number,
    camY: number,
    camZ: number,
    label: string
): void {
    ensureCapacity(engine, state, storage, label);
    const count = storage.count;
    if (count === 0) {
        state.lastSortVersion = sortVersion;
        state.lastCamX = camX;
        state.lastCamY = camY;
        state.lastCamZ = camZ;
        state.lastUploadedCount = 0;
        return;
    }

    const versionChanged = state.lastSortVersion !== sortVersion;
    const camMoved = state.blended && (state.lastCamX !== camX || state.lastCamY !== camY || state.lastCamZ !== camZ);
    const countChanged = state.lastUploadedCount !== count;
    if (!versionChanged && !camMoved && !countChanged) {
        return;
    }

    const indices = state.indices;
    if (state.blended) {
        const distances = state.distances;
        const data = storage.data;
        const stride = storage.stride;
        for (let i = 0; i < count; i++) {
            const off = i * stride;
            const dx = data[off]! - camX;
            const dy = data[off + 1]! - camY;
            const dz = data[off + 2]! - camZ;
            indices[i] = i;
            distances[i] = dx * dx + dy * dy + dz * dz;
        }
        // Insertion sort — fast for small N and near-sorted lists; the typical
        // case is a few sprites swapping order as the camera moves.
        for (let i = 1; i < count; i++) {
            const idx = indices[i]!;
            const dist = distances[idx];
            let j = i - 1;
            while (j >= 0 && distances[indices[j]!]! < dist!) {
                indices[j + 1] = indices[j]!;
                j--;
            }
            indices[j + 1] = idx;
        }
    } else {
        for (let i = 0; i < count; i++) {
            indices[i] = i;
        }
    }

    engine.device.queue.writeBuffer(state.indexBuffer!, 0, indices.buffer, indices.byteOffset, count * 4);

    state.lastSortVersion = sortVersion;
    state.lastCamX = camX;
    state.lastCamY = camY;
    state.lastCamZ = camZ;
    state.lastUploadedCount = count;
}

/** Compute the centroid of all visible sprites' world positions. Sets
 *  `state.centroid` and returns it. Cheap walk over the first three floats. */
export function computeSpriteCentroid(state: SpriteSortState, storage: SpriteStorage): [number, number, number] {
    const count = storage.count;
    if (count === 0) {
        state.centroid[0] = 0;
        state.centroid[1] = 0;
        state.centroid[2] = 0;
        return state.centroid;
    }
    const data = storage.data;
    const stride = storage.stride;
    let sx = 0;
    let sy = 0;
    let sz = 0;
    for (let i = 0; i < count; i++) {
        const off = i * stride;
        sx += data[off]!;
        sy += data[off + 1]!;
        sz += data[off + 2]!;
    }
    const inv = 1 / count;
    state.centroid[0] = sx * inv;
    state.centroid[1] = sy * inv;
    state.centroid[2] = sz * inv;
    return state.centroid;
}

/** Release GPU resources owned by the sort state. */
export function disposeSpriteSortState(state: SpriteSortState): void {
    if (state.indexBuffer) {
        state.indexBuffer.destroy();
        state.indexBuffer = null;
    }
}
