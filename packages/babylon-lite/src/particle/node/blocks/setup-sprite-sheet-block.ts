import { useSpriteSheet, type SpriteSheetConfig } from "../../sprite-columns.js";
import type { NpeBlockEvaluator } from "../npe-build.js";

/**
 * `SetupSpriteSheetBlock` — configures the sprite-sheet feature. Allocates the sprite columns via
 * {@link useSpriteSheet} (only now, on this buffer), records the render cell dimensions + the per-particle
 * cell-index column + update step on the system's sprite handle, and owns the birth reset that seeds a spawned
 * particle's cell state before any creation slot, like Babylon.js `Particle._reset`. Random start cells
 * lazy-load their own column variant and still sample their offset in the update. A non-sprite system never
 * reaches this block, so it allocates no sprite columns and imports none of the sprite module.
 */
export const npeBlock: NpeBlockEvaluator = {
    async build(block, ctx) {
        const system = ctx.state.system!;
        const buffer = ctx.state.buffer!;
        const s = block.serialized;
        const config: SpriteSheetConfig = {
            startCellID: typeof s.start === "number" ? s.start : 0,
            endCellID: typeof s.end === "number" ? s.end : 0,
            loop: typeof s.loop === "boolean" ? s.loop : true,
            changeSpeed: typeof s.spriteCellChangeSpeed === "number" ? s.spriteCellChangeSpeed : 1,
        };
        const sheet = s.randomStartCell === true ? (await import("../../sprite-columns-random.js")).useRandomSpriteSheet(buffer, config) : useSpriteSheet(buffer, config);
        system._spriteSheet = {
            cellWidth: typeof s.width === "number" ? s.width : 0,
            cellHeight: typeof s.height === "number" ? s.height : 0,
            startCellID: config.startCellID,
            endCellID: config.endCellID,
            cellIndex: sheet.cellIndex,
            update: sheet.update,
        };
        // The sheet owns the birth reset and replaces a SpriteCellIndex reader's zero fallback, so a spawn writes the cell once.
        system._resetParticle = sheet.birth;
    },
};
