import type { Vec3 } from "../../../math/types.js";
import type { NpeBlockEvaluator } from "../npe-build.js";
import type { ScalarGetter } from "../npe-value.js";

const OP_DOT = 0;
const OP_DISTANCE = 1;

/**
 * `ParticleVectorMathBlock` — Float `Dot` (the default) or `Distance` of two Vector3 operands. Like Babylon.js,
 * both operands must be connected. Unknown operations publish no output.
 */
export const npeBlock: NpeBlockEvaluator = {
    build(block, ctx) {
        const operation = typeof block.serialized.operation === "number" ? block.serialized.operation : OP_DOT;
        if ((operation !== OP_DOT && operation !== OP_DISTANCE) || !ctx.isConnected(block, "left") || !ctx.isConnected(block, "right")) {
            return;
        }
        const left = ctx.input(block, "left");
        const right = ctx.input(block, "right");
        const getter: ScalarGetter = (i) => {
            const l = left(i) as Vec3;
            const lx = l.x;
            const ly = l.y;
            const lz = l.z;
            const r = right(i) as Vec3;
            if (operation === OP_DOT) {
                return lx * r.x + ly * r.y + lz * r.z;
            }
            const dx = lx - r.x;
            const dy = ly - r.y;
            const dz = lz - r.z;
            return Math.sqrt(dx * dx + dy * dy + dz * dz);
        };
        ctx.setOutput(block.id, "output", getter);
    },
};
