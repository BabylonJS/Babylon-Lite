/**
 * Havok Physics V2 integration for Babylon Lite.
 *
 * Standalone-function API consistent with Lite conventions:
 * ```ts
 *   const world = await createHavokWorld(scene);
 *   setPhysicsGravity(world, { x: 0, y: -9.81, z: 0 });
 *   const agg = createPhysicsAggregate(world, sphere, PhysicsShapeType.SPHERE, { mass: 1 });
 * ```
 *
 * The WASM binary is loaded lazily on first call and cached for subsequent worlds.
 */

import type { Mat4, Vec3, Quat } from "../math/types.js";
import type { SceneNode } from "../scene/scene-node.js";
import type { SceneContext } from "../scene/scene-core.js";
import type { Mesh } from "../mesh/mesh.js";
import type { HavokFloatingOriginContext, WorldRegion } from "./havok-floating-origin.js";
import { onBeforeRender } from "../scene/scene-core.js";
import { mat4Invert } from "../math/mat4-invert.js";
import { mat4Multiply } from "../math/mat4-multiply.js";
import { mat4Scale } from "../math/mat4-scale.js";

// ─── Enums ───────────────────────────────────────────────────────────

/** Geometry type of a physics collision shape. */
export const enum PhysicsShapeType {
    SPHERE = 0,
    CAPSULE = 1,
    CYLINDER = 2,
    BOX = 3,
    CONVEX_HULL = 4,
    CONTAINER = 5,
    MESH = 6,
    HEIGHTFIELD = 7,
}

/** How a body moves: `STATIC` (immovable), `ANIMATED` (driven by the node transform), or `DYNAMIC` (simulated). */
export const enum PhysicsMotionType {
    STATIC = 0,
    ANIMATED = 1,
    DYNAMIC = 2,
}

/**
 * How a moved transform node is propagated to its physics body before each step.
 * `DISABLED` skips the sync, `TELEPORT` snaps the body to the node (`HP_Body_SetQTransform`),
 * and `ACTION` sets the body's velocity so it reaches the node (`HP_Body_SetTargetQTransform`,
 * dragging resting bodies via friction). Values match Babylon.js `PhysicsPrestepType`.
 */
export const enum PhysicsPrestepType {
    DISABLED = 0,
    TELEPORT = 1,
    ACTION = 2,
}

/** Type of Havok Physics V2 constraint. */
export const enum PhysicsConstraintType {
    BALL_AND_SOCKET = 1,
    DISTANCE = 2,
    HINGE = 3,
    SLIDER = 4,
    LOCK = 5,
    PRISMATIC = 6,
    SIX_DOF = 7,
}

/** Axis addressed by a Physics V2 constraint limit. */
export const enum PhysicsConstraintAxis {
    LINEAR_X = 0,
    LINEAR_Y = 1,
    LINEAR_Z = 2,
    ANGULAR_X = 3,
    ANGULAR_Y = 4,
    ANGULAR_Z = 5,
    LINEAR_DISTANCE = 6,
}

// ─── Option interfaces ───────────────────────────────────────────────

/** Geometry parameters describing a collision shape; which fields apply depends on the shape type. */
export interface PhysicsShapeParameters {
    center?: Vec3;
    radius?: number;
    pointA?: Vec3;
    pointB?: Vec3;
    rotation?: Quat;
    extents?: Vec3;
}

/** Options for `createPhysicsShape`: the shape type plus its geometry parameters. */
export interface PhysicsShapeOptions {
    type: PhysicsShapeType;
    parameters?: PhysicsShapeParameters;
    /** Mesh or transform hierarchy used when `type` is `MESH` or `CONVEX_HULL`. */
    mesh?: SceneNode;
    /** When true, mesh and convex-hull shapes accumulate descendant meshes under `mesh`. */
    includeChildMeshes?: boolean;
}

/** Options for `createPhysicsAggregate`: mass, material (friction/restitution), and optional shape geometry overrides. */
export interface PhysicsAggregateOptions {
    mass: number;
    friction?: number;
    restitution?: number;
    radius?: number;
    pointA?: Vec3;
    pointB?: Vec3;
    extents?: Vec3;
    rotation?: Quat;
    center?: Vec3;
    startAsleep?: boolean;
    isTriggerShape?: boolean;
    /**
     * Optional pre-built shape. When provided, it is used directly and the
     * primitive-shape build path is skipped. This lets callers supply
     * mesh/convex-hull shapes (built via `createPhysicsShape`) without pulling
     * the mesh-shape code into `createPhysicsAggregate` itself.
     */
    shape?: PhysicsShape;
}

/** Mass properties applied to a physics body. Omitted fields keep Havok's shape-derived values. */
export interface PhysicsMassProperties {
    centerOfMass?: Vec3;
    mass?: number;
    inertia?: Vec3;
    inertiaOrientation?: Quat;
}

/** Pivot/axis options used to create a physics constraint. */
export interface PhysicsConstraintOptions {
    pivotA?: Vec3;
    pivotB?: Vec3;
    axisA?: Vec3;
    axisB?: Vec3;
    perpAxisA?: Vec3;
    perpAxisB?: Vec3;
    maxDistance?: number;
    collision?: boolean;
}

/** Limit options used by 6DoF constraints. */
export interface PhysicsConstraintLimit {
    axis: PhysicsConstraintAxis;
    minLimit?: number;
    maxLimit?: number;
    stiffness?: number;
    damping?: number;
}

// ─── Opaque handles (pure state — no methods) ────────────────────────

/** Opaque handle to a Havok rigid body, bound to a scene node and a motion type. */
export interface PhysicsBody {
    /** @internal */ readonly _hkBody: any;
    /** @internal */ readonly _world: PhysicsWorld;
    /** @internal */ _shape?: PhysicsShape | null;
    /** @internal */ _preStep: boolean;
    /** @internal How a moved node is propagated to the body pre-step (TELEPORT by default). */
    _prestepType: PhysicsPrestepType;
    readonly node: SceneNode;
    readonly motionType: PhysicsMotionType;
    /** @internal The floating-origin region this body lives in; set only under floating origin. */
    _region?: WorldRegion;
}

/** Opaque handle to a Havok collision shape. */
export interface PhysicsShape {
    /** @internal */ readonly _hkShape: any;
    /** @internal */ readonly _type: PhysicsShapeType;
}

/** A body and its shape wired together, as produced by `createPhysicsAggregate`. */
export interface PhysicsAggregate {
    readonly body: PhysicsBody;
    readonly shape: PhysicsShape;
}

/** Opaque handle to a Havok constraint between two bodies. */
export interface PhysicsConstraint {
    /** @internal */ readonly _hkConstraint: any;
    readonly bodyA: PhysicsBody;
    readonly bodyB: PhysicsBody;
    readonly type: PhysicsConstraintType;
    readonly options: PhysicsConstraintOptions;
    readonly limits?: readonly PhysicsConstraintLimit[];
}

// ─── PhysicsWorld — pure-state handle ────────────────────────────────

