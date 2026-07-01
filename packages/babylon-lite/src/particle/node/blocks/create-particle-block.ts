import { createParticleSystem } from "../../particle-system.js";
import { copyColor4 } from "../../particle-math.js";
import type { Color4 } from "../../../math/types.js";
import type { ParticleScale } from "../../particle.js";
import type { ParticleBlockEvaluator } from "../npe-types.js";

/**
 * `CreateParticleBlock` — creates the {@link ParticleSystem} and fills the creation slots that set a new
 * particle's lifetime/emit-power, size/scale, angle, colour, and dead colour (which also derives the
 * per-step colour ramp). Mirrors BJS `CreateParticleBlock._build`. The shape block fills the
 * position/direction slots; the fixed slot order is enforced by the runtime, not by build order.
 */
export const createParticleBlock: ParticleBlockEvaluator = {
    build(block, ctx) {
        const state = ctx.state;
        const system = createParticleSystem(block.name, state.capacity);
        state.system = system;

        const lifeTimeGetter = ctx.input(block, "lifeTime", () => 1);
        const emitPowerGetter = ctx.input(block, "emitPower", () => 1);
        const colorGetter = ctx.input(block, "color", () => ({ r: 1, g: 1, b: 1, a: 1 }));
        const colorDeadGetter = ctx.input(block, "colorDead", () => ({ r: 0, g: 0, b: 0, a: 0 }));
        const scaleGetter = ctx.input(block, "scale", () => ({ x: 1, y: 1 }));
        const angleGetter = ctx.input(block, "angle", () => 0);
        const sizeGetter = ctx.input(block, "size", () => 1);

        system._createLifeTime = (particle, sys) => {
            state.particle = particle;
            state.system = sys;
            particle.lifeTime = lifeTimeGetter(state) as number;
            sys._emitPower = emitPowerGetter(state) as number;
        };

        system._createEmitPower = (particle, sys) => {
            state.particle = particle;
            state.system = sys;
            // Mirrors BJS `_CreateEmitPowerData`: scale the (unit) emission direction by the emit power so a
            // particle's velocity magnitude equals its emit power. A zero emit power parks the particle and
            // stashes its facing in `_initialDirection`. (Lite has no inherited-velocity offset to add.)
            const emitPower = sys._emitPower;
            if (emitPower === 0) {
                particle._initialDirection.x = particle.direction.x;
                particle._initialDirection.y = particle.direction.y;
                particle._initialDirection.z = particle.direction.z;
                particle.direction.x = 0;
                particle.direction.y = 0;
                particle.direction.z = 0;
            } else {
                particle.direction.x *= emitPower;
                particle.direction.y *= emitPower;
                particle.direction.z *= emitPower;
            }
        };

        system._createSize = (particle, sys) => {
            state.particle = particle;
            state.system = sys;
            const size = sizeGetter(state);
            particle.size = typeof size === "number" ? size : 1;
            const scale = scaleGetter(state);
            if (scale && typeof scale === "object") {
                const vec = scale as ParticleScale;
                particle.scale.x = vec.x;
                particle.scale.y = vec.y;
            } else {
                particle.scale.x = scale as number;
                particle.scale.y = scale as number;
            }
        };

        system._createAngle = (particle, sys) => {
            state.particle = particle;
            state.system = sys;
            particle.angle = angleGetter(state) as number;
        };

        system._createColor = (particle, sys) => {
            state.particle = particle;
            state.system = sys;
            const color = colorGetter(state) as Color4 | null;
            if (color) {
                copyColor4(particle.color, color);
            }
        };

        system._createColorDead = (particle, sys) => {
            state.particle = particle;
            state.system = sys;
            copyColor4(particle.colorDead, colorDeadGetter(state) as Color4);
            copyColor4(particle.initialColor, particle.color);
            const invLife = 1 / particle.lifeTime;
            particle.colorStep.r = (particle.colorDead.r - particle.initialColor.r) * invLife;
            particle.colorStep.g = (particle.colorDead.g - particle.initialColor.g) * invLife;
            particle.colorStep.b = (particle.colorDead.b - particle.initialColor.b) * invLife;
            particle.colorStep.a = (particle.colorDead.a - particle.initialColor.a) * invLife;
        };

        ctx.setOutput(block.id, "particle", () => system);
    },
};
