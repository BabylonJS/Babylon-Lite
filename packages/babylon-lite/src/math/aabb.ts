/** Axis-aligned bounding box helpers. */

import type { Mat4 } from "./types.js";

export type Aabb = [min: [number, number, number], max: [number, number, number]];

/** Compute an AABB by folding XYZ min/max over a positions buffer.
 *
 *  When `world` is provided each position is transformed by it before being
 *  folded (column-major Mat4: m[col*4+row]). Otherwise the AABB is computed
 *  in the positions' own space.
 *
 *  Returns `[[+Inf,+Inf,+Inf],[-Inf,-Inf,-Inf]]` for empty input — callers
 *  that care can check `isFinite(min[0])`. */
export function computeAabb(positions: Float32Array, world?: Mat4): Aabb {
    let minX = Infinity,
        minY = Infinity,
        minZ = Infinity;
    let maxX = -Infinity,
        maxY = -Infinity,
        maxZ = -Infinity;

    if (world) {
        const m0 = world[0]!,
            m1 = world[1]!,
            m2 = world[2]!,
            m4 = world[4]!,
            m5 = world[5]!,
            m6 = world[6]!,
            m8 = world[8]!,
            m9 = world[9]!,
            m10 = world[10]!,
            m12 = world[12]!,
            m13 = world[13]!,
            m14 = world[14]!;
        for (let i = 0; i < positions.length; i += 3) {
            const lx = positions[i]!;
            const ly = positions[i + 1]!;
            const lz = positions[i + 2]!;
            const x = m0 * lx + m4 * ly + m8 * lz + m12;
            const y = m1 * lx + m5 * ly + m9 * lz + m13;
            const z = m2 * lx + m6 * ly + m10 * lz + m14;
            if (x < minX) {
                minX = x;
            }
            if (x > maxX) {
                maxX = x;
            }
            if (y < minY) {
                minY = y;
            }
            if (y > maxY) {
                maxY = y;
            }
            if (z < minZ) {
                minZ = z;
            }
            if (z > maxZ) {
                maxZ = z;
            }
        }
    } else {
        for (let i = 0; i < positions.length; i += 3) {
            const x = positions[i]!;
            const y = positions[i + 1]!;
            const z = positions[i + 2]!;
            if (x < minX) {
                minX = x;
            }
            if (x > maxX) {
                maxX = x;
            }
            if (y < minY) {
                minY = y;
            }
            if (y > maxY) {
                maxY = y;
            }
            if (z < minZ) {
                minZ = z;
            }
            if (z > maxZ) {
                maxZ = z;
            }
        }
    }

    return [
        [minX, minY, minZ],
        [maxX, maxY, maxZ],
    ];
}
