import type { Particle } from "../../particle.js";
import type { ParticleSystem } from "../../particle-system.js";
import type { ParticleBlockEvaluator } from "../npe-types.js";

/** Clamp to [0, 1] (matches BJS `Clamp(value)` default bounds). */
function clamp01(value: number): number {
    return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * Advance a particle's animation-sheet cell index for the current frame. Mirrors BJS
 * `Particle.updateCellIndex`: the cell cycles through `[initialStart, initialEnd]` over the particle's
 * life, `spriteCellChangeSpeed` cycles per life; `spriteRandomStartCell` offsets each particle's phase by
 * a per-particle random fraction of its life (drawn lazily on the first update).
 */
function updateCellIndex(particle: Particle, system: ParticleSystem): void {
    // Set by SetupSpriteSheetBlock, which always precedes this update block in the graph, so it is
    // non-null whenever this hook runs. Reading it here (rather than named system fields) keeps the sprite
    // config off the shared ParticleSystem shape.
    const sheet = system._spriteSheet!;
    let offsetAge = particle.age;
    let changeSpeed = sheet.changeSpeed;

    if (sheet.randomStartCell) {
        if (particle._randomCellOffset < 0) {
            particle._randomCellOffset = Math.random() * particle.lifeTime;
        }
        if (changeSpeed === 0) {
            // Speed 0 means "stay on the (random) start cell": use the offset as a fixed phase.
            changeSpeed = 1;
            offsetAge = particle._randomCellOffset;
        } else {
            offsetAge += particle._randomCellOffset;
        }
    }

    const dist = particle._initialEndSpriteCellId - particle._initialStartSpriteCellId + 1;
    const ratio = particle._initialSpriteCellLoop
        ? clamp01(((offsetAge * changeSpeed) % particle.lifeTime) / particle.lifeTime)
        : clamp01((offsetAge * changeSpeed) / particle.lifeTime);

    particle.cellIndex = (particle._initialStartSpriteCellId + ratio * dist) | 0;
}

/**
 * `BasicSpriteUpdateBlock` — adds a per-frame update step that advances each particle's animation-sheet
 * `cellIndex` (see {@link updateCellIndex}). Pass-through in the update chain (particle in → particle
 * out). Mirrors BJS `BasicSpriteUpdateBlock`, which calls `particle.updateCellIndex()` each step.
 */
export const basicSpriteUpdateBlock: ParticleBlockEvaluator = {
    build(block, ctx) {
        const system = ctx.input(block, "particle")(ctx.state) as ParticleSystem;
        if (!system._spriteSheet) {
            throw new Error("NodeParticle: BasicSpriteUpdateBlock requires SetupSpriteSheetBlock");
        }
        ctx.setOutput(block.id, "output", () => system);
        system._updateQueue.push(updateCellIndex);
    },
};
