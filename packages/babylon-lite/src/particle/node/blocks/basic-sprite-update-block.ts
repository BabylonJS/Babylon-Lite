import type { NpeBlockEvaluator } from "../npe-build.js";

/**
 * `BasicSpriteUpdateBlock` — adds a per-frame update step that advances each particle's sprite-sheet
 * cell index. Graph construction validates and captures the sprite handle after the setup-sprite-sheet block
 * has built.
 */
export const basicSpriteUpdateBlock: NpeBlockEvaluator = {
    build(_block, ctx) {
        const system = ctx.state.system!;
        const sheet = system._spriteSheet;
        if (!sheet) {
            throw new Error("NodeParticle: BasicSpriteUpdateBlock requires SetupSpriteSheetBlock");
        }
        system.updateSteps.push((i) => {
            sheet.update(i);
        });
    },
};
