import type { Vec2 } from "./types.js";

/**
 * Writes the unit-length form of `source` into `result`.
 *
 * Zero-length and already-normalized vectors are copied unchanged, matching the
 * Babylon.js `Vector2.normalizeToRef` contract.
 */
export function normalizeVec2ToRef<T extends Vec2>(source: Vec2, result: T): T {
    const length = Math.hypot(source.x, source.y);
    if (length === 0 || length === 1) {
        result.x = source.x;
        result.y = source.y;
        return result;
    }

    result.x = source.x / length;
    result.y = source.y / length;
    return result;
}
