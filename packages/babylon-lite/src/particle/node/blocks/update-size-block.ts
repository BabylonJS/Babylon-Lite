import type { ParticleSystem } from "../../particle-system.js";
import type { ParticleBlockEvaluator } from "../npe-types.js";

/**
 * `UpdateSizeBlock` — each step, sets the particle size to the value of its `size` input (typically a size
 * gradient evaluated at the age/lifetime ratio, so the particle grows or shrinks over its life). Mirrors
 * BJS `UpdateSizeBlock`.
 */
export const updateSizeBlock: ParticleBlockEvaluator = {
    build(block, ctx) {
        const state = ctx.state;
        const system = ctx.input(block, "particle")(state) as ParticleSystem;
        ctx.setOutput(block.id, "output", () => system);

        if (!ctx.isConnected(block, "size")) {
            return;
        }
        const sizeGetter = ctx.input(block, "size");

        system._updateQueue.push((particle, sys) => {
            state.particle = particle;
            state.system = sys;
            particle.size = sizeGetter(state) as number;
        });
    },
};
