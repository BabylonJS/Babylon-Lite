/**
 * Havok Physics V2 character controller for Babylon Lite — a collide-and-slide kinematic
 * character built entirely on the Havok shapecast / shapeproximity query primitives.
 *
 * Kept in a standalone, tree-shakeable module: the per-frame `_stepWorld` core in `havok.ts`
 * never references this code, so only scenes that import {@link createPhysicsCharacterController}
 * pay for it. The controller sweeps a capsule shape through the world each step, builds a contact
 * manifold from the cast + proximity hits, turns the contacts into surface constraints, then runs
 * a simplex velocity solver (1D/2D/3D plane clipping) to compute a collision-free displacement.
 *
 * ```ts
 *   const cc = createPhysicsCharacterController(world, { x: 0, y: 1, z: 0 }, { capsuleHeight: 1.8, capsuleRadius: 0.6 });
 *   onPhysicsAfterStep(world, () => {
 *       cc.moveWithCollisions({ x: 0, y: -0.05, z: 0.02 });
 *       const p = cc.getPosition();
 *       displayMesh.position.set(p.x, p.y, p.z);
 *   });
 * ```
 *
 * The algorithm follows Babylon.js' `PhysicsCharacterController` (Apache-2.0), re-expressed with
 * Lite's plain-data `Vec3` math and free-function physics API. Left-handed, +Y up.
 */

import type { Quat, Vec3 } from "../math/types.js";
import { mat4Invert } from "../math/mat4-invert.js";
import type { Mat4 } from "../math/types.js";
import { createTransformNode } from "../scene/transform-node.js";
import type { TransformNode } from "../scene/transform-node.js";
import {
    createPhysicsBody,
    createPhysicsShape,
    PhysicsMotionType,
    PhysicsShapeType,
    removePhysicsBody,
    setPhysicsBodyMassProperties,
    setPhysicsBodyPreStep,
    setPhysicsBodyShape,
} from "./havok.js";
import type { PhysicsBody, PhysicsShape, PhysicsWorld } from "./havok.js";

// ─── Public types ────────────────────────────────────────────────────

/** Contact state of the character against the geometry beneath it. */
export const enum CharacterSupportedState {
    /** No surface within reach. */
    UNSUPPORTED = 0,
    /** Touching a surface too steep to stand on; the character slides. */
    SLIDING = 1,
    /** Standing on a walkable surface. */
    SUPPORTED = 2,
}

/** Options describing the character's collision capsule. */
export interface PhysicsCharacterControllerOptions {
    /** Total capsule height (tip to tip), in metres. Default `1.8`. */
    capsuleHeight: number;
    /** Capsule radius, in metres. Default `0.6`. */
    capsuleRadius: number;
}

/**
 * Collision event fired by {@link PhysicsCharacterController.onTriggerCollisionObservable}
 * for every dynamic body the character pushes during a step. Mirrors Babylon.js'
 * `onTriggerCollisionObservable` payload (minus its `colliderIndex`, which has no Lite equivalent).
 */
export interface CharacterCollisionEvent {
    /** The dynamic physics body the character contacted. Its `.node.name` identifies the collider. */
    collider: PhysicsBody;
    /** Impulse (world space) the character applied to the collider at the contact point. */
    impulse: Vec3;
    /** World-space position of the contact at which the impulse was applied. */
    impulsePosition: Vec3;
}

/**
 * Minimal single-event observable used by {@link PhysicsCharacterController} for collision
 * callbacks. Kept local to the physics module (no dependency on gizmo/observable code) so the
 * character-controller graph stays self-contained and tree-shakeable.
 */
export class CharacterCollisionObservable {
    private _subs: ((event: CharacterCollisionEvent) => void)[] = [];

    /**
     * Subscribe to collision events.
     * @param cb - Callback invoked for each dynamic-body contact during a step.
     * @returns A disposer that removes the subscription when called.
     */
    public add(cb: (event: CharacterCollisionEvent) => void): () => void {
        this._subs.push(cb);
        return () => {
            const i = this._subs.indexOf(cb);
            if (i >= 0) {
                this._subs.splice(i, 1);
            }
        };
    }

    /**
     * Notify all subscribers of a collision event.
     * @param event - The collision event payload.
     */
    public notify(event: CharacterCollisionEvent): void {
        for (const s of this._subs) {
            s(event);
        }
    }
}

/** Surface information returned by {@link PhysicsCharacterController.checkSupport}. */
export interface CharacterSurfaceInfo {
    /** Whether the supporting surface belongs to a dynamic (simulated) body. */
    isSurfaceDynamic: boolean;
    /** Whether the character is unsupported, sliding, or supported. */
    supportedState: CharacterSupportedState;
    /** Average normal of the supporting surfaces (world space). */
    averageSurfaceNormal: Vec3;
    /** Average linear velocity induced by the supporting surfaces. */
    averageSurfaceVelocity: Vec3;
    /** Average angular velocity induced by the supporting surfaces. */
    averageAngularSurfaceVelocity: Vec3;
}

// ─── Internal data structures ────────────────────────────────────────

interface Contact {
    position: Vec3;
    normal: Vec3;
    distance: number;
    fraction: number;
    body: PhysicsBody | null;
    allowedPenetration: number;
}

interface SurfaceConstraint {
    planeNormal: Vec3;
    planeDistance: number;
    staticFriction: number;
    dynamicFriction: number;
    extraUpStaticFriction: number;
    extraDownStaticFriction: number;
    velocity: Vec3;
    angularVelocity: Vec3;
    priority: number;
}

const enum InteractionStatus {
    OK = 0,
    FAILURE_3D = 1,
    FAILURE_2D = 2,
}

interface PlaneInteraction {
    touched: boolean;
    stopped: boolean;
    surfaceTime: number;
    penaltyDistance: number;
    status: InteractionStatus;
}

interface ActivePlane {
    index: number;
    constraint: SurfaceConstraint;
    interaction: PlaneInteraction;
}

interface SolverInfo {
    supportPlanes: ActivePlane[];
    numSupportPlanes: number;
    currentTime: number;
    inputConstraints: SurfaceConstraint[];
    outputInteractions: PlaneInteraction[];
}

interface SolverOutput {
    position: Vec3;
    velocity: Vec3;
    deltaTime: number;
    planeInteractions: PlaneInteraction[];
}

interface BodyTracking {
    prev: number[];
    frameId: number;
}

// ─── Vec3 helpers (plain-data, allocation-friendly) ──────────────────

function v(x = 0, y = 0, z = 0): Vec3 {
    return { x, y, z };
}
function vclone(a: Vec3): Vec3 {
    return { x: a.x, y: a.y, z: a.z };
}
function vcopy(d: Vec3, s: Vec3): void {
    d.x = s.x;
    d.y = s.y;
    d.z = s.z;
}
function vset(d: Vec3, x: number, y: number, z: number): void {
    d.x = x;
    d.y = y;
    d.z = z;
}
function vadd(a: Vec3, b: Vec3): Vec3 {
    return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}
function vsub(a: Vec3, b: Vec3): Vec3 {
    return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}
function vscale(a: Vec3, s: number): Vec3 {
    return { x: a.x * s, y: a.y * s, z: a.z * s };
}
function vaddIn(d: Vec3, a: Vec3): void {
    d.x += a.x;
    d.y += a.y;
    d.z += a.z;
}
function vsubIn(d: Vec3, a: Vec3): void {
    d.x -= a.x;
    d.y -= a.y;
    d.z -= a.z;
}
function vscaleIn(d: Vec3, s: number): void {
    d.x *= s;
    d.y *= s;
    d.z *= s;
}
function vdot(a: Vec3, b: Vec3): number {
    return a.x * b.x + a.y * b.y + a.z * b.z;
}
function vcross(a: Vec3, b: Vec3): Vec3 {
    return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}
