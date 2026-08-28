import type { Vec2, Vec3, Color4 } from "../../../math/types.js";
import type { NpeBlockEvaluator } from "../npe-build.js";
import type { NpeGetter } from "../npe-value.js";
import { hasIntBlockInput } from "./particle-value-type.js";

function apply(operation: number, left: number, right: number): number {
    switch (operation) {
        case 0:
            return left + right;
        case 1:
            return left - right;
        case 2:
            return left * right;
        case 3:
            return left / right;
        case 4:
            return Math.max(left, right);
        case 5:
            return Math.min(left, right);
        default:
            return left;
    }
}

/** Compact math evaluator for distinct source blocks, whose result scratches cannot alias. */
export const particleMathCompactBlock: NpeBlockEvaluator = {
    build(block, ctx) {
        const operation = typeof block.serialized.operation === "number" ? block.serialized.operation : 0;
        const left = ctx.input(block, "left");
        const right = ctx.input(block, "right");
        const intResult = hasIntBlockInput(ctx._blocks, block, "left") && hasIntBlockInput(ctx._blocks, block, "right");
        const vector2: Vec2 = { x: 0, y: 0 };
        const vector3: Vec3 = { x: 0, y: 0, z: 0 };
        const color4: Color4 = { r: 0, g: 0, b: 0, a: 0 };
        const getter: NpeGetter = (i) => {
            const a = left(i);
            const b = right(i);
            const aScalar = typeof a === "number";
            const bScalar = typeof b === "number";
            if (aScalar && bScalar) {
                const result = apply(operation, a, b);
                return intResult ? result | 0 : result;
            }
            const shape = aScalar ? b : a;
            if (typeof shape !== "number" && "r" in shape) {
                const leftColor = a as Color4;
                const rightColor = b as Color4;
                color4.r = apply(operation, aScalar ? a : leftColor.r, bScalar ? b : rightColor.r);
                color4.g = apply(operation, aScalar ? a : leftColor.g, bScalar ? b : rightColor.g);
                color4.b = apply(operation, aScalar ? a : leftColor.b, bScalar ? b : rightColor.b);
                color4.a = apply(operation, aScalar ? a : leftColor.a, bScalar ? b : rightColor.a);
                return color4;
            }
            if (typeof shape !== "number" && "z" in shape) {
                const leftVector = a as Vec3;
                const rightVector = b as Vec3;
                vector3.x = apply(operation, aScalar ? a : leftVector.x, bScalar ? b : rightVector.x);
                vector3.y = apply(operation, aScalar ? a : leftVector.y, bScalar ? b : rightVector.y);
                vector3.z = apply(operation, aScalar ? a : leftVector.z, bScalar ? b : rightVector.z);
                return vector3;
            }
            const leftVector = a as Vec2;
            const rightVector = b as Vec2;
            vector2.x = apply(operation, aScalar ? a : leftVector.x, bScalar ? b : rightVector.x);
            vector2.y = apply(operation, aScalar ? a : leftVector.y, bScalar ? b : rightVector.y);
            return vector2;
        };
        ctx.setOutput(block.id, "output", getter);
    },
};