/** Pure-state handle to a Havok physics world: the WASM module, the native world, its bodies, and the timestep. */
export interface PhysicsWorld {
    /** @internal */ readonly _hknp: any;
    /** @internal */ readonly _hkWorld: any;
    /** @internal */ readonly _bodies: PhysicsBody[];
    /** @internal */ _timestep: number;
    /** @internal World-wide gravity `[x, y, z]` set at creation; used to seed floating-origin regions. */
    _gravity: number[];
    /** @internal Floating-origin runtime; present only after `enableHavokFloatingOrigin` is called. */
    _fo?: HavokFloatingOriginContext;
    /** @internal Callbacks run after each physics step (post body→node sync, pre-render). */
    _afterStep?: ((timestep: number) => void)[];
    /** @internal Lazily-created Havok query collector, cached by the standalone `physics/havok-queries.ts` module. */
    _queryCollector?: any;
}

// ─── Factory ─────────────────────────────────────────────────────────

/**
 * Create a Havok physics world and register per-frame stepping on the scene.
 *
 * The caller is responsible for loading the WASM binary externally:
 * ```ts
 *   import HavokPhysics from "@babylonjs/havok";
 *   const hknp = await HavokPhysics({ locateFile: () => "/HavokPhysics.wasm" });
 *   const world = createHavokWorld(scene, hknp);
 * ```
 *
 * For Large World Rendering, call {@link enableHavokFloatingOrigin} on the returned world (before
 * creating any bodies) to opt into multi-region floating-origin simulation.
 */
export function createHavokWorld(scene: SceneContext, hknp: any, gravity?: Vec3): PhysicsWorld {
    const hkWorld = hknp.HP_World_Create()[1];

    const g = gravity ?? { x: 0, y: -9.81, z: 0 };
    hknp.HP_World_SetGravity(hkWorld, [g.x, g.y, g.z]);

    const world: PhysicsWorld = {
        _hknp: hknp,
        _hkWorld: hkWorld,
        _bodies: [],
        _timestep: 1 / 60,
        _gravity: [g.x, g.y, g.z],
    };

    // Register per-frame physics step
    onBeforeRender(scene, (deltaMs: number) => {
        _stepWorld(world, deltaMs);
    });

    return world;
}

/**
 * Opt a Havok world into multi-region floating-origin simulation (Large World Rendering).
 *
 * Loads the floating-origin runtime on demand (`physics/havok-floating-origin.ts`) so worlds that
 * never call this — i.e. ordinary near-origin physics scenes — never pull that code into their
 * bundle. Once enabled, bodies far apart in world space are simulated in separate regions (each
 * within `floatingOriginWorldRadius` of its origin) so the float32 Havok solver keeps full
 * precision. Node transforms remain true world coordinates; eye-relative rendering is handled
 * independently by the floating-origin render path.
 *
 * Must be called **before** creating any bodies in the world. Pair it with an engine created with
 * `useFloatingOrigin: true` so rendering and physics share the same far-from-origin handling.
 * @param world - The physics world to enable floating origin on.
 * @param floatingOriginWorldRadius - Region capture radius in metres (default 100000, matching Babylon.js).
 */
export async function enableHavokFloatingOrigin(world: PhysicsWorld, floatingOriginWorldRadius = 100000): Promise<void> {
    const fo = await import("./havok-floating-origin.js");
    world._fo = fo.createHavokFloatingOriginContext(world._hkWorld, world._gravity, floatingOriginWorldRadius);
}

// ─── Per-frame stepping ──────────────────────────────────────────────

function _stepWorld(world: PhysicsWorld, deltaMs: number): void {
    const { _hknp: hknp, _hkWorld: hkWorld, _bodies: bodies } = world;
    const dt = Math.min(deltaMs / 1000, 0.1);
    if (dt <= 0) {
        return;
    }

    // Floating-origin worlds run a multi-region step (loaded on demand).
    if (world._fo) {
        world._fo.step(world);
        return;
    }

    // Pre-step: sync moved nodes into Havok. A body syncs only when its prestep type is not
    // DISABLED and it is either ANIMATED (kinematic) or explicitly pre-stepped. TELEPORT snaps the
    // body to the node; ACTION sets a velocity toward it (so resting bodies are dragged via friction).
    for (let i = 0; i < bodies.length; i++) {
        const b = bodies[i]!;
        if (b._prestepType !== PhysicsPrestepType.DISABLED && (b.motionType === (PhysicsMotionType.ANIMATED as number) || b._preStep)) {
            if (b._prestepType === PhysicsPrestepType.ACTION) {
                _syncNodeToBodyTarget(hknp, b);
            } else {
                _syncNodeToBody(hknp, b);
            }
        }
    }

    hknp.HP_World_Step(hkWorld, world._timestep);

    // Post-step: sync DYNAMIC bodies from Havok → node
    for (let i = 0; i < bodies.length; i++) {
        const b = bodies[i]!;
        if (b.motionType === (PhysicsMotionType.DYNAMIC as number)) {
            _syncBodyToNode(hknp, b);
        }
    }

    // After-step hooks run once body→node sync is complete, before rendering. This mirrors
    // Babylon.js, where physics is advanced inside `scene.animate()` (before render) and
    // post-step scene logic runs in `onAfterRenderObservable`.
    if (world._afterStep) {
        const cbs = world._afterStep;
        for (let i = 0; i < cbs.length; i++) {
            cbs[i]!(world._timestep);
        }
    }
}

/**
 * Registers a callback to run after each physics step, once dynamic body transforms have been
 * synced back to their nodes and before the frame is rendered. Use this for per-step logic that
 * must observe (or react to) the freshly-integrated state — e.g. tracking a marker to a body's
 * post-step pose, or applying a force whose effect should integrate on the next step.
 * @param world - The physics world to hook.
 * @param cb - Callback invoked with the world timestep (seconds) after each step.
 */
export function onPhysicsAfterStep(world: PhysicsWorld, cb: (timestep: number) => void): void {
    (world._afterStep ??= []).push(cb);
}

function _syncBodyToNode(hknp: any, body: PhysicsBody): void {
    const t = hknp.HP_Body_GetQTransform(body._hkBody)[1];
    const pos = t[0]; // [x, y, z]
    const rot = t[1]; // [x, y, z, w]
    const node = body.node;
    node.position.set(pos[0], pos[1], pos[2]);
    node.rotationQuaternion.set(rot[0], rot[1], rot[2], rot[3]);
}

function _syncNodeToBody(hknp: any, body: PhysicsBody): void {
    const node = body.node;
    const p = node.position;
    const q = node.rotationQuaternion;
    hknp.HP_Body_SetQTransform(body._hkBody, [
        [p.x, p.y, p.z],
        [q.x, q.y, q.z, q.w],
    ]);
}

// ACTION prestep: instead of snapping the body, set its target transform so Havok derives a
// velocity that carries the body to the node over the step. Resting bodies stacked on top are then
// dragged along by friction rather than tunneled through.
function _syncNodeToBodyTarget(hknp: any, body: PhysicsBody): void {
    const node = body.node;
    const p = node.position;
    const q = node.rotationQuaternion;
    hknp.HP_Body_SetTargetQTransform(body._hkBody, [
        [p.x, p.y, p.z],
        [q.x, q.y, q.z, q.w],
    ]);
}

