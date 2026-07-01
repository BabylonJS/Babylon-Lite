import type { Vec3, Color4 } from "../../../math/types.js";
import type { ParticleScale } from "../../particle.js";
import type { ParticleBlockEvaluator, ParticleValue, NpeGetter } from "../npe-types.js";

const OP_ADD = 0;
const OP_SUBTRACT = 1;
const OP_MULTIPLY = 2;
const OP_DIVIDE = 3;
const OP_MAX = 4;
const OP_MIN = 5;

function applyScalar(op: number, a: number, b: number): number {
    switch (op) {
        case OP_ADD:
            return a + b;
        case OP_SUBTRACT:
            return a - b;
        case OP_MULTIPLY:
            return a * b;
        case OP_DIVIDE:
            return a / b;
        case OP_MAX:
            return Math.max(a, b);
        case OP_MIN:
            return Math.min(a, b);
        default:
            return a;
    }
}

/** Replicate a scalar across each component (mirrors BJS `state.adapt`). */
function splatColor(s: number): Color4 {
    return { r: s, g: s, b: s, a: s };
}
function splatVec3(s: number): Vec3 {
    return { x: s, y: s, z: s };
}
function splatVec2(s: number): ParticleScale {
    return { x: s, y: s };
}

function applyOp(op: number, left: ParticleValue, right: ParticleValue): ParticleValue {
    const leftScalar = typeof left === "number";
    const rightScalar = typeof right === "number";

    if (leftScalar && rightScalar) {
        return applyScalar(op, left, right as number);
    }

    // Determine the vector shape from whichever operand is not a scalar; the other is splatted to match.
    const shape = (leftScalar ? right : left) as Vec3 | Color4 | ParticleScale;

    if ("r" in shape) {
        const a = leftScalar ? splatColor(left as number) : (left as Color4);
        const b = rightScalar ? splatColor(right as number) : (right as Color4);
        return { r: applyScalar(op, a.r, b.r), g: applyScalar(op, a.g, b.g), b: applyScalar(op, a.b, b.b), a: applyScalar(op, a.a, b.a) };
    }
    if ("z" in shape) {
        const a = leftScalar ? splatVec3(left as number) : (left as Vec3);
        const b = rightScalar ? splatVec3(right as number) : (right as Vec3);
        return { x: applyScalar(op, a.x, b.x), y: applyScalar(op, a.y, b.y), z: applyScalar(op, a.z, b.z) };
    }
    const a = leftScalar ? splatVec2(left as number) : (left as ParticleScale);
    const b = rightScalar ? splatVec2(right as number) : (right as ParticleScale);
    return { x: applyScalar(op, a.x, b.x), y: applyScalar(op, a.y, b.y) };
}

/**
 * `ParticleMathBlock` — applies an arithmetic operation (add/subtract/multiply/divide/max/min) to two
 * inputs. Scalar+scalar stays scalar; scalar+vector replicates the scalar across the vector's components
 * (BJS `adapt`). Mirrors BJS `ParticleMathBlock`.
 */
export const particleMathBlock: ParticleBlockEvaluator = {
    build(block, ctx) {
        const operation = typeof block.serialized.operation === "number" ? block.serialized.operation : OP_ADD;
        const leftGetter = ctx.input(block, "left");
        const rightGetter = ctx.input(block, "right");

        const getter: NpeGetter = (state) => applyOp(operation, leftGetter(state), rightGetter(state));
        ctx.setOutput(block.id, "output", getter);
    },
};
