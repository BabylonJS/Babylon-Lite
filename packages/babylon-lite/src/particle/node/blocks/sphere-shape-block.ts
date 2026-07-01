import { randomRange } from "../../particle-math.js";
import type { Vec3 } from "../../../math/types.js";
import type { ParticleSystem } from "../../particle-system.js";
import type { ParticleBlockEvaluator } from "../npe-types.js";

/**
 * `SphereShapeBlock` — emits particles from a sphere. The position slot draws a point inside a sphere of
 * `radius` (thinned toward the surface by `radiusRange`) using uniform spherical coordinates. The direction
 * slot points each particle radially outward from the emitter — with optional `directionRandomizer` jitter —
 * unless both `direction1` and `direction2` are connected, in which case it draws a uniform random direction
 * between them (the `BoxShapeBlock` behaviour). The random-draw order and the `randomRange` short-circuit
 * (which skips the RNG when min === max, so a zero-width range or zero randomizer consumes nothing) match BJS
 * `SphereShapeBlock` exactly, keeping creation-time draws aligned. Pure-translation emitter only.
 */
export const sphereShapeBlock: ParticleBlockEvaluator = {
    build(block, ctx) {
        const state = ctx.state;
        const system = ctx.input(block, "particle")(state) as ParticleSystem;

        const isHemispheric = block.serialized.isHemispheric === true;
        const radiusGetter = ctx.input(block, "radius", () => 1);
        const radiusRangeGetter = ctx.input(block, "radiusRange", () => 1);
        const directionRandomizerGetter = ctx.input(block, "directionRandomizer", () => 0);
        const dir1Getter = ctx.input(block, "direction1", () => ({ x: 0, y: 1, z: 0 }));
        const dir2Getter = ctx.input(block, "direction2", () => ({ x: 0, y: 1, z: 0 }));
        // BJS uses the radial (directionRandomizer) path unless BOTH directions are explicitly connected.
        const useExplicitDirections = ctx.isConnected(block, "direction1") && ctx.isConnected(block, "direction2");

        system._createPosition = (particle, sys) => {
            state.particle = particle;
            state.system = sys;
            const radius = radiusGetter(state) as number;
            const radiusRange = radiusRangeGetter(state) as number;
            const randRadius = radius - randomRange(0, radius * radiusRange);
            const v = randomRange(0, 1);
            const phi = randomRange(0, 2 * Math.PI);
            const theta = Math.acos(2 * v - 1);
            const rx = randRadius * Math.cos(phi) * Math.sin(theta);
            let ry = randRadius * Math.cos(theta);
            const rz = randRadius * Math.sin(phi) * Math.sin(theta);
            if (isHemispheric) {
                ry = Math.abs(ry);
            }
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
            // Radial direction: outward from the emitter through the particle, then jittered + renormalized.
            let dx = particle.position.x - state.emitter.x;
            let dy = particle.position.y - state.emitter.y;
            let dz = particle.position.z - state.emitter.z;
            let length = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (length !== 0 && length !== 1) {
                dx /= length;
                dy /= length;
                dz /= length;
            }
            dx += randomRange(0, directionRandomizer);
            dy += randomRange(0, directionRandomizer);
            dz += randomRange(0, directionRandomizer);
            length = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (length !== 0 && length !== 1) {
                dx /= length;
                dy /= length;
                dz /= length;
            }
            particle.direction.x = dx;
            particle.direction.y = dy;
            particle.direction.z = dz;
            particle._initialDirection.x = dx;
            particle._initialDirection.y = dy;
            particle._initialDirection.z = dz;
        };

        ctx.setOutput(block.id, "output", () => system);
    },
};
