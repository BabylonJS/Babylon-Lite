/**
 * Movement Controller — camera-relative WASD movement with smooth orientation
 * and AABB rigid body collision.
 *
 * Translates WASD input into horizontal movement at 16 studs/s, relative to
 * the camera's horizontal angle. After computing the desired position the
 * controller resolves overlaps against world rigid bodies (blocks) by sliding
 * along the nearest non-penetrating edge.
 */

import type { SceneNode } from "babylon-lite";

import type { CameraController } from "./camera-controller.js";
import type { InputManager } from "./input-manager.js";
import type { RigidBodySource } from "./physics-controller.js";

const WALK_SPEED = 16; // studs/s
const TURN_RATE = 13; // rad/s for orientation interpolation

/** Classic auto-step: ledges up to this height are climbed, not collided. */
const STEP_HEIGHT = 1.2;
/** Climb speed for auto-step (studs/s) — a deliberate hop, not a snap.
 *  The climb is a deterministic ramp that overwrites the same-frame gravity
 *  dip — below ~21 studs/s a naive per-tick rise never outruns accumulating
 *  fall velocity and the character stalls mid-step. */
const STEP_CLIMB_RATE = 15;
/** Character collision height (feet to head), matching PhysicsController use. */
const CHAR_HEIGHT = 5;

/** Character collision half-extents (XZ only). */
const CHAR_HX = 0.5;
const CHAR_HZ = 0.5;

export class MovementController {
    private readonly _root: SceneNode;
    private readonly _input: InputManager;
    private readonly _camera: CameraController;
    private readonly _bodies: RigidBodySource;
    private _currentYaw = 0;
    private _climbBaseY: number | null = null;
    private _climbElapsed = 0;

    constructor(root: SceneNode, input: InputManager, camera: CameraController, bodies: RigidBodySource = () => []) {
        this._root = root;
        this._input = input;
        this._camera = camera;
        this._bodies = bodies;
    }

