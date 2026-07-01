import type { ParticleSystem } from "../../particle-system.js";
import type { ParticleBlockEvaluator } from "../npe-types.js";

/**
 * `UpdateAngleBlock` — each step, sets the particle angle to the value of its `angle` input (typically
 * `currentAngle + angularSpeed * scaledUpdateSpeed`). Mirrors BJS `UpdateAngleBlock`.
 */
export const updateAngleBlock: ParticleBlockEvaluator = {
    build(block, ctx) {
        const state = ctx.state;
        const system = ctx.input(block, "particle")(state) as ParticleSystem;
        ctx.setOutput(block.id, "output", () => system);

        if (!ctx.isConnected(block, "angle")) {
            return;
        }
        const angleGetter = ctx.input(block, "angle");

        system._updateQueue.push((particle, sys) => {
            state.particle = particle;
            state.system = sys;
            particle.angle = angleGetter(state) as number;
        });
    },
};