// ─── Gravity ─────────────────────────────────────────────────────────

/**
 * Sets gravity for the world, or for a single region when `worldPosition` is given.
 * Passing a position is useful for planetary scenarios where gravity direction varies by location.
 * @param world - The physics world.
 * @param gravity - Gravity acceleration in m/s².
 * @param worldPosition - Optional world position selecting the region to update; omit to update all regions.
 */
export function setPhysicsGravity(world: PhysicsWorld, gravity: Vec3, worldPosition?: Vec3): void {
    if (world._fo) {
        world._fo.setGravity(world, [gravity.x, gravity.y, gravity.z], worldPosition);
        return;
    }
    world._hknp.HP_World_SetGravity(world._hkWorld, [gravity.x, gravity.y, gravity.z]);
}

/**
 * Returns the world's current gravity vector, or a specific region's when `worldPosition` is given.
 * @param world - The physics world.
 * @param worldPosition - Optional world position selecting the region to read; omit for the world-wide gravity.
 * @returns Gravity acceleration in m/s².
 */
export function getPhysicsGravity(world: PhysicsWorld, worldPosition?: Vec3): Vec3 {
    if (worldPosition && world._fo) {
        const g = world._fo.getRegionGravity(world, worldPosition);
        return { x: g[0]!, y: g[1]!, z: g[2]! };
    }
    const g = world._hknp.HP_World_GetGravity(world._hkWorld)[1];
    return { x: g[0], y: g[1], z: g[2] };
}

// ─── Timestep ────────────────────────────────────────────────────────

/**
 * Sets the fixed simulation timestep used by each world step.
 * @param world - The physics world.
 * @param dt - Timestep in seconds (e.g. `1 / 60`).
 */
export function setPhysicsTimestep(world: PhysicsWorld, dt: number): void {
    world._timestep = dt;
}

/**
 * Returns the world's fixed simulation timestep in seconds.
 * @param world - The physics world.
 * @returns The timestep in seconds.
 */
export function getPhysicsTimestep(world: PhysicsWorld): number {
    return world._timestep;
}

// ─── Velocity limits ─────────────────────────────────────────────────

/**
 * Clamps the maximum linear and angular speeds of bodies in the world.
 * @param world - The physics world.
 * @param maxLinear - Maximum linear speed.
 * @param maxAngular - Maximum angular speed.
 */
export function setPhysicsVelocityLimits(world: PhysicsWorld, maxLinear: number, maxAngular: number): void {
    if (world._fo) {
        world._fo.setVelocityLimits(world, maxLinear, maxAngular);
        return;
    }
    world._hknp.HP_World_SetSpeedLimit(world._hkWorld, maxLinear, maxAngular);
}

/**
 * Returns the world's current maximum linear and angular speed limits.
 * @param world - The physics world.
 * @returns The `maxLinear` and `maxAngular` speed limits.
 */
export function getPhysicsVelocityLimits(world: PhysicsWorld): { maxLinear: number; maxAngular: number } {
    const limits = world._hknp.HP_World_GetSpeedLimit(world._hkWorld);
    return { maxLinear: limits[1], maxAngular: limits[2] };
}

// ─── Body ────────────────────────────────────────────────────────────

/**
 * Creates a rigid body bound to a scene node, adds it to the world, and seeds it with the node's transform.
 * @param world - The physics world.
 * @param node - The scene node the body follows / drives.
 * @param motionType - Whether the body is static, animated (kinematic), or dynamic.
 * @param startsAsleep - When true, the body is added in a sleeping state.
 * @returns The created physics body handle.
 */
export function createPhysicsBody(world: PhysicsWorld, node: SceneNode, motionType: PhysicsMotionType, startsAsleep = false): PhysicsBody {
    const { _hknp: hknp, _hkWorld: hkWorld } = world;

    const hkBody = hknp.HP_Body_Create()[1];

    // Set motion type
    const hkMotion =
        motionType === PhysicsMotionType.STATIC ? hknp.MotionType.STATIC : motionType === PhysicsMotionType.ANIMATED ? hknp.MotionType.KINEMATIC : hknp.MotionType.DYNAMIC;
    hknp.HP_Body_SetMotionType(hkBody, hkMotion);

    const body: PhysicsBody = {
        _hkBody: hkBody,
        _shape: null,
        _preStep: false,
        _prestepType: PhysicsPrestepType.TELEPORT,
        _world: world,
        node,
        motionType,
    };

    if (world._fo) {
        // Floating origin: place the body in its region, storing it in region-local coordinates.
        world._fo.placeBody(world, body, startsAsleep);
    } else {
        // Add to world first, then set transform (Havok resets transform on add)
        hknp.HP_World_AddBody(hkWorld, hkBody, startsAsleep);

        const p = node.position;
        const q = node.rotationQuaternion;
        hknp.HP_Body_SetQTransform(hkBody, [
            [p.x, p.y, p.z],
            [q.x, q.y, q.z, q.w],
        ]);
    }

    world._bodies.push(body);
    return body;
}

/**
 * Enable or disable pre-step synchronization from a node transform to its Havok body.
 * @param body - The physics body to update.
 * @param enabled - When true, the node transform is written to Havok before each physics step.
 */
export function setPhysicsBodyPreStep(body: PhysicsBody, enabled: boolean): void {
    body._preStep = enabled;
}

/**
 * Sets how a moved transform node is propagated to its physics body before each step.
 * `TELEPORT` snaps the body to the node, `ACTION` sets a velocity toward it (so resting bodies are
 * dragged along by friction), and `DISABLED` skips the pre-step sync entirely. Setting any type
 * other than `DISABLED` automatically enables prestep syncing for the body (equivalent to
 * {@link setPhysicsBodyPreStep}), so STATIC/DYNAMIC bodies are synced without an extra call.
 * @param body - The physics body to update.
 * @param type - The prestep behaviour to apply.
 */
export function setPhysicsBodyPrestepType(body: PhysicsBody, type: PhysicsPrestepType): void {
    body._prestepType = type;
    if (type !== PhysicsPrestepType.DISABLED) {
        body._preStep = true;
    }
}

/**
 * Applies a world-space impulse to a physics body.
 * @param body - The physics body to update.
 * @param impulse - Impulse vector.
 * @param location - World-space application point.
 */
export function applyPhysicsBodyImpulse(body: PhysicsBody, impulse: Vec3, location: Vec3): void {
    const hknp = body._world._hknp;
    hknp.HP_Body_ApplyImpulse(body._hkBody, [location.x, location.y, location.z], [impulse.x, impulse.y, impulse.z]);
}

/**
 * Applies a force for one fixed physics timestep, matching Babylon.js PhysicsBody.applyForce.
 * @param world - The physics world.
 * @param body - The physics body to update.
 * @param force - Force vector.
 * @param location - World-space application point.
 */
export function applyPhysicsBodyForce(world: PhysicsWorld, body: PhysicsBody, force: Vec3, location: Vec3): void {
    applyPhysicsBodyImpulse(body, { x: force.x * world._timestep, y: force.y * world._timestep, z: force.z * world._timestep }, location);
}

