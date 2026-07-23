import { createGridSpriteAtlas } from "../../sprite/shared/sprite-atlas.js";
import { createFacingBillboardSystem, addBillboardSpriteIndex, clearBillboardSprites } from "../../sprite/billboard-sprite.js";
import { billboardBlendAdditive, billboardBlendAlpha, billboardBlendOneOne } from "../../sprite/billboard-blend.js";
import type { BillboardBlendMode, FacingBillboardSpriteSystem } from "../../sprite/billboard-sprite.js";
import { column } from "./particle-buffer.js";
import * as C from "./columns.js";
import type { SoaSystem } from "./animate.js";

const BLENDMODE_ONEONE = 0; // Babylon.js BLENDMODE_ONEONE (pure additive, src·1 + dst)
const BLENDMODE_STANDARD = 1; // Babylon.js BLENDMODE_STANDARD (alpha blend)

/** Map a particle-system blend mode to a billboard blend descriptor (mirrors the object renderer). */
function blendForMode(mode: number): BillboardBlendMode {
    if (mode === BLENDMODE_STANDARD) {
        return billboardBlendAlpha;
    }
    if (mode === BLENDMODE_ONEONE) {
        return billboardBlendOneOne;
    }
    return billboardBlendAdditive;
}

/**
 * Create a camera-facing billboard system that renders a particle system's live columns using its texture.
 * A graph without an animation sheet uses the texture as a single-frame atlas.
 */
export function createSoaParticleBillboard(system: SoaSystem): FacingBillboardSpriteSystem {
    const texture = system.texture;
    if (!texture) {
        throw new Error("createSoaParticleBillboard: the particle system has no texture");
    }
    const sheet = system._spriteSheet;
    const atlas = createGridSpriteAtlas(texture, {
        // With a sprite sheet the texture is a grid of cells; otherwise it is a single-frame sprite.
        cellWidthPx: sheet && sheet.cellWidth > 0 ? sheet.cellWidth : texture.width,
        cellHeightPx: sheet && sheet.cellHeight > 0 ? sheet.cellHeight : texture.height,
    });
    return createFacingBillboardSystem(atlas, { capacity: system.buffer.capacity, blendMode: blendForMode(system.blendMode) });
}

/** Upload the current set of alive particles into the billboard instance buffer (call once per frame). */
export function syncSoaParticleBillboard(system: SoaSystem, billboard: FacingBillboardSpriteSystem): void {
    clearBillboardSprites(billboard);
    const buffer = system.buffer;
    const posX = buffer.posX;
    const posY = buffer.posY;
    const posZ = buffer.posZ;
    const size = column(buffer, C.COL_SIZE, Float32Array);
    const scaleX = column(buffer, C.COL_SCALE_X, Float32Array);
    const scaleY = column(buffer, C.COL_SCALE_Y, Float32Array);
    const angle = column(buffer, C.COL_ANGLE, Float32Array);
    const colR = column(buffer, C.COL_COLOR_R, Float32Array);
    const colG = column(buffer, C.COL_COLOR_G, Float32Array);
    const colB = column(buffer, C.COL_COLOR_B, Float32Array);
    const colA = column(buffer, C.COL_COLOR_A, Float32Array);
    const cellIndex = system._spriteSheet ? system._spriteSheet.cellIndex : null;

    for (let i = 0; i < buffer.alive; i++) {
        addBillboardSpriteIndex(billboard, {
            position: [posX[i]!, posY[i]!, posZ[i]!],
            sizeWorld: [size[i]! * scaleX[i]!, size[i]! * scaleY[i]!],
            color: [colR[i]!, colG[i]!, colB[i]!, colA[i]!],
            rotation: angle[i]!,
            frame: cellIndex ? cellIndex[i]! : 0,
        });
    }
}
