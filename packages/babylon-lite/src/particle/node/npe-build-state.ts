import { scaleVec3ToRef } from "../../math/vec3-ref.js";
import { scaleColor4ToRef } from "../../math/color4-ref.js";
import { transformCoordinatesToRef } from "../../math/mat4-transform.js";
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
const CTX_LOCAL_POSITION_UPDATED = 0x0018;
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
        case CTX_LOCAL_POSITION_UPDATED:
            // isLocal position integration: advance the local position by the scaled direction, then bake the
            // emitter world matrix to get the world position. Mirrors BJS `LocalPositionUpdated`.
            scaleVec3ToRef(particle.direction, particle._directionScale, particle._scaledDirection);
            particle._localPosition.x += particle._scaledDirection.x;
            particle._localPosition.y += particle._scaledDirection.y;
            particle._localPosition.z += particle._scaledDirection.z;
            transformCoordinatesToRef(particle._localPosition.x, particle._localPosition.y, particle._localPosition.z, state.emitterWorldMatrix, particle.position);
            return particle.position;
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

/** Whether a contextual source id is handled by {@link getContextualValue}. Keep in sync with its switch. */
export function isContextualSourceSupported(source: number): boolean {
    switch (source) {
        case CTX_POSITION:
        case CTX_DIRECTION:
        case CTX_AGE:
        case CTX_LIFETIME:
        case CTX_COLOR:
        case CTX_SCALED_DIRECTION:
        case CTX_SCALE:
        case CTX_AGE_GRADIENT:
        case CTX_ANGLE:
        case CTX_INITIAL_COLOR:
        case CTX_COLOR_DEAD:
        case CTX_INITIAL_DIRECTION:
        case CTX_COLOR_STEP:
        case CTX_SCALED_COLOR_STEP:
        case CTX_LOCAL_POSITION_UPDATED:
        case CTX_SIZE:
        case CTX_DIRECTION_SCALE:
            return true;
        default:
            return false;
    }
}

/** Whether a system source id is handled by {@link getSystemValue}. Keep in sync with its switch. */
export function isSystemSourceSupported(source: number): boolean {
    switch (source) {
        case SYS_TIME:
        case SYS_DELTA:
        case SYS_EMITTER:
            return true;
        default:
            return false;
    }
}
