/**
 * Antigravity Racer — ship simulation (physics + AI steering).
 *
 * A direct, frame-rate-independent port of the playground's `TickShip`: same
 * track-relative wall clamping, banking, drift/inertia, and AI look-ahead +
 * avoidance steering, but every per-frame multiplicative/lerp constant from the
 * original (tuned for an implicit 60 Hz update) is converted with
 * {@link frameWeightToDt} so identical motion plays out at any frame rate, and
 * the whole thing is driven by a fixed simulation step (see `game.ts`) instead
 * of a raw `deltaTime`.
 */

import type { Vec3 } from "babylon-lite";
import { addVec3, crossVec3, dotVec3, lerpVec3, normalizeVec3Object, quatFromLookDirectionRH, scaleVec3, subVec3 } from "babylon-lite";

import { advanceSegment, frameLocalCoords, frameToWorld, type TrackData } from "./track.js";
import { BOOST_DEBOUNCE_RINGS, BOOST_SPEED_KICK, MAX_ACCEL, MAX_SPEED, MAX_STEER_TILT, MAX_YAW_RATE, RING_COUNT, VELOCITY_DRAG_PER_SEC } from "./constants.js";

/** Continuous per-tick control axes for a human-driven ship. */
export interface ShipAxes {
    /** -1 (left) .. +1 (right). */
    steer: number;
    accelerate: boolean;
}

export interface ShipState {
    readonly index: number;
    readonly isAI: boolean;
    /** Which human player controls this ship (0 or 1), or -1 for AI. */
    readonly playerSlot: number;
    worldPos: Vec3;
    velocity: number;
    velocityDirection: Vec3;
    velocityDirectionEffective: Vec3;
    up: Vec3;
    rotYSpeed: number;
    currentSegment: number;
    lastBonusSegment: number;
    lapCount: number;
    /** Visual-only banking roll (radians), smoothed. */
    tiltZ: number;
    /** Visual-only local wobble offset (ship-local space). */
    wobble: Vec3;
    /** World orientation, derived each tick from (direction, up). */
    orientationQuat: { x: number; y: number; z: number; w: number };
    /** Seconds remaining on a boost visual flash (camera FOV kick, HUD flash). Consumed by callers. */
    boostFlashTimer: number;
    /** Per-AI speed variance so opponents don't all move identically. */
    aiSpeedFactor: number;
    /** Trail emission point (tail), recomputed each tick for the trail renderer. */
    trailEmitPoint: Vec3;
}

/** Convert a per-frame blend/decay weight tuned at 60 Hz into the equivalent weight for `dt` seconds,
 *  so `current += (goal - current) * frameWeightToDt(k, dt)` plays identically at any frame rate. */
export function frameWeightToDt(perFrameWeightAt60Hz: number, dt: number): number {
    const k = Math.min(0.999999, Math.max(0, perFrameWeightAt60Hz));
    return 1 - Math.pow(1 - k, dt * 60);
}

function rotateAroundAxis(v: Vec3, axis: Vec3, angle: number): Vec3 {
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    const d = dotVec3(axis, v);
    const c = crossVec3(axis, v);
    return {
        x: v.x * cosA + c.x * sinA + axis.x * d * (1 - cosA),
        y: v.y * cosA + c.y * sinA + axis.y * d * (1 - cosA),
        z: v.z * cosA + c.z * sinA + axis.z * d * (1 - cosA),
    };
}

