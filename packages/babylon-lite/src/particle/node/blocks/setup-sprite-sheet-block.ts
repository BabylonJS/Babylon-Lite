import type { ParticleSystem } from "../../particle-system.js";
import type { ParticleBlockEvaluator } from "../npe-types.js";

/**
 * `SetupSpriteSheetBlock` — configures the system's animation-sheet (sprite-sheet) properties: cell
 * dimensions, the start/end cell range, loop, random start cell, and cell change speed. It is a
 * pass-through in the creation chain (particle in → particle out) that sets the properties on the
 * {@link ParticleSystem}; the per-particle cell state is seeded at creation and advanced each frame by
 * {@link basicSpriteUpdateBlock}. Mirrors BJS `SetupSpriteSheetBlock`.
 */
export const setupSpriteSheetBlock: ParticleBlockEvaluator = {
    build(block, ctx) {
        const system = ctx.input(block, "particle")(ctx.state) as ParticleSystem;
        const s = block.serialized;

        system._isAnimationSheetEnabled = true;
        if (typeof s.width === "number") {
            system.spriteCellWidth = s.width;
        }
        if (typeof s.height === "number") {
            system.spriteCellHeight = s.height;
        }
        if (typeof s.start === "number") {
            system.startSpriteCellID = s.start;
        }
        if (typeof s.end === "number") {
            system.endSpriteCellID = s.end;
        }
        if (typeof s.loop === "boolean") {
            system.spriteCellLoop = s.loop;
        }
        if (typeof s.randomStartCell === "boolean") {
            system.spriteRandomStartCell = s.randomStartCell;
        }
        if (typeof s.spriteCellChangeSpeed === "number") {
            system.spriteCellChangeSpeed = s.spriteCellChangeSpeed;
        }

        ctx.setOutput(block.id, "output", () => system);
    },
};
