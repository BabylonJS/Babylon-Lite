/**
 * Antigravity Racer — camera rigs.
 *
 * Both rigs are per-tick ports of the playground's camera code in `TickShips`,
 * and both use a {@link createBankedFreeCamera} so the view rolls with the track
 * exactly like the original's `camera.upVector` writes.
 *
 * `ChaseCamera` follows one human ship from a ship-local offset; `DemoCamera` is
 * the attract-mode camera that re-anchors ahead of ship 5 every 2–4 seconds and
 * dollies with a fixed orientation in between.
 */

import type { BankedFreeCamera, SceneContext, Vec3 } from "babylon-lite";
import { createBankedFreeCamera } from "babylon-lite";

import { shipSpeedRatio, type ShipState } from "./simulation.js";
import type { TrackData } from "./track.js";
import {
    CAMERA_FOV,
    CAMERA_LERP_BASE,
    CAMERA_LERP_SPEED_TERM,
    CHASE_CAMERA_OFFSETS,
    CHASE_TARGET_LOCAL,
    DEMO_CAMERA_LOOKAHEAD,
    DEMO_CAMERA_MIN_TIME,
    DEMO_CAMERA_SHIP,
    DEMO_CAMERA_TIME_RANGE,
    DEMO_CAMERA_UP,
    EDITOR_CAMERA_FAR,
    TICK_TIME,
} from "./constants.js";

/** `TransformCoordinates(local, ShipMesh.worldMatrix)` — writes into `out`. */
function shipLocalToWorldToRef(ship: ShipState, local: Vec3, out: Vec3): Vec3 {
    const p = ship.worldPos;
    const r = ship.meshRight;
    const u = ship.up;
    const d = ship.meshForward;
    out.x = p.x + r.x * local.x + u.x * local.y + d.x * local.z;
    out.y = p.y + r.y * local.x + u.y * local.y + d.y * local.z;
    out.z = p.z + r.z * local.x + u.z * local.y + d.z * local.z;
    return out;
}

function lerpTo(current: number, goal: number, t: number): number {
    return current + (goal - current) * t;
}

/**
 * Chase camera for a human ship.
 *
 * Per tick the desired position/target are read straight out of the ship's own world matrix, then the
 * camera eases toward them with the original's speed-dependent weight `0.1 + speedRatio * 0.7`. Storing
 * and lerping the target point matches Babylon's `TargetCamera.target` semantics: after `setTarget(t)`
 * with the already-updated position, `_currentTarget` is exactly `t` again.
 */
export class ChaseCamera {
    readonly camera: BankedFreeCamera;
    private readonly _ship: ShipState;
    private readonly _desiredPos: Vec3 = { x: 0, y: 0, z: 0 };
    private readonly _desiredTarget: Vec3 = { x: 0, y: 0, z: 0 };

    constructor(scene: SceneContext, ship: ShipState) {
        this._ship = ship;
        shipLocalToWorldToRef(ship, CHASE_CAMERA_OFFSETS[ship.cameraOffsetIndex]!, this._desiredPos);
        shipLocalToWorldToRef(ship, CHASE_TARGET_LOCAL, this._desiredTarget);
        this.camera = createBankedFreeCamera({ ...this._desiredPos }, { ...this._desiredTarget }, ship.up);
        this.camera.fov = CAMERA_FOV;
        scene.camera = this.camera;
    }

    /** Cycle to the next `CameraRels` offset (C key / gamepad shoulder). */
    cycleOffset(): void {
        this._ship.cameraOffsetIndex = (this._ship.cameraOffsetIndex + 1) % CHASE_CAMERA_OFFSETS.length;
    }

    tick(): void {
        const ship = this._ship;
        const cam = this.camera;
        shipLocalToWorldToRef(ship, CHASE_CAMERA_OFFSETS[ship.cameraOffsetIndex]!, this._desiredPos);
        shipLocalToWorldToRef(ship, CHASE_TARGET_LOCAL, this._desiredTarget);
        const k = CAMERA_LERP_BASE + shipSpeedRatio(ship) * CAMERA_LERP_SPEED_TERM;

        cam.position.set(lerpTo(cam.position.x, this._desiredPos.x, k), lerpTo(cam.position.y, this._desiredPos.y, k), lerpTo(cam.position.z, this._desiredPos.z, k));
        cam.target.set(lerpTo(cam.target.x, this._desiredTarget.x, k), lerpTo(cam.target.y, this._desiredTarget.y, k), lerpTo(cam.target.z, this._desiredTarget.z, k));
        cam.upVector.set(lerpTo(cam.upVector.x, ship.up.x, k), lerpTo(cam.upVector.y, ship.up.y, k), lerpTo(cam.upVector.z, ship.up.z, k));
    }
}

