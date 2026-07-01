import { randomRange } from "../../particle-math.js";
import type { Vec3 } from "../../../math/types.js";
import type { ParticleSystem } from "../../particle-system.js";
import type { ParticleBlockEvaluator } from "../npe-types.js";

/**
 * `BoxShapeBlock` — emits particles from a box. The position slot draws a uniform random point inside
 * `[minEmitBox, maxEmitBox]`; the direction slot draws a uniform random direction between `direction1`
 * and `direction2`. Each component uses `randomRange` (which skips the RNG when min === max), so a
 * zero-width axis consumes no random — matching BJS `BoxShapeBlock` exactly. The pure-translation emitter
 * offsets world-space positions; directions are unaffected.
 */
export const boxShapeBlock: ParticleBlockEvaluator = {
    build(block, ctx) {
        const state = ctx.state;
        const system = ctx.input(block, "particle")(state) as ParticleSystem;

        const dir1Getter = ctx.input(block, "direction1", () => ({ x: 0, y: 1, z: 0 }));
        const dir2Getter = ctx.input(block, "direction2", () => ({ x: 0, y: 1, z: 0 }));
        const minBoxGetter = ctx.input(block, "minEmitBox", () => ({ x: -0.5, y: -0.5, z: -0.5 }));
        const maxBoxGetter = ctx.input(block, "maxEmitBox", () => ({ x: 0.5, y: 0.5, z: 0.5 }));

        system._createPosition = (particle, sys) => {
            state.particle = particle;
            state.system = sys;
            const minBox = minBoxGetter(state) as Vec3;
            const maxBox = maxBoxGetter(state) as Vec3;
            const rx = randomRange(minBox.x, maxBox.x);
            const ry = randomRange(minBox.y, maxBox.y);
            const rz = randomRange(minBox.z, maxBox.z);
            if (sys.isLocal) {
                particle.position.x = rx;
                particle.position.y = ry;
                particle.position.z = rz;
            } else {
                particle.position.x = rx + state.emitter.x;
                particle.position.y = ry + state.emitter.y;
                particle.position.z = rz + state.emitter.z;
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
