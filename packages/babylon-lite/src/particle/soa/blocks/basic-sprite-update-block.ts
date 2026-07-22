import type { SoaBlockEvaluator } from "../npe-build.js";

/**
 * `BasicSpriteUpdateBlock` (SoA) — adds a per-frame update step that advances each particle's sprite-sheet
 * cell index. Graph construction validates and captures the sprite handle after the setup-sprite-sheet block
 * has built. Mirrors the object version.
 */
export const basicSpriteUpdateBlock: SoaBlockEvaluator = {
    build(_block, ctx) {
        const system = ctx.state.system!;
        const sheet = system._spriteSheet;
        if (!sheet) {
            throw new Error("SoA NodeParticle: BasicSpriteUpdateBlock requires SetupSpriteSheetBlock");
        }
        system.updateSteps.push((i) => {
            sheet.update(i);
        });
    },
};
