/**
 * Physics Controller — manual kinematics for gravity, jumping, and ground clamp.
 *
 * No Havok or external physics engine. Gravity pulls the character down each
 * frame, Space applies a jump impulse when grounded, and Y is clamped to the
 * highest supporting surface. All support comes from the live rigid-body
 * source (the Workspace parts, ground plate included); there is no
 * hardcoded ground plane. Falling past the kill plane respawns at the origin
 * (classic fell-off-the-baseplate behavior). Emits "jumped", "airborne", and
 * "landed" events for the state machine.
 */

import type { TransformNode } from "babylon-lite";

import type { EventEmitter, PlayerEvents } from "./events.js";
import type { InputManager } from "./input-manager.js";
import type { RigidBody } from "./rigid-body.js";

const GRAVITY = 196; // studs/s²
const JUMP_VELOCITY = 50; // studs/s

/** Below this Y the character respawns at the spawn point. */
const KILL_PLANE_Y = -80;

/** Character start + kill-plane respawn point. Single source for both. */
export const SPAWN = { x: -20, y: 0, z: -20 } as const;

/** Character collision half-extents (XZ), matching MovementController. */
const CHAR_HX = 0.5;
const CHAR_HZ = 0.5;

/** Live provider of collidable bodies (the Workspace's parts). */
export type RigidBodySource = () => readonly RigidBody[];

export class PhysicsController {
    private readonly _root: TransformNode;
    private readonly _input: InputManager;
    private readonly _events: EventEmitter<PlayerEvents>;
    private readonly _bodies: RigidBodySource;
    private _verticalVelocity = 0;
    private _grounded = true;

    constructor(root: TransformNode, input: InputManager, events: EventEmitter<PlayerEvents>, bodies: RigidBodySource = () => []) {
        this._root = root;
        this._input = input;
        this._events = events;
        this._bodies = bodies;
    }

    /**
     * Tick order: jump check → gravity → position integration → ground clamp
     * → kill plane. `dt` is in seconds, already capped to 0.05 by the caller.
     */
    tick(dt: number): void {
        // Step 1 — Jump impulse
        if (this._input.isJumpPressed() && this._grounded) {
            this._verticalVelocity = JUMP_VELOCITY;
            this._grounded = false;
            this._events.emit("jumped", undefined as void);
            this._events.emit("airborne", undefined as void);
        }

        // Step 2 — Gravity
        this._verticalVelocity -= GRAVITY * dt;

        // Step 3 — Integrate position. Support candidacy is judged from the
        // PRE-integration height — a fast fall must not tunnel past a surface
        // that was under the feet at tick start.
        const prevY = this._root.position.y;
        this._root.position.y += this._verticalVelocity * dt;

        // Step 4 — Ground clamp (highest supporting surface)
        const groundY = this._computeGroundLevel(prevY);
        if (this._root.position.y <= groundY) {
            this._root.position.y = groundY;
            this._verticalVelocity = 0;
            if (!this._grounded) {
                this._grounded = true;
                this._events.emit("landed", undefined as void);
            }
        }

        // Step 5 — Kill plane: fell off the world → respawn (classic).
        if (this._root.position.y < KILL_PLANE_Y) {
            this._root.position.x = SPAWN.x;
            this._root.position.y = SPAWN.y;
            this._root.position.z = SPAWN.z;
            this._verticalVelocity = 0;
            this._grounded = false; // next clamp fires "landed" for the state machine
        }
    }

    isGrounded(): boolean {
        return this._grounded;
    }

    /**
     * Compute the highest supporting surface under the character footprint,
     * or -Infinity when nothing is below (free fall off the world edge).
     * `fromY` is the pre-integration height (prevents fast-fall tunneling).
     */
    private _computeGroundLevel(fromY: number): number {
        let ground = -Infinity;
        const cx = this._root.position.x;
        const cz = this._root.position.z;
        for (const body of this._bodies()) {
            const b = body.getAABB();
            // Character footprint must overlap rigid body XZ
            const overlapX = Math.min(cx + CHAR_HX, b.maxX) - Math.max(cx - CHAR_HX, b.minX);
            const overlapZ = Math.min(cz + CHAR_HZ, b.maxZ) - Math.max(cz - CHAR_HZ, b.minZ);
            if (overlapX > 0 && overlapZ > 0) {
                // Can stand on top of this rigid body
                if (b.maxY > ground && b.maxY <= fromY + 0.1) {
                    ground = b.maxY;
                }
            }
        }
        return ground;
    }
}
