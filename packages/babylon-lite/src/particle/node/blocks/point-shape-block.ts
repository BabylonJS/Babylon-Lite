import { randomRange } from "../../particle-math.js";
import type { Vec3 } from "../../../math/types.js";
import type { ParticleSystem } from "../../particle-system.js";
import type { ParticleBlockEvaluator } from "../npe-types.js";

/**
 * `PointShapeBlock` — emits particles from a single point (the emitter). The position slot places the
 * particle at the emitter with no random draw; the direction slot draws a uniform random direction between
 * `direction1` and `direction2`. Mirrors BJS `PointShapeBlock`. Pure-translation emitter only.
 */
export const pointShapeBlock: ParticleBlockEvaluator = {
    build(block, ctx) {
        const state = ctx.state;
        const system = ctx.input(block, "particle")(state) as ParticleSystem;

        const dir1Getter = ctx.input(block, "direction1", () => ({ x: 0, y: 1, z: 0 }));
        const dir2Getter = ctx.input(block, "direction2", () => ({ x: 0, y: 1, z: 0 }));

        system._createPosition = (particle, sys) => {
            if (sys.isLocal) {
                particle.position.x = 0;
                particle.position.y = 0;
                particle.position.z = 0;
            } else {
                particle.position.x = state.emitter.x;
                particle.position.y = state.emitter.y;
                particle.position.z = state.emitter.z;
            }
        };

        system._createDirection = (particle, sys) => {
            state.particle = particle;
            state.system = sys;
            const dir1 = dir1Getter(state) as Vec3;
            const dir2 = dir2Getter(state) as Vec3;
            const rx = randomRange(dir1.x, dir2.x);
            const ry = randomRange(dir1.y, dir2.y);
            const rz = randomRange(dir1.z, dir2.z);
            particle.direction.x = rx;
            particle.direction.y = ry;
            particle.direction.z = rz;
            particle._initialDirection.x = rx;
            particle._initialDirection.y = ry;
            particle._initialDirection.z = rz;
        };

        ctx.setOutput(block.id, "output", () => system);
    },
};
