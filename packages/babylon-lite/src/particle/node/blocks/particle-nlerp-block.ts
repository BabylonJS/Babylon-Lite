import type { Vec2, Vec3, Color4 } from "../../../math/types.js";
import type { NpeBlockEvaluator } from "../npe-build.js";
import type { NpeGetter } from "../npe-value.js";

/**
 * `ParticleNLerpBlock` — `(1 - gradient) * left + gradient * right` (gradient defaults to 0), normalized for
 * vectors and colours; scalars are a plain lerp. Like Babylon.js, both operands must be connected, inputs are read
 * left, right, then gradient, and the output keeps the `left` typing.
 */
export const npeBlock: NpeBlockEvaluator = {
    build(block, ctx) {
        if (!ctx.isConnected(block, "left") || !ctx.isConnected(block, "right")) {
            return;
        }
        const left = ctx.input(block, "left");
        const right = ctx.input(block, "right");
        const gradient = ctx.input(block, "gradient", () => 0);
        const v2: Vec2 = { x: 0, y: 0 };
        const v3: Vec3 = { x: 0, y: 0, z: 0 };
        const c4: Color4 = { r: 0, g: 0, b: 0, a: 0 };

        const getter: NpeGetter = (i) => {
            const l = left(i);
            if (typeof l === "number") {
                const r = right(i) as number;
                const g = gradient(i) as number;
                return (1 - g) * l + g * r;
            }
            if ("r" in l) {
                const lr = l.r;
                const lg = l.g;
                const lb = l.b;
                const la = l.a;
                const r = right(i) as Color4;
                const rr = r.r;
                const rg = r.g;
                const rb = r.b;
                const ra = r.a;
                const g = gradient(i) as number;
                c4.r = (1 - g) * lr + g * rr;
                c4.g = (1 - g) * lg + g * rg;
                c4.b = (1 - g) * lb + g * rb;
                c4.a = (1 - g) * la + g * ra;
                const length = Math.sqrt(c4.r * c4.r + c4.g * c4.g + c4.b * c4.b + c4.a * c4.a);
                if (length !== 0) {
                    const scale = 1 / length;
                    c4.r *= scale;
                    c4.g *= scale;
                    c4.b *= scale;
                    c4.a *= scale;
                }
                return c4;
            }
            if ("z" in l) {
                const lx = l.x;
                const ly = l.y;
                const lz = l.z;
                const r = right(i) as Vec3;
                const rx = r.x;
                const ry = r.y;
                const rz = r.z;
                const g = gradient(i) as number;
                v3.x = (1 - g) * lx + g * rx;
                v3.y = (1 - g) * ly + g * ry;
                v3.z = (1 - g) * lz + g * rz;
                const length = Math.sqrt(v3.x * v3.x + v3.y * v3.y + v3.z * v3.z);
                if (length !== 0) {
                    const scale = 1 / length;
                    v3.x *= scale;
                    v3.y *= scale;
                    v3.z *= scale;
                }
                return v3;
            }
            const lx = l.x;
            const ly = l.y;
            const r = right(i) as Vec2;
            const rx = r.x;
            const ry = r.y;
            const g = gradient(i) as number;
            v2.x = (1 - g) * lx + g * rx;
            v2.y = (1 - g) * ly + g * ry;
            const length = Math.sqrt(v2.x * v2.x + v2.y * v2.y);
            if (length !== 0) {
                const scale = 1 / length;
                v2.x *= scale;
                v2.y *= scale;
            }
            return v2;
        };

        ctx.setOutput(block.id, "output", getter, ctx.isInt(block, "left"));
    },
};