/**
 * Creates and enables a Havok constraint between two physics bodies.
 * @param world - The physics world.
 * @param bodyA - Parent body.
 * @param bodyB - Child body.
 * @param type - Constraint type.
 * @param options - Pivot and axis options.
 * @param limits - Optional 6DoF limits.
 */
export function createPhysicsConstraint(
    world: PhysicsWorld,
    bodyA: PhysicsBody,
    bodyB: PhysicsBody,
    type: PhysicsConstraintType,
    options: PhysicsConstraintOptions = {},
    limits: readonly PhysicsConstraintLimit[] = []
): PhysicsConstraint {
    const hknp = world._hknp;
    const joint = hknp.HP_Constraint_Create()[1];
    hknp.HP_Constraint_SetParentBody(joint, bodyA._hkBody);
    hknp.HP_Constraint_SetChildBody(joint, bodyB._hkBody);

    const pivotA = options.pivotA ?? ZERO_VEC3;
    const pivotB = options.pivotB ?? ZERO_VEC3;
    const axisA = options.axisA ?? X_AXIS;
    const axisB = options.axisB ?? X_AXIS;
    const perpAxisA = options.perpAxisA ?? normalTo(axisA);
    const perpAxisB = options.perpAxisB ?? normalTo(axisB);
    hknp.HP_Constraint_SetAnchorInParent(joint, vec3Array(pivotA), vec3Array(axisA), vec3Array(perpAxisA));
    hknp.HP_Constraint_SetAnchorInChild(joint, vec3Array(pivotB), vec3Array(axisB), vec3Array(perpAxisB));

    configureConstraintAxes(hknp, joint, type, options, limits);
    hknp.HP_Constraint_SetCollisionsEnabled(joint, !!options.collision);
    hknp.HP_Constraint_SetEnabled(joint, true);

    return { _hkConstraint: joint, bodyA, bodyB, type, options: { ...options, axisA, axisB, perpAxisA, perpAxisB }, limits };
}

/**
 * Sets the Havok filter membership mask for a collision shape.
 * @param world - The physics world.
 * @param shape - The shape to update.
 * @param membershipMask - Bitmask describing which collision group this shape belongs to.
 */
export function setPhysicsShapeFilterMembershipMask(world: PhysicsWorld, shape: PhysicsShape, membershipMask: number): void {
    const info = world._hknp.HP_Shape_GetFilterInfo(shape._hkShape)[1];
    world._hknp.HP_Shape_SetFilterInfo(shape._hkShape, [membershipMask, info[1]]);
}

/**
 * Sets the Havok filter collide mask for a collision shape.
 * @param world - The physics world.
 * @param shape - The shape to update.
 * @param collideMask - Bitmask describing which collision groups this shape collides with.
 */
export function setPhysicsShapeFilterCollideMask(world: PhysicsWorld, shape: PhysicsShape, collideMask: number): void {
    const info = world._hknp.HP_Shape_GetFilterInfo(shape._hkShape)[1];
    world._hknp.HP_Shape_SetFilterInfo(shape._hkShape, [info[0], collideMask]);
}

const ZERO_VEC3: Vec3 = { x: 0, y: 0, z: 0 };
const X_AXIS: Vec3 = { x: 1, y: 0, z: 0 };

function vec3Array(v: Vec3): [number, number, number] {
    return [v.x, v.y, v.z];
}

function normalTo(axis: Vec3): Vec3 {
    const ax = Math.abs(axis.x);
    const ay = Math.abs(axis.y);
    const az = Math.abs(axis.z);
    if (ax <= ay && ax <= az) {
        return normalizeVec3({ x: 0, y: -axis.z, z: axis.y });
    }
    if (ay <= ax && ay <= az) {
        return normalizeVec3({ x: -axis.z, y: 0, z: axis.x });
    }
    return normalizeVec3({ x: -axis.y, y: axis.x, z: 0 });
}

function normalizeVec3(v: Vec3): Vec3 {
    const inv = 1 / Math.max(1e-8, Math.hypot(v.x, v.y, v.z));
    return { x: v.x * inv, y: v.y * inv, z: v.z * inv };
}

function configureConstraintAxes(hknp: any, joint: any, type: PhysicsConstraintType, options: PhysicsConstraintOptions, limits: readonly PhysicsConstraintLimit[]): void {
    const axis = hknp.ConstraintAxis;
    const mode = hknp.ConstraintAxisLimitMode;
    const lock = (a: any): void => hknp.HP_Constraint_SetAxisMode(joint, a, mode.LOCKED);
    const limit = (a: any, min: number, max: number): void => {
        hknp.HP_Constraint_SetAxisMode(joint, a, mode.LIMITED);
        hknp.HP_Constraint_SetAxisMinLimit(joint, a, min);
        hknp.HP_Constraint_SetAxisMaxLimit(joint, a, max);
    };

    switch (type) {
        case PhysicsConstraintType.LOCK:
            lock(axis.LINEAR_X);
            lock(axis.LINEAR_Y);
            lock(axis.LINEAR_Z);
            lock(axis.ANGULAR_X);
            lock(axis.ANGULAR_Y);
            lock(axis.ANGULAR_Z);
            break;
        case PhysicsConstraintType.DISTANCE: {
            const d = options.maxDistance ?? 0;
            limit(axis.LINEAR_DISTANCE, d, d);
            break;
        }
        case PhysicsConstraintType.HINGE:
            lock(axis.LINEAR_X);
            lock(axis.LINEAR_Y);
            lock(axis.LINEAR_Z);
            lock(axis.ANGULAR_Y);
            lock(axis.ANGULAR_Z);
            break;
        case PhysicsConstraintType.PRISMATIC:
            lock(axis.LINEAR_Y);
            lock(axis.LINEAR_Z);
            lock(axis.ANGULAR_X);
            lock(axis.ANGULAR_Y);
            lock(axis.ANGULAR_Z);
            break;
        case PhysicsConstraintType.SLIDER:
            lock(axis.LINEAR_Y);
            lock(axis.LINEAR_Z);
            lock(axis.ANGULAR_Y);
            lock(axis.ANGULAR_Z);
            break;
        case PhysicsConstraintType.BALL_AND_SOCKET:
            lock(axis.LINEAR_X);
            lock(axis.LINEAR_Y);
            lock(axis.LINEAR_Z);
            break;
        case PhysicsConstraintType.SIX_DOF:
            for (const l of limits) {
                const nativeAxis = constraintAxisToNative(axis, l.axis);
                if ((l.minLimit ?? -1) === 0 && (l.maxLimit ?? -1) === 0) {
                    lock(nativeAxis);
                } else {
                    if (l.minLimit !== undefined || l.maxLimit !== undefined) {
                        hknp.HP_Constraint_SetAxisMode(joint, nativeAxis, mode.LIMITED);
                    }
                    if (l.minLimit !== undefined) {
                        hknp.HP_Constraint_SetAxisMinLimit(joint, nativeAxis, l.minLimit);
                    }
                    if (l.maxLimit !== undefined) {
                        hknp.HP_Constraint_SetAxisMaxLimit(joint, nativeAxis, l.maxLimit);
                    }
                }
                if (l.stiffness !== undefined) {
                    hknp.HP_Constraint_SetAxisStiffness(joint, nativeAxis, l.stiffness);
                }
                if (l.damping !== undefined) {
                    hknp.HP_Constraint_SetAxisDamping(joint, nativeAxis, l.damping);
                }
            }
            break;
    }
}