function vlenSq(a: Vec3): number {
    return a.x * a.x + a.y * a.y + a.z * a.z;
}
function vlen(a: Vec3): number {
    return Math.sqrt(vlenSq(a));
}
function vnormIn(a: Vec3): void {
    const l = vlen(a);
    if (l > 1e-12) {
        const inv = 1 / l;
        a.x *= inv;
        a.y *= inv;
        a.z *= inv;
    }
}
function vequalsEps(a: Vec3, b: Vec3, eps: number): boolean {
    return Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps && Math.abs(a.z - b.z) <= eps;
}
function clamp(value: number, lo: number, hi: number): number {
    return Math.min(Math.max(value, lo), hi);
}

/** Transform a position by a column-major 4×4 matrix (with translation). */
function transformCoord(m: ArrayLike<number>, p: Vec3): Vec3 {
    return {
        x: p.x * m[0]! + p.y * m[4]! + p.z * m[8]! + m[12]!,
        y: p.x * m[1]! + p.y * m[5]! + p.z * m[9]! + m[13]!,
        z: p.x * m[2]! + p.y * m[6]! + p.z * m[10]! + m[14]!,
    };
}

// ─── Controller ──────────────────────────────────────────────────────

/**
 * A physics-driven character controller. Create one with
 * {@link createPhysicsCharacterController}; drive it each physics step with
 * {@link PhysicsCharacterController.moveWithCollisions} and read back the resolved position
 * with {@link PhysicsCharacterController.getPosition}.
 */
export class PhysicsCharacterController {
    /** Minimum separation kept from surfaces, in metres. Default `0.05`. */
    public keepDistance = 0.05;
    /** Extra distance over which a contact is still tracked. Default `0.1`. */
    public keepContactTolerance = 0.1;
    /** Maximum number of cast iterations per integration step. Default `10`. */
    public maxCastIterations = 10;
    /** Speed at which penetrations are pushed out. Default `1.0`. */
    public penetrationRecoverySpeed = 1.0;
    /** Static-friction coefficient against surfaces. Default `0`. */
    public staticFriction = 0;
    /** Dynamic-friction coefficient against surfaces. Default `1`. */
    public dynamicFriction = 1;
    /** Cosine of the steepest slope the character can stand on. Default `0.5` (60°). */
    public maxSlopeCosine = 0.5;
    /** Upper bound on per-solve character speed. Default `10`. */
    public maxCharacterSpeedForSolver = 10.0;
    /** World up vector. Default `(0, 1, 0)`. */
    public up: Vec3 = { x: 0, y: 1, z: 0 };
    /** Push strength applied to dynamic bodies the character contacts. Default `1e38`. */
    public characterStrength = 1e38;
    /** Acceleration factor used by {@link calculateMovement}. Default `0.05`. */
    public acceleration = 0.05;
    /** Maximum world-space acceleration used by {@link calculateMovement}. Default `50`. */
    public maxAcceleration = 50;
    /** Character mass used when reacting to gravity against dynamic bodies. Default `0`. */
    public characterMass = 0;

    /**
     * Fires once per dynamic body the character pushes during a step, just before the reactive
     * impulse is applied. Mirrors Babylon.js' `onTriggerCollisionObservable`. Subscribe with
     * `.add(cb)`; the returned disposer removes the subscription.
     */
    public readonly onTriggerCollisionObservable = new CharacterCollisionObservable();

    private readonly _world: PhysicsWorld;
    private readonly _shape: PhysicsShape;
    private readonly _node: TransformNode;
    private readonly _body: PhysicsBody;
    private readonly _startCollector: any;
    private readonly _castCollector: any;

    private _position: Vec3;
    private _velocity: Vec3 = v();
    private _lastVelocity: Vec3 = v();
    private _lastDisplacement: Vec3 = v();
    private _orientation: Quat = { x: 0, y: 0, z: 0, w: 1 };
    private _manifold: Contact[] = [];
    private _lastInvDeltaTime = 60;
    private _frameId = 0;
    private readonly _contactAngleSensitivity = 10.0;
    private readonly _displacementEps = 1e-4;
    private readonly _bodyTracking = new Map<PhysicsBody, BodyTracking>();

    /** Construct a controller. Prefer the {@link createPhysicsCharacterController} factory. */
    public constructor(world: PhysicsWorld, position: Vec3, options: PhysicsCharacterControllerOptions) {
        this._world = world;
        this._position = vclone(position);

        const r = options.capsuleRadius ?? 0.6;
        const h = options.capsuleHeight ?? 1.8;
        this._shape = createPhysicsShape(world, {
            type: PhysicsShapeType.CAPSULE,
            parameters: { pointA: { x: 0, y: h * 0.5 - r, z: 0 }, pointB: { x: 0, y: -h * 0.5 + r, z: 0 }, radius: r },
        });

        this._node = createTransformNode("CCTransformNode", position.x, position.y, position.z);
        this._body = createPhysicsBody(world, this._node, PhysicsMotionType.ANIMATED);
        setPhysicsBodyShape(world, this._body, this._shape);
        setPhysicsBodyMassProperties(world, this._body, { inertia: { x: 0, y: 0, z: 0 } });
        setPhysicsBodyPreStep(this._body, true);

        const hknp = world._hknp;
        this._startCollector = hknp.HP_QueryCollector_Create(16)[1];
        this._castCollector = hknp.HP_QueryCollector_Create(16)[1];
    }

    /** Release the controller's body, shape, and query collectors. */
    public dispose(): void {
        const hknp = this._world._hknp;
        removePhysicsBody(this._world, this._body);
        hknp.HP_Shape_Release(this._shape._hkShape);
        hknp.HP_QueryCollector_Release(this._startCollector);
        hknp.HP_QueryCollector_Release(this._castCollector);
    }

    /** Get the current character position (world space). The returned vector is owned by the controller. */
    public getPosition(): Vec3 {
        return this._position;
    }

    /** Teleport the character to a new position, clearing any swept motion. */
    public setPosition(position: Vec3): void {
        vcopy(this._position, position);
        this._node.position.set(position.x, position.y, position.z);
    }

    /** Get the current character velocity (world space). The returned vector is owned by the controller. */
    public getVelocity(): Vec3 {
        return this._velocity;
    }

    /** Set the character velocity (world space). */
    public setVelocity(velocity: Vec3): void {
        vcopy(this._velocity, velocity);
    }

    /**
     * Move the character by a displacement this physics step, sliding along any geometry it meets.
     * @param displacement - Requested world-space displacement for this step.
     */
    public moveWithCollisions(displacement: Vec3): void {
        const deltaTime = this._world._timestep;
        if (!deltaTime || deltaTime <= 0) {
            return;
        }
        const invDeltaTime = 1 / deltaTime;
        this._frameId++;
        vcopy(this._velocity, vscale(displacement, invDeltaTime));
        vcopy(this._lastDisplacement, displacement);
        vcopy(this._lastVelocity, this._velocity);
        this._lastInvDeltaTime = invDeltaTime;
        this._integrateManifolds(deltaTime, ZERO);
    }

