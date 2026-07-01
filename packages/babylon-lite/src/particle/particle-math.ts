import type { Vec3, Color4 } from "../math/types.js";

/**
 * Babylon.js `RandomRange` semantics: returns `min` **without consuming a random** when
 * `min === max`, otherwise `Math.random() * (max - min) + min`.
 *
 * This short-circuit matters for deterministic parity — emitter shape blocks call this for each
 * position/direction component, and equal min/max bounds (a common default) must not advance the
 * seeded RNG sequence. Note: `ParticleRandomBlock` deliberately does **not** short-circuit; it
 * always draws a random, so it has its own inline expression rather than calling this helper.
 */
export function randomRange(min: number, max: number): number {
    if (min === max) {
        return min;
    }
    return Math.random() * (max - min) + min;
}

/** Copy `src` into `dst` (Vec3, in place). */
export function copyVec3(dst: Vec3, src: Vec3): void {
    dst.x = src.x;
    dst.y = src.y;
    dst.z = src.z;
}

/** `dst += src` (Vec3, in place). */
export function addVec3InPlace(dst: Vec3, src: Vec3): void {
    dst.x += src.x;
    dst.y += src.y;
    dst.z += src.z;
}

/** `out = src * s` (Vec3). */
export function scaleVec3ToRef(src: Vec3, s: number, out: Vec3): void {
    out.x = src.x * s;
    out.y = src.y * s;
    out.z = src.z * s;
}

/** Copy `src` into `dst` (Color4, in place). */
export function copyColor4(dst: Color4, src: Color4): void {
    dst.r = src.r;
    dst.g = src.g;
    dst.b = src.b;
    dst.a = src.a;
}

/** `out = src * s` (Color4). */
export function scaleColor4ToRef(src: Color4, s: number, out: Color4): void {
    out.r = src.r * s;
    out.g = src.g * s;
    out.b = src.b * s;
    out.a = src.a * s;
}
