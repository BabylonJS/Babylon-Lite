import type { Vec2, Vec3, Color4 } from "../../../math/types.js";
import type { NpeBlockEvaluator } from "../npe-build.js";
import type { NpeGetter } from "../npe-value.js";

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

/**
 * `ParticleMathBlock` — arithmetic on two inputs; scalar+vector splats the scalar. Writes results into
 * a reused scratch (never a fresh object) so it is allocation-free even on the update hot path. Mirrors the
 * object version's math and `adapt` semantics.
 */
export const particleMathBlock: NpeBlockEvaluator = {
    build(block, ctx) {
        const op = typeof block.serialized.operation === "number" ? block.serialized.operation : OP_ADD;
        const left = ctx.input(block, "left");
        const right = ctx.input(block, "right");
        const v3: Vec3 = { x: 0, y: 0, z: 0 };
        const c4: Color4 = { r: 0, g: 0, b: 0, a: 0 };
        const v2: Vec2 = { x: 0, y: 0 };

        const getter: NpeGetter = (i) => {
            const l = left(i);
            if (typeof l === "number") {
                const r = right(i);
                if (typeof r === "number") {
                    return applyScalar(op, l, r);
                }
                if ("r" in r) {
                    c4.r = applyScalar(op, l, r.r);
                    c4.g = applyScalar(op, l, r.g);
                    c4.b = applyScalar(op, l, r.b);
                    c4.a = applyScalar(op, l, r.a);
                    return c4;
                }
                if ("z" in r) {
                    v3.x = applyScalar(op, l, r.x);
                    v3.y = applyScalar(op, l, r.y);
                    v3.z = applyScalar(op, l, r.z);
                    return v3;
                }
                v2.x = applyScalar(op, l, r.x);
                v2.y = applyScalar(op, l, r.y);
                return v2;
            }
            if ("r" in l) {
                c4.r = l.r;
                c4.g = l.g;
                c4.b = l.b;
                c4.a = l.a;
                const r = right(i);
                const scalar = typeof r === "number";
                c4.r = applyScalar(op, c4.r, scalar ? r : "r" in r ? r.r : 0);
                c4.g = applyScalar(op, c4.g, scalar ? r : "r" in r ? r.g : 0);
                c4.b = applyScalar(op, c4.b, scalar ? r : "r" in r ? r.b : 0);
                c4.a = applyScalar(op, c4.a, scalar ? r : "r" in r ? r.a : 0);
                return c4;
            }
            if ("z" in l) {
                v3.x = l.x;
                v3.y = l.y;
                v3.z = l.z;
                const r = right(i);
                const scalar = typeof r === "number";
                v3.x = applyScalar(op, v3.x, scalar ? r : "z" in r ? r.x : 0);
                v3.y = applyScalar(op, v3.y, scalar ? r : "z" in r ? r.y : 0);
                v3.z = applyScalar(op, v3.z, scalar ? r : "z" in r ? r.z : 0);
                return v3;
            }
            v2.x = l.x;
            v2.y = l.y;
            const r = right(i);
            const scalar = typeof r === "number";
            const vector = !scalar && !("r" in r) && !("z" in r) ? r : null;
            v2.x = applyScalar(op, v2.x, scalar ? r : (vector?.x ?? 0));
            v2.y = applyScalar(op, v2.y, scalar ? r : (vector?.y ?? 0));
            return v2;
        };

        ctx.setOutput(block.id, "output", getter);
    },
};
