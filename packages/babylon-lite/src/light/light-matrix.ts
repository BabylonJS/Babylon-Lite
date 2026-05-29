/** Shared light matrix helper — builds a local matrix from a direction vector + optional position. */

import type { Mat4 } from "../math/types.js";
import type { Mat4Storage } from "../math/types.js";

/** Build a local matrix from a direction vector + optional position.
 *  Column 2 = forward (normalized direction), column 0 = right, column 1 = up. */
export function localMatrixFromDirection(dx: number, dy: number, dz: number, px = 0, py = 0, pz = 0, out?: Mat4): Mat4 {
    const flen = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    const fx = dx / flen,
        fy = dy / flen,
        fz = dz / flen;

    // Right = normalize(cross(worldUp, forward))
    let rx = -fz,
        rz = fx;
    const ry = 0;
    const rlen = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1;
    rx /= rlen;
    rz /= rlen;

    // Up = cross(forward, right)
    const ux = fy * rz - fz * ry,
        uy = fz * rx - fx * rz,
        uz = fx * ry - fy * rx;

    // F32 fallback used only when callers don't pass `out`. Light factories
    // always pass a policy-allocated `_localMatrix` as `out` (see Task 2.3),
    // so the F32 path is exercised only by ad-hoc / test usage.
    const out4: Mat4 = out ?? (new Float32Array(16) as unknown as Mat4);
    const m = out4 as unknown as Mat4Storage;
    m[0] = rx;
    m[1] = ry;
    m[2] = rz;
    m[3] = 0;
    m[4] = ux;
    m[5] = uy;
    m[6] = uz;
    m[7] = 0;
    m[8] = fx;
    m[9] = fy;
    m[10] = fz;
    m[11] = 0;
    m[12] = px;
    m[13] = py;
    m[14] = pz;
    m[15] = 1;
    return out4;
}