function constraintAxisToNative(axis: any, value: PhysicsConstraintAxis): any {
    switch (value) {
        case PhysicsConstraintAxis.LINEAR_X:
            return axis.LINEAR_X;
        case PhysicsConstraintAxis.LINEAR_Y:
            return axis.LINEAR_Y;
        case PhysicsConstraintAxis.LINEAR_Z:
            return axis.LINEAR_Z;
        case PhysicsConstraintAxis.ANGULAR_X:
            return axis.ANGULAR_X;
        case PhysicsConstraintAxis.ANGULAR_Y:
            return axis.ANGULAR_Y;
        case PhysicsConstraintAxis.ANGULAR_Z:
            return axis.ANGULAR_Z;
        case PhysicsConstraintAxis.LINEAR_DISTANCE:
            return axis.LINEAR_DISTANCE;
    }
}

// ─── Shape ───────────────────────────────────────────────────────────

interface HavokBuffer {
    offset: number;
    numObjects: number;
}

class MeshAccumulator {
    private readonly _vertices: number[] = [];
    private readonly _indices: number[] = [];
    private readonly _collectIndices: boolean;

    public constructor(collectIndices: boolean) {
        this._collectIndices = collectIndices;
    }

    public addNodeMeshes(root: SceneNode, includeChildren: boolean): void {
        const invRoot = mat4Invert(root.worldMatrix as Mat4);
        if (!invRoot) {
            throw new Error("Cannot create physics mesh shape from a singular root transform.");
        }

        const rootScale = mat4Scale(root.scaling.x, root.scaling.y, root.scaling.z);
        const rootToBody = mat4Multiply(rootScale, invRoot);
        this._addNodeMesh(root, rootToBody);

        if (includeChildren) {
            for (const child of root.children) {
                this._addDescendantMeshes(child, rootToBody);
            }
        }

        if (this._vertices.length === 0) {
            throw new Error("Cannot create physics mesh shape without vertex positions.");
        }
        if (this._collectIndices && this._indices.length === 0) {
            throw new Error("Cannot create physics mesh shape without triangle indices.");
        }
    }

    public getVertices(hknp: any): HavokBuffer {
        const numObjects = this._vertices.length;
        const offset = hknp._malloc(numObjects * 4);
        new Float32Array(hknp.HEAPU8.buffer, offset, numObjects).set(this._vertices);
        return { offset, numObjects };
    }

    public getTriangles(hknp: any): HavokBuffer {
        const numObjects = this._indices.length;
        const offset = hknp._malloc(numObjects * 4);
        new Int32Array(hknp.HEAPU8.buffer, offset, numObjects).set(this._indices);
        return { offset, numObjects };
    }

    public freeBuffer(hknp: any, buffer: HavokBuffer): void {
        hknp._free(buffer.offset);
    }

    private _addDescendantMeshes(node: SceneNode, rootToBody: Mat4): void {
        this._addNodeMesh(node, rootToBody);
        for (const child of node.children) {
            this._addDescendantMeshes(child, rootToBody);
        }
    }

    private _addNodeMesh(node: SceneNode, rootToBody: Mat4): void {
        if (!isMesh(node)) {
            return;
        }
        const positions = node._cpuPositions;
        if (!positions || positions.length === 0) {
            return;
        }

        const meshToBody = mat4Multiply(rootToBody, node.worldMatrix as Mat4);
        const indexOffset = this._vertices.length / 3;
        for (let i = 0; i < positions.length; i += 3) {
            transformPositionInto(this._vertices, meshToBody, positions[i]!, positions[i + 1]!, positions[i + 2]!);
        }

        if (!this._collectIndices) {
            return;
        }

        const indices = node._cpuIndices;
        if (!indices) {
            return;
        }
        for (let i = 0; i < indices.length; i += 3) {
            const a = indices[i]! + indexOffset;
            const b = indices[i + 1]! + indexOffset;
            const c = indices[i + 2]! + indexOffset;
            // Babylon Lite scenes use Babylon.js' default left-handed winding, so
            // reverse triangle order for Havok's mesh-shape interior optimization.
            this._indices.push(c, b, a);
        }
    }
}

function isMesh(node: SceneNode): node is Mesh {
    return "_gpu" in node && "_cpuPositions" in node;
}

function transformPositionInto(dst: number[], m: Mat4, x: number, y: number, z: number): void {
    dst.push(m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!);
}

/**
 * Creates a collision shape from the given options.
 * @param world - The physics world.
 * @param options - The shape type and its geometry parameters.
 * @returns The created shape handle.
 */
export function createPhysicsShape(world: PhysicsWorld, options: PhysicsShapeOptions): PhysicsShape {
    const { _hknp: hknp } = world;
    const params = options.parameters ?? {};

    let hkShape: any;
    const primitiveShape = createPrimitivePhysicsShapeHandle(hknp, options.type, params);
    if (primitiveShape !== null) {
        return { _hkShape: primitiveShape, _type: options.type };
    }

    switch (options.type) {
        case PhysicsShapeType.CONTAINER: {
            hkShape = hknp.HP_Shape_CreateContainer()[1];
            break;
        }
        case PhysicsShapeType.CONVEX_HULL:
        case PhysicsShapeType.MESH: {
            if (!options.mesh) {
                throw new Error("Physics mesh shapes require a mesh or transform hierarchy.");
            }
            const collectIndices = options.type === PhysicsShapeType.MESH;
            const accum = new MeshAccumulator(collectIndices);
            accum.addNodeMeshes(options.mesh, options.includeChildMeshes ?? false);
            const positions = accum.getVertices(hknp);
            const numVec3s = positions.numObjects / 3;
            if (options.type === PhysicsShapeType.CONVEX_HULL) {
                hkShape = hknp.HP_Shape_CreateConvexHull(positions.offset, numVec3s)[1];
            } else {
                const triangles = accum.getTriangles(hknp);
                const numTriangles = triangles.numObjects / 3;
                hkShape = hknp.HP_Shape_CreateMesh(positions.offset, numVec3s, triangles.offset, numTriangles)[1];
                accum.freeBuffer(hknp, triangles);
            }
            accum.freeBuffer(hknp, positions);
            break;
        }
        default:
            throw new Error(`Unsupported shape type: ${options.type}`);
    }

    return { _hkShape: hkShape, _type: options.type };
}

