import type { Vec3, Color4 } from "../math/types.js";
import type { Texture2D } from "../texture/texture-2d.js";
import type { Particle } from "./particle.js";
import { createParticle, resetParticle } from "./particle.js";

/**
 * A unit of per-particle work run during creation or update. The node-graph build populates a
 * system's create/update queues with these closures (one per graph block that touches a particle).
 */
export type ParticleProcess = (particle: Particle, system: ParticleSystem) => void;

/**
 * A CPU-simulated particle system — pure state.
 *
 * The node-graph build configures the public properties and fills {@link ParticleSystem._createQueue}
 * and {@link ParticleSystem._updateQueue}. {@link animateParticleSystem} advances the simulation by a
 * single step. Rendering is handled separately by binding live particles to a billboard system.
 */
export interface ParticleSystem {
    /** System name (from the graph's SystemBlock). */
    name: string;
    /** Maximum number of simultaneously alive particles. */
    capacity: number;
    /** Particles emitted per simulated time unit. */
    emitRate: number;
    /** Simulation advance per render frame, before the per-step ratio. */
    updateSpeed: number;
    /** When non-zero, the system stops once `_actualFrame` reaches this value. */
    targetStopDuration: number;
    /** Blend mode index (Babylon.js `BLENDMODE_*`); mapped to a billboard blend descriptor at render time. */
    blendMode: number;
    /** Billboard mode index (Babylon.js `PARTICLES_BILLBOARDMODE_*`). */
    billboardMode: number;
    /** Whether particles render as camera-facing billboards. */
    isBillboardBased: boolean;
    /** Whether particle coordinates are emitter-local rather than world. */
    isLocal: boolean;
    /** Emitter world position (pure-translation emitter). */
    emitter: Vec3;
    /** Particle texture used by the billboard renderer (resolved after async asset loads complete). */
    texture: Texture2D | null;

    /** @internal Deferred texture binder, run by the build once async loads settle. */
    _resolveTexture: (() => void) | null;

    /** @internal Live particles (compacted; recycling swaps with the last). */
    _particles: Particle[];
    /** @internal Recycled-particle pool for zero-allocation steady state. */
    _stock: Particle[];
    /** @internal Whether the system is started. */
    _started: boolean;
    /** @internal Whether the system has been stopped (drains remaining particles, emits no more). */
    _stopped: boolean;
    /** @internal Accumulated simulated time, in update-speed units. */
    _actualFrame: number;
    /** @internal Fractional emission carry-over between steps. */
    _newPartsExcess: number;
    /** @internal Update speed scaled by the current step ratio. */
    _scaledUpdateSpeed: number;
    /** @internal Emit power of the most recently created particle (set by the creation queue). */
    _emitPower: number;
    /** @internal Monotonic particle-id source. */
    _nextParticleId: number;
    /** @internal Scratch: `colorStep * _scaledUpdateSpeed` (contextual ScaledColorStep). */
    _scaledColorStep: Color4;
    /**
     * @internal Creation slots, run in this fixed order on every spawn — matching the
     * `ThinParticleSystem` creation-queue wiring. The fixed order (not graph build order) is what
     * makes the per-particle `Math.random()` sequence match Babylon.js. Each slot is filled by the
     * block that owns it (CreateParticleBlock fills lifetime/size/angle/colour; the shape block fills
     * position/direction); unfilled slots are skipped.
     */
    _createLifeTime: ParticleProcess | null;
    /** @internal */
    _createPosition: ParticleProcess | null;
    /** @internal */
    _createDirection: ParticleProcess | null;
    /** @internal */
    _createEmitPower: ParticleProcess | null;
    /** @internal */
    _createSize: ParticleProcess | null;
    /** @internal */
    _createAngle: ParticleProcess | null;
    /** @internal */
    _createColor: ParticleProcess | null;
    /** @internal */
    _createColorDead: ParticleProcess | null;
    /** @internal Per-particle update steps, in graph-connection order. */
    _updateQueue: ParticleProcess[];
}

/** Create an empty particle system with Babylon.js default properties. The graph build overrides these. */
export function createParticleSystem(name: string, capacity: number): ParticleSystem {
    return {
        name,
        capacity,
        emitRate: 10,
        updateSpeed: 0.016666666666666666,
        targetStopDuration: 0,
        blendMode: 0,
        billboardMode: 7,
        isBillboardBased: true,
        isLocal: false,
        emitter: { x: 0, y: 0, z: 0 },
        texture: null,
        _resolveTexture: null,
        _particles: [],
        _stock: [],
        _started: false,
        _stopped: false,
        _actualFrame: 0,
        _newPartsExcess: 0,
        _scaledUpdateSpeed: 0,
        _emitPower: 1,
        _nextParticleId: 0,
        _scaledColorStep: { r: 0, g: 0, b: 0, a: 0 },
        _createLifeTime: null,
        _createPosition: null,
        _createDirection: null,
        _createEmitPower: null,
        _createSize: null,
        _createAngle: null,
        _createColor: null,
        _createColorDead: null,
        _updateQueue: [],
    };
}

