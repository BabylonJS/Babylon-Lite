/**
 * Antigravity Racer — ship simulation (physics + AI steering).
 *
 * A tick-for-tick port of the playground's `TickShip`. Every formula and every
 * constant is the original's, in the original's per-tick units; the fixed 60 Hz
 * clock in `game.ts` is what makes that frame-rate independent, not any
 * rescaling. See `docs/lite/architecture/demo-antigravity-racer.md` for the
 * annotated derivation of each step.
 */

import type { Quat, Vec3 } from "babylon-lite";
import { addVec3, crossVec3, dotVec3, lerpVec3, normalizeVec3Object, quatFromLookDirectionRH, scaleVec3, subVec3 } from "babylon-lite";

import { advanceSegment, frameLocalCoords, frameToWorld, type TrackData } from "./track.js";
import {
    AI_AIM_LOOKAHEAD,
    AI_AVOID_LIMIT,
    AI_AVOID_TOLERANCE,
    BOOST_DEBOUNCE_SEGMENTS,
    BOOST_SPEED_KICK,
    CEIL_DAMP,
    FLOOR_DAMP,
    GRAVITY_NOISE_STRENGTH,
    INERTIA_SPEED_TERM,
    LAST_BONUS_SEGMENT_INIT,
    MAX_ACCEL,
    MAX_SPEED,
    MAX_STEER_TILT,
    MAX_YAW_RATE,
    NOISE_TILT_GAIN,
    TILT_BLEND,
    TRAIL_EMITTER_LOCAL,
    UP_BLEND,
    VELOCITY_DRAG,
    WALL_BASE_SLOPE,
    WALL_HIT_DRAG,
    WOBBLE_Y_OFFSET,
    YAW_BLEND,
} from "./constants.js";

/** Per-tick control intent for a human-driven ship. Binary, exactly like the playground's key map. */
export interface ShipControls {
    left: boolean;
    right: boolean;
    accelerate: boolean;
}

export interface ShipState {
    /** Spawn segment index; doubles as the anti-gravity noise phase offset (the PG's `Index`). */
    readonly index: number;
    readonly isAI: boolean;
    /** Which human player controls this ship (0 or 1), or -1 for AI. */
    readonly playerSlot: number;
    worldPos: Vec3;
    /** World units per tick. */
    velocity: number;
    /** Steered heading (unit length). */
    velocityDirection: Vec3;
    /** Drifting heading. Deliberately NOT normalized — its length drop is what costs speed in corners. */
    velocityDirectionEffective: Vec3;
    up: Vec3;
    /** The (right, up, forward) basis written to `ShipMesh` this tick — captured BEFORE the yaw update,
     *  because the original assigns `ShipMesh.rotation` before rotating `velocityDirection`. The camera
     *  and the trail emitter read this basis, not the post-yaw heading. */
    meshRight: Vec3;
    /** Forward axis of the `ShipMesh` basis (see {@link ShipState.meshRight}). */
    meshForward: Vec3;
    rotYSpeed: number;
    currentSegment: number;
    lastBonusSegment: number;
    /** Visual-only banking roll (radians), smoothed (`ShipTransform.rotation.z`). */
    tiltZ: number;
    /** Visual-only local wobble offset (`ShipTransform.position`). */
    wobble: Vec3;
    /** World orientation, derived each tick from the (right, up, forward) basis. */
    orientationQuat: Quat;
    /** Pre-acceleration speed ratio for this tick — the trail's `intensity` channel. */
    trailIntensity: number;
    /** Which of `CHASE_CAMERA_OFFSETS` this ship's chase camera uses. */
    cameraOffsetIndex: number;
}

/** `speedRatio` as the original computes it — clamped at 1, from the CURRENT velocity. */
export function shipSpeedRatio(ship: ShipState): number {
    const ratio = ship.velocity / MAX_SPEED;
    return ratio > 1 ? 1 : ratio;
}

/**
 * The trail emitter in world space: `TransformCoordinates((0.05, 0, 0.85), ShipTransform.worldMatrix)`.
 *
 * `ShipTransform` is `translate(wobble) · Ry(π) · Rz(tiltZ)` under `ShipMesh`'s (right, up, direction)
 * basis at `worldPos`, so the local point folds to
 * `(wobble.x - 0.05·cos(tilt), wobble.y + 0.05·sin(tilt), wobble.z - 0.85)` before being lifted into the
 * ship basis. `antigravity-racer-simulation.test.ts` proves the folded form equals the matrix composition.
 */
