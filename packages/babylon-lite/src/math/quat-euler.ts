/** Euler XYZ → quaternion (intrinsic XYZ order). */
export function eulerToQuat(rx: number, ry: number, rz: number): [number, number, number, number] {
    const cx = Math.cos(rx * 0.5),
        sx_ = Math.sin(rx * 0.5);
    const cy = Math.cos(ry * 0.5),
        sy_ = Math.sin(ry * 0.5);
    const cz = Math.cos(rz * 0.5),
        sz_ = Math.sin(rz * 0.5);
    return [sx_ * cy * cz + cx * sy_ * sz_, cx * sy_ * cz - sx_ * cy * sz_, cx * cy * sz_ + sx_ * sy_ * cz, cx * cy * cz - sx_ * sy_ * sz_];
}

/** Quaternion → Euler XYZ (inverse of eulerToQuat). */
export function quatToEulerXYZ(qx: number, qy: number, qz: number, qw: number): [number, number, number] {
    const sinY = 2 * (qx * qz + qw * qy);
    const ry = Math.asin(Math.max(-1, Math.min(1, sinY)));
    const rx = Math.atan2(-(2 * (qy * qz - qw * qx)), 1 - 2 * (qx * qx + qy * qy));
    const rz = Math.atan2(-(2 * (qx * qy - qw * qz)), 1 - 2 * (qy * qy + qz * qz));
    return [rx, ry, rz];
}
