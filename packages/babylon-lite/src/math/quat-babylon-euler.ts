/** Quaternion to Babylon.js pitch/yaw/roll Euler angles. */
export function quatToBabylonEulerTuple(qx: number, qy: number, qz: number, qw: number): [number, number, number] {
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
        return [zAxisY < 0 ? Math.PI / 2 : -Math.PI / 2, 2 * Math.atan2(qy, qw), 0];
    }

    return [Math.atan2(-2 * zAxisY, cosX), Math.atan2(2 * (qz * qx + qy * qw), sqz - sqx - sqy + sqw), Math.atan2(zSin, zCos)];
}

/** Quaternion to Babylon.js alpha/beta/gamma Euler angles. */
export function quatToBabylonAlphaBetaGammaTuple(qx: number, qy: number, qz: number, qw: number): [number, number, number] {
    const beta = 2 * Math.atan2(Math.sqrt(qx * qx + qy * qy), Math.sqrt(qz * qz + qw * qw));
    const gammaPlusAlpha = 2 * Math.atan2(qz, qw);
    const gammaMinusAlpha = 2 * Math.atan2(qy, qx);
    return [(gammaPlusAlpha - gammaMinusAlpha) / 2, beta, (gammaPlusAlpha + gammaMinusAlpha) / 2];
}
