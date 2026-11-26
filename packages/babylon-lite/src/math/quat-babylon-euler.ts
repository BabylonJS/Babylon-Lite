import type { Vec3 } from "./types.js";

/** Write Babylon.js pitch/yaw/roll Euler angles from a quaternion. */
export function quatToBabylonEulerToRef<T extends Vec3>(qx: number, qy: number, qz: number, qw: number, out: T): T {
    const zAxisY = qy * qz - qx * qw;
    const sqw = qw * qw;
    const sqz = qz * qz;
    const sqx = qx * qx;
    const sqy = qy * qy;
    const zSin = 2 * (qx * qy + qz * qw);
    const zCos = -sqz - sqx + sqy + sqw;
    const cosX = Math.sqrt(zSin * zSin + zCos * zCos);
    const lengthSquared = sqx + sqy + sqz + sqw;

    if (cosX < 1e-8 * lengthSquared) {
        out.x = zAxisY < 0 ? Math.PI / 2 : -Math.PI / 2;
        out.y = 2 * Math.atan2(qy, qw);
        out.z = 0;
        return out;
    }

    out.x = Math.atan2(-2 * zAxisY, cosX);
    out.y = Math.atan2(2 * (qz * qx + qy * qw), sqz - sqx - sqy + sqw);
    out.z = Math.atan2(zSin, zCos);
    return out;
}

/** Write Babylon.js alpha/beta/gamma Euler angles from a quaternion. */
export function quatToBabylonAlphaBetaGammaToRef<T extends Vec3>(qx: number, qy: number, qz: number, qw: number, out: T): T {
    const beta = 2 * Math.atan2(Math.sqrt(qx * qx + qy * qy), Math.sqrt(qz * qz + qw * qw));
    const gammaPlusAlpha = 2 * Math.atan2(qz, qw);
    const gammaMinusAlpha = 2 * Math.atan2(qy, qx);
    out.x = (gammaPlusAlpha - gammaMinusAlpha) / 2;
    out.y = beta;
    out.z = (gammaPlusAlpha + gammaMinusAlpha) / 2;
    return out;
}
