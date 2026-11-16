import type { Vec3 } from "./types.js";

/**
 * Write an orientation matrix that maps local +Z to `forward` and local +Y to
 * `up`. Inputs must be normalized and orthogonal.
 */
export function writeMat4FromLookDirectionLHIntoBuffer<T extends Float32Array | Float64Array>(out: T, forward: Vec3, up: Vec3): T {
    const rightX = up.y * forward.z - up.z * forward.y;
    const rightY = up.z * forward.x - up.x * forward.z;
    const rightZ = up.x * forward.y - up.y * forward.x;
    return writeBasis(out, rightX, rightY, rightZ, up.x, up.y, up.z, forward.x, forward.y, forward.z);
}

/**
 * Write an orientation matrix that maps local -Z to `forward` and local +Y to
 * `up`. Inputs must be normalized and orthogonal.
 */
export function writeMat4FromLookDirectionRHIntoBuffer<T extends Float32Array | Float64Array>(out: T, forward: Vec3, up: Vec3): T {
    const backX = -forward.x;
    const backY = -forward.y;
    const backZ = -forward.z;
    const leftX = up.y * backZ - up.z * backY;
    const leftY = up.z * backX - up.x * backZ;
    const leftZ = up.x * backY - up.y * backX;
    return writeBasis(out, leftX, leftY, leftZ, up.x, up.y, up.z, backX, backY, backZ);
}

function writeBasis<T extends Float32Array | Float64Array>(out: T, x0: number, x1: number, x2: number, y0: number, y1: number, y2: number, z0: number, z1: number, z2: number): T {
    out[0] = x0;
    out[1] = x1;
    out[2] = x2;
    out[3] = 0;
    out[4] = y0;
    out[5] = y1;
    out[6] = y2;
    out[7] = 0;
    out[8] = z0;
    out[9] = z1;
    out[10] = z2;
    out[11] = 0;
    out[12] = 0;
    out[13] = 0;
    out[14] = 0;
    out[15] = 1;
    return out;
}
