import { createGridSpriteAtlas } from "../sprite/shared/sprite-atlas.js";
import { createFacingBillboardSystem, addBillboardSpriteIndex, clearBillboardSprites } from "../sprite/billboard-sprite.js";
import { billboardBlendAdditive, billboardBlendAlpha } from "../sprite/billboard-blend.js";
import type { BillboardBlendMode, FacingBillboardSpriteSystem } from "../sprite/billboard-sprite.js";
import type { ParticleSystem } from "./particle-system.js";

const BLENDMODE_STANDARD = 1; // Babylon.js BaseParticleSystem.BLENDMODE_STANDARD (alpha blend)

/** Map a particle-system blend mode to a billboard blend descriptor. */
function blendForMode(mode: number): BillboardBlendMode {
    // ONEONE (0), ADD (2), MULTIPLYADD (4) all render additively; STANDARD (1) is alpha-blended.
    return mode === BLENDMODE_STANDARD ? billboardBlendAlpha : billboardBlendAdditive;
}

/**
 * Create a camera-facing billboard system that renders `system`'s particles using the system's texture.
 * The texture becomes a single-frame atlas; the blend mode follows the system's blend mode.
 */
export function createParticleBillboard(system: ParticleSystem): FacingBillboardSpriteSystem {
    const texture = system.texture;
    if (!texture) {
        throw new Error("createParticleBillboard: the particle system has no texture");
    }
    const atlas = createGridSpriteAtlas(texture, { cellWidthPx: texture.width, cellHeightPx: texture.height });
    return createFacingBillboardSystem(atlas, { capacity: system.capacity, blendMode: blendForMode(system.blendMode) });
}

/** Upload the current set of alive particles into the billboard instance buffer (call once per frame). */
export function syncParticleBillboard(system: ParticleSystem, billboard: FacingBillboardSpriteSystem): void {
    clearBillboardSprites(billboard);
    const particles = system._particles;
    for (let i = 0; i < particles.length; i++) {
        const particle = particles[i]!;
        addBillboardSpriteIndex(billboard, {
            position: [particle.position.x, particle.position.y, particle.position.z],
            sizeWorld: [particle.size * particle.scale.x, particle.size * particle.scale.y],
            color: [particle.color.r, particle.color.g, particle.color.b, particle.color.a],
            rotation: particle.angle,
            frame: 0,
        });
    }
}