/**
 * Attract-mode camera.
 *
 * Every 2–4 seconds it re-anchors on the segment frame 20 ahead of ship 5, two units along that frame's
 * up axis, looking three units along a randomly-signed ±3× forward vector, with the frame's up as its up.
 * Between anchors it only dollies: position AND target move by the same delta each tick, which is what
 * keeps Babylon's orientation fixed when `position` is written without a `setTarget`.
 */
export class DemoCamera {
    readonly camera: BankedFreeCamera;
    private readonly _track: TrackData;
    private readonly _ships: readonly ShipState[];
    private _time = 0;
    private readonly _translate: Vec3 = { x: 0, y: 0, z: 0 };

    constructor(scene: SceneContext, track: TrackData, ships: readonly ShipState[]) {
        this._track = track;
        this._ships = ships;
        const frame = track.frames[0]!;
        this.camera = createBankedFreeCamera(frame.pos, { x: frame.pos.x + frame.dir.x, y: frame.pos.y + frame.dir.y, z: frame.pos.z + frame.dir.z }, frame.up);
        this.camera.fov = CAMERA_FOV;
        this.camera.farPlane = EDITOR_CAMERA_FAR;
        scene.camera = this.camera;
        this._anchor();
    }

    tick(): void {
        this._time -= TICK_TIME;
        if (this._time < 0) {
            this._anchor();
            return;
        }
        const cam = this.camera;
        const dx = this._translate.x * TICK_TIME;
        const dy = this._translate.y * TICK_TIME;
        const dz = this._translate.z * TICK_TIME;
        // Position and target move together: Babylon keeps the rotation fixed while only `position`
        // is written, so the camera dollies without re-aiming.
        cam.position.set(cam.position.x + dx, cam.position.y + dy, cam.position.z + dz);
        cam.target.set(cam.target.x + dx, cam.target.y + dy, cam.target.z + dz);
    }

    private _anchor(): void {
        const frames = this._track.frames;
        const anchorShip = this._ships[DEMO_CAMERA_SHIP] ?? this._ships[0]!;
        const frame = frames[(anchorShip.currentSegment + DEMO_CAMERA_LOOKAHEAD) % frames.length]!;
        this._time = Math.random() * DEMO_CAMERA_TIME_RANGE + DEMO_CAMERA_MIN_TIME;

        const dirFactor = 3 * (Math.random() > 0.5 ? 1 : -1);
        const aimX = frame.dir.x * dirFactor;
        const aimY = frame.dir.y * dirFactor;
        const aimZ = frame.dir.z * dirFactor;

        // TransformCoordinates INCLUDES the frame's translation, so this is a world point — then
        // scaled to a small drift velocity. Faithfully odd, exactly like the original.
        const rx = Math.random() - 0.5;
        const ry = Math.random() * 2 - 1;
        const rz = Math.random() * 2 - 1;
        const scale = Math.random() * 0.014;
        this._translate.x = (frame.pos.x + frame.right.x * rx + frame.up.x * ry + frame.dir.x * rz) * scale;
        this._translate.y = (frame.pos.y + frame.right.y * rx + frame.up.y * ry + frame.dir.y * rz) * scale;
        this._translate.z = (frame.pos.z + frame.right.z * rx + frame.up.z * ry + frame.dir.z * rz) * scale;

        const cam = this.camera;
        cam.position.set(
            frame.pos.x + frame.up.x * DEMO_CAMERA_UP - this._translate.x * this._time,
            frame.pos.y + frame.up.y * DEMO_CAMERA_UP - this._translate.y * this._time,
            frame.pos.z + frame.up.z * DEMO_CAMERA_UP - this._translate.z * this._time
        );
        cam.target.set(frame.pos.x + aimX * 3, frame.pos.y + aimY * 3, frame.pos.z + aimZ * 3);
        cam.upVector.set(frame.up.x, frame.up.y, frame.up.z);
    }
}
