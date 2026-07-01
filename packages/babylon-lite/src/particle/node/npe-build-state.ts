import { scaleVec3ToRef, scaleColor4ToRef } from "../particle-math.js";
import type { NpeBuildState, ParticleValue } from "./npe-types.js";

// Contextual source ids (Babylon.js `NodeParticleContextualSources`; values are hex).
const CTX_POSITION = 0x0001;
const CTX_DIRECTION = 0x0002;
const CTX_AGE = 0x0003;
const CTX_LIFETIME = 0x0004;
const CTX_COLOR = 0x0005;
const CTX_SCALED_DIRECTION = 0x0006;
const CTX_SCALE = 0x0007;
const CTX_AGE_GRADIENT = 0x0008;
const CTX_ANGLE = 0x0009;
const CTX_INITIAL_COLOR = 0x0013;
const CTX_COLOR_DEAD = 0x0014;
const CTX_INITIAL_DIRECTION = 0x0015;
const CTX_COLOR_STEP = 0x0016;
const CTX_SCALED_COLOR_STEP = 0x0017;
const CTX_SIZE = 0x0019;
const CTX_DIRECTION_SCALE = 0x0020;

// System source ids (Babylon.js `NodeParticleSystemSources`).
const SYS_TIME = 1;
const SYS_DELTA = 2;
const SYS_EMITTER = 3;

/**
 * Resolve a contextual source against the current particle/system (mirrors BJS
 * `NodeParticleBuildState.getContextualValue`). Vector/colour results that derive from per-step scratch
 * (`ScaledDirection`, `ScaledColorStep`) are written into the particle/system scratch buffers in place.
 */
export function getContextualValue(state: NpeBuildState, source: number): ParticleValue {
    const particle = state.particle;
    const system = state.system;
    if (!particle || !system) {
        return null;
    }

    switch (source) {
        case CTX_POSITION:
            return particle.position;
        case CTX_DIRECTION:
            return particle.direction;
        case CTX_AGE:
            return particle.age;
        case CTX_LIFETIME:
            return particle.lifeTime;
        case CTX_COLOR:
            return particle.color;
        case CTX_SCALED_DIRECTION:
            scaleVec3ToRef(particle.direction, particle._directionScale, particle._scaledDirection);
            return particle._scaledDirection;
        case CTX_SCALE:
            return particle.scale;
        case CTX_AGE_GRADIENT:
            return particle.age / particle.lifeTime;
        case CTX_ANGLE:
            return particle.angle;
        case CTX_INITIAL_COLOR:
            return particle.initialColor;
        case CTX_COLOR_DEAD:
            return particle.colorDead;
        case CTX_INITIAL_DIRECTION:
            return particle._initialDirection;
        case CTX_COLOR_STEP:
            return particle.colorStep;
        case CTX_SCALED_COLOR_STEP:
            scaleColor4ToRef(particle.colorStep, system._scaledUpdateSpeed, system._scaledColorStep);
            return system._scaledColorStep;
        case CTX_SIZE:
            return particle.size;
        case CTX_DIRECTION_SCALE:
            return particle._directionScale;
        default:
            return null;
    }
}

/** Resolve a system source (mirrors BJS `NodeParticleBuildState.getSystemValue`). */
export function getSystemValue(state: NpeBuildState, source: number): ParticleValue {
    const system = state.system;
    switch (source) {
        case SYS_TIME:
            return system ? system._actualFrame : 0;
        case SYS_DELTA:
            return system ? system._scaledUpdateSpeed : 0;
        case SYS_EMITTER:
            return state.emitter;
        default:
            return null;
    }
}
