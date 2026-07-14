/**
 * Data-oriented particle system + simulation loop — SPIKE.
 *
 * Mirrors the emission-count, update, lifetime-clamp, recycle, and creation logic of the object runtime's
 * `animateParticleSystem` exactly (same `Math.random` consumption and creation-step order), but operates on
 * a {@link ParticleBuffer} of columns via ordered {@link ParticleStep} lists. The creation and update steps
 * are supplied by the graph build (or, in tests, hand-wired). Feature state lives in feature columns, so a
 * system pays nothing for features it does not use.
 */
import { createParticleBuffer, killParticle, spawnParticle, type ParticleBuffer } from "./particle-buffer.js";
import type { ParticleStep } from "./value.js";

/** Pure-state data-oriented particle system. Behaviour is provided by the standalone functions below. */
export interface SoaSystem {
    readonly buffer: ParticleBuffer;
    /** Particles emitted per simulated time unit. */
    emitRate: number;
    /** Simulation advance per frame, before the per-step ratio. */
    updateSpeed: number;
    /** When non-zero, the system stops once `_actualFrame` reaches this value. */
    targetStopDuration: number;
    /** Creation steps, run in Babylon.js slot order on every spawned particle. */
    createSteps: ParticleStep[];
    /** Update steps, run in graph order on every live particle each frame. */
    updateSteps: ParticleStep[];

    /** @internal Scaled step for the current particle (= the object runtime's `_directionScale`; clamped on the dying step). */
    _scaledStep: number;
    /** @internal Update speed scaled by the step ratio for the whole frame (unclamped; used by scaled colour step). */
    _scaledUpdateSpeed: number;
    /** @internal Fractional emission carry-over between steps. */
    _newPartsExcess: number;
    /** @internal Whether the system is started. */
    _started: boolean;
    /** @internal Whether the system has been stopped (drains remaining particles). */
    _stopped: boolean;
    /** @internal Accumulated simulated time, in update-speed units. */
    _actualFrame: number;
}

/** Create a data-oriented particle system with an empty buffer of the given capacity. */
export function createSoaSystem(capacity: number): SoaSystem {
    return {
        buffer: createParticleBuffer(capacity),
        emitRate: 10,
        updateSpeed: 0.016666666666666666,
        targetStopDuration: 0,
        createSteps: [],
        updateSteps: [],
        _scaledStep: 0,
        _scaledUpdateSpeed: 0,
        _newPartsExcess: 0,
        _started: false,
        _stopped: false,
        _actualFrame: 0,
    };
}

/** Start emission. Resets the simulated-time accumulator. */
export function startSoaSystem(system: SoaSystem): void {
    system._started = true;
    system._stopped = false;
    system._actualFrame = 0;
}

/** Stop emission. Existing particles continue until they expire. */
export function stopSoaSystem(system: SoaSystem): void {
    system._stopped = true;
}

/**
 * Advance the simulation by one step. `scaledRatio` is the per-step multiplier on {@link SoaSystem.updateSpeed}
 * (scene animation ratio for a live frame, or the pre-warm step offset). Mirrors `animateParticleSystem`.
 */
export function animateSoa(system: SoaSystem, scaledRatio: number): void {
    if (!system._started) {
        return;
    }

    const scaledUpdateSpeed = system.updateSpeed * scaledRatio;

    let newParticles = (system.emitRate * scaledUpdateSpeed) >> 0;
    system._newPartsExcess += system.emitRate * scaledUpdateSpeed - newParticles;
    if (system._newPartsExcess > 1.0) {
        const extra = system._newPartsExcess >> 0;
        newParticles += extra;
        system._newPartsExcess -= extra;
    }

    if (system._stopped) {
        newParticles = 0;
    } else {
        system._actualFrame += scaledUpdateSpeed;
        if (system.targetStopDuration && system._actualFrame >= system.targetStopDuration) {
            stopSoaSystem(system);
        }
    }

    updateExisting(system, scaledUpdateSpeed);
    createNew(system, newParticles);
}

function updateExisting(system: SoaSystem, scaledUpdateSpeed: number): void {
    const buffer = system.buffer;
    const age = buffer.age;
    const lifeTime = buffer.lifeTime;
    const steps = system.updateSteps;
    system._scaledUpdateSpeed = scaledUpdateSpeed;

    for (let i = 0; i < buffer.alive; i++) {
        let stepSpeed = scaledUpdateSpeed;
        const previousAge = age[i]!;
        age[i] = previousAge + stepSpeed;

        // Clamp the final partial step so a particle dies exactly at its lifetime (matches the object runtime).
        if (age[i]! > lifeTime[i]!) {
            const diff = age[i]! - previousAge;
            const oldDiff = lifeTime[i]! - previousAge;
            stepSpeed = (oldDiff * stepSpeed) / diff;
            age[i] = lifeTime[i]!;
        }

        system._scaledStep = stepSpeed;
        for (let s = 0; s < steps.length; s++) {
            steps[s]!(i);
        }

        if (age[i]! >= lifeTime[i]!) {
            killParticle(buffer, i);
            i--;
        }
    }
}

function createNew(system: SoaSystem, count: number): void {
    const buffer = system.buffer;
    const steps = system.createSteps;

    for (let n = 0; n < count; n++) {
        const i = spawnParticle(buffer);
        if (i < 0) {
            break;
        }
        for (let s = 0; s < steps.length; s++) {
            steps[s]!(i);
        }
    }
}
