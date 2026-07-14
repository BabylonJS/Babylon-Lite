import type { Vec2, Vec3, Color4 } from "../../../math/types.js";
import type { ParticleBlockEvaluator, ParticleValue, NpeGetter } from "../npe-types.js";

/** Euclidean length of a Vec2/Vec3 input (or the absolute value of a scalar). Mirrors BJS `Vector.length()`. */
function vectorLength(v: ParticleValue): number {
    if (typeof v === "number") {
        return Math.abs(v);
    }
    if (v && typeof v === "object") {
        if ("z" in v) {
            const vec = v as Vec3;
            return Math.sqrt(vec.x * vec.x + vec.y * vec.y + vec.z * vec.z);
        }
        if ("r" in v) {
            const c = v as Color4;
            return Math.sqrt(c.r * c.r + c.g * c.g + c.b * c.b + c.a * c.a);
        }
        if ("x" in v) {
            const vec = v as Vec2;
            return Math.sqrt(vec.x * vec.x + vec.y * vec.y);
        }
    }
    return 0;
}

/**
 * `ParticleVectorLengthBlock` — outputs the Euclidean length (magnitude) of a vector input. Mirrors BJS
 * `ParticleVectorLengthBlock` (`input.length()`); used, e.g., to measure a particle's speed from its
 * velocity vector for the velocity-limit gradient.
 */
export const particleVectorLengthBlock: ParticleBlockEvaluator = {
    build(block, ctx) {
        const inputGetter = ctx.input(block, "input");
        const getter: NpeGetter = (state) => vectorLength(inputGetter(state));
        ctx.setOutput(block.id, "output", getter);
    },
};