    /**
     * Advance the controller using a velocity already chosen for this step (instead of a raw
     * displacement). Mirrors Babylon.js' `integrate`: it picks a cast direction from the current
     * velocity and surface info, then runs the collide-and-slide.
     * @param deltaTime - Step duration in seconds.
     * @param surfaceInfo - Surface info from a prior {@link checkSupport} call.
     * @param gravity - Gravity applied to the character this step.
     */
    public integrate(deltaTime: number, surfaceInfo: CharacterSurfaceInfo, gravity: Vec3): void {
        const invDeltaTime = 1 / deltaTime;
        const tolerance = this._displacementEps * invDeltaTime;
        if (vequalsEps(this._velocity, this._lastVelocity, tolerance)) {
            vscaleIn(this._lastDisplacement, deltaTime * this._lastInvDeltaTime);
        } else {
            const displacementVelocity = vclone(this._velocity);
            if (surfaceInfo.supportedState === CharacterSupportedState.SUPPORTED) {
                const relative = vsub(this._velocity, surfaceInfo.averageSurfaceVelocity);
                const normalDotVelocity = vdot(surfaceInfo.averageSurfaceNormal, relative);
                if (normalDotVelocity < 0) {
                    vsubIn(relative, vscale(surfaceInfo.averageSurfaceNormal, normalDotVelocity));
                    vcopy(displacementVelocity, relative);
                    vaddIn(displacementVelocity, surfaceInfo.averageSurfaceVelocity);
                }
            }
            vcopy(this._lastDisplacement, vscale(displacementVelocity, deltaTime));
        }
        vcopy(this._lastVelocity, this._velocity);
        this._lastInvDeltaTime = invDeltaTime;
        this._frameId++;
        this._integrateManifolds(deltaTime, gravity);
    }

    /**
     * Probe the surface under the character along a direction (usually gravity) to classify support.
     * @param deltaTime - Step duration in seconds.
     * @param direction - Direction to probe, usually the gravity direction.
     * @returns Support classification and averaged surface motion/normal.
     */
    public checkSupport(deltaTime: number, direction: Vec3): CharacterSurfaceInfo {
        const eps = 1e-4;
        const info: CharacterSurfaceInfo = {
            isSurfaceDynamic: false,
            supportedState: CharacterSupportedState.UNSUPPORTED,
            averageSurfaceNormal: v(),
            averageSurfaceVelocity: v(),
            averageAngularSurfaceVelocity: v(),
        };
        this._validateManifold();
        const constraints = this._createConstraintsFromManifold(deltaTime, 0);
        const storedVelocities: Vec3[] = [];
        for (const c of constraints) {
            storedVelocities.push(vclone(c.velocity));
            vset(c.velocity, 0, 0, 0);
        }
        const maxSurfaceVelocity = v(this.maxCharacterSpeedForSolver, this.maxCharacterSpeedForSolver, this.maxCharacterSpeedForSolver);
        const output = this._simplexSolverSolve(constraints, direction, deltaTime, deltaTime, maxSurfaceVelocity);
        if (vequalsEps(output.velocity, direction, eps)) {
            info.supportedState = CharacterSupportedState.UNSUPPORTED;
            return info;
        }
        if (vlenSq(output.velocity) < eps) {
            info.supportedState = CharacterSupportedState.SUPPORTED;
        } else {
            vnormIn(output.velocity);
            const angleSin = vdot(output.velocity, direction);
            const cosSqr = 1 - angleSin * angleSin;
            info.supportedState = cosSqr < this.maxSlopeCosine * this.maxSlopeCosine ? CharacterSupportedState.SLIDING : CharacterSupportedState.SUPPORTED;
        }
        let numTouching = 0;
        for (let i = 0; i < constraints.length; i++) {
            if (output.planeInteractions[i]!.touched && vdot(constraints[i]!.planeNormal, direction) < -0.08) {
                vaddIn(info.averageSurfaceNormal, constraints[i]!.planeNormal);
                vaddIn(info.averageSurfaceVelocity, storedVelocities[i]!);
                vaddIn(info.averageAngularSurfaceVelocity, constraints[i]!.angularVelocity);
                numTouching++;
            }
        }
        if (numTouching > 0) {
            vnormIn(info.averageSurfaceNormal);
            vscaleIn(info.averageSurfaceVelocity, 1 / numTouching);
            vscaleIn(info.averageAngularSurfaceVelocity, 1 / numTouching);
        }
        if (info.supportedState === CharacterSupportedState.SUPPORTED) {
            for (const m of this._manifold) {
                if (vdot(m.normal, direction) < -0.08 && m.body?.motionType === (PhysicsMotionType.DYNAMIC as number)) {
                    info.isSurfaceDynamic = true;
                    break;
                }
            }
        }
        return info;
    }

    /**
     * Compute a target velocity from the current state, a desired velocity, and surface info — a
     * helper for steering input into surface-aware motion.
     * @param deltaTime - Step duration in seconds.
     * @param forwardWorld - Character forward direction (world space).
     * @param surfaceNormal - Supporting surface normal.
     * @param currentVelocity - Current character velocity.
     * @param surfaceVelocity - Velocity induced by the surface.
     * @param desiredVelocity - Desired character velocity.
     * @param upWorld - Up vector (world space).
     * @returns The new velocity vector.
     */
    public calculateMovement(deltaTime: number, forwardWorld: Vec3, surfaceNormal: Vec3, currentVelocity: Vec3, surfaceVelocity: Vec3, desiredVelocity: Vec3, upWorld: Vec3): Vec3 {
        const eps = 1e-5;
        let binorm = vcross(forwardWorld, upWorld);
        if (vlenSq(binorm) < eps) {
            return v();
        }
        vnormIn(binorm);
        const tangent = vcross(binorm, surfaceNormal);
        vnormIn(tangent);
        binorm = vcross(tangent, surfaceNormal);
        vnormIn(binorm);
        // Orthonormal surface frame rows: tangent, binorm, surfaceNormal. Its inverse is the transpose.
        const rel = vsub(currentVelocity, surfaceVelocity);
        const relative = { x: vdot(rel, tangent), y: vdot(rel, binorm), z: vdot(rel, surfaceNormal) };
        const sideVec = vcross(upWorld, forwardWorld);
        const fwd = vdot(desiredVelocity, forwardWorld);
        const side = vdot(desiredVelocity, sideVec);
        const len = vlen(desiredVelocity);
        const desiredSF = v(-fwd, side, 0);
        vnormIn(desiredSF);
        vscaleIn(desiredSF, len);
        const diff = vsub(desiredSF, relative);
        const lenSq = vlenSq(diff);
        const maxVelocityDelta = this.maxAcceleration * deltaTime;
        const factor = lenSq * this.acceleration * this.acceleration > maxVelocityDelta * maxVelocityDelta ? maxVelocityDelta / Math.sqrt(lenSq) : this.acceleration;
        vscaleIn(diff, factor);
        vaddIn(relative, diff);
        // Transform back to world via the frame rows.
        const result = {
            x: relative.x * tangent.x + relative.y * binorm.x + relative.z * surfaceNormal.x,
            y: relative.x * tangent.y + relative.y * binorm.y + relative.z * surfaceNormal.y,
            z: relative.x * tangent.z + relative.y * binorm.z + relative.z * surfaceNormal.z,
        };
        vaddIn(result, surfaceVelocity);
        return result;
    }

    // ─── Manifold integration ────────────────────────────────────────

