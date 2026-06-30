import type { Vec3, Color4 } from "../../../math/types.js";
import type { ParticleScale } from "../../particle.js";
import type { ParticleBlockEvaluator, ParticleValue, NpeGetter } from "../npe-types.js";

/** Scalar lerp: `(1 - g) * a + g * b`. */
function lerp(g: number, a: number, b: number): number {
    return (1 - g) * a + g * b;
}

function lerpValue(left: ParticleValue, right: ParticleValue, gradient: number): ParticleValue {
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
        const a = left as ParticleScale;
        const b = right && typeof right === "object" ? (right as ParticleScale) : { x: 0, y: 0 };
        return { x: lerp(gradient, a.x, b.x), y: lerp(gradient, a.y, b.y) };
    }
    return 0;
}

/**
 * `ParticleLerpBlock` — linearly interpolates between `left` and `right` by a scalar `gradient`,
 * component-wise for vectors/colours. Mirrors BJS `ParticleLerpBlock`.
 */
export const particleLerpBlock: ParticleBlockEvaluator = {
    build(block, ctx) {
        const leftGetter = ctx.input(block, "left");
        const rightGetter = ctx.input(block, "right");
        const gradientGetter = ctx.input(block, "gradient", () => 0);

        const getter: NpeGetter = (state) => {
            const gradient = gradientGetter(state);
            return lerpValue(leftGetter(state), rightGetter(state), typeof gradient === "number" ? gradient : 0);
        };
        ctx.setOutput(block.id, "output", getter);
    },
};
