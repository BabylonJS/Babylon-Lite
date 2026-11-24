import { column } from "../../particle-buffer.js";
import type { NpeBlockEvaluator } from "../npe-build.js";

/**
 * `UpdateSpriteCellIndexBlock` — each update, floor the `cellIndex` input into the signed sprite cell-index column (a
 * no-op when unconnected). Signed storage keeps negative graph intermediates like Babylon.js's number; the atlas
 * validates the final cell when it renders. The birth reset belongs to the column's readers: the sprite sheet and the
 * `SpriteCellIndex` source each seed a spawned slot before any creation getter, so a write-only column needs none.
 */
export const npeBlock: NpeBlockEvaluator = {
    build(block, ctx) {
        if (!ctx.isConnected(block, "cellIndex")) {
            return;
        }
        const cellIndex = column(ctx.state.buffer!, "sprite.cellIndex", Int32Array);
        const value = ctx.input(block, "cellIndex");
        ctx.state.system!.updateSteps.push((i) => {
            cellIndex[i] = Math.floor(value(i) as number);
        });
    },
};