    private _integrateManifolds(deltaTime: number, gravity: Vec3): void {
        const epsSqrd = 1e-8;
        let newVelocity = v();
        let remainingTime = deltaTime;
        this._validateManifold();
        for (let iter = 0; iter < this.maxCastIterations && remainingTime > 1e-5; iter++) {
            this._castWithCollectors(this._position, vadd(this._position, this._lastDisplacement));
            const updateResult = this._updateManifold(this._lastDisplacement);
            const constraints = this._createConstraintsFromManifold(deltaTime, deltaTime - remainingTime);
            const maxSurfaceVelocity = v(this.maxCharacterSpeedForSolver, this.maxCharacterSpeedForSolver, this.maxCharacterSpeedForSolver);
            const minDeltaTime = vlenSq(this._velocity) === 0 ? 0 : (0.5 * this.keepDistance) / vlen(this._velocity);
            const solveResults = this._simplexSolverSolve(constraints, this._velocity, remainingTime, minDeltaTime, maxSurfaceVelocity);
            const newDisplacement = solveResults.position;
            const solverDeltaTime = solveResults.deltaTime;
            newVelocity = solveResults.velocity;
            this._resolveContacts(deltaTime, gravity);

            let newContactIndex = -1;
            if (updateResult !== 0 || (vlenSq(newDisplacement) > epsSqrd && !vequalsEps(this._lastDisplacement, newDisplacement, this._displacementEps))) {
                this._castWithCollectors(this._position, vadd(this._position, newDisplacement), true);
                const hknp = this._world._hknp;
                const numCastHits = hknp.HP_QueryCollector_GetNumHits(this._castCollector)[1];
                for (let i = 0; i < numCastHits; i++) {
                    const [fraction, , hitWorld] = hknp.HP_QueryCollector_GetShapeCastResult(this._castCollector, i)[1];
                    const newContact = this._contactFromCast(hitWorld, newDisplacement, fraction);
                    if (this._findContact(newContact, this._manifold, 0.1) === -1) {
                        newContactIndex = this._manifold.length;
                        this._manifold.push(newContact);
                        break;
                    }
                }
            }

            if (newContactIndex >= 0) {
                const newContact = this._manifold[newContactIndex]!;
                const displacementLengthInv = 1 / vlen(newDisplacement);
                const angleBetween = vdot(newDisplacement, newContact.normal) * displacementLengthInv;
                const keepDistanceAlongMovement = this.keepDistance / -angleBetween;
                let fraction = newContact.fraction - keepDistanceAlongMovement * displacementLengthInv;
                fraction = clamp(fraction, 0, 1);
                vaddIn(this._position, vscale(newDisplacement, fraction));
                remainingTime -= solverDeltaTime * fraction;
            } else {
                vaddIn(this._position, newDisplacement);
                remainingTime -= solverDeltaTime;
            }
            vcopy(this._lastDisplacement, newDisplacement);
        }
        vcopy(this._velocity, newVelocity);
        this._node.position.set(this._position.x, this._position.y, this._position.z);
    }

    private _castWithCollectors(startPos: Vec3, endPos: Vec3, castOnly = false): void {
        const hknp = this._world._hknp;
        const hkWorld = this._world._hkWorld;
        const shapeHandle = this._shape._hkShape;
        const startNative = [startPos.x, startPos.y, startPos.z];
        const orientation = [this._orientation.x, this._orientation.y, this._orientation.z, this._orientation.w];
        const ignoreSelf = [this._body._hkBody[0]];
        if (!castOnly) {
            const proxQuery = [shapeHandle, startNative, orientation, this.keepDistance + this.keepContactTolerance, false, ignoreSelf];
            hknp.HP_World_ShapeProximityWithCollector(hkWorld, this._startCollector, proxQuery);
        }
        const castQuery = [shapeHandle, orientation, startNative, [endPos.x, endPos.y, endPos.z], false, ignoreSelf];
        hknp.HP_World_ShapeCastWithCollector(hkWorld, this._castCollector, castQuery);
    }

    private _findBody(id: unknown): PhysicsBody | null {
        const bodies = this._world._bodies;
        for (let i = 0; i < bodies.length; i++) {
            if (bodies[i]!._hkBody[0] === id) {
                return bodies[i]!;
            }
        }
        return null;
    }

    private _contactFromCast(cp: any, castPath: Vec3, hitFraction: number): Contact {
        const normal = v(cp[4][0], cp[4][1], cp[4][2]);
        const dist = -hitFraction * vdot(castPath, normal);
        return {
            position: v(cp[3][0], cp[3][1], cp[3][2]),
            normal,
            distance: dist,
            fraction: hitFraction,
            body: this._findBody(cp[0][0]),
            allowedPenetration: clamp(this.keepDistance - dist, 0, this.keepDistance),
        };
    }

    private _validateManifold(): void {
        this._manifold = this._manifold.filter((c) => c.body === null || this._world._bodies.indexOf(c.body) !== -1);
    }

    private _updateManifold(castPath: Vec3): number {
        const hknp = this._world._hknp;
        const numProximityHits = hknp.HP_QueryCollector_GetNumHits(this._startCollector)[1];
        if (numProximityHits > 0) {
            const newContacts: Contact[] = [];
            let minDistance = 1e38;
            for (let i = 0; i < numProximityHits; i++) {
                const [distance, , contactWorld] = hknp.HP_QueryCollector_GetShapeProximityResult(this._startCollector, i)[1];
                minDistance = Math.min(minDistance, distance);
                newContacts.push({
                    position: v(contactWorld[3][0], contactWorld[3][1], contactWorld[3][2]),
                    normal: v(contactWorld[4][0], contactWorld[4][1], contactWorld[4][2]),
                    distance,
                    fraction: 0,
                    body: this._findBody(contactWorld[0][0]),
                    allowedPenetration: clamp(this.keepDistance - distance, 0, this.keepDistance),
                });
            }
            for (let i = this._manifold.length - 1; i >= 0; i--) {
                const bestMatch = this._findContact(this._manifold[i]!, newContacts, 1.1);
                if (bestMatch >= 0) {
                    const newAllowed = Math.min(clamp(this.keepDistance - newContacts[bestMatch]!.distance, 0, this.keepDistance), this._manifold[i]!.allowedPenetration);
                    this._manifold[i] = newContacts[bestMatch]!;
                    this._manifold[i]!.allowedPenetration = newAllowed;
                    newContacts.splice(bestMatch, 1);
                } else {
                    this._manifold.splice(i, 1);
                }
            }
            const closestContactIndex = newContacts.findIndex((c) => c.distance === minDistance);
            if (closestContactIndex >= 0) {
                const closest = newContacts[closestContactIndex]!;
                const bestMatch = this._findContact(closest, this._manifold, 0.1);
                if (bestMatch >= 0) {
                    const newAllowed = Math.min(clamp(this.keepDistance - closest.distance, 0, this.keepDistance), this._manifold[bestMatch]!.allowedPenetration);
                    this._manifold[bestMatch] = closest;
                    this._manifold[bestMatch]!.allowedPenetration = newAllowed;
                } else {
                    this._manifold.push(closest);
                }
            }
        } else {
            this._manifold.length = 0;
        }

        let numHitBodies = 0;
        const numCastHits = hknp.HP_QueryCollector_GetNumHits(this._castCollector)[1];
        if (numCastHits > 0) {
            let closestHitBodyId: unknown = null;
            for (let i = 0; i < numCastHits; i++) {
                const [fraction, , hitWorld] = hknp.HP_QueryCollector_GetShapeCastResult(this._castCollector, i)[1];
                if (closestHitBodyId === null) {
                    const contact = this._contactFromCast(hitWorld, castPath, fraction);
                    closestHitBodyId = hitWorld[0][0];
                    if (this._findContact(contact, this._manifold, 0.1) === -1) {
                        this._manifold.push(contact);
                    }
                    if (contact.body?.motionType === (PhysicsMotionType.STATIC as number) || contact.body === null) {
                        break;
                    }
                } else if (hitWorld[0][0] !== closestHitBodyId) {
                    numHitBodies++;
                    break;
                }
            }
        }
        return numHitBodies;
    }

