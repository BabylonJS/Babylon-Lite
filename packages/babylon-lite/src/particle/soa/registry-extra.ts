import type { SoaBlockEvaluator } from "./npe-build.js";

/** Resolve optional blocks after the base registry misses. This entire loader table is a lazy chunk. */
export async function loadExtraBlockEvaluator(className: string): Promise<SoaBlockEvaluator> {
    switch (className) {
        case "UpdateSizeBlock":
            return (await import("./blocks/update-size-block.js")).updateSizeBlock;
        case "ParticleGradientBlock":
            return (await import("./blocks/particle-gradient-block.js")).particleGradientBlock;
        case "ParticleGradientValueBlock":
            return (await import("./blocks/particle-gradient-value-block.js")).particleGradientValueBlock;
        case "SetupSpriteSheetBlock":
            return (await import("./blocks/setup-sprite-sheet-block.js")).setupSpriteSheetBlock;
        case "BasicSpriteUpdateBlock":
            return (await import("./blocks/basic-sprite-update-block.js")).basicSpriteUpdateBlock;
        default:
            return (await import("./registry-extra-basic.js")).loadBasicBlockEvaluator(className);
    }
}