/** Spawn a ship at a given ring index, offset laterally (`lateral`, in local track-width units). */
export function createShipState(track: TrackData, spawnRing: number, lateral: number, index: number, isAI: boolean, playerSlot: number, aiSpeedFactor = 1): ShipState {
    const frame = track.frames[spawnRing % track.frames.length]!;
    const worldPos = frameToWorld(frame, { x: lateral, y: 0, z: 0 });
    return {
        index,
        isAI,
        playerSlot,
        worldPos,
        velocity: 0,
        velocityDirection: { ...frame.dir },
        velocityDirectionEffective: { ...frame.dir },
        up: { ...frame.up },
        rotYSpeed: 0,
        currentSegment: spawnRing % track.frames.length,
        lastBonusSegment: -9999,
        lapCount: 0,
        tiltZ: 0,
        wobble: { x: 0, y: 0.5, z: 0 },
        orientationQuat: quatFromLookDirectionRH(frame.dir, frame.up),
        boostFlashTimer: 0,
        aiSpeedFactor,
        trailEmitPoint: { ...worldPos },
    };
}

/** Nearest ship ahead of `ship` within `limitRings`, for AI avoidance. */
function firstShipAhead(ships: readonly ShipState[], selfIndex: number, limitRings: number): ShipState | null {
    const current = ships[selfIndex]!.currentSegment;
    let best: ShipState | null = null;
    let bestValue = limitRings;
    for (let i = 0; i < ships.length; i++) {
        if (i === selfIndex) {
            continue;
        }
        const diff = (ships[i]!.currentSegment - current + RING_COUNT) % RING_COUNT;
        if (diff < bestValue) {
            best = ships[i]!;
            bestValue = diff;
        }
    }
    return best;
}

function touchBoost(ship: ShipState, localX: number, track: TrackData): void {
    const seg = ship.currentSegment;
    const debounced = Math.abs(seg - ship.lastBonusSegment) > BOOST_DEBOUNCE_RINGS;
    const hit = debounced && ((localX > 1 && track.boostRight[seg]) || (localX < -1 && track.boostLeft[seg]));
    if (hit) {
        ship.lastBonusSegment = seg;
        ship.velocity += BOOST_SPEED_KICK;
        ship.boostFlashTimer = 0.4;
    }
}

