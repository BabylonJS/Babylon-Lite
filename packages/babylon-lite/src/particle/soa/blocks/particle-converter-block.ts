import type { Vec2, Vec3, Color4 } from "../../../math/types.js";
import type { SoaBlockEvaluator } from "../npe-build.js";

/**
 * `ParticleConverterBlock` (SoA) — composes a Color4 from component inputs and exposes every projection
 * (`color`, `xyz`, `xy`, `zw`, `x`, `y`, `z`, `w`), r↔x g↔y b↔z a↔w. Fills reused scratch. Mirrors the
 * object version.
 */
export const particleConverterBlock: SoaBlockEvaluator = {
    build(block, ctx) {
        const colorIn = ctx.input(block, "color");
        const xyzIn = ctx.input(block, "xyz");
        const xyIn = ctx.input(block, "xy");
        const zwIn = ctx.input(block, "zw");
        const xIn = ctx.input(block, "x");
        const yIn = ctx.input(block, "y");
        const zIn = ctx.input(block, "z");
        const wIn = ctx.input(block, "w");

        const hasColor = ctx.isConnected(block, "color");
        const hasXyz = ctx.isConnected(block, "xyz");
        const hasXy = ctx.isConnected(block, "xy");
        const hasZw = ctx.isConnected(block, "zw");
        const hasX = ctx.isConnected(block, "x");
        const hasY = ctx.isConnected(block, "y");
        const hasZ = ctx.isConnected(block, "z");
        const hasW = ctx.isConnected(block, "w");

        const data: Color4 = { r: 0, g: 0, b: 0, a: 0 };
        const fill = (i: number): void => {
            if (hasColor) {
                const c = colorIn(i) as Color4;
                data.r = c.r;
                data.g = c.g;
                data.b = c.b;
                data.a = c.a;
                return;
            }
            let x = 0;
            let y = 0;
            let z = 0;
            let w = 0;
            if (hasX) {
                x = xIn(i) as number;
            }
            if (hasY) {
                y = yIn(i) as number;
            }
            if (hasZ) {
                z = zIn(i) as number;
            }
            if (hasW) {
                w = wIn(i) as number;
            }
            if (hasXy) {
                const t = xyIn(i) as Vec2 | null;
                if (t) {
                    x = t.x;
                    y = t.y;
                }
            }
            if (hasZw) {
                const t = zwIn(i) as Vec2 | null;
                if (t) {
                    z = t.x;
                    w = t.y;
                }
            }
            if (hasXyz) {
                const t = xyzIn(i) as Vec3 | null;
                if (t) {
                    x = t.x;
                    y = t.y;
                    z = t.z;
                }
            }
            data.r = x;
            data.g = y;
            data.b = z;
            data.a = w;
        };

        const v3: Vec3 = { x: 0, y: 0, z: 0 };
        const v2a: Vec2 = { x: 0, y: 0 };
        const v2b: Vec2 = { x: 0, y: 0 };
        ctx.setOutput(block.id, "color", (i) => {
            fill(i);
            return data;
        });
        ctx.setOutput(block.id, "xyz", (i) => {
            fill(i);
            v3.x = data.r;
            v3.y = data.g;
            v3.z = data.b;
            return v3;
        });
        ctx.setOutput(block.id, "xy", (i) => {
            fill(i);
            v2a.x = data.r;
            v2a.y = data.g;
            return v2a;
        });
        ctx.setOutput(block.id, "zw", (i) => {
            fill(i);
            v2b.x = data.b;
            v2b.y = data.a;
            return v2b;
        });
        ctx.setOutput(block.id, "x", (i) => {
            fill(i);
            return data.r;
        });
        ctx.setOutput(block.id, "y", (i) => {
            fill(i);
            return data.g;
        });
        ctx.setOutput(block.id, "z", (i) => {
            fill(i);
            return data.b;
        });
        ctx.setOutput(block.id, "w", (i) => {
            fill(i);
            return data.a;
        });
    },
};
