/**
 * Racer vehicle — loads a Kenney car GLB, locates its `body` + `wheel-*` child
 * nodes, and drives them with a clean-room TypeScript port of the kit's GDScript
 * arcade controller (`scripts/vehicle.gd`).
 *
 * Like the original, the car's planar motion comes from a hidden dynamic physics
 * sphere (see `./physics.ts`): speed and steering ease toward their targets with
 * the kit's own lerp rates, the controller drives the ball's velocity along the
 * heading and reads the settled position back, and the visual body/wheels lean,
 * roll and steer exactly as they do in the Godot original.
 */

import type { EngineContext, Mesh, SceneContext, TransformNode } from "babylon-lite";
import { addToScene, getContainerMeshes, loadGltf } from "babylon-lite";

import type { RacerAxes } from "./input.js";
import type { CarBall } from "./physics.js";

// ── Tunables (matched to the kit; a few signs depend on glTF handedness) ──────
const MAX_SPEED = 10; // world units/second at full throttle
const CAR_Y = 0.15; // ride height so the wheels sit on the road surface
const WHEEL_SPIN = 62; // visual wheel roll gain (kit adds `acceleration` per 60fps frame)
const FORWARD_SIGN = 1; // flip if W drives backwards
const STEER_SIGN = -1; // heading turns the same way the front wheels point (glTF/Babylon handedness)
const MODEL_YAW_OFFSET = 0; // radians, if the car model faces sideways
const DRIVE_GRIP = 8; // how fast the ball's velocity chases the heading (lower ⇒ looser, more drift)
// Speed easing rates (per second): lower ⇒ a more gradual build-up / run-down, less "all or nothing".
const ACCEL_RATE = 2.5; // throttle ramp toward target speed (also the coast-down when you lift off)
const BRAKE_RATE = 4; // active braking (S while rolling forward)
const REVERSE_RATE = 2; // building up reverse speed

export interface Vehicle {
    /** Yaw/position this to move the whole car. */
    readonly root: TransformNode;
    readonly body: TransformNode | null;
    /** Authored local body height, retained across animation and vehicle swaps. */
    readonly bodyRestY: number;
    readonly wheels: {
        readonly frontLeft: TransformNode | null;
        readonly frontRight: TransformNode | null;
        readonly backLeft: TransformNode | null;
        readonly backRight: TransformNode | null;
    };
    /** Every renderable mesh in the car, for shadow-caster registration. */
    readonly meshes: readonly Mesh[];
    /** True for the motorcycle — it leans INTO turns, opposite the cars' body roll. */
    readonly motorcycle: boolean;
}

/** Depth-first search for a node by exact name within a loaded hierarchy. */
function findNode(root: TransformNode, name: string): TransformNode | null {
    if (root.name === name) {
        return root;
    }
    for (const child of root.children) {
        const found = findNode(child as TransformNode, name);
        if (found) {
            return found;
        }
    }
    return null;
}

/** Load a car GLB, register it with the scene, and resolve its animated parts. */
export async function loadVehicle(engine: EngineContext, scene: SceneContext, url: string, motorcycle = false): Promise<Vehicle> {
    const container = await loadGltf(engine, url);
    addToScene(scene, container);
    const root = container.entities[0] as TransformNode;
    const body = findNode(root, "body");
    return {
        root,
        body,
        bodyRestY: body?.position.y ?? 0,
        wheels: {
            // Trucks have four named wheels; the motorcycle has just `wheel-front` / `wheel-back`.
            frontLeft: findNode(root, "wheel-front-left") ?? findNode(root, "wheel-front"),
            frontRight: findNode(root, "wheel-front-right") ?? findNode(root, "wheel-front"),
            backLeft: findNode(root, "wheel-back-left") ?? findNode(root, "wheel-back"),
            backRight: findNode(root, "wheel-back-right") ?? findNode(root, "wheel-back"),
        },
        meshes: getContainerMeshes(container),
        motorcycle,
    };
}

// ── Small math helpers ────────────────────────────────────────────────────────

function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * Math.min(1, Math.max(0, t));
}

function clamp(v: number, lo: number, hi: number): number {
    return Math.min(hi, Math.max(lo, v));
}

type Quat = [number, number, number, number];

/** Quaternion product a·b (x,y,z,w). */
function qmul(a: Quat, b: Quat): Quat {
    const [ax, ay, az, aw] = a;
    const [bx, by, bz, bw] = b;
    return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}