    // ─── Contact comparison ──────────────────────────────────────────

    private _compareContacts(a: Contact, b: Contact): number {
        const angSquared = (1 - vdot(a.normal, b.normal)) * this._contactAngleSensitivity * this._contactAngleSensitivity;
        const planeDistSquared = (a.distance - b.distance) * (a.distance * b.distance);
        const aVel = this._getPointVelocity(a.body, a.position);
        const bVel = this._getPointVelocity(b.body, b.position);
        const velocityDiffSquared = vlenSq(vsub(aVel, bVel));
        return angSquared * 10 + velocityDiffSquared * 0.1 + planeDistSquared;
    }

    private _findContact(reference: Contact, list: Contact[], threshold: number): number {
        let bestIdx = -1;
        let bestFitness = threshold;
        for (let i = 0; i < list.length; i++) {
            const fitness = this._compareContacts(reference, list[i]!);
            if (fitness < bestFitness) {
                bestFitness = fitness;
                bestIdx = i;
            }
        }
        return bestIdx;
    }

    // ─── Body kinematics ─────────────────────────────────────────────

    private _getMassProperties(body: PhysicsBody): any {
        return this._world._hknp.HP_Body_GetMassProperties(body._hkBody)[1];
    }

    private _getComWorld(body: PhysicsBody): Vec3 {
        const com = this._getMassProperties(body)[0];
        return transformCoord(body.node.worldMatrix, v(com[0], com[1], com[2]));
    }

    private _getPointVelocity(body: PhysicsBody | null, pointWorld: Vec3): Vec3 {
        if (!body) {
            return v();
        }
        const hknp = this._world._hknp;
        const comWorld = this._getComWorld(body);
        const relPos = vsub(pointWorld, comWorld);
        const avArr = hknp.HP_Body_GetAngularVelocity(body._hkBody)[1];
        const av = v(avArr[0], avArr[1], avArr[2]);
        const lvArr = hknp.HP_Body_GetLinearVelocity(body._hkBody)[1];
        return vadd(vcross(av, relPos), v(lvArr[0], lvArr[1], lvArr[2]));
    }

    private _getInvMass(body: PhysicsBody): number {
        const mass = this._getMassProperties(body)[1];
        return mass > 0 ? 1 / mass : 0;
    }

    // ─── Surface constraints ─────────────────────────────────────────

    private _createSurfaceConstraint(dt: number, contact: Contact, timeTravelled: number): SurfaceConstraint {
        const constraint: SurfaceConstraint = {
            planeNormal: vclone(contact.normal),
            planeDistance: contact.distance,
            staticFriction: this.staticFriction,
            dynamicFriction: this.dynamicFriction,
            extraUpStaticFriction: 0,
            extraDownStaticFriction: 0,
            velocity: v(),
            angularVelocity: v(),
            priority: 0,
        };
        const maxSlopeCosine = Math.max(this.maxSlopeCosine, 0.1);
        const normalDotUp = vdot(contact.normal, this.up);
        if (normalDotUp > maxSlopeCosine) {
            const com = this._position;
            const contactArm = vsub(contact.position, com);
            const scale = vdot(contact.normal, contactArm);
            contact.position.x = com.x + this.up.x * scale;
            contact.position.y = com.y + this.up.y * scale;
            contact.position.z = com.z + this.up.z * scale;
        }
        const motionType = contact.body?.motionType ?? (PhysicsMotionType.STATIC as number);
        const shift = vdot(constraint.velocity, constraint.planeNormal) * timeTravelled;
        constraint.planeDistance -= shift;
        if (motionType === (PhysicsMotionType.STATIC as number)) {
            constraint.priority = 2;
        } else if (motionType === (PhysicsMotionType.ANIMATED as number) && contact.body) {
            const body = contact.body;
            const currentWorld = matToArray(body.node.worldMatrix);
            const tracking = this._bodyTracking.get(body);
            if (!tracking) {
                this._bodyTracking.set(body, { prev: currentWorld, frameId: this._frameId });
            } else {
                if (tracking.frameId + 1 === this._frameId) {
                    const inv = mat4Invert(body.node.worldMatrix);
                    if (inv) {
                        const characterLocal = transformCoord(inv, this._position);
                        const characterWorld = transformCoord(tracking.prev, characterLocal);
                        const playerDelta = vsub(this._position, characterWorld);
                        vcopy(constraint.velocity, playerDelta);
                        vscaleIn(constraint.velocity, 1 / dt);
                        constraint.priority = 1;
                    }
                }
                tracking.prev = currentWorld;
                tracking.frameId = this._frameId;
            }
        }
        return constraint;
    }

    private _addMaxSlopePlane(maxSlopeCos: number, index: number, constraints: SurfaceConstraint[], allowedPenetration: number): void {
        const src = constraints[index]!;
        const verticalComponent = vdot(src.planeNormal, this.up);
        if (verticalComponent > 0.01 && verticalComponent < maxSlopeCos) {
            const newConstraint: SurfaceConstraint = {
                planeNormal: vclone(src.planeNormal),
                planeDistance: src.planeDistance,
                velocity: vclone(src.velocity),
                angularVelocity: vclone(src.angularVelocity),
                priority: src.priority,
                dynamicFriction: src.dynamicFriction,
                staticFriction: src.staticFriction,
                extraDownStaticFriction: src.extraDownStaticFriction,
                extraUpStaticFriction: src.extraUpStaticFriction,
            };
            const distance = newConstraint.planeDistance;
            vsubIn(newConstraint.planeNormal, vscale(this.up, verticalComponent));
            vnormIn(newConstraint.planeNormal);
            if (distance >= 0) {
                newConstraint.planeDistance = distance * vdot(newConstraint.planeNormal, src.planeNormal);
            } else {
                const penetrationToResolve = Math.min(0, distance + allowedPenetration);
                newConstraint.planeDistance = penetrationToResolve / vdot(newConstraint.planeNormal, src.planeNormal);
                src.planeDistance = 0;
                this._resolveConstraintPenetration(newConstraint);
            }
            constraints.push(newConstraint);
        }
    }

    private _resolveConstraintPenetration(constraint: SurfaceConstraint): void {
        if (constraint.planeDistance < -1e-6) {
            vsubIn(constraint.velocity, vscale(constraint.planeNormal, constraint.planeDistance * this.penetrationRecoverySpeed));
        }
    }

    private _createConstraintsFromManifold(dt: number, timeTravelled: number): SurfaceConstraint[] {
        const constraints: SurfaceConstraint[] = [];
        for (let i = 0; i < this._manifold.length; i++) {
            const surfaceConstraint = this._createSurfaceConstraint(dt, this._manifold[i]!, timeTravelled);
            constraints.push(surfaceConstraint);
            this._addMaxSlopePlane(this.maxSlopeCosine, i, constraints, this._manifold[i]!.allowedPenetration);
            this._resolveConstraintPenetration(surfaceConstraint);
        }
        return constraints;
    }

