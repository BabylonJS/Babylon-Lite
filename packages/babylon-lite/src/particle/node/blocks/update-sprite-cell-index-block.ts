import { column } from "../../particle-buffer.js";
import type { NpeBlockEvaluator } from "../npe-build.js";

/**
 * `UpdateSpriteCellIndexBlock` — each update, floor the `cellIndex` input into the sprite cell-index column (a no-op
 * when unconnected). Babylon.js resets a recycled particle's cell to the sprite sheet's start cell, which is 0 without
 * a sheet; with no `SetupSpriteSheetBlock` built yet, this block owns that reset and runs it before every creation
 * slot, since spawned slots keep stale column data. A sheet built later seeds its own start cell at birth.
 */
export const npeBlock: NpeBlockEvaluator = {
    build(block, ctx) {
        if (!ctx.isConnected(block, "cellIndex")) {
            return;
        }
        const system = ctx.state.system!;
        const cellIndex = column(ctx.state.buffer!, "sprite.cellIndex", Uint16Array);
        const value = ctx.input(block, "cellIndex");
        system.updateSteps.push((i) => {
            cellIndex[i] = Math.floor(value(i) as number);
        });
        if (!system._spriteSheet) {
            const previous = system.createLifeTime;
            system.createLifeTime = (i) => {
                cellIndex[i] = 0;
                previous?.(i);
            };
        }
    },
};
