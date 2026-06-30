import type { Color4, Vec3 } from "../../../math/types.js";
import type { ParticleScale } from "../../particle.js";
import type { ParticleBlockEvaluator, ParticleValue, NpeBuildState } from "../npe-types.js";

/**
 * `ParticleConverterBlock` — composes a Color4 from individual or partial component inputs and exposes it
 * as every projection (`color`, `xyz`, `xy`, `zw`, `x`, `y`, `z`, `w`). Component order maps r↔x, g↔y,
 * b↔z, a↔w. Mirrors BJS `ParticleConverterBlock`.
 */
export const particleConverterBlock: ParticleBlockEvaluator = {
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

        const getData = (state: NpeBuildState): Color4 => {
            if (hasColor) {
                const color = colorIn(state) as Color4;
                return { r: color.r, g: color.g, b: color.b, a: color.a };
            }

            let x = 0;
            let y = 0;
            let z = 0;
            let w = 0;

            if (hasX) {
                x = xIn(state) as number;
            }
            if (hasY) {
                y = yIn(state) as number;
            }
            if (hasZ) {
                z = zIn(state) as number;
            }
            if (hasW) {
                w = wIn(state) as number;
            }
            if (hasXy) {
                const temp = xyIn(state) as ParticleScale | null;
                if (temp) {
                    x = temp.x;
                    y = temp.y;
                }
            }
            if (hasZw) {
                const temp = zwIn(state) as ParticleScale | null;
                if (temp) {
                    z = temp.x;
                    w = temp.y;
                }
            }
            if (hasXyz) {
                const temp = xyzIn(state) as Vec3 | null;
                if (temp) {
                    x = temp.x;
                    y = temp.y;
                    z = temp.z;
                }
            }

            return { r: x, g: y, b: z, a: w };
        };

        ctx.setOutput(block.id, "color", (state) => getData(state) as ParticleValue);
        ctx.setOutput(block.id, "xyz", (state) => {
            const data = getData(state);
            return { x: data.r, y: data.g, z: data.b };
        });
        ctx.setOutput(block.id, "xy", (state) => {
            const data = getData(state);
            return { x: data.r, y: data.g };
        });
        ctx.setOutput(block.id, "zw", (state) => {
            const data = getData(state);
            return { x: data.b, y: data.a };
        });
        ctx.setOutput(block.id, "x", (state) => getData(state).r);
        ctx.setOutput(block.id, "y", (state) => getData(state).g);
        ctx.setOutput(block.id, "z", (state) => getData(state).b);
        ctx.setOutput(block.id, "w", (state) => getData(state).a);
    },
};