function qAxis(axis: 0 | 1 | 2, angle: number): Quat {
    const h = angle / 2;
    const s = Math.sin(h);
    const q: Quat = [0, 0, 0, Math.cos(h)];
    q[axis] = s;
    return q;
}

/** Set a node's rotation from an XYZ Euler triple via quaternions (no proxy round-trip). */
function setEulerXYZ(node: TransformNode, x: number, y: number, z: number): void {
    const q = qmul(qmul(qAxis(0, x), qAxis(1, y)), qAxis(2, z));
    node.rotationQuaternion.set(q[0], q[1], q[2], q[3]);
}

/**
 * Arcade vehicle controller — a faithful port of `scripts/vehicle.gd`. Owns the
 * car's motion state, and each frame drives the physics ball (when assigned) and
 * the visual nodes.
 */
export class VehicleController {
    private _v: Vehicle;

    private _posX = 0;
    private _posZ = 0;
    private _heading = 0; // yaw, radians

    private _speed = 0; // linear_speed, roughly [-1, 1]
    private _angularSpeed = 0;
    private _acceleration = 0;
    private _lean = 0; // calculated_lean
    private _bodyPitch = 0;
    private _steerAngle = 0; // front-wheel steer
    private _wheelRoll = 0;

    /**
     * Dynamic-sphere physics proxy. When set, the ball owns the car's planar
     * position and barrier collisions: the controller drives its velocity toward
     * the heading and reads the settled centre back each frame. Assigned by the
     * demo once the world + colliders exist.
     */
    ball: CarBall | null = null;

    private _groundY = 0;
    private _groundPitch = 0;
    private _groundRoll = 0;

    constructor(vehicle: Vehicle, startX = 0, startZ = 0, startHeading = 0) {
        this._v = vehicle;
        this._posX = startX;
        this._posZ = startZ;
        this._heading = startHeading;
        this._applyRoot();
    }

    /** Swap the visible car model (vehicle selection); keeps the current pose. */
    setVehicle(vehicle: Vehicle): void {
        this._v = vehicle;
        this._applyRoot();
    }

    /** Current world position (for the follow camera); y rides up over bumps so the camera bobs too. */
    get position(): { x: number; y: number; z: number } {
        return { x: this._posX, y: CAR_Y + this._groundY, z: this._posZ };
    }

    /** Current forward speed, ~[-1, 1] (for the camera's speed-based zoom). */
    get speed(): number {
        return this._speed;
    }

    /** Unit world-space forward direction the car is pointing (for the chase camera). */
    get forward(): { x: number; z: number } {
        return { x: Math.sin(this._heading) * FORWARD_SIGN, z: Math.cos(this._heading) * FORWARD_SIGN };
    }

    /** Drift intensity (kit's `|speed − acceleration| + |lean|·2`), for smoke/skid effects. */
    get driftIntensity(): number {
        return Math.abs(this._speed - this._acceleration) + Math.abs(this._lean) * 2;
    }

    /** True when the current vehicle is the motorcycle — one rear wheel, so a single smoke/skid trail. */
    get isMotorcycle(): boolean {
        return this._v.motorcycle;
    }

    tick(dt: number, axes: RacerAxes): void {
        const inputX = axes.steer;
        const inputZ = axes.throttle;

        // ── Steering ──────────────────────────────────────────────────────────
        let direction = Math.sign(this._speed);
        if (direction === 0) {
            direction = Math.abs(inputZ) > 0.1 ? Math.sign(inputZ) : 1;
        }
        const steeringGrip = clamp(Math.abs(this._speed), 0.2, 1.0);
        const targetAngular = -inputX * steeringGrip * 4 * direction * STEER_SIGN;
        this._angularSpeed = lerp(this._angularSpeed, targetAngular, dt * 4);
        this._heading += this._angularSpeed * dt;

        // ── Throttle / brake / reverse (eased for a gradual build-up) ───────────
        const targetSpeed = inputZ;
        if (targetSpeed < 0 && this._speed > 0.01) {
            this._speed = lerp(this._speed, 0, dt * BRAKE_RATE); // braking
        } else if (targetSpeed < 0) {
            this._speed = lerp(this._speed, targetSpeed / 2, dt * REVERSE_RATE); // reverse (half speed)
        } else {
            this._speed = lerp(this._speed, targetSpeed, dt * ACCEL_RATE); // accelerate / coast down
        }
        this._acceleration = lerp(this._acceleration, this._speed, dt * 1);

        // ── Drive the physics ball toward the heading velocity, read its planar position back ─
        const fwdX = Math.sin(this._heading) * FORWARD_SIGN;
        const fwdZ = Math.cos(this._heading) * FORWARD_SIGN;
        if (this.ball) {
            this.ball.drive(fwdX * this._speed * MAX_SPEED, fwdZ * this._speed * MAX_SPEED, DRIVE_GRIP);
            const p = this.ball.position();
            this._posX = p.x;
            this._posZ = p.z;
        } else {
            this._posX += fwdX * this._speed * MAX_SPEED * dt;
            this._posZ += fwdZ * this._speed * MAX_SPEED * dt;
        }
        this._alignToGround(dt);
        this._applyRoot();

        // ── Visual effects ────────────────────────────────────────────────────
        this._effectBody(dt, inputX);
        this._effectWheels(dt, inputX);
    }

