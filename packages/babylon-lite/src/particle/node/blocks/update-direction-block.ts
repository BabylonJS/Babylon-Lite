import { copyVec3 } from "../../particle-math.js";
import type { Vec3 } from "../../../math/types.js";
import type { ParticleSystem } from "../../particle-system.js";
import type { ParticleBlockEvaluator } from "../npe-types.js";

/**
 * `UpdateDirectionBlock` — each step, sets the particle direction (velocity) to the value of its
 * `direction` input (typically `currentDirection + gravity * scaledUpdateSpeed`, after drag/limit math).
 * Mirrors BJS `UpdateDirectionBlock`.
 */
export const updateDirectionBlock: ParticleBlockEvaluator = {
    build(block, ctx) {
        const state = ctx.state;
        const system = ctx.input(block, "particle")(state) as ParticleSystem;
        ctx.setOutput(block.id, "output", () => system);

        if (!ctx.isConnected(block, "direction")) {
            return;
        }
        const directionGetter = ctx.input(block, "direction");

        system._updateQueue.push((particle, sys) => {
            state.particle = particle;
            state.system = sys;
            copyVec3(particle.direction, directionGetter(state) as Vec3);
        });
    },
};
