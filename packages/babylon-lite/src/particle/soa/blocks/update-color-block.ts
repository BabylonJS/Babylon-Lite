import { column } from "../particle-buffer.js";
import * as C from "../columns.js";
import type { Color4 } from "../../../math/types.js";
import type { SoaBlockEvaluator } from "../npe-build.js";

/**
 * `UpdateColorBlock` (SoA) — each step, writes the particle colour columns from the `color` input
 * (typically `currentColour + scaledColorStep`). Mirrors the object version.
 */
export const updateColorBlock: SoaBlockEvaluator = {
    build(block, ctx) {
        const system = ctx.state.system!;
        const buffer = ctx.state.buffer!;
        if (!ctx.isConnected(block, "color")) {
            return;
        }
        const colorGetter = ctx.input(block, "color");
        const colR = column(buffer, C.COL_COLOR_R, Float32Array);
        const colG = column(buffer, C.COL_COLOR_G, Float32Array);
        const colB = column(buffer, C.COL_COLOR_B, Float32Array);
        const colA = column(buffer, C.COL_COLOR_A, Float32Array);

        system.updateSteps.push((i) => {
            const c = colorGetter(i) as Color4;
            colR[i] = c.r;
            colG[i] = c.g;
            colB[i] = c.b;
            colA[i] = c.a;
        });
    },
};
