import type { SoaBlockEvaluator } from "../npe-build.js";

/**
 * `BasicSpriteUpdateBlock` (SoA) — adds a per-frame update step that advances each particle's sprite-sheet
 * cell index. The step reads the system's sprite handle lazily at runtime, so it does not depend on whether
 * the setup-sprite-sheet block has built yet. Mirrors the object version.
 */
export const basicSpriteUpdateBlock: SoaBlockEvaluator = {
    build(_block, ctx) {
        const system = ctx.state.system!;
        system.updateSteps.push((i) => {
            system._spriteSheet!.update(i);
        });
    },
};