/** Advance one ship by `dt` seconds. `axes` is only read for human ships (ignored for AI). */
export function tickShip(ship: ShipState, ships: readonly ShipState[], track: TrackData, dt: number, axes: ShipAxes, simTime: number): void {
    const frames = track.frames;
    const n = frames.length;
    const prevSegment = ship.currentSegment;
    const seg = advanceSegment(frames, ship.currentSegment, ship.worldPos);
    if (seg < prevSegment - n / 2) {
        ship.lapCount++;
    }
    const frame = frames[seg]!;
    const local = frameLocalCoords(frame, ship.worldPos);
    const y = local.y * (local.y < 0 ? 0.45 : 0.9);
    const wallSlope = 2.5 + y;
    let x = local.x;
    if (x < -wallSlope) {
        x = -wallSlope;
        ship.velocity *= 0.99;
    } else if (x > wallSlope) {
        x = wallSlope;
        ship.velocity *= 0.99;
    }
    const nextFrame = frames[(seg + 1) % n]!;
    const lerpedUpRaw = lerpVec3(frame.up, nextFrame.up, Math.max(0, Math.min(1, local.z)));
    ship.worldPos = frameToWorld(frame, { x, y: local.y, z: local.z });
    ship.currentSegment = seg;

    touchBoost(ship, x, track);

    let direction = ship.velocityDirection;
    let n2 = lerpVec3(ship.up, lerpedUpRaw, frameWeightToDt(0.1, dt));
    n2 = normalizeVec3Object(n2);
    const right = normalizeVec3Object(crossVec3(n2, direction));
    direction = normalizeVec3Object(crossVec3(right, n2));
    const up = normalizeVec3Object(crossVec3(direction, right));
    ship.up = up;
    ship.velocityDirection = direction;

    const localTime = simTime + ship.index;
    const noise: Vec3 = { x: Math.cos(localTime), y: Math.sin(1.67 * localTime) * Math.cos(localTime * 0.37), z: Math.sin(localTime * 2.14) };
    const noiseStrength = 0.1;
    const maxSpeed = MAX_SPEED * ship.aiSpeedFactor;
    let speedRatio = ship.velocity / maxSpeed;
    speedRatio = speedRatio > 1 ? 1 : speedRatio < 0 ? 0 : speedRatio;

    let steer = 0;
    let go = false;
    if (ship.isAI) {
        const aimFrame = frames[(seg + 6) % n]!;
        let aim = subVec3(aimFrame.pos, ship.worldPos);
        aim = normalizeVec3Object(aim);
        let dtProj = dotVec3(right, aim);
        const ahead = firstShipAhead(ships, ship.index, 6);
        if (ahead) {
            const avoid = normalizeVec3Object(subVec3(ahead.worldPos, ship.worldPos));
            const dtAvoid = dotVec3(right, avoid);
            const tolerance = 0.1;
            if (Math.abs(dtProj - dtAvoid) < tolerance) {
                dtProj = dtAvoid > dtProj ? dtAvoid + tolerance : dtAvoid - tolerance;
            }
        }
        steer = dtProj;
        go = true;
    } else {
        steer = Math.max(-1, Math.min(1, axes.steer));
        go = axes.accelerate;
    }
    let desiredTilt = MAX_STEER_TILT * steer;
    const desiredYawRate = MAX_YAW_RATE * steer;

    if (go && ship.velocity < maxSpeed) {
        ship.velocity += MAX_ACCEL * (1 - speedRatio) * dt;
    }
    ship.velocity *= Math.pow(VELOCITY_DRAG_PER_SEC, dt);

    // Drift/inertia: blend the effective (visual/motion) direction toward the steered direction.
    // `inertiaWeight` is the ORIGINAL per-frame blend factor (1 - speedRatio*0.98) — converted below.
    const inertiaWeight = frameWeightToDt(1 - speedRatio * 0.98, dt);
    ship.velocityDirectionEffective = normalizeVec3Object(lerpVec3(ship.velocityDirectionEffective, ship.velocityDirection, inertiaWeight));
    ship.worldPos = addVec3(ship.worldPos, scaleVec3(ship.velocityDirectionEffective, ship.velocity * dt));

    ship.rotYSpeed += (desiredYawRate - ship.rotYSpeed) * frameWeightToDt(0.1, dt);
    ship.velocityDirection = normalizeVec3Object(rotateAroundAxis(ship.velocityDirection, ship.up, ship.rotYSpeed * dt));

    desiredTilt += noise.x * noiseStrength * 3;
    ship.tiltZ += (desiredTilt - ship.tiltZ) * frameWeightToDt(0.1, dt);
    ship.wobble = { x: noise.x * noiseStrength, y: noise.y * noiseStrength + 0.5, z: noise.z * noiseStrength };

    ship.orientationQuat = quatFromLookDirectionRH(ship.velocityDirection, ship.up);
    ship.boostFlashTimer = Math.max(0, ship.boostFlashTimer - dt);

    // Trail emission point: a fixed local offset behind+above the ship, in its own basis.
    ship.trailEmitPoint = addVec3(ship.worldPos, addVec3(scaleVec3(ship.velocityDirection, -1.1), scaleVec3(ship.up, 0.2)));
}

export function tickAllShips(ships: readonly ShipState[], track: TrackData, dt: number, axesForPlayer: (playerSlot: 0 | 1) => ShipAxes, simTime: number): void {
    for (const ship of ships) {
        const axes = ship.isAI ? { steer: 0, accelerate: false } : axesForPlayer(ship.playerSlot as 0 | 1);
        tickShip(ship, ships, track, dt, axes, simTime);
    }
}

/** Rank ships by total progress (laps * ring count + current ring), highest first. */
export function rankShips(ships: readonly ShipState[]): ShipState[] {
    return [...ships].sort((a, b) => b.lapCount * RING_COUNT + b.currentSegment - (a.lapCount * RING_COUNT + a.currentSegment));
}
