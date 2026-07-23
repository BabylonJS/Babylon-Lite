import { useRandomSpriteSheet } from "../../sprite-columns-random.js";
import type { NpeBlockEvaluator } from "../npe-build.js";

/** `SetupSpriteSheetBlock` evaluator for systems with random start cells. */
export const setupSpriteSheetRandomBlock: NpeBlockEvaluator = {
    build(block, ctx) {
        const system = ctx.state.system!;
        const serialized = block.serialized;
        const sheet = useRandomSpriteSheet(ctx.state.buffer!, {
            startCellID: typeof serialized.start === "number" ? serialized.start : 0,
            endCellID: typeof serialized.end === "number" ? serialized.end : 0,
            loop: typeof serialized.loop === "boolean" ? serialized.loop : true,
            changeSpeed: typeof serialized.spriteCellChangeSpeed === "number" ? serialized.spriteCellChangeSpeed : 1,
        });
        system._spriteSheet = {
            cellWidth: typeof serialized.width === "number" ? serialized.width : 0,
            cellHeight: typeof serialized.height === "number" ? serialized.height : 0,
            cellIndex: sheet.cellIndex,
            update: sheet.update,
        };
        const previous = system.createColorDead;
        system.createColorDead = previous
            ? (i) => {
                  previous(i);
                  sheet.birth(i);
              }
            : sheet.birth;
    },
};
