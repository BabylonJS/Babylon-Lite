import { createGridSpriteAtlas } from "../sprite/shared/sprite-atlas.js";
import { createFacingBillboardSystem, addBillboardSpriteIndex, clearBillboardSprites } from "../sprite/billboard-sprite.js";
import { billboardBlendAdditive, billboardBlendAlpha, billboardBlendOneOne } from "../sprite/billboard-blend.js";
import type { BillboardBlendMode, FacingBillboardSpriteSystem } from "../sprite/billboard-sprite.js";
import type { ParticleSystem } from "./particle-system.js";

const BLENDMODE_ONEONE = 0;
const BLENDMODE_STANDARD = 1;

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
 * Convert a particle system into its generic camera-facing billboard rendering representation.
 * A graph without an animation sheet uses the texture as a single-frame atlas.
 */
export function createParticleBillboard(system: ParticleSystem): FacingBillboardSpriteSystem {
    const texture = system.texture;
    if (!texture) {
        throw new Error("createParticleBillboard: the particle system has no texture");
    }
    const sheet = system._spriteSheet;
    const atlas = createGridSpriteAtlas(texture, {
        // With a sprite sheet the texture is a grid of cells; otherwise it is a single-frame sprite.
        cellWidthPx: sheet && sheet.cellWidth > 0 ? sheet.cellWidth : texture.width,
        cellHeightPx: sheet && sheet.cellHeight > 0 ? sheet.cellHeight : texture.height,
    });
    const blendMode = system._particleBlend ?? blendForMode(system.blendMode);
    return createFacingBillboardSystem(atlas, { capacity: system.buffer.capacity, blendMode });
}

/** Upload the current set of alive particles into the billboard instance buffer (call once per frame). */
export function syncParticleBillboard(system: ParticleSystem, billboard: FacingBillboardSpriteSystem): void {
    clearBillboardSprites(billboard);
    const buffer = system.buffer;
    const posX = buffer.posX;
    const posY = buffer.posY;
    const posZ = buffer.posZ;
    const size = buffer.size;
    const scaleX = buffer.scaleX;
    const scaleY = buffer.scaleY;
    const angle = buffer.angle;
    const colR = buffer.colorR;
    const colG = buffer.colorG;
    const colB = buffer.colorB;
    const colA = buffer.colorA;
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
