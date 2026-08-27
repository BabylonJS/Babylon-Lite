/**
 * Antigravity Racer — camera rigs.
 *
 * `ChaseCamera` follows one ship from a ship-relative offset (matches the
 * source PG's `CameraRels`-driven follow cam): each tick it computes the
 * desired world position/target directly from the ship's own (right, up,
 * forward) basis — exactly like the original — and eases a `FreeCamera`
 * toward them. Lite's `FreeCamera` always keeps world +Y as its look-at up
 * (see GUIDANCE), so unlike the original the camera doesn't visually roll
 * through banked/inverted sections, but its POSITION still correctly follows
 * the ship's actual orientation, so it never clips through the track.
 * `SpectatorCamera` (demo/attract mode) uses a plain world-up orbit instead,
 * which is a good fit since it isn't locked to one ship's banking.
 */

import type { ArcRotateCamera, FreeCamera, SceneContext } from "babylon-lite";
import { createArcRotateCamera, createFreeCamera, dampScalar, expDampFactor } from "babylon-lite";

import type { ShipState } from "./simulation.js";
import { CAMERA_LERP_TAU, CHASE_CAMERA_LOOK_AHEAD, CHASE_CAMERA_OFFSETS, MAX_SPEED } from "./constants.js";

/** Ship-relative unit "right" vector (right = up × forward, matching the ship's own convention). */
function shipRight(ship: ShipState): { x: number; y: number; z: number } {
    const u = ship.up;
    const f = ship.velocityDirection;
    const x = u.y * f.z - u.z * f.y;
    const y = u.z * f.x - u.x * f.z;
    const z = u.x * f.y - u.y * f.x;
    const len = Math.sqrt(x * x + y * y + z * z) || 1;
    return { x: x / len, y: y / len, z: z / len };
}

export class ChaseCamera {
    readonly camera: FreeCamera;
    private _offsetIndex = 0;
    private _px: number;
    private _py: number;
    private _pz: number;
    private _tx: number;
    private _ty: number;
    private _tz: number;

    constructor(scene: SceneContext, ship: ShipState) {
        const off = CHASE_CAMERA_OFFSETS[0]!;
        const right = shipRight(ship);
        const p = ship.worldPos;
        this._px = p.x + right.x * off.x + ship.up.x * off.y + ship.velocityDirection.x * off.z;
        this._py = p.y + right.y * off.x + ship.up.y * off.y + ship.velocityDirection.y * off.z;
        this._pz = p.z + right.z * off.x + ship.up.z * off.y + ship.velocityDirection.z * off.z;
        this._tx = p.x + ship.velocityDirection.x * CHASE_CAMERA_LOOK_AHEAD;
        this._ty = p.y + ship.velocityDirection.y * CHASE_CAMERA_LOOK_AHEAD;
        this._tz = p.z + ship.velocityDirection.z * CHASE_CAMERA_LOOK_AHEAD;
        this.camera = createFreeCamera({ x: this._px, y: this._py, z: this._pz }, { x: this._tx, y: this._ty, z: this._tz });
        this.camera.fov = 0.75;
        this.camera.nearPlane = 0.3;
        this.camera.farPlane = 800;
        scene.camera = this.camera;
    }

    cycleOffset(): void {
        this._offsetIndex = (this._offsetIndex + 1) % CHASE_CAMERA_OFFSETS.length;
    }

    tick(dt: number, ship: ShipState): void {
        const cam = this.camera;
        const speedRatio = Math.min(1, Math.abs(ship.velocity) / MAX_SPEED);
        const off = CHASE_CAMERA_OFFSETS[this._offsetIndex]!;
        const p = ship.worldPos;
        const right = shipRight(ship);

        const desiredPX = p.x + right.x * off.x + ship.up.x * off.y + ship.velocityDirection.x * off.z;
        const desiredPY = p.y + right.y * off.x + ship.up.y * off.y + ship.velocityDirection.y * off.z;
        const desiredPZ = p.z + right.z * off.x + ship.up.z * off.y + ship.velocityDirection.z * off.z;
        const desiredTX = p.x + ship.velocityDirection.x * CHASE_CAMERA_LOOK_AHEAD;
        const desiredTY = p.y + ship.velocityDirection.y * CHASE_CAMERA_LOOK_AHEAD;
        const desiredTZ = p.z + ship.velocityDirection.z * CHASE_CAMERA_LOOK_AHEAD;

        const t = expDampFactor(dt, CAMERA_LERP_TAU * (1.2 - speedRatio * 0.5));
        this._px = dampScalar(this._px, desiredPX, t);
        this._py = dampScalar(this._py, desiredPY, t);
        this._pz = dampScalar(this._pz, desiredPZ, t);
        this._tx = dampScalar(this._tx, desiredTX, t);
        this._ty = dampScalar(this._ty, desiredTY, t);
        this._tz = dampScalar(this._tz, desiredTZ, t);
        cam.position.set(this._px, this._py, this._pz);
        cam.target.set(this._tx, this._ty, this._tz);

        const desiredFov = 0.72 + speedRatio * 0.1 + (ship.boostFlashTimer > 0 ? 0.15 : 0);
        cam.fov = dampScalar(cam.fov, desiredFov, expDampFactor(dt, 0.08));
    }
}

/** Spectator camera for demo/attract mode: slowly auto-orbits the current leader, and
 *  periodically swaps to another ship for variety. */
export class SpectatorCamera {
    readonly camera: ArcRotateCamera;
    private _retargetIn = 3;
    private _target: ShipState;

    constructor(scene: SceneContext, initial: ShipState) {
        this._target = initial;
        this.camera = createArcRotateCamera(0, 1.1, 16, { x: initial.worldPos.x, y: initial.worldPos.y, z: initial.worldPos.z });
        this.camera.fov = 0.8;
        this.camera.nearPlane = 0.3;
        this.camera.farPlane = 800;
        scene.camera = this.camera;
    }

    tick(dt: number, ships: readonly ShipState[]): void {
        this._retargetIn -= dt;
        if (this._retargetIn <= 0) {
            this._retargetIn = 4 + Math.random() * 4;
            const candidates = ships.filter((s) => s !== this._target);
            if (candidates.length) {
                this._target = candidates[Math.floor(Math.random() * candidates.length)]!;
            }
        }
        const p = this._target.worldPos;
        const t = expDampFactor(dt, 0.6);
        this.camera.target.x = dampScalar(this.camera.target.x, p.x, t);
        this.camera.target.y = dampScalar(this.camera.target.y, p.y, t);
        this.camera.target.z = dampScalar(this.camera.target.z, p.z, t);
        this.camera.alpha += dt * 0.15;
        this.camera.beta = 1.05 + Math.sin(this.camera.alpha * 0.6) * 0.15;
        const speedRatio = Math.min(1, Math.abs(this._target.velocity) / MAX_SPEED);
        this.camera.radius = dampScalar(this.camera.radius, 12 + speedRatio * 6, expDampFactor(dt, 0.5));
    }
}
