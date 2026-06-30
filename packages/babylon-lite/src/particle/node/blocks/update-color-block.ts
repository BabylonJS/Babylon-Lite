import { copyColor4 } from "../../particle-math.js";
import type { Color4 } from "../../../math/types.js";
import type { ParticleSystem } from "../../particle-system.js";
import type { ParticleBlockEvaluator } from "../npe-types.js";

/**
 * `UpdateColorBlock` — each step, sets the particle colour to the value of its `color` input (typically
 * `currentColour + scaledColorStep` with the alpha clamped). Mirrors BJS `UpdateColorBlock`.
 */
export const updateColorBlock: ParticleBlockEvaluator = {
    build(block, ctx) {
        const state = ctx.state;
        const system = ctx.input(block, "particle")(state) as ParticleSystem;
        ctx.setOutput(block.id, "output", () => system);

        if (!ctx.isConnected(block, "color")) {
            return;
        }
        const colorGetter = ctx.input(block, "color");

        system._updateQueue.push((particle, sys) => {
            state.particle = particle;
            state.system = sys;
            copyColor4(particle.color, colorGetter(state) as Color4);
        });
    },
};
