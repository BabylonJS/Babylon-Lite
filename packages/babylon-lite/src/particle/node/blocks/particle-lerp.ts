import type { Vec2, Vec3, Color4 } from "../../../math/types.js";
import type { ParticleValue } from "../npe-types.js";

/** Scalar lerp: `(1 - g) * a + g * b`. */
export function lerp(g: number, a: number, b: number): number {
    return (1 - g) * a + g * b;
}

/**
 * Component-wise linear interpolation of a particle value (number, Vec2, Vec3, or Color4) by a scalar
 * gradient, dispatched on the runtime shape of `left`. Shared by `ParticleLerpBlock` and
 * `ParticleGradientBlock`.
 */
export function lerpValue(left: ParticleValue, right: ParticleValue, gradient: number): ParticleValue {
    if (typeof left === "number") {
        return lerp(gradient, left, typeof right === "number" ? right : 0);
    }
    if (left && typeof left === "object") {
        if ("r" in left) {
            const a = left as Color4;
            const b = right && typeof right === "object" && "r" in right ? (right as Color4) : { r: 0, g: 0, b: 0, a: 0 };
            return { r: lerp(gradient, a.r, b.r), g: lerp(gradient, a.g, b.g), b: lerp(gradient, a.b, b.b), a: lerp(gradient, a.a, b.a) };
        }
        if ("z" in left) {
            const a = left as Vec3;
            const b = right && typeof right === "object" && "z" in right ? (right as Vec3) : { x: 0, y: 0, z: 0 };
            return { x: lerp(gradient, a.x, b.x), y: lerp(gradient, a.y, b.y), z: lerp(gradient, a.z, b.z) };
        }
        const a = left as Vec2;
        const b = right && typeof right === "object" ? (right as Vec2) : { x: 0, y: 0 };
        return { x: lerp(gradient, a.x, b.x), y: lerp(gradient, a.y, b.y) };
    }
    return 0;
}
