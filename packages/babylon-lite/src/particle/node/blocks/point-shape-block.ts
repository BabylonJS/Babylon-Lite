import { randomRange } from "../../../math/random-range.js";
import { transformCoordinatesToRef, transformNormalToRef } from "../../../math/mat4-transform.js";
import type { Vec3 } from "../../../math/types.js";
import type { ParticleSystem } from "../../particle-system.js";
import type { ParticleBlockEvaluator } from "../npe-types.js";

/**
 * `PointShapeBlock` — emits particles from a single point (the emitter). The position slot places the
 * particle at the emitter with no random draw; the direction slot draws a uniform random direction between
 * `direction1` and `direction2`. Mirrors BJS `PointShapeBlock`. The emitter's world matrix is baked into the
 * birth position and direction.
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
                transformCoordinatesToRef(0, 0, 0, state.emitterWorldMatrix, particle.position);
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
            if (sys.isLocal) {
                particle.direction.x = rx;
                particle.direction.y = ry;
                particle.direction.z = rz;
            } else {
                transformNormalToRef(rx, ry, rz, state.emitterWorldMatrix, particle.direction);
            }
            particle._initialDirection.x = particle.direction.x;
            particle._initialDirection.y = particle.direction.y;
            particle._initialDirection.z = particle.direction.z;
        };

        ctx.setOutput(block.id, "output", () => system);
    },
};
