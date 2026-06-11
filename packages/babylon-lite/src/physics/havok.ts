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

import type { Vec3, Quat } from "../math/types.js";
import type { SceneNode } from "../scene/scene-node.js";
import type { SceneContext } from "../scene/scene-core.js";
import type { Mesh } from "../mesh/mesh.js";
import type { HavokFloatingOriginContext, WorldRegion } from "./havok-floating-origin.js";
import { onBeforeRender } from "../scene/scene-core.js";

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
}

// ─── Opaque handles (pure state — no methods) ────────────────────────

/** Opaque handle to a Havok rigid body, bound to a scene node and a motion type. */
export interface PhysicsBody {
    /** @internal */ readonly _hkBody: any;
    readonly node: SceneNode;
    readonly motionType: PhysicsMotionType;
    /** @internal The floating-origin region this body lives in; set only under floating origin. */
    _region?: WorldRegion;
}

/** Opaque handle to a Havok collision shape. */
export interface PhysicsShape {
    /** @internal */ readonly _hkShape: any;
}

/** A body and its shape wired together, as produced by `createPhysicsAggregate`. */
export interface PhysicsAggregate {
    readonly body: PhysicsBody;
    readonly shape: PhysicsShape;
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

    // Pre-step: sync ANIMATED bodies from node → Havok
    for (let i = 0; i < bodies.length; i++) {
        const b = bodies[i]!;
        if (b.motionType === (PhysicsMotionType.ANIMATED as number)) {
            _syncNodeToBody(hknp, b);
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

// ─── Shape ───────────────────────────────────────────────────────────

/**
 * Creates a collision shape (sphere, box, capsule, or cylinder) from the given options.
 * @param world - The physics world.
 * @param options - The shape type and its geometry parameters.
 * @returns The created shape handle.
 */
export function createPhysicsShape(world: PhysicsWorld, options: PhysicsShapeOptions): PhysicsShape {
    const { _hknp: hknp } = world;
    const params = options.parameters ?? {};

    let hkShape: any;
    switch (options.type) {
        case PhysicsShapeType.SPHERE: {
            const c = params.center ?? { x: 0, y: 0, z: 0 };
            const r = params.radius ?? 0.5;
            hkShape = hknp.HP_Shape_CreateSphere([c.x, c.y, c.z], r)[1];
            break;
        }
        case PhysicsShapeType.BOX: {
            const c = params.center ?? { x: 0, y: 0, z: 0 };
            const q = params.rotation ?? { x: 0, y: 0, z: 0, w: 1 };
            const e = params.extents ?? { x: 1, y: 1, z: 1 };
            hkShape = hknp.HP_Shape_CreateBox([c.x, c.y, c.z], [q.x, q.y, q.z, q.w], [e.x, e.y, e.z])[1];
            break;
        }
        case PhysicsShapeType.CAPSULE: {
            const a = params.pointA ?? { x: 0, y: 0, z: 0 };
            const b = params.pointB ?? { x: 0, y: 1, z: 0 };
            const r = params.radius ?? 0.5;
            hkShape = hknp.HP_Shape_CreateCapsule([a.x, a.y, a.z], [b.x, b.y, b.z], r)[1];
            break;
        }
        case PhysicsShapeType.CYLINDER: {
            const a = params.pointA ?? { x: 0, y: 0, z: 0 };
            const b = params.pointB ?? { x: 0, y: 1, z: 0 };
            const r = params.radius ?? 0.5;
            hkShape = hknp.HP_Shape_CreateCylinder([a.x, a.y, a.z], [b.x, b.y, b.z], r)[1];
            break;
        }
        default:
            throw new Error(`Unsupported shape type: ${options.type}`);
    }

    return { _hkShape: hkShape };
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
}

/**
 * Sets a shape's surface material properties.
 * @param world - The physics world.
 * @param shape - The collision shape.
 * @param friction - Friction coefficient (used for both static and dynamic friction).
 * @param restitution - Bounciness in `[0, 1]`.
 */
export function setPhysicsShapeMaterial(world: PhysicsWorld, shape: PhysicsShape, friction: number, restitution: number): void {
    // Material array: [staticFriction, dynamicFriction, restitution, frictionCombine, restitutionCombine]
    // Combine modes: 0 = GEOMETRIC_MEAN, 1 = MINIMUM, 2 = MAXIMUM
    const material = [friction, friction, restitution, 0, 2];
    world._hknp.HP_Shape_SetMaterial(shape._hkShape, material);
}

// ─── Mass ────────────────────────────────────────────────────────────

/**
 * Sets a body's mass and a matching diagonal inertia tensor.
 * @param world - The physics world.
 * @param body - The body to update.
 * @param mass - Mass in kilograms.
 */
export function setPhysicsBodyMass(world: PhysicsWorld, body: PhysicsBody, mass: number): void {
    // massProperties: [centerOfMass[3], mass, inertia[3], inertiaOrientation[4]]
    const massProps = [[0, 0, 0], mass, [mass, mass, mass], [0, 0, 0, 1]];
    world._hknp.HP_Body_SetMassProperties(body._hkBody, massProps);
}

// ─── Aggregate (convenience) ─────────────────────────────────────────

/**
 * Create a physics aggregate: body + shape + material wired together.
 * `mass === 0` → STATIC, `mass > 0` → DYNAMIC.
 * Shape geometry is auto-sized from the mesh bounding box when not specified.
 */
export function createPhysicsAggregate(world: PhysicsWorld, node: Mesh, type: PhysicsShapeType, options: PhysicsAggregateOptions): PhysicsAggregate {
    const motionType = options.mass === 0 ? PhysicsMotionType.STATIC : PhysicsMotionType.DYNAMIC;

    // Build shape parameters, auto-sizing from bounding box if needed
    const shapeParams = _buildShapeParams(node, type, options);
    const shape = createPhysicsShape(world, { type, parameters: shapeParams });

    // Set material (friction + restitution)
    const friction = options.friction ?? 0.5;
    const restitution = options.restitution ?? 0.0;
    setPhysicsShapeMaterial(world, shape, friction, restitution);

    // Create body
    const body = createPhysicsBody(world, node, motionType, options.startAsleep);
    setPhysicsBodyShape(world, body, shape);

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