/** Start emission. Resets the simulated-time accumulator. */
export function startParticleSystem(system: ParticleSystem): void {
    system._started = true;
    system._stopped = false;
    system._actualFrame = 0;
}

/** Stop emission. Existing particles continue until they expire. */
export function stopParticleSystem(system: ParticleSystem): void {
    system._stopped = true;
}

/**
 * Advance the simulation by one step.
 *
 * `scaledRatio` is the per-step multiplier on {@link ParticleSystem.updateSpeed}: the scene animation
 * ratio for a live frame, or the pre-warm step offset during pre-warm. Mirrors the emission-count,
 * update, recycle, and creation logic of Babylon.js `ThinParticleSystem.animate`.
 */
export function animateParticleSystem(system: ParticleSystem, scaledRatio: number): void {
    if (!system._started) {
        return;
    }

    system._scaledUpdateSpeed = system.updateSpeed * scaledRatio;

    // Emission count: integer part this step, fractional part carried over.
    let newParticles = (system.emitRate * system._scaledUpdateSpeed) >> 0;
    system._newPartsExcess += system.emitRate * system._scaledUpdateSpeed - newParticles;
    if (system._newPartsExcess > 1.0) {
        const extra = system._newPartsExcess >> 0;
        newParticles += extra;
        system._newPartsExcess -= extra;
    }

    if (system._stopped) {
        newParticles = 0;
    } else {
        system._actualFrame += system._scaledUpdateSpeed;
        if (system.targetStopDuration && system._actualFrame >= system.targetStopDuration) {
            stopParticleSystem(system);
        }
    }

    updateExistingParticles(system);
    createNewParticles(system, newParticles);
}

function updateExistingParticles(system: ParticleSystem): void {
    const particles = system._particles;
    const updateQueue = system._updateQueue;

    for (let i = 0; i < particles.length; i++) {
        const particle = particles[i]!;

        let stepSpeed = system._scaledUpdateSpeed;
        const previousAge = particle.age;
        particle.age += stepSpeed;

        // Clamp the final partial step so a particle dies exactly at its lifetime.
        if (particle.age > particle.lifeTime) {
            const diff = particle.age - previousAge;
            const oldDiff = particle.lifeTime - previousAge;
            stepSpeed = (oldDiff * stepSpeed) / diff;
            particle.age = particle.lifeTime;
        }

        particle._directionScale = stepSpeed;

        for (let q = 0; q < updateQueue.length; q++) {
            updateQueue[q]!(particle, system);
        }

        if (particle.age >= particle.lifeTime) {
            recycleParticle(system, i);
            i--;
        }
    }
}

function createNewParticles(system: ParticleSystem, count: number): void {
    const particles = system._particles;

    for (let n = 0; n < count; n++) {
        if (particles.length >= system.capacity) {
            break;
        }

        const id = system._nextParticleId++;
        const pooled = system._stock.pop();
        const particle = pooled ?? createParticle(id);
        if (pooled) {
            resetParticle(particle, id);
        }

        particles.push(particle);
        runCreationSlots(system, particle);
    }
}

/** Run the fixed-order creation slots for a freshly spawned particle (skips unfilled slots). */
function runCreationSlots(system: ParticleSystem, particle: Particle): void {
    if (system._createLifeTime) {
        system._createLifeTime(particle, system);
    }
    if (system._createPosition) {
        system._createPosition(particle, system);
    }
    if (system._createDirection) {
        system._createDirection(particle, system);
    }
    if (system._createEmitPower) {
        system._createEmitPower(particle, system);
    }
    if (system._createSize) {
        system._createSize(particle, system);
    }
    if (system._createAngle) {
        system._createAngle(particle, system);
    }
    if (system._createColor) {
        system._createColor(particle, system);
    }
    if (system._createColorDead) {
        system._createColorDead(particle, system);
    }
}

/** Recycle a dead particle by swapping it with the last live particle and returning it to the pool. */
function recycleParticle(system: ParticleSystem, index: number): void {
    const particles = system._particles;
    const dead = particles[index]!;
    const lastIndex = particles.length - 1;
    if (index !== lastIndex) {
        particles[index] = particles[lastIndex]!;
    }
    particles.pop();
    system._stock.push(dead);
}
