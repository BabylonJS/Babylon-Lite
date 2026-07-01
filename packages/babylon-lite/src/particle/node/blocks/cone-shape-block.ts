import { randomRange } from "../../particle-math.js";
import type { Vec3 } from "../../../math/types.js";
import type { ParticleSystem } from "../../particle-system.js";
import type { ParticleBlockEvaluator } from "../npe-types.js";

/**
 * `ConeShapeBlock` — emits particles from a cone. The position slot draws a point on/in the cone from a
 * height factor, a thinned radius, and a random azimuth; the direction slot points the particle radially
 * outward from the emitter (with optional `directionRandomizer` jitter) unless both `direction1` and
 * `direction2` are connected. The random-draw order and the `randomRange` short-circuit match BJS
 * `ConeShapeBlock` exactly. Pure-translation emitter only.
 */
export const coneShapeBlock: ParticleBlockEvaluator = {
    build(block, ctx) {
        const state = ctx.state;
        const system = ctx.input(block, "particle")(state) as ParticleSystem;

        const emitFromSpawnPointOnly = block.serialized.emitFromSpawnPointOnly === true;
        const radiusGetter = ctx.input(block, "radius", () => 1);
        const coneAngleGetter = ctx.input(block, "angle", () => Math.PI);
        const radiusRangeGetter = ctx.input(block, "radiusRange", () => 1);
        const heightRangeGetter = ctx.input(block, "heightRange", () => 1);
        const directionRandomizerGetter = ctx.input(block, "directionRandomizer", () => 0);
        const dir1Getter = ctx.input(block, "direction1", () => ({ x: 0, y: 1, z: 0 }));
        const dir2Getter = ctx.input(block, "direction2", () => ({ x: 0, y: 1, z: 0 }));
        const useExplicitDirections = ctx.isConnected(block, "direction1") && ctx.isConnected(block, "direction2");

        system._createPosition = (particle, sys) => {
            state.particle = particle;
            state.system = sys;
            const radius = radiusGetter(state) as number;
            const coneAngle = coneAngleGetter(state) as number;
            const radiusRange = radiusRangeGetter(state) as number;
            const heightRange = heightRangeGetter(state) as number;

            let h: number;
            if (!emitFromSpawnPointOnly) {
                h = randomRange(0, heightRange);
                h = 1 - h * h;
            } else {
                h = 0.0001;
            }
            let newRadius = radius - randomRange(0, radius * radiusRange);
            newRadius = newRadius * h;
            const s = randomRange(0, Math.PI * 2);
            const rx = newRadius * Math.sin(s);
            const rz = newRadius * Math.cos(s);
            const ry = h * (coneAngle !== 0 ? radius / Math.tan(coneAngle / 2) : 1);

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
