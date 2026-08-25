import type { Color4, Vec2, Vec3 } from "../../../math/types.js";
import type { NpeBlockEvaluator } from "../npe-build.js";
import type { ScalarGetter, NpeValue } from "../npe-value.js";

function vectorLength(value: NpeValue): number {
    if (typeof value === "number") {
        return Math.abs(value);
    }
    if ("z" in value) {
        const vector = value as Vec3;
        return Math.sqrt(vector.x * vector.x + vector.y * vector.y + vector.z * vector.z);
    }
    if ("r" in value) {
        const color = value as Color4;
        return Math.sqrt(color.r * color.r + color.g * color.g + color.b * color.b + color.a * color.a);
    }
    const vector = value as Vec2;
    return Math.sqrt(vector.x * vector.x + vector.y * vector.y);
}

/** `ParticleVectorLengthBlock` — return the magnitude of a scalar, vector, or color. */
export const particleVectorLengthBlock: NpeBlockEvaluator = {
    build(block, ctx) {
        const input = ctx.input(block, "input");
        const getter: ScalarGetter = (i) => vectorLength(input(i));
        ctx.setOutput(block.id, "output", getter);
    },
};