function createPrimitivePhysicsShapeHandle(hknp: any, type: PhysicsShapeType, params: PhysicsShapeParameters): any | null {
    switch (type) {
        case PhysicsShapeType.SPHERE: {
            const c = params.center ?? { x: 0, y: 0, z: 0 };
            const r = params.radius ?? 0.5;
            return hknp.HP_Shape_CreateSphere([c.x, c.y, c.z], r)[1];
        }
        case PhysicsShapeType.BOX: {
            const c = params.center ?? { x: 0, y: 0, z: 0 };
            const q = params.rotation ?? { x: 0, y: 0, z: 0, w: 1 };
            const e = params.extents ?? { x: 1, y: 1, z: 1 };
            return hknp.HP_Shape_CreateBox([c.x, c.y, c.z], [q.x, q.y, q.z, q.w], [e.x, e.y, e.z])[1];
        }
        case PhysicsShapeType.CAPSULE: {
            const a = params.pointA ?? { x: 0, y: 0, z: 0 };
            const b = params.pointB ?? { x: 0, y: 1, z: 0 };
            const r = params.radius ?? 0.5;
            return hknp.HP_Shape_CreateCapsule([a.x, a.y, a.z], [b.x, b.y, b.z], r)[1];
        }
        case PhysicsShapeType.CYLINDER: {
            const a = params.pointA ?? { x: 0, y: 0, z: 0 };
            const b = params.pointB ?? { x: 0, y: 1, z: 0 };
            const r = params.radius ?? 0.5;
            return hknp.HP_Shape_CreateCylinder([a.x, a.y, a.z], [b.x, b.y, b.z], r)[1];
        }
        default:
            return null;
    }
}

// ─── Shape ↔ Body wiring ─────────────────────────────────────────────

/**
 * Assigns a collision shape to a body.
 * @param world - The physics world.
 * @param body - The body to attach the shape to.
 * @param shape - The collision shape.
 */
export function setPhysicsBodyShape(world: PhysicsWorld, body: PhysicsBody, shape: PhysicsShape): void {
    world._hknp.HP_Body_SetShape(body._hkBody, shape._hkShape);
    body._shape = shape;
}

/**
 * Adds a child shape to a container shape with an explicit local transform.
 * @param world - The physics world.
 * @param container - Parent container shape.
 * @param child - Child shape to append.
 * @param translation - Child translation in container space.
 * @param rotation - Child rotation in container space.
 * @param scale - Child scale in container space.
 */
export function addPhysicsShapeChild(world: PhysicsWorld, container: PhysicsShape, child: PhysicsShape, translation?: Vec3, rotation?: Quat, scale?: Vec3): void {
    const t = translation ?? { x: 0, y: 0, z: 0 };
    const r = rotation ?? { x: 0, y: 0, z: 0, w: 1 };
    const s = scale ?? { x: 1, y: 1, z: 1 };
    world._hknp.HP_Shape_AddChild(container._hkShape, child._hkShape, [
        [t.x, t.y, t.z],
        [r.x, r.y, r.z, r.w],
        [s.x, s.y, s.z],
    ]);
}

/**
 * Adds a child shape to a container, deriving its local transform from two scene nodes.
 * @param world - The physics world.
 * @param container - Parent container shape.
 * @param parentNode - Scene node associated with the container shape.
 * @param child - Child shape to append.
 * @param childNode - Scene node associated with the child shape.
 */
export function addPhysicsShapeChildFromParent(world: PhysicsWorld, container: PhysicsShape, parentNode: SceneNode, child: PhysicsShape, childNode: SceneNode): void {
    const invParent = mat4Invert(parentNode.worldMatrix as Mat4);
    if (!invParent) {
        throw new Error("Cannot add physics child shape from a singular parent transform.");
    }
    const childToParent = mat4Multiply(invParent, childNode.worldMatrix as Mat4);
    const transform = decomposeMatrix(childToParent);
    addPhysicsShapeChild(world, container, child, transform.translation, transform.rotation, transform.scale);
}

/**
 * Sets a shape's surface material properties.
 * @param world - The physics world.
 * @param shape - The collision shape.
 * @param friction - Friction coefficient (used for both static and dynamic friction).
 * @param restitution - Bounciness in `[0, 1]`.
 */
export function setPhysicsShapeMaterial(world: PhysicsWorld, shape: PhysicsShape, friction: number, restitution: number): void {
    // Material array: [staticFriction, dynamicFriction, restitution, frictionCombine, restitutionCombine].
    // Havok's combine modes are embind enum objects, not raw numbers.
    const combines = world._hknp.MaterialCombine;
    const material = [friction, friction, restitution, combines.MINIMUM, combines.MAXIMUM];
    world._hknp.HP_Shape_SetMaterial(shape._hkShape, material);
}

// ─── Mass ────────────────────────────────────────────────────────────

/**
 * Sets a body's mass, preserving the shape-derived inertia tensor, centre of mass, and inertia
 * orientation (matching Babylon.js `HavokPlugin` — only the mass scalar is overridden). A body with
 * no shape attached yet has no inertia tensor to derive, so it falls back to an isotropic inertia
 * proportional to the mass until a shape is set.
 * @param world - The physics world.
 * @param body - The body to update.
 * @param mass - Mass in kilograms.
 * @param centerOfMass - Optional body-local centre of mass override. When omitted, the shape-derived
 *   centre of mass is preserved. Use this when the collision shape is offset from the body's reference
 *   frame (e.g. a prop whose body origin sits at its base but whose shape is centred on its middle)
 *   so it tumbles around its real centre.
 */
export function setPhysicsBodyMass(world: PhysicsWorld, body: PhysicsBody, mass: number, centerOfMass?: Vec3): void {
    // Match Babylon.js HavokPlugin._internalUpdateMassProperties: for a body with a shape, start from
    // the shape-derived mass properties (correct anisotropic inertia tensor + centre of mass +
    // orientation) and override only the mass scalar. Writing a placeholder isotropic inertia would
    // make constrained/torqued bodies rotate at the wrong rate and break physics parity. A shape-less
    // body has no inertia to derive, so keep the previous mass-proportional isotropic fallback.
    const massProps = body._shape ? buildMassProperties(world, body) : [[0, 0, 0], mass, [mass, mass, mass], [0, 0, 0, 1]];
    massProps[1] = mass;
    if (centerOfMass) {
        massProps[0] = [centerOfMass.x, centerOfMass.y, centerOfMass.z];
    }
    world._hknp.HP_Body_SetMassProperties(body._hkBody, massProps);
}

/**
 * Sets a body's mass properties, preserving Havok's shape-derived values for omitted fields.
 * @param world - The physics world.
 * @param body - The body to update.
 * @param properties - Mass-property overrides.
 */
export function setPhysicsBodyMassProperties(world: PhysicsWorld, body: PhysicsBody, properties: PhysicsMassProperties): void {
    const massProps = buildMassProperties(world, body);
    if (properties.centerOfMass) {
        massProps[0] = [properties.centerOfMass.x, properties.centerOfMass.y, properties.centerOfMass.z];
    }
    if (properties.mass !== undefined) {
        massProps[1] = properties.mass;
    }
    if (properties.inertia) {
        massProps[2] = [properties.inertia.x, properties.inertia.y, properties.inertia.z];
    }
    if (properties.inertiaOrientation) {
        massProps[3] = [properties.inertiaOrientation.x, properties.inertiaOrientation.y, properties.inertiaOrientation.z, properties.inertiaOrientation.w];
    }
    world._hknp.HP_Body_SetMassProperties(body._hkBody, massProps);
}