    // ─── Contact resolution (push dynamic bodies) ────────────────────

    private _resolveContacts(deltaTime: number, gravity: Vec3): void {
        const eps = 1e-12;
        const hknp = this._world._hknp;
        for (const contact of this._manifold) {
            const body = contact.body;
            if (!body || body.motionType !== (PhysicsMotionType.DYNAMIC as number)) {
                continue;
            }
            const pointRelVel = this._getPointVelocity(body, contact.position);
            vsubIn(pointRelVel, this._velocity);
            const inputProjectedVelocity = vdot(pointRelVel, contact.normal);
            let deltaVelocity = -inputProjectedVelocity * 0.9;
            if (contact.distance < 0) {
                deltaVelocity += (contact.distance * 0.4) / deltaTime;
            }
            let outputImpulse = v();
            if (deltaVelocity < 0) {
                const comWorld = this._getComWorld(body);
                const r = vsub(contact.position, comWorld);
                const jacAng = vcross(r, contact.normal);
                // Inertia is treated as isotropic for the impulse magnitude (Lite bodies use diagonal inertia).
                const inputObjectMassInv = vlenSq(jacAng) * this._getInvMass(body) + this._getInvMass(body);
                let impulseMag = inputObjectMassInv > 0 ? deltaVelocity / inputObjectMassInv : 0;
                const maxPushImpulse = -this.characterStrength * deltaTime;
                if (impulseMag < maxPushImpulse) {
                    impulseMag = maxPushImpulse;
                }
                outputImpulse = vscale(contact.normal, impulseMag);
            }
            let relVelN = vdot(contact.normal, vscale(gravity, deltaTime));
            if (inputProjectedVelocity < 0) {
                relVelN -= inputProjectedVelocity;
            }
            if (relVelN < -eps) {
                vaddIn(outputImpulse, vscale(contact.normal, this.characterMass * relVelN));
            }
            this.onTriggerCollisionObservable.notify({ collider: body, impulse: outputImpulse, impulsePosition: contact.position });
            hknp.HP_Body_ApplyImpulse(body._hkBody, [contact.position.x, contact.position.y, contact.position.z], [outputImpulse.x, outputImpulse.y, outputImpulse.z]);
        }
    }

    // ─── Simplex velocity solver ─────────────────────────────────────

    private _getOutput(info: SolverInfo, constraint: SurfaceConstraint): PlaneInteraction {
        return info.outputInteractions[info.inputConstraints.indexOf(constraint)]!;
    }

    private _sortInfo(info: SolverInfo): void {
        for (let i = 0; i < info.numSupportPlanes - 1; i++) {
            for (let j = i + 1; j < info.numSupportPlanes; j++) {
                const p0 = info.supportPlanes[i]!;
                const p1 = info.supportPlanes[j]!;
                if (p0.constraint.priority < p1.constraint.priority) {
                    continue;
                }
                if (p0.constraint.priority === p1.constraint.priority && vlenSq(p0.constraint.velocity) < vlenSq(p1.constraint.velocity)) {
                    continue;
                }
                info.supportPlanes[i] = p1;
                info.supportPlanes[j] = p0;
            }
        }
    }

    private _solve1d(sci: SurfaceConstraint, velocityIn: Vec3, velocityOut: Vec3): void {
        const eps = 1e-5;
        const groundVelocity = sci.velocity;
        const relativeVelocity = vsub(velocityIn, groundVelocity);
        const planeVel = vdot(relativeVelocity, sci.planeNormal);
        const origVelocity2 = vlenSq(relativeVelocity);
        vsubIn(relativeVelocity, vscale(sci.planeNormal, planeVel));
        const vp2 = planeVel * planeVel;
        const extraStaticFriction = vdot(relativeVelocity, this.up) > 0 ? sci.extraUpStaticFriction : sci.extraDownStaticFriction;
        if (extraStaticFriction > 0) {
            const horizontal = vcross(this.up, sci.planeNormal);
            const hor2 = vlenSq(horizontal);
            let horVel = 0;
            if (hor2 > eps) {
                vscaleIn(horizontal, 1 / Math.sqrt(hor2));
                horVel = vdot(relativeVelocity, horizontal);
                const horVel2 = horVel * horVel;
                const f2 = sci.staticFriction * sci.staticFriction;
                if (vp2 * f2 >= horVel2) {
                    vsubIn(relativeVelocity, vscale(horizontal, horVel));
                    horVel = 0;
                }
            }
            const vertVel2 = origVelocity2 - horVel * horVel - vp2;
            const f2 = (sci.staticFriction + extraStaticFriction) * (sci.staticFriction + extraStaticFriction);
            if (vp2 * f2 >= vertVel2 && horVel === 0) {
                vcopy(velocityOut, groundVelocity);
                return;
            }
        } else {
            const f2 = sci.staticFriction * sci.staticFriction;
            if (vp2 * (1 + f2) >= origVelocity2) {
                vcopy(velocityOut, groundVelocity);
                return;
            }
        }
        if (sci.dynamicFriction < 1) {
            const velOut2 = vlenSq(relativeVelocity);
            if (velOut2 >= eps && velOut2 > 1e-4 * origVelocity2) {
                let f = Math.sqrt(origVelocity2 / velOut2);
                f = sci.dynamicFriction + (1 - sci.dynamicFriction) * f;
                vscaleIn(relativeVelocity, f);
                const p = vdot(sci.planeNormal, relativeVelocity);
                vsubIn(relativeVelocity, vscale(sci.planeNormal, p));
            }
        }
        vcopy(velocityOut, relativeVelocity);
        vaddIn(velocityOut, groundVelocity);
    }

    private _solveTest1d(sci: SurfaceConstraint, velocityIn: Vec3): boolean {
        const relativeVelocity = vsub(velocityIn, sci.velocity);
        return vdot(relativeVelocity, sci.planeNormal) < -1e-3;
    }

