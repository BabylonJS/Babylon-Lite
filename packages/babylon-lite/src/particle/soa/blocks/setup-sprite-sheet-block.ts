import { useSpriteSheet, type SpriteSheetConfig } from "../sprite-columns.js";
import type { SoaBlockEvaluator } from "../npe-build.js";

/**
 * `SetupSpriteSheetBlock` (SoA) — configures the sprite-sheet feature. Allocates the sprite columns via
 * {@link useSpriteSheet} (only now, on this buffer), records the render cell dimensions + the per-particle
 * cell-index column + update step on the system's sprite handle, and attaches the birth hook that seeds a
 * new particle's cell state. A non-sprite system never reaches this block, so it allocates no sprite
 * columns and imports none of the sprite module. Mirrors the object version.
 */
export const setupSpriteSheetBlock: SoaBlockEvaluator = {
    build(block, ctx) {
        const system = ctx.state.system!;
        const buffer = ctx.state.buffer!;
        const s = block.serialized;
        const config: SpriteSheetConfig = {
            startCellID: typeof s.start === "number" ? s.start : 0,
            endCellID: typeof s.end === "number" ? s.end : 0,
            loop: typeof s.loop === "boolean" ? s.loop : true,
            changeSpeed: typeof s.spriteCellChangeSpeed === "number" ? s.spriteCellChangeSpeed : 1,
        };
        const sheet = useSpriteSheet(buffer, config);
        system._spriteSheet = {
            cellWidth: typeof s.width === "number" ? s.width : 0,
            cellHeight: typeof s.height === "number" ? s.height : 0,
            cellIndex: sheet.cellIndex,
            update: sheet.update,
        };
        const previousColorDead = system.createColorDead;
        system.createColorDead = previousColorDead
            ? (i) => {
                  previousColorDead(i);
                  sheet.birth(i);
              }
            : sheet.birth;
    },
};