function buildMassProperties(world: PhysicsWorld, body: PhysicsBody): any[] {
    const hknp = world._hknp;
    const ok = hknp.Result?.RESULT_OK ?? 0;
    const shape = hknp.HP_Body_GetShape(body._hkBody);
    if (shape[0] === ok) {
        const shapeMass = hknp.HP_Shape_BuildMassProperties(shape[1]);
        if (shapeMass[0] === ok) {
            return shapeMass[1];
        }
    }
    return [[0, 0, 0], 1, [1, 1, 1], [0, 0, 0, 1]];
}

function decomposeMatrix(m: Mat4): { translation: Vec3; rotation: Quat; scale: Vec3 } {
    const sx = Math.hypot(m[0]!, m[1]!, m[2]!);
    const sy = Math.hypot(m[4]!, m[5]!, m[6]!);
    const sz = Math.hypot(m[8]!, m[9]!, m[10]!);
    const invSx = sx > 1e-8 ? 1 / sx : 0;
    const invSy = sy > 1e-8 ? 1 / sy : 0;
    const invSz = sz > 1e-8 ? 1 / sz : 0;
    const r00 = m[0]! * invSx;
    const r01 = m[4]! * invSy;
    const r02 = m[8]! * invSz;
    const r10 = m[1]! * invSx;
    const r11 = m[5]! * invSy;
    const r12 = m[9]! * invSz;
    const r20 = m[2]! * invSx;
    const r21 = m[6]! * invSy;
    const r22 = m[10]! * invSz;

    let x: number;
    let y: number;
    let z: number;
    let w: number;
    const trace = r00 + r11 + r22;
    if (trace > 0) {
        const s = Math.sqrt(trace + 1) * 2;
        w = 0.25 * s;
        x = (r21 - r12) / s;
        y = (r02 - r20) / s;
        z = (r10 - r01) / s;
    } else if (r00 > r11 && r00 > r22) {
        const s = Math.sqrt(1 + r00 - r11 - r22) * 2;
        w = (r21 - r12) / s;
        x = 0.25 * s;
        y = (r01 + r10) / s;
        z = (r02 + r20) / s;
    } else if (r11 > r22) {
        const s = Math.sqrt(1 + r11 - r00 - r22) * 2;
        w = (r02 - r20) / s;
        x = (r01 + r10) / s;
        y = 0.25 * s;
        z = (r12 + r21) / s;
    } else {
        const s = Math.sqrt(1 + r22 - r00 - r11) * 2;
        w = (r10 - r01) / s;
        x = (r02 + r20) / s;
        y = (r12 + r21) / s;
        z = 0.25 * s;
    }
    const invLen = 1 / Math.hypot(x, y, z, w);
    return {
        translation: { x: m[12]!, y: m[13]!, z: m[14]! },
        rotation: { x: x * invLen, y: y * invLen, z: z * invLen, w: w * invLen },
        scale: { x: sx, y: sy, z: sz },
    };
}

// ─── Body control (impulse / velocity / motion type / transform) ─────
// Runtime body controls used by gameplay: shoot/throw (impulse + velocity), grab (switch a body to
// ANIMATED/kinematic while held, then back to DYNAMIC on release), and teleport (restore/load/undo).

/**
 * Apply a one-shot linear impulse (kg·m/s) to a body at a world `point` (defaults to the body's
 * current position / centre of mass), waking it if asleep. Used to shoot, throw, or shove a prop.
 * @param world - The physics world.
 * @param body - The body to push.
 * @param impulse - World-space impulse vector (kg·m/s).
 * @param point - World point of application; defaults to the body's current position.
 */
export function applyPhysicsImpulse(world: PhysicsWorld, body: PhysicsBody, impulse: Vec3, point?: Vec3): void {
    const hknp = world._hknp;
    let loc = point;
    if (!loc) {
        const t = hknp.HP_Body_GetQTransform(body._hkBody)[1];
        loc = { x: t[0][0], y: t[0][1], z: t[0][2] };
    }
    hknp.HP_Body_ApplyImpulse(body._hkBody, [loc.x, loc.y, loc.z], [impulse.x, impulse.y, impulse.z]);
}

/**
 * Set a body's linear velocity (m/s) directly — e.g. to impart a throw velocity on release.
 */
export function setPhysicsBodyLinearVelocity(world: PhysicsWorld, body: PhysicsBody, velocity: Vec3): void {
    world._hknp.HP_Body_SetLinearVelocity(body._hkBody, [velocity.x, velocity.y, velocity.z]);
}

/**
 * Get a body's current linear velocity (m/s).
 */
export function getPhysicsBodyLinearVelocity(world: PhysicsWorld, body: PhysicsBody): Vec3 {
    const v = world._hknp.HP_Body_GetLinearVelocity(body._hkBody)[1];
    return { x: v[0], y: v[1], z: v[2] };
}

/**
 * Set a body's angular velocity (rad/s).
 */
export function setPhysicsBodyAngularVelocity(world: PhysicsWorld, body: PhysicsBody, velocity: Vec3): void {
    world._hknp.HP_Body_SetAngularVelocity(body._hkBody, [velocity.x, velocity.y, velocity.z]);
}

/**
 * Switch a body's motion type at runtime (e.g. ANIMATED/kinematic while a prop is grabbed, then
 * DYNAMIC on release). Mutates `body.motionType` so the per-frame step syncs it the right way
 * (ANIMATED: node → body before the step; DYNAMIC: body → node after).
 */
export function setPhysicsBodyMotionType(world: PhysicsWorld, body: PhysicsBody, motionType: PhysicsMotionType): void {
    const hknp = world._hknp;
    const hkMotion =
        motionType === PhysicsMotionType.STATIC ? hknp.MotionType.STATIC : motionType === PhysicsMotionType.ANIMATED ? hknp.MotionType.KINEMATIC : hknp.MotionType.DYNAMIC;
    hknp.HP_Body_SetMotionType(body._hkBody, hkMotion);
    (body as { motionType: PhysicsMotionType }).motionType = motionType;
}

/**
 * Teleport a body to a world position + orientation (a pure transform set — velocities are left
 * unchanged). For grab-follow, save-restore, and undo. Also updates the bound node so a render that
 * reads the node before the next physics step stays consistent.
 */
export function setPhysicsBodyTransform(world: PhysicsWorld, body: PhysicsBody, position: Vec3, rotation: Quat): void {
    world._hknp.HP_Body_SetQTransform(body._hkBody, [
        [position.x, position.y, position.z],
        [rotation.x, rotation.y, rotation.z, rotation.w],
    ]);
    body.node.position.set(position.x, position.y, position.z);
    body.node.rotationQuaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
}

// ─── Removal ─────────────────────────────────────────────────────────

/**
 * Remove a single body from the world and release its native handle (the per-frame step skips it from
 * now on). After this the body must not be reused. A body that isn't in the world is ignored, so this is
 * safe to call once per body. Does NOT release the body's collision shape — release that separately with
 * {@link releasePhysicsShape} if it isn't shared.
 * @param world - The physics world.
 * @param body - The body to remove.
 */
