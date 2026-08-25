import type { Vec3 } from "./types.js";

/**
 * Scales axis-aligned bounds around `center`, preserving their per-axis shape.
 */
export function scaleBoundsFromCenterToRef<TMin extends Vec3, TMax extends Vec3>(
    minimum: Vec3,
    maximum: Vec3,
    center: Vec3,
    factor: number,
    resultMinimum: TMin,
    resultMaximum: TMax
): { minimum: TMin; maximum: TMax } {
    const dx = maximum.x - minimum.x;
    const dy = maximum.y - minimum.y;
    const dz = maximum.z - minimum.z;
    const length = Math.hypot(dx, dy, dz);
    const halfDistance = length * factor * 0.5;
    const inverseLength = length === 0 ? 0 : 1 / length;
    const rx = dx * inverseLength * halfDistance;
    const ry = dy * inverseLength * halfDistance;
    const rz = dz * inverseLength * halfDistance;

    resultMinimum.x = center.x - rx;
    resultMinimum.y = center.y - ry;
    resultMinimum.z = center.z - rz;
    resultMaximum.x = center.x + rx;
    resultMaximum.y = center.y + ry;
    resultMaximum.z = center.z + rz;

    return { minimum: resultMinimum, maximum: resultMaximum };
}
