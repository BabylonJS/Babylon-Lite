/** Write a perspective projection into `out` without allocating. */
export function mat4PerspectiveLHToRef(out: Float32Array, fov: number, aspect: number, near: number, far: number): void {
    const tan = 1 / Math.tan(fov * 0.5);
    const range = far - near;
    out[0] = tan / aspect;
    out[5] = tan;
    out[10] = far / range;
    out[11] = 1;
    out[14] = -(far * near) / range;
}