export function shipEmitterPoint(ship: ShipState): Vec3 {
    const c = Math.cos(ship.tiltZ);
    const s = Math.sin(ship.tiltZ);
    const lx = ship.wobble.x - TRAIL_EMITTER_LOCAL.x * c;
    const ly = ship.wobble.y + TRAIL_EMITTER_LOCAL.x * s;
    const lz = ship.wobble.z - TRAIL_EMITTER_LOCAL.z;
    const right = ship.meshRight;
    const forward = ship.meshForward;
    return {
        x: ship.worldPos.x + right.x * lx + ship.up.x * ly + forward.x * lz,
        y: ship.worldPos.y + right.y * lx + ship.up.y * ly + forward.y * lz,
        z: ship.worldPos.z + right.z * lx + ship.up.z * ly + forward.z * lz,
    };
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

/** Spawn a ship on `spawnSegment`, offset laterally (`lateral`, in local track-width units). */
export function createShipState(track: TrackData, spawnSegment: number, lateral: number, index: number, isAI: boolean, playerSlot: number): ShipState {
    const frame = track.frames[spawnSegment % track.frames.length]!;
    return {
        index,
        isAI,
        playerSlot,
        worldPos: frameToWorld(frame, { x: lateral, y: 0, z: 0 }),
        velocity: 0,
        velocityDirection: { ...frame.dir },
        velocityDirectionEffective: { ...frame.dir },
        up: { ...frame.up },
        meshRight: { ...frame.right },
        meshForward: { ...frame.dir },
        rotYSpeed: 0,
        currentSegment: spawnSegment % track.frames.length,
        lastBonusSegment: LAST_BONUS_SEGMENT_INIT,
        tiltZ: 0,
        wobble: { x: 0, y: WOBBLE_Y_OFFSET, z: 0 },
        orientationQuat: quatFromLookDirectionRH(frame.dir, frame.up),
        trailIntensity: 0,
        cameraOffsetIndex: 0,
    };
}

/** Nearest ship strictly ahead of `ships[selfIndex]` within `limit` segments (the PG's `GetFirstNextShip`). */
function firstShipAhead(ships: readonly ShipState[], selfIndex: number, limit: number, segmentCount: number): ShipState | null {
    const current = ships[selfIndex]!.currentSegment;
    let best: ShipState | null = null;
    let bestValue = limit;
    for (let i = 0; i < ships.length; i++) {
        if (i === selfIndex) {
            continue;
        }
        const diff = (ships[i]!.currentSegment - current + segmentCount) % segmentCount;
        if (diff < bestValue) {
            best = ships[i]!;
            bestValue = diff;
        }
    }
    return best;
}

/** Advance one ship by exactly one 60 Hz tick. `controls` is only read for human ships. */
export function tickShip(ship: ShipState, ships: readonly ShipState[], track: TrackData, controls: ShipControls, simTime: number): void {
    const frames = track.frames;
    const count = frames.length;

    // ── Segment advance, wall clamp, vertical adhesion ──────────────────────
    const seg = advanceSegment(frames, ship.currentSegment, ship.worldPos);
    const frame = frames[seg]!;
    const local = frameLocalCoords(frame, ship.worldPos);
    // The damped Y is written BACK into the reconstructed world position — this is what
    // glues the ship to the deck, with the original's floor/ceiling asymmetry.
    local.y *= local.y < 0 ? FLOOR_DAMP : CEIL_DAMP;
    const wallSlope = WALL_BASE_SLOPE + local.y;
    if (local.x < -wallSlope) {
        local.x = -wallSlope;
        ship.velocity *= WALL_HIT_DRAG;
    }
    if (local.x > wallSlope) {
        local.x = wallSlope;
        ship.velocity *= WALL_HIT_DRAG;
    }
    const nextFrame = frames[(seg + 1) % count]!;
    // `Matrix.Lerp(M[seg], M[seg+1], local.z)` is a component-wise, UNCLAMPED blend and only its
    // up column is ever read, so blend the up vectors directly — extrapolation included.
    const interpolatedUp = lerpVec3(frame.up, nextFrame.up, local.z);
    ship.worldPos = frameToWorld(frame, local);
    ship.currentSegment = seg;

    // ── Boost pads ──────────────────────────────────────────────────────────
    if (Math.abs(seg - ship.lastBonusSegment) > BOOST_DEBOUNCE_SEGMENTS && ((local.x > 1 && track.boostRight[seg]) || (local.x < -1 && track.boostLeft[seg]))) {
        ship.lastBonusSegment = seg;
        ship.velocity += BOOST_SPEED_KICK;
    }

    // ── Orientation frame ───────────────────────────────────────────────────
    let direction = ship.velocityDirection;
    const n = normalizeVec3Object(lerpVec3(ship.up, interpolatedUp, UP_BLEND));
    const right = normalizeVec3Object(crossVec3(n, direction));
    direction = normalizeVec3Object(crossVec3(right, n));
    const up = normalizeVec3Object(crossVec3(direction, right));
    ship.up = up;
    ship.velocityDirection = direction;
    // `ShipMesh.rotation` is written HERE in the original, before the yaw update below, so the
    // camera and the trail emitter see this basis for the rest of the tick.
    ship.meshRight = right;
    ship.meshForward = direction;
    ship.orientationQuat = quatFromLookDirectionRH(direction, up);

    // ── Noise + steering intent ─────────────────────────────────────────────
    const localTime = simTime + ship.index;
    const noiseX = Math.cos(localTime);
    const noiseY = Math.sin(1.67 * localTime) * Math.cos(localTime * 0.37);
    const noiseZ = Math.sin(localTime * 2.14);
    // Computed BEFORE this tick's acceleration, and reused by the camera and the trail.
    const speedRatio = shipSpeedRatio(ship);
    ship.trailIntensity = speedRatio;

    let desiredTilt = 0;
    let desiredYaw = 0;
    let go = false;
    if (ship.isAI) {
        const aim = normalizeVec3Object(subVec3(frames[(seg + AI_AIM_LOOKAHEAD) % count]!.pos, ship.worldPos));
        let d = dotVec3(right, aim);
        const ahead = firstShipAhead(ships, ships.indexOf(ship), AI_AVOID_LIMIT, count);
        if (ahead) {
            const ds = dotVec3(right, normalizeVec3Object(subVec3(ahead.worldPos, ship.worldPos)));
            if (Math.abs(d - ds) < AI_AVOID_TOLERANCE) {
                d = ds > d ? ds + AI_AVOID_TOLERANCE : ds - AI_AVOID_TOLERANCE;
            }
        }
        desiredTilt = MAX_STEER_TILT * d;
        desiredYaw = MAX_YAW_RATE * d;
        go = true;
    } else {
        // Binary, and RIGHT WINS when both are held — the playground's `if (left) … if (right) …`.
        if (controls.left) {
            desiredTilt = -MAX_STEER_TILT;
            desiredYaw = -MAX_YAW_RATE;
        }
        if (controls.right) {
            desiredTilt = MAX_STEER_TILT;
            desiredYaw = MAX_YAW_RATE;
        }
        go = controls.accelerate;
    }

    // ── Acceleration, drag, drift, integration ──────────────────────────────
    if (go && ship.velocity < MAX_SPEED) {
        ship.velocity += MAX_ACCEL * (1 - speedRatio);
    }
    ship.velocity *= VELOCITY_DRAG;

    const fakeInertia = 1 - speedRatio * INERTIA_SPEED_TERM;
    // NOT normalized: through a corner the blended direction shortens, and the ship loses ground speed.
    ship.velocityDirectionEffective = lerpVec3(ship.velocityDirectionEffective, ship.velocityDirection, fakeInertia);
    ship.worldPos = addVec3(ship.worldPos, scaleVec3(ship.velocityDirectionEffective, ship.velocity));

    ship.rotYSpeed += (desiredYaw - ship.rotYSpeed) * YAW_BLEND;
    ship.velocityDirection = normalizeVec3Object(rotateAroundAxis(ship.velocityDirection, ship.up, ship.rotYSpeed));

    // ── Visual transform ────────────────────────────────────────────────────
    desiredTilt += noiseX * GRAVITY_NOISE_STRENGTH * NOISE_TILT_GAIN;
    ship.tiltZ += (desiredTilt - ship.tiltZ) * TILT_BLEND;
    ship.wobble = {
        x: noiseX * GRAVITY_NOISE_STRENGTH,
        y: noiseY * GRAVITY_NOISE_STRENGTH + WOBBLE_Y_OFFSET,
        z: noiseZ * GRAVITY_NOISE_STRENGTH,
    };
}

const AI_CONTROLS: ShipControls = { left: false, right: false, accelerate: false };

/** Tick every ship once, in spawn order — the playground's `TickShips` loop. */
export function tickAllShips(ships: readonly ShipState[], track: TrackData, controlsForPlayer: (playerSlot: 0 | 1) => ShipControls, simTime: number): void {
    for (const ship of ships) {
        tickShip(ship, ships, track, ship.isAI ? AI_CONTROLS : controlsForPlayer(ship.playerSlot as 0 | 1), simTime);
    }
}
