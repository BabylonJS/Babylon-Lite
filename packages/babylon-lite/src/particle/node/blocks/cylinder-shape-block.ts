import { randomRange } from "../../particle-math.js";
import type { Vec3 } from "../../../math/types.js";
import type { ParticleSystem } from "../../particle-system.js";
import type { ParticleBlockEvaluator } from "../npe-types.js";

/**
 * `CylinderShapeBlock` — emits particles from a cylinder. The position slot draws a uniformly distributed
 * point in the disc (`sqrt` radius distribution) at a random height; the direction slot mirrors the
 * cylinder surface normal in the XZ plane, jittered by `directionRandomizer`, unless both `direction1` and
 * `direction2` are connected. Mirrors BJS `CylinderShapeBlock` — note the azimuth jitter draws
 * `randomRange(-PI/2, PI/2)` even when the randomizer is 0 (it is then multiplied by 0), so the random
 * sequence stays aligned. Pure-translation emitter only.
 */
export const cylinderShapeBlock: ParticleBlockEvaluator = {
    build(block, ctx) {
        const state = ctx.state;
        const system = ctx.input(block, "particle")(state) as ParticleSystem;

        const radiusGetter = ctx.input(block, "radius", () => 1);
        const heightGetter = ctx.input(block, "height", () => 1);
        const radiusRangeGetter = ctx.input(block, "radiusRange", () => 1);
        const directionRandomizerGetter = ctx.input(block, "directionRandomizer", () => 0);
        const dir1Getter = ctx.input(block, "direction1", () => ({ x: 0, y: 1, z: 0 }));
        const dir2Getter = ctx.input(block, "direction2", () => ({ x: 0, y: 1, z: 0 }));
        const useExplicitDirections = ctx.isConnected(block, "direction1") && ctx.isConnected(block, "direction2");

        system._createPosition = (particle, sys) => {
            state.particle = particle;
            state.system = sys;
            const height = heightGetter(state) as number;
            const radiusRange = radiusRangeGetter(state) as number;
            const radius = radiusGetter(state) as number;

            const yPos = randomRange(-height / 2, height / 2);
            const angle = randomRange(0, 2 * Math.PI);
            const radiusDistribution = randomRange((1 - radiusRange) * (1 - radiusRange), 1);
            const positionRadius = Math.sqrt(radiusDistribution) * radius;
            const xPos = positionRadius * Math.cos(angle);
            const zPos = positionRadius * Math.sin(angle);

            if (sys.isLocal) {
                particle.position.x = xPos;
                particle.position.y = yPos;
                particle.position.z = zPos;
            } else {
                particle.position.x = xPos + state.emitter.x;
                particle.position.y = yPos + state.emitter.y;
                particle.position.z = zPos + state.emitter.z;
            }
        };

        system._createDirection = (particle, sys) => {
            state.particle = particle;
            state.system = sys;
            if (useExplicitDirections) {
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
                return;
            }
            const directionRandomizer = directionRandomizerGetter(state) as number;
            let tx = particle.position.x - state.emitter.x;
            let ty = particle.position.y - state.emitter.y;
            let tz = particle.position.z - state.emitter.z;
            let length = Math.sqrt(tx * tx + ty * ty + tz * tz);
            if (length !== 0 && length !== 1) {
                tx /= length;
                ty /= length;
                tz /= length;
            }

            const randY = randomRange(-directionRandomizer / 2, directionRandomizer / 2);
            let azimuth = Math.atan2(tx, tz);
            azimuth += randomRange(-Math.PI / 2, Math.PI / 2) * directionRandomizer;

            ty = randY;
            tx = Math.sin(azimuth);
            tz = Math.cos(azimuth);
            length = Math.sqrt(tx * tx + ty * ty + tz * tz);
            if (length !== 0 && length !== 1) {
                tx /= length;
                ty /= length;
                tz /= length;
            }
            particle.direction.x = tx;
            particle.direction.y = ty;
            particle.direction.z = tz;
            particle._initialDirection.x = tx;
            particle._initialDirection.y = ty;
            particle._initialDirection.z = tz;
        };

        ctx.setOutput(block.id, "output", () => system);
    },
};