export function removePhysicsBody(world: PhysicsWorld, body: PhysicsBody): void {
    const { _hknp: hknp, _hkWorld: hkWorld, _bodies: bodies } = world;
    const i = bodies.indexOf(body);
    if (i < 0) {
        return; // already removed / not part of this world
    }
    bodies.splice(i, 1);
    hknp.HP_World_RemoveBody(hkWorld, body._hkBody);
    hknp.HP_Body_Release(body._hkBody);
}

/**
 * Release a collision shape's native handle, freeing its WASM memory. Only call once no body still
 * references the shape (e.g. after {@link removePhysicsBody}). Useful when rebuilding a changing set of
 * static colliders so their shapes don't accumulate.
 * @param world - The physics world.
 * @param shape - The shape to release.
 */
export function releasePhysicsShape(world: PhysicsWorld, shape: PhysicsShape): void {
    world._hknp.HP_Shape_Release(shape._hkShape);
}

// ─── Aggregate (convenience) ─────────────────────────────────────────

/**
 * Create a physics aggregate: body + shape + material wired together.
 * `mass === 0` → STATIC, `mass > 0` → DYNAMIC.
 * Primitive shape geometry is auto-sized from the mesh bounding box when not specified.
 */
export function createPhysicsAggregate(world: PhysicsWorld, node: Mesh, type: PhysicsShapeType, options: PhysicsAggregateOptions): PhysicsAggregate {
    const motionType = options.mass === 0 ? PhysicsMotionType.STATIC : PhysicsMotionType.DYNAMIC;

    // Use a caller-supplied pre-built shape if present (e.g. a mesh/convex-hull
    // shape built via createPhysicsShape); otherwise build a primitive shape.
    // Reading options.shape adds no mesh code to this function.
    let shape = options.shape;
    if (!shape) {
        // Build shape parameters, auto-sizing from bounding box if needed
        const shapeParams = _buildShapeParams(node, type, options);
        const hkShape = createPrimitivePhysicsShapeHandle(world._hknp, type, shapeParams);
        if (hkShape === null) {
            throw new Error("createPhysicsAggregate supports only primitive physics shapes.");
        }
        shape = { _hkShape: hkShape, _type: type };
    }

    // Create body
    const body = createPhysicsBody(world, node, motionType, options.startAsleep);
    setPhysicsBodyShape(world, body, shape);

    // Set material (friction + restitution) after assigning the shape, matching
    // Babylon.js PhysicsAggregate/HavokPlugin ordering.
    const friction = options.friction ?? 0.2;
    const restitution = options.restitution ?? 0.2;
    setPhysicsShapeMaterial(world, shape, friction, restitution);

    // Set mass for dynamic bodies
    if (options.mass > 0) {
        setPhysicsBodyMass(world, body, options.mass);
    }

    return { body, shape };
}

function _buildShapeParams(node: Mesh, type: PhysicsShapeType, options: PhysicsAggregateOptions): PhysicsShapeParameters {
    const params: PhysicsShapeParameters = {};

    if (options.center) {
        params.center = options.center;
    }
    if (options.rotation) {
        params.rotation = options.rotation;
    }

    switch (type) {
        case PhysicsShapeType.SPHERE: {
            params.radius = options.radius ?? _boundingRadius(node);
            params.center = params.center ?? _boundingCenter(node);
            break;
        }
        case PhysicsShapeType.BOX: {
            params.extents = options.extents ?? _boundingExtents(node);
            params.center = params.center ?? _boundingCenter(node);
            break;
        }
        case PhysicsShapeType.CAPSULE:
        case PhysicsShapeType.CYLINDER: {
            params.radius = options.radius ?? _boundingRadius(node);
            params.pointA = options.pointA ?? { x: 0, y: 0, z: 0 };
            params.pointB = options.pointB ?? { x: 0, y: 1, z: 0 };
            break;
        }
    }
    return params;
}

function _boundingCenter(mesh: Mesh): Vec3 {
    if (mesh.boundMin && mesh.boundMax) {
        return {
            x: (mesh.boundMin[0] + mesh.boundMax[0]) * 0.5,
            y: (mesh.boundMin[1] + mesh.boundMax[1]) * 0.5,
            z: (mesh.boundMin[2] + mesh.boundMax[2]) * 0.5,
        };
    }
    return { x: 0, y: 0, z: 0 };
}

function _boundingExtents(mesh: Mesh): Vec3 {
    if (mesh.boundMin && mesh.boundMax) {
        return {
            x: mesh.boundMax[0] - mesh.boundMin[0],
            y: mesh.boundMax[1] - mesh.boundMin[1],
            z: mesh.boundMax[2] - mesh.boundMin[2],
        };
    }
    return { x: 1, y: 1, z: 1 };
}

function _boundingRadius(mesh: Mesh): number {
    if (mesh.boundMin && mesh.boundMax) {
        const dx = mesh.boundMax[0]! - mesh.boundMin[0]!;
        const dy = mesh.boundMax[1]! - mesh.boundMin[1]!;
        const dz = mesh.boundMax[2]! - mesh.boundMin[2]!;
        return Math.max(dx, dy, dz) * 0.5;
    }
    return 0.5;
}

interface PhysicsDebugGeometry {
    positions: Float32Array;
    indices: Uint32Array;
}

/** @internal */
export function getPhysicsBodyDebugGeometry(world: PhysicsWorld, body: PhysicsBody): PhysicsDebugGeometry {
    const hknp = world._hknp;
    const shapeResult = hknp.HP_Body_GetShape(body._hkBody);
    const ok = hknp.Result?.RESULT_OK ?? 0;
    if (shapeResult[0] !== ok || !shapeResult[1]) {
        return { positions: new Float32Array(0), indices: new Uint32Array(0) };
    }
    const geometryResult = hknp.HP_Shape_CreateDebugDisplayGeometry(shapeResult[1]);
    if (geometryResult[0] !== ok) {
        return { positions: new Float32Array(0), indices: new Uint32Array(0) };
    }
    const geometryInfo = hknp.HP_DebugGeometry_GetInfo(geometryResult[1])[1];
    const positionsInPlugin = new Float32Array(hknp.HEAPU8.buffer, geometryInfo[0], geometryInfo[1] * 3);
    const indicesInPlugin = new Uint32Array(hknp.HEAPU8.buffer, geometryInfo[2], geometryInfo[3] * 3);
    const positions = positionsInPlugin.slice(0);
    const indices = indicesInPlugin.slice(0);
    hknp.HP_DebugGeometry_Release(geometryResult[1]);
    return { positions, indices };
}

// ─── Dispose ─────────────────────────────────────────────────────────

/**
 * Removes and releases all bodies, then releases the native world. Call once when tearing down physics.
 * @param world - The physics world to dispose.
 */
export function disposePhysics(world: PhysicsWorld): void {
    if (world._fo) {
        world._fo.dispose(world);
        return;
    }

    const { _hknp: hknp, _hkWorld: hkWorld, _bodies: bodies } = world;

    // Remove and release all bodies
    for (let i = bodies.length - 1; i >= 0; i--) {
        const b = bodies[i]!;
        hknp.HP_World_RemoveBody(hkWorld, b._hkBody);
        hknp.HP_Body_Release(b._hkBody);
    }
    bodies.length = 0;

    // Release world
    hknp.HP_World_Release(hkWorld);
}