    private _applyRoot(): void {
        this._v.root.position.set(this._posX, CAR_Y + this._groundY, this._posZ);
        this._v.root.rotation.set(this._groundPitch, this._heading + MODEL_YAW_OFFSET, this._groundRoll);
    }

    /** Read the physics ground under the car — the ball's ride-height plus a raycast slope — and ease toward it. */
    private _alignToGround(dt: number): void {
        const ball = this.ball;
        if (!ball) {
            return;
        }
        const fx = Math.sin(this._heading) * FORWARD_SIGN;
        const fz = Math.cos(this._heading) * FORWARD_SIGN;
        const L = 1.0; // fore/aft probe distance (≈ half wheelbase)
        const W = 0.7; // left/right probe distance (≈ half track)
        const front = ball.heightAt(this._posX + fx * L, this._posZ + fz * L);
        const back = ball.heightAt(this._posX - fx * L, this._posZ - fz * L);
        // NB: the perpendicular offset (-fz, fx) is the car's physical right; (+fz, -fx) is its left.
        const heightRight = ball.heightAt(this._posX + fz * W, this._posZ - fx * W);
        const heightLeft = ball.heightAt(this._posX - fz * W, this._posZ + fx * W);
        this._groundY = lerp(this._groundY, ball.position().y - ball.restY, dt * 12);
        this._groundPitch = lerp(this._groundPitch, Math.atan2(front - back, 2 * L), dt * 12);
        this._groundRoll = lerp(this._groundRoll, Math.atan2(heightRight - heightLeft, 2 * W), dt * 12);
    }

    private _effectBody(dt: number, inputX: number): void {
        // A motorcycle leans INTO the turn; the cars body-roll the other way — same magnitude, flipped sign.
        const leanSign = this._v.motorcycle ? -1 : 1;
        this._lean = lerp(this._lean, leanSign * (-inputX / 5) * this._speed, dt * 5);
        this._bodyPitch = lerp(this._bodyPitch, -(this._speed - this._acceleration) / 6, dt * 10);
        const body = this._v.body;
        if (body) {
            setEulerXYZ(body, this._bodyPitch, 0, this._lean);
            body.position.y = lerp(body.position.y, this._v.bodyRestY + 0.05, dt * 5);
        }
    }

    private _effectWheels(dt: number, inputX: number): void {
        // Roll all wheels proportionally to acceleration (kit adds per 60fps frame).
        this._wheelRoll += this._acceleration * dt * WHEEL_SPIN;
        this._steerAngle = lerp(this._steerAngle, -inputX / 1.5, dt * 10);

        const { frontLeft, frontRight, backLeft, backRight } = this._v.wheels;
        // Front wheels steer (yaw) then roll about their steered axle.
        const frontRotation = qmul(qAxis(1, this._steerAngle), qAxis(0, this._wheelRoll));
        if (frontLeft) {
            frontLeft.rotationQuaternion.set(...frontRotation);
        }
        if (frontRight && frontRight !== frontLeft) {
            frontRight.rotationQuaternion.set(...frontRotation);
        }
        const rearRotation = qAxis(0, this._wheelRoll);
        if (backLeft) {
            backLeft.rotationQuaternion.set(...rearRotation);
        }
        if (backRight && backRight !== backLeft) {
            backRight.rotationQuaternion.set(...rearRotation);
        }
    }
}
