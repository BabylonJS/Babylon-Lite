import { copyVec3 } from "../../particle-math.js";
import type { Vec3 } from "../../../math/types.js";
import type { ParticleSystem } from "../../particle-system.js";
import type { ParticleBlockEvaluator } from "../npe-types.js";

/**
 * `UpdatePositionBlock` — each step, sets the particle position to the value of its `position` input
 * (typically `currentPosition + scaledDirection`). Mirrors BJS `UpdatePositionBlock`.
 */
export const updatePositionBlock: ParticleBlockEvaluator = {
    build(block, ctx) {
        const state = ctx.state;
        const system = ctx.input(block, "particle")(state) as ParticleSystem;
        ctx.setOutput(block.id, "output", () => system);

        if (!ctx.isConnected(block, "position")) {
            return;
        }
        const positionGetter = ctx.input(block, "position");

        system._updateQueue.push((particle, sys) => {
            state.particle = particle;
            state.system = sys;
            copyVec3(particle.position, positionGetter(state) as Vec3);
        });
    },
};