    tick(dt: number): void {
        const keys = this._input.getMovementKeys();
        let dx = 0;
        let dz = 0;
        if (keys.w) {
            dz += 1;
        }
        if (keys.s) {
            dz -= 1;
        }
        if (keys.a) {
            dx -= 1;
        }
        if (keys.d) {
            dx += 1;
        }

        // No movement input → early exit (retain last facing direction)
        if (dx === 0 && dz === 0) {
            this._climbBaseY = null;
            return;
        }

        // Camera-relative direction
        const alpha = this._camera.getAlpha();
        const forwardX = -Math.cos(alpha);
        const forwardZ = -Math.sin(alpha);
        const rightX = -Math.sin(alpha);
        const rightZ = Math.cos(alpha);

        let moveX = dx * rightX + dz * forwardX;
        let moveZ = dx * rightZ + dz * forwardZ;

        // Normalize diagonal
        const length = Math.sqrt(moveX * moveX + moveZ * moveZ);
        if (length > 0) {
            moveX /= length;
            moveZ /= length;
        }

        // Desired position
        let nx = this._root.position.x + moveX * WALK_SPEED * dt;
        let nz = this._root.position.z + moveZ * WALK_SPEED * dt;

        // Resolve rigid body collisions: slide along edges, but auto-step
        // onto low ledges (<= STEP_HEIGHT) so paths and
        // single bricks are walkable, 2-stud walls still block.
        const cy = this._root.position.y;
        const slideOut = (b: { minX: number; maxX: number; minZ: number; maxZ: number }): void => {
            const overlapX = Math.min(nx + CHAR_HX, b.maxX) - Math.max(nx - CHAR_HX, b.minX);
            const overlapZ = Math.min(nz + CHAR_HZ, b.maxZ) - Math.max(nz - CHAR_HZ, b.minZ);
            if (overlapX > 0 && overlapZ > 0) {
                // Push out on the axis with the smallest overlap
                if (overlapX < overlapZ) {
                    nx += nx < (b.minX + b.maxX) / 2 ? -overlapX : overlapX;
                } else {
                    nz += nz < (b.minZ + b.maxZ) / 2 ? -overlapZ : overlapZ;
                }
            }
        };
        let stepUpTo = -Infinity;
        for (const body of this._bodies()) {
            const b = body.getAABB();
            // Skip if no vertical overlap (character feet..top vs rigid body)
            if (cy >= b.maxY || cy + CHAR_HEIGHT <= b.minY) {
                continue;
            }
            const overlapX = Math.min(nx + CHAR_HX, b.maxX) - Math.max(nx - CHAR_HX, b.minX);
            const overlapZ = Math.min(nz + CHAR_HZ, b.maxZ) - Math.max(nz - CHAR_HZ, b.minZ);
            if (overlapX > 0 && overlapZ > 0) {
                if (b.maxY - cy <= STEP_HEIGHT) {
                    stepUpTo = Math.max(stepUpTo, b.maxY); // climbable — defer
                } else {
                    slideOut(b);
                }
            }
        }
        if (stepUpTo <= cy) {
            this._climbBaseY = null; // not climbing this tick
        }
        if (stepUpTo > cy) {
            // Re-evaluate at the post-slide position: step only if a climbable
            // ledge still overlaps there AND the raised column has headroom.
            let onLedge = false;
            let clear = true;
            for (const body of this._bodies()) {
                const b = body.getAABB();
                const ox = Math.min(nx + CHAR_HX, b.maxX) - Math.max(nx - CHAR_HX, b.minX);
                const oz = Math.min(nz + CHAR_HZ, b.maxZ) - Math.max(nz - CHAR_HZ, b.minZ);
                if (ox <= 0 || oz <= 0) {
                    continue;
                }
                if (b.maxY > cy && b.maxY - cy <= STEP_HEIGHT) {
                    onLedge = true; // the ledge itself (or another climbable one)
                    continue;
                }
                if (stepUpTo < b.maxY && stepUpTo + CHAR_HEIGHT > b.minY) {
                    clear = false;
                    break;
                }
            }
            if (onLedge && clear) {
                // Rise along a fixed ramp from the climb's start height:
                // instant snap reads jarring). Overwrites this frame's gravity
                // dip; max() preserves jumps. The physics ground clamp fires
                // the grounded bookkeeping once the feet reach the ledge top.
                if (this._climbBaseY === null) {
                    this._climbBaseY = cy;
                    this._climbElapsed = 0;
                }
                this._climbElapsed += dt;
                const ramp = Math.min(stepUpTo, this._climbBaseY + STEP_CLIMB_RATE * this._climbElapsed);
                this._root.position.y = Math.max(this._root.position.y, ramp);
                if (this._root.position.y >= stepUpTo) {
                    this._climbBaseY = null; // climb complete
                }
            } else if (onLedge) {
                // No headroom — the ledges are walls after all.
                this._climbBaseY = null;
                for (const body of this._bodies()) {
                    const b = body.getAABB();
                    if (cy >= b.maxY || b.maxY - cy > STEP_HEIGHT || cy + CHAR_HEIGHT <= b.minY) {
                        continue;
                    }
                    slideOut(b);
                }
            } else {
                this._climbBaseY = null; // slid clear of the ledge
            }
        }

        this._root.position.x = nx;
        this._root.position.z = nz;

        // Smooth orientation toward movement direction
        const desiredYaw = Math.atan2(moveX, moveZ);
        let diff = desiredYaw - this._currentYaw;

        // Normalize diff to [-π, π]
        while (diff > Math.PI) {
            diff -= 2 * Math.PI;
        }
        while (diff < -Math.PI) {
            diff += 2 * Math.PI;
        }

        const maxStep = TURN_RATE * dt;
        if (Math.abs(diff) <= maxStep) {
            this._currentYaw = desiredYaw;
        } else {
            this._currentYaw += Math.sign(diff) * maxStep;
        }

        // Y-axis quaternion: (0, sin(θ/2), 0, cos(θ/2))
        this._root.rotationQuaternion.set(0, Math.sin(this._currentYaw / 2), 0, Math.cos(this._currentYaw / 2));
    }
}
