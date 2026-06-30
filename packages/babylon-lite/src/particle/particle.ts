import type { Vec3, Color4 } from "../math/types.js";

/** Non-uniform 2D scale applied to a particle's billboard quad (multiplies {@link Particle.size}). */
export interface ParticleScale {
    x: number;
    y: number;
}

/**
 * A single CPU-simulated particle — pure state, pooled and reused across its lifecycle.
 *
 * Field semantics mirror Babylon.js `Particle` so the node-graph evaluator reproduces identical
 * motion. Mutable scratch fields (prefixed `_`) hold per-step intermediates used by the contextual
 * sources the update graph reads from.
 */
export interface Particle {
    /** Unique id assigned on every (re)creation; keys per-particle random locks. */
    id: number;
    /** World-space position. */
    position: Vec3;
    /** Movement direction (advances {@link position} by `direction * _directionScale` each step). */
    direction: Vec3;
    /** Current RGBA colour. */
    color: Color4;
    /** Target colour reached at end of life. */
    colorDead: Color4;
    /** Colour captured at birth (start of the colour ramp). */
    initialColor: Color4;
    /** Per-unit-life colour delta: `(colorDead - initialColor) / lifeTime`. */
    colorStep: Color4;
    /** Seconds elapsed since birth. */
    age: number;
    /** Total lifespan in seconds. */
    lifeTime: number;
    /** Rotation of the billboard quad, in radians. */
    angle: number;
    /** Uniform size multiplier. */
    size: number;
    /** Non-uniform per-axis scale (multiplies {@link size}). */
    scale: ParticleScale;
    /** Animation-sheet cell index. */
    cellIndex: number;

    /** @internal Scratch: direction scale for the current step (= the system's scaled update speed). */
    _directionScale: number;
    /** @internal Scratch: `direction * _directionScale`. */
    _scaledDirection: Vec3;
    /** @internal Scratch: emission direction captured at birth. */
    _initialDirection: Vec3;
    /** @internal Scratch: position in emitter-local space. */
    _localPosition: Vec3;
}

/** Create a fresh particle with the given id and default (zeroed) state. */
export function createParticle(id: number): Particle {
    return {
        id,
        position: { x: 0, y: 0, z: 0 },
        direction: { x: 0, y: 0, z: 0 },
        color: { r: 1, g: 1, b: 1, a: 1 },
        colorDead: { r: 0, g: 0, b: 0, a: 0 },
        initialColor: { r: 1, g: 1, b: 1, a: 1 },
        colorStep: { r: 0, g: 0, b: 0, a: 0 },
        age: 0,
        lifeTime: 1,
        angle: 0,
        size: 1,
        scale: { x: 1, y: 1 },
        cellIndex: 0,
        _directionScale: 0,
        _scaledDirection: { x: 0, y: 0, z: 0 },
        _initialDirection: { x: 0, y: 0, z: 0 },
        _localPosition: { x: 0, y: 0, z: 0 },
    };
}

/**
 * Reset a pooled particle for reuse, assigning a fresh id (mirrors Babylon.js `Particle._reset`).
 * Remaining fields are overwritten by the creation queue on every spawn, so only the lifecycle
 * scratch needs clearing here.
 */
export function resetParticle(particle: Particle, id: number): void {
    particle.id = id;
    particle.age = 0;
    particle.cellIndex = 0;
    particle._directionScale = 0;
}