    private _solve2d(info: SolverInfo, maxSurfaceVelocity: Vec3, sci0: SurfaceConstraint, sci1: SurfaceConstraint, velocityIn: Vec3, velocityOut: Vec3): void {
        const eps = 1e-5;
        const axis = vcross(sci0.planeNormal, sci1.planeNormal);
        const axisLen2 = vlenSq(axis);
        let solveSequentially = false;
        let axisVel = v();

        while (true) {
            if (axisLen2 <= eps || solveSequentially) {
                this._getOutput(info, sci0).status = InteractionStatus.FAILURE_2D;
                this._getOutput(info, sci1).status = InteractionStatus.FAILURE_2D;
                if (sci0.priority > sci1.priority) {
                    this._solve1d(sci1, velocityIn, velocityOut);
                    this._solve1d(sci0, velocityIn, velocityOut);
                } else {
                    this._solve1d(sci0, velocityIn, velocityOut);
                    this._solve1d(sci1, velocityIn, velocityOut);
                }
                return;
            }
            const invAxisLen = 1 / Math.sqrt(axisLen2);
            vscaleIn(axis, invAxisLen);
            const r0 = vcross(sci0.planeNormal, sci1.planeNormal);
            const r1 = vcross(sci1.planeNormal, axis);
            const r2 = vcross(axis, sci0.planeNormal);
            const sVel = vadd(sci0.velocity, sci1.velocity);
            const t = v(0.5 * vdot(axis, sVel), vdot(sci0.planeNormal, sci0.velocity), vdot(sci1.planeNormal, sci1.velocity));
            axisVel = v(vdot(t, r0), vdot(t, r1), vdot(t, r2));
            vscaleIn(axisVel, invAxisLen);
            if (Math.abs(axisVel.x) > maxSurfaceVelocity.x || Math.abs(axisVel.y) > maxSurfaceVelocity.y || Math.abs(axisVel.z) > maxSurfaceVelocity.z) {
                solveSequentially = true;
            } else {
                break;
            }
        }
        const groundVelocity = axisVel;
        const relativeVelocity = vsub(velocityIn, groundVelocity);
        const vel2 = vlenSq(relativeVelocity);
        const axisVert = vdot(this.up, axis);
        let axisProjVelocity = vdot(relativeVelocity, axis);
        let staticFriction = sci0.staticFriction + sci1.staticFriction;
        if (axisVert * axisProjVelocity > 0) {
            staticFriction += (sci0.extraUpStaticFriction + sci1.extraUpStaticFriction) * axisVert;
        } else {
            staticFriction += (sci0.extraDownStaticFriction + sci1.extraDownStaticFriction) * axisVert;
        }
        staticFriction *= 0.5;
        const dynamicFriction = (sci0.dynamicFriction + sci1.dynamicFriction) * 0.5;
        const f2 = staticFriction * staticFriction;
        const av2 = axisProjVelocity * axisProjVelocity;
        if ((vel2 - av2) * f2 >= av2) {
            vcopy(velocityOut, groundVelocity);
            return;
        }
        if (dynamicFriction < 1 && axisProjVelocity * axisProjVelocity > 1e-4 * vel2) {
            const f = Math.abs(1 / axisProjVelocity) * Math.sqrt(vel2) * (1 - dynamicFriction) + dynamicFriction;
            axisProjVelocity *= f;
        }
        vcopy(velocityOut, groundVelocity);
        vaddIn(velocityOut, vscale(axis, axisProjVelocity));
    }

    private _solve3d(
        info: SolverInfo,
        maxSurfaceVelocity: Vec3,
        sci0: SurfaceConstraint,
        sci1: SurfaceConstraint,
        sci2: SurfaceConstraint,
        allowResort: boolean,
        velocityIn: Vec3,
        velocityOut: Vec3
    ): void {
        const eps = 1e-5;
        let pointVel = v();
        let r0 = vcross(sci1.planeNormal, sci2.planeNormal);
        let r1 = vcross(sci2.planeNormal, sci0.planeNormal);
        let r2 = vcross(sci0.planeNormal, sci1.planeNormal);
        let det = vdot(r0, sci0.planeNormal);
        let solveSequentially = false;

        while (true) {
            if (Math.abs(det) < eps || solveSequentially) {
                if (allowResort) {
                    this._sortInfo(info);
                    sci0 = info.supportPlanes[0]!.constraint;
                    sci1 = info.supportPlanes[1]!.constraint;
                    sci2 = info.supportPlanes[2]!.constraint;
                }
                this._getOutput(info, sci0).status = InteractionStatus.FAILURE_3D;
                this._getOutput(info, sci1).status = InteractionStatus.FAILURE_3D;
                this._getOutput(info, sci2).status = InteractionStatus.FAILURE_3D;
                const oldNum = info.numSupportPlanes;
                this._solve2d(info, maxSurfaceVelocity, sci0, sci1, velocityIn, velocityOut);
                if (oldNum === info.numSupportPlanes) {
                    this._solve2d(info, maxSurfaceVelocity, sci0, sci2, velocityIn, velocityOut);
                }
                if (oldNum === info.numSupportPlanes) {
                    this._solve2d(info, maxSurfaceVelocity, sci1, sci2, velocityIn, velocityOut);
                }
                return;
            }
            const t = v(vdot(sci0.planeNormal, sci0.velocity), vdot(sci1.planeNormal, sci1.velocity), vdot(sci2.planeNormal, sci2.velocity));
            pointVel = {
                x: t.x * r0.x + t.y * r1.x + t.z * r2.x,
                y: t.x * r0.y + t.y * r1.y + t.z * r2.y,
                z: t.x * r0.z + t.y * r1.z + t.z * r2.z,
            };
            vscaleIn(pointVel, 1 / det);
            if (Math.abs(pointVel.x) > maxSurfaceVelocity.x || Math.abs(pointVel.y) > maxSurfaceVelocity.y || Math.abs(pointVel.z) > maxSurfaceVelocity.z) {
                solveSequentially = true;
            } else {
                break;
            }
            // Recompute basis after a resort if it happens on a later pass.
            r0 = vcross(sci1.planeNormal, sci2.planeNormal);
            r1 = vcross(sci2.planeNormal, sci0.planeNormal);
            r2 = vcross(sci0.planeNormal, sci1.planeNormal);
            det = vdot(r0, sci0.planeNormal);
        }
        vcopy(velocityOut, pointVel);
    }

    private _examineActivePlanes(info: SolverInfo, maxSurfaceVelocity: Vec3, velocityIn: Vec3, velocityOut: Vec3): void {
        while (true) {
            switch (info.numSupportPlanes) {
                case 1: {
                    this._solve1d(info.supportPlanes[0]!.constraint, velocityIn, velocityOut);
                    return;
                }
                case 2: {
                    const velocity = v();
                    this._solve1d(info.supportPlanes[1]!.constraint, velocityIn, velocity);
                    if (!this._solveTest1d(info.supportPlanes[0]!.constraint, velocity)) {
                        this._copyPlane(info.supportPlanes[0]!, info.supportPlanes[1]!);
                        info.numSupportPlanes = 1;
                        vcopy(velocityOut, velocity);
                    } else {
                        this._solve2d(info, maxSurfaceVelocity, info.supportPlanes[0]!.constraint, info.supportPlanes[1]!.constraint, velocityIn, velocityOut);
                    }
                    return;
                }
                case 3: {
                    {
                        const velocity = v();
                        this._solve1d(info.supportPlanes[2]!.constraint, velocityIn, velocityOut);
                        if (!this._solveTest1d(info.supportPlanes[0]!.constraint, velocity) && !this._solveTest1d(info.supportPlanes[1]!.constraint, velocity)) {
                            vcopy(velocityOut, velocity);
                            this._copyPlane(info.supportPlanes[0]!, info.supportPlanes[2]!);
                            info.numSupportPlanes = 1;
                            continue;
                        }
                    }
                    {
                        let droppedAPlane = false;
                        for (let testPlane = 0; testPlane < 2; testPlane++) {
                            this._solve2d(info, maxSurfaceVelocity, info.supportPlanes[testPlane]!.constraint, info.supportPlanes[2]!.constraint, velocityIn, velocityOut);
                            if (!this._solveTest1d(info.supportPlanes[1 - testPlane]!.constraint, velocityOut)) {
                                this._copyPlane(info.supportPlanes[0]!, info.supportPlanes[testPlane]!);
                                this._copyPlane(info.supportPlanes[1]!, info.supportPlanes[2]!);
                                info.numSupportPlanes--;
                                droppedAPlane = true;
                                break;
                            }
                        }
                        if (droppedAPlane) {
                            continue;
                        }
                    }
                    this._solve3d(
                        info,
                        maxSurfaceVelocity,
                        info.supportPlanes[0]!.constraint,
                        info.supportPlanes[1]!.constraint,
                        info.supportPlanes[2]!.constraint,
                        true,
                        velocityIn,
                        velocityOut
                    );
                    return;
                }
                case 4: {
                    this._sortInfo(info);
                    let droppedAPlane = false;
                    for (let i = 0; i < 3; i++) {
                        const velocity = v();
                        this._solve3d(
                            info,
                            maxSurfaceVelocity,
                            info.supportPlanes[(i + 1) % 3]!.constraint,
                            info.supportPlanes[(i + 2) % 3]!.constraint,
                            info.supportPlanes[3]!.constraint,
                            false,
                            velocityIn,
                            velocity
                        );
                        if (!this._solveTest1d(info.supportPlanes[i]!.constraint, velocity)) {
                            this._copyPlane(info.supportPlanes[i]!, info.supportPlanes[2]!);
                            this._copyPlane(info.supportPlanes[2]!, info.supportPlanes[3]!);
                            info.numSupportPlanes = 3;
                            droppedAPlane = true;
                            break;
                        }
                    }
                    if (droppedAPlane) {
                        continue;
                    }
                    {
                        const velocity = vclone(velocityIn);
                        this._solve3d(
                            info,
                            maxSurfaceVelocity,
                            info.supportPlanes[0]!.constraint,
                            info.supportPlanes[1]!.constraint,
                            info.supportPlanes[2]!.constraint,
                            false,
                            velocity,
                            velocity
                        );
                        vcopy(velocityOut, velocity);
                    }
                    {
                        let maxStatus = InteractionStatus.OK;
                        for (let i = 0; i < 4; i++) {
                            maxStatus = Math.max(maxStatus, info.supportPlanes[i]!.interaction.status);
                        }
                        for (let i = 0; i < 4; i++) {
                            if (maxStatus === info.supportPlanes[i]!.interaction.status) {
                                this._copyPlane(info.supportPlanes[i]!, info.supportPlanes[3]!);
                                break;
                            }
                            info.numSupportPlanes--;
                        }
                    }
                    for (let i = 0; i < 3; i++) {
                        info.supportPlanes[i]!.interaction.status = InteractionStatus.OK;
                    }
                    continue;
                }
                default:
                    return;
            }
        }
    }

