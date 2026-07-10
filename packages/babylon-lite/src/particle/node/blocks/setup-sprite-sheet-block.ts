import type { ParticleSystem, SpriteSheetConfig } from "../../particle-system.js";
import type { ParticleBlockEvaluator } from "../npe-types.js";

/**
 * `SetupSpriteSheetBlock` — configures the system's animation-sheet (sprite-sheet): cell dimensions, the
 * start/end cell range, loop, random start cell, and cell change speed. It is a pass-through in the
 * creation chain (particle in → particle out) that stores the config in {@link ParticleSystem._spriteSheet}
 * and attaches a creation birth-hook that seeds each particle's cell state; the cell is then advanced each
 * frame by {@link basicSpriteUpdateBlock}. Mirrors BJS `SetupSpriteSheetBlock`.
 */
export const setupSpriteSheetBlock: ParticleBlockEvaluator = {
    build(block, ctx) {
        const system = ctx.input(block, "particle")(ctx.state) as ParticleSystem;
        const s = block.serialized;

        // All sprite config lives in one handle on the system (one optional field, not eight named props
        // with defaults on every particle system). Absent serialized fields fall back to the BJS defaults
        // the core previously initialized.
        const sheet: SpriteSheetConfig = {
            cellWidth: typeof s.width === "number" ? s.width : 0,
            cellHeight: typeof s.height === "number" ? s.height : 0,
            startCellID: typeof s.start === "number" ? s.start : 0,
            endCellID: typeof s.end === "number" ? s.end : 0,
            loop: typeof s.loop === "boolean" ? s.loop : true,
            randomStartCell: typeof s.randomStartCell === "boolean" ? s.randomStartCell : false,
            changeSpeed: typeof s.spriteCellChangeSpeed === "number" ? s.spriteCellChangeSpeed : 1,
        };
        system._spriteSheet = sheet;

        // Birth hook: capture the cell range on each particle at creation (immutable for its life) and seed
        // the starting cell. Pushed onto the generic creation queue so the core sim loop carries no
        // sprite-specific branch. Draws no RNG (the random start-cell offset is drawn lazily on first
        // update), so the creation random sequence matches Babylon.js.
        system._createQueue.push((particle) => {
            particle._initialStartSpriteCellId = sheet.startCellID;
            particle._initialEndSpriteCellId = sheet.endCellID;
            particle._initialSpriteCellLoop = sheet.loop;
            particle.cellIndex = sheet.startCellID;
            particle._randomCellOffset = -1;
        });

        ctx.setOutput(block.id, "output", () => system);
    },
};