    private _copyPlane(dst: ActivePlane, src: ActivePlane): void {
        dst.index = src.index;
        dst.constraint = src.constraint;
        dst.interaction = src.interaction;
    }

    private _simplexSolverSolve(constraints: SurfaceConstraint[], velocity: Vec3, deltaTime: number, minDeltaTime: number, maxSurfaceVelocity: Vec3): SolverOutput {
        const eps = 1e-6;
        const output: SolverOutput = {
            position: v(),
            velocity: vclone(velocity),
            deltaTime,
            planeInteractions: [],
        };
        for (let i = 0; i < constraints.length; i++) {
            output.planeInteractions.push({ touched: false, stopped: false, surfaceTime: 0, penaltyDistance: 0, status: InteractionStatus.OK });
        }
        const info: SolverInfo = {
            supportPlanes: [],
            numSupportPlanes: 0,
            currentTime: 0,
            inputConstraints: constraints,
            outputInteractions: output.planeInteractions,
        };
        const emptyConstraint = (): SurfaceConstraint => ({
            planeNormal: v(),
            planeDistance: 0,
            staticFriction: 0,
            dynamicFriction: 0,
            extraUpStaticFriction: 0,
            extraDownStaticFriction: 0,
            velocity: v(),
            angularVelocity: v(),
            priority: 0,
        });
        const emptyInteraction = (): PlaneInteraction => ({ touched: false, stopped: false, surfaceTime: 0, penaltyDistance: 0, status: InteractionStatus.OK });
        for (let i = 0; i < 4; i++) {
            info.supportPlanes.push({ index: -1, constraint: emptyConstraint(), interaction: emptyInteraction() });
        }
        let remainingTime = deltaTime;
        while (remainingTime > 0) {
            let hitIndex = -1;
            let minCollisionTime = remainingTime;
            for (let i = 0; i < constraints.length; i++) {
                if (info.numSupportPlanes >= 1 && info.supportPlanes[0]!.index === i) {
                    continue;
                }
                if (info.numSupportPlanes >= 2 && info.supportPlanes[1]!.index === i) {
                    continue;
                }
                if (info.numSupportPlanes >= 3 && info.supportPlanes[2]!.index === i) {
                    continue;
                }
                if (output.planeInteractions[i]!.status !== InteractionStatus.OK) {
                    continue;
                }
                const sci = constraints[i]!;
                const relativeVel = vsub(output.velocity, sci.velocity);
                const relativeProjectedVel = -vdot(relativeVel, sci.planeNormal);
                if (relativeProjectedVel <= 0) {
                    continue;
                }
                const relativePos = vsub(output.position, vscale(sci.velocity, info.currentTime));
                let projectedPos = vdot(sci.planeNormal, relativePos);
                const penaltyDist = output.planeInteractions[i]!.penaltyDistance;
                if (penaltyDist < eps) {
                    projectedPos = 0;
                }
                projectedPos += penaltyDist;
                if (projectedPos < minCollisionTime * relativeProjectedVel) {
                    minCollisionTime = projectedPos / relativeProjectedVel;
                    hitIndex = i;
                }
            }
            if (minCollisionTime > 1e-4) {
                info.currentTime += minCollisionTime;
                remainingTime -= minCollisionTime;
                vaddIn(output.position, vscale(output.velocity, minCollisionTime));
                for (let i = 0; i < info.numSupportPlanes; i++) {
                    info.supportPlanes[i]!.interaction.surfaceTime += minCollisionTime;
                    info.supportPlanes[i]!.interaction.touched = true;
                }
                output.deltaTime = info.currentTime;
                if (info.currentTime > minDeltaTime) {
                    return output;
                }
            }
            if (hitIndex < 0) {
                output.deltaTime = deltaTime;
                break;
            }
            const supportPlane = info.supportPlanes[info.numSupportPlanes++]!;
            supportPlane.constraint = constraints[hitIndex]!;
            supportPlane.interaction = output.planeInteractions[hitIndex]!;
            supportPlane.interaction.penaltyDistance = (supportPlane.interaction.penaltyDistance + eps) * 2;
            supportPlane.index = hitIndex;
            this._examineActivePlanes(info, maxSurfaceVelocity, velocity, output.velocity);
        }
        return output;
    }
}

const ZERO: Vec3 = { x: 0, y: 0, z: 0 };

function matToArray(m: Mat4): number[] {
    const out: number[] = new Array(16);
    for (let i = 0; i < 16; i++) {
        out[i] = m[i]!;
    }
    return out;
}

/**
 * Create a Havok physics character controller.
 *
 * The controller adds a kinematic capsule body to `world` and resolves collisions by sweeping
 * that capsule each step. Drive it from a per-physics-step callback (e.g. `onPhysicsAfterStep`)
 * by calling {@link PhysicsCharacterController.moveWithCollisions} with the desired displacement,
 * then read {@link PhysicsCharacterController.getPosition} to update your display mesh.
 * @param world - The physics world to add the character to.
 * @param position - Initial world-space position of the character.
 * @param options - Capsule dimensions.
 * @returns The character controller instance.
 */
export function createPhysicsCharacterController(world: PhysicsWorld, position: Vec3, options: PhysicsCharacterControllerOptions): PhysicsCharacterController {
    return new PhysicsCharacterController(world, position, options);
}
