/**
 * Physics (Havok V2) compat surface.
 *
 * Babylon Lite ships a Havok-V2 physics subset through standalone factory
 * functions (`createHavokWorld`, `createPhysicsAggregate`, …). This module wraps
 * the Babylon.js class-shaped entry points on top of that native API so ported
 * `@babylonjs/core` physics code resolves and behaves correctly.
 *
 * The headline wrapper is {@link HavokPlugin}, which mirrors Babylon.js's
 * `new HavokPlugin(useDeltaForWorldStep, hpInjection)`. When
 * `useDeltaForWorldStep` is `true` (the Babylon.js default) the world is stepped
 * by the **elapsed frame time** rather than a fixed `1/60` slice, so simulation
 * speed is independent of the display refresh rate (resolves issue #332). Lite's
 * native physics does this on its own: a world with no fixed step (its
 * `_fixedDeltaMs` is `0`, the default) advances by the live per-frame delta each
 * frame (clamped to a tunnelling ceiling). The wrapper therefore just leaves the
 * world in its native frame-delta mode for delta stepping, and pins a fixed step
 * only when `useDeltaForWorldStep` is `false` — no per-frame policy of its own is
 * needed.
 */

import {
    applyPhysicsBodyForce,
    applyPhysicsBodyImpulse,
    calculatePhysicsCharacterMovementToRef,
    createPhysicsCharacterController,
    createHavokWorld,
    createPhysicsAggregate,
    createPhysicsBody,
    createPhysicsConstraint,
    createPhysicsShape,
    disposePhysics,
    getPhysicsBodyAngularVelocity,
    getPhysicsBodyLinearVelocity,
    PhysicsMotionType as LitePhysicsMotionType,
    PhysicsPrestepType as LitePhysicsPrestepType,
    PhysicsConstraintAxis as LitePhysicsConstraintAxis,
    PhysicsConstraintType as LitePhysicsConstraintType,
    PhysicsShapeType as LitePhysicsShapeType,
    releasePhysicsConstraint,
    releasePhysicsShape,
    removePhysicsBody,
    setPhysicsBodyAngularVelocity,
    setPhysicsBodyLinearVelocity,
    setPhysicsBodyMassProperties,
    setPhysicsBodyMotionType,
    setPhysicsBodyPrestepType,
    setPhysicsBodyShape,
    setPhysicsGravity,
    setPhysicsShapeFilterCollideMask,
    setPhysicsShapeFilterMembershipMask,
    setPhysicsShapeIsTrigger,
    setPhysicsShapeMaterial,
    setPhysicsTimestep,
} from "babylon-lite";
import type {
    CharacterCollisionEvent as LiteCharacterCollisionEvent,
    CharacterSurfaceInfo as LiteCharacterSurfaceInfo,
    Mesh as LiteMesh,
    PhysicsBody as LitePhysicsBody,
    PhysicsCharacterController as LitePhysicsCharacterController,
    PhysicsConstraint as LitePhysicsConstraint,
    PhysicsMassProperties,
    PhysicsShape as LitePhysicsShape,
    PhysicsShapeParameters,
    PhysicsWorld,
    SceneContext,
} from "babylon-lite";

import { unsupported } from "../error.js";
import { Vector3 } from "../math/vector.js";
import type { Mesh, TransformNode } from "../meshes/meshes.js";
import type { ObserverCallback } from "../misc/observable.js";
import { Observable } from "../misc/observable.js";
import type { Node } from "../node/node.js";
import type { Scene } from "../scene/scene.js";

/** Minimal `{x, y, z}` view shared by the compat `Vector3` and Lite's `Vec3`. */
interface Vec3Like {
    x: number;
    y: number;
    z: number;
}

let physicsBodyWrappers: WeakMap<LitePhysicsBody, PhysicsBody> | null = null;

function getPhysicsBodyWrappers(): WeakMap<LitePhysicsBody, PhysicsBody> {
    return (physicsBodyWrappers ??= new WeakMap());
}

// ─── Enums (values match Babylon.js `@babylonjs/core`) ───────────────

/** The type of a Havok physics collision shape. Values match Babylon.js `PhysicsShapeType`. */
export enum PhysicsShapeType {
    SPHERE = 0,
    CAPSULE = 1,
    CYLINDER = 2,
    BOX = 3,
    CONVEX_HULL = 4,
    CONTAINER = 5,
    MESH = 6,
    HEIGHTFIELD = 7,
}

/** How a body moves. Values match Babylon.js `PhysicsMotionType`. */
export enum PhysicsMotionType {
    STATIC = 0,
    ANIMATED = 1,
    DYNAMIC = 2,
}

/** How a moved transform node is propagated to its body before each step. Values match Babylon.js `PhysicsPrestepType`. */
export enum PhysicsPrestepType {
    DISABLED = 0,
    TELEPORT = 1,
    ACTION = 2,
}

/** Type of a Physics V2 constraint. Values match Babylon.js `PhysicsConstraintType`. */
export enum PhysicsConstraintType {
    BALL_AND_SOCKET = 1,
    DISTANCE = 2,
    HINGE = 3,
    SLIDER = 4,
    LOCK = 5,
    PRISMATIC = 6,
    SIX_DOF = 7,
}

/** Axis addressed by a Physics V2 constraint limit. */
export enum PhysicsConstraintAxis {
    LINEAR_X = 0,
    LINEAR_Y = 1,
    LINEAR_Z = 2,
    ANGULAR_X = 3,
    ANGULAR_Y = 4,
    ANGULAR_Z = 5,
    LINEAR_DISTANCE = 6,
}

/** Contact state of a physics character against its supporting surface. */
export enum CharacterSupportedState {
    UNSUPPORTED = 0,
    SLIDING = 1,
    SUPPORTED = 2,
}

export interface CharacterShapeOptions {
    shape?: PhysicsShape;
    capsuleHeight?: number;
    capsuleRadius?: number;
}

export interface CharacterSurfaceInfo {
    isSurfaceDynamic: boolean;
    supportedState: CharacterSupportedState;
    averageSurfaceNormal: Vector3;
    averageSurfaceVelocity: Vector3;
    averageAngularSurfaceVelocity: Vector3;
}

export interface ICharacterControllerCollisionEvent {
    collider: PhysicsBody;
    colliderIndex: number;
    impulse: Vector3;
    impulsePosition: Vector3;
}

export interface PhysicsConstraintParameters {
    pivotA?: Vec3Like;
    pivotB?: Vec3Like;
    axisA?: Vec3Like;
    axisB?: Vec3Like;
    perpAxisA?: Vec3Like;
    perpAxisB?: Vec3Like;
    maxDistance?: number;
    collision?: boolean;
}

export class Physics6DoFLimit {
    public axis!: PhysicsConstraintAxis;
    public minLimit?: number;
    public maxLimit?: number;
    public stiffness?: number;
    public damping?: number;
}

export interface PhysicsMaterial {
    friction?: number;
    staticFriction?: number;
    restitution?: number;
}

export interface PhysicShapeOptions {
    type?: PhysicsShapeType;
    parameters?: PhysicsShapeParameters;
    pluginData?: LitePhysicsShape;
}

export interface PhysicsAggregateParameters {
    mass: number;
    friction?: number;
    staticFriction?: number;
    restitution?: number;
    radius?: number;
    pointA?: Vec3Like;
    pointB?: Vec3Like;
    extents?: Vec3Like;
    rotation?: { x: number; y: number; z: number; w: number };
    center?: Vec3Like;
    mesh?: Mesh;
    startAsleep?: boolean;
    isTriggerShape?: boolean;
}

function requirePhysicsWorld(scene: Scene | undefined): PhysicsWorld {
    const world = scene?.getPhysicsEngine()?.getPhysicsPlugin().world;
    if (!world) {
        return unsupported("Physics", "Call `scene.enablePhysics(...)` with a ready HavokPlugin before creating physics bodies or shapes.");
    }
    return world;
}

function liteShapeType(type: PhysicsShapeType): LitePhysicsShapeType {
    switch (type) {
        case PhysicsShapeType.SPHERE:
            return LitePhysicsShapeType.SPHERE;
        case PhysicsShapeType.CAPSULE:
            return LitePhysicsShapeType.CAPSULE;
        case PhysicsShapeType.CYLINDER:
            return LitePhysicsShapeType.CYLINDER;
        case PhysicsShapeType.BOX:
            return LitePhysicsShapeType.BOX;
        case PhysicsShapeType.CONVEX_HULL:
            return LitePhysicsShapeType.CONVEX_HULL;
        case PhysicsShapeType.CONTAINER:
            return LitePhysicsShapeType.CONTAINER;
        case PhysicsShapeType.MESH:
            return LitePhysicsShapeType.MESH;
        case PhysicsShapeType.HEIGHTFIELD:
            return LitePhysicsShapeType.HEIGHTFIELD;
        default:
            throw new Error(`Invalid PhysicsShapeType value: ${type}`);
    }
}

function liteMotionType(type: PhysicsMotionType): LitePhysicsMotionType {
    switch (type) {
        case PhysicsMotionType.STATIC:
            return LitePhysicsMotionType.STATIC;
        case PhysicsMotionType.ANIMATED:
            return LitePhysicsMotionType.ANIMATED;
        case PhysicsMotionType.DYNAMIC:
            return LitePhysicsMotionType.DYNAMIC;
        default:
            throw new Error(`Invalid PhysicsMotionType value: ${type}`);
    }
}

function litePrestepType(type: PhysicsPrestepType): LitePhysicsPrestepType {
    switch (type) {
        case PhysicsPrestepType.DISABLED:
            return LitePhysicsPrestepType.DISABLED;
        case PhysicsPrestepType.TELEPORT:
            return LitePhysicsPrestepType.TELEPORT;
        case PhysicsPrestepType.ACTION:
            return LitePhysicsPrestepType.ACTION;
        default:
            throw new Error(`Invalid PhysicsPrestepType value: ${type}`);
    }
}

function liteConstraintType(type: PhysicsConstraintType): LitePhysicsConstraintType {
    switch (type) {
        case PhysicsConstraintType.BALL_AND_SOCKET:
            return LitePhysicsConstraintType.BALL_AND_SOCKET;
        case PhysicsConstraintType.DISTANCE:
            return LitePhysicsConstraintType.DISTANCE;
        case PhysicsConstraintType.HINGE:
            return LitePhysicsConstraintType.HINGE;
        case PhysicsConstraintType.SLIDER:
            return LitePhysicsConstraintType.SLIDER;
        case PhysicsConstraintType.LOCK:
            return LitePhysicsConstraintType.LOCK;
        case PhysicsConstraintType.PRISMATIC:
            return LitePhysicsConstraintType.PRISMATIC;
        case PhysicsConstraintType.SIX_DOF:
            return LitePhysicsConstraintType.SIX_DOF;
    }
}

function liteConstraintAxis(axis: PhysicsConstraintAxis): LitePhysicsConstraintAxis {
    switch (axis) {
        case PhysicsConstraintAxis.LINEAR_X:
            return LitePhysicsConstraintAxis.LINEAR_X;
        case PhysicsConstraintAxis.LINEAR_Y:
            return LitePhysicsConstraintAxis.LINEAR_Y;
        case PhysicsConstraintAxis.LINEAR_Z:
            return LitePhysicsConstraintAxis.LINEAR_Z;
        case PhysicsConstraintAxis.ANGULAR_X:
            return LitePhysicsConstraintAxis.ANGULAR_X;
        case PhysicsConstraintAxis.ANGULAR_Y:
            return LitePhysicsConstraintAxis.ANGULAR_Y;
        case PhysicsConstraintAxis.ANGULAR_Z:
            return LitePhysicsConstraintAxis.ANGULAR_Z;
        case PhysicsConstraintAxis.LINEAR_DISTANCE:
            return LitePhysicsConstraintAxis.LINEAR_DISTANCE;
    }
}

/** Babylon.js-shaped collision shape backed by a Babylon Lite physics shape. */
export class PhysicsShape {
    /** @internal */
    public _lite!: LitePhysicsShape;
    /** @internal */
    private readonly _world: PhysicsWorld;
    /** @internal */
    private _material: PhysicsMaterial = {};
    /** @internal */
    private _membershipMask = 0xffffffff;
    /** @internal */
    private _collideMask = 0xffffffff;
    /** @internal */
    private _isTrigger = false;
    /** @internal */
    private _disposed = false;
    /** @internal Whether this wrapper is responsible for releasing the native shape. */
    private _ownsLiteShape = true;

    public constructor(options: PhysicShapeOptions, scene: Scene) {
        this._world = requirePhysicsWorld(scene);
        if (options.pluginData) {
            this._lite = options.pluginData;
        } else if (options.type !== undefined) {
            this._lite = createPhysicsShape(this._world, { type: liteShapeType(options.type), parameters: options.parameters });
        } else {
            return unsupported("PhysicsShape", "Specify either `type` or a native Lite shape as `pluginData`.");
        }
    }

    /** @internal */
    public static _fromLite(shape: LitePhysicsShape, world: PhysicsWorld, ownsLiteShape = true): PhysicsShape {
        const wrapper = Object.create(PhysicsShape.prototype) as PhysicsShape;
        Object.defineProperties(wrapper, {
            _lite: { value: shape, enumerable: true, writable: true },
            _world: { value: world },
            _material: { value: {}, writable: true },
            _membershipMask: { value: 0xffffffff, writable: true },
            _collideMask: { value: 0xffffffff, writable: true },
            _isTrigger: { value: false, writable: true },
            _disposed: { value: false, writable: true },
            _ownsLiteShape: { value: ownsLiteShape },
        });
        return wrapper;
    }

    /** @internal */
    public _replaceLiteShape(shape: LitePhysicsShape): void {
        this._lite = shape;
        this.material = this._material;
        this.filterMembershipMask = this._membershipMask;
        this.filterCollideMask = this._collideMask;
        this.isTrigger = this._isTrigger;
    }

    public getClassName(): string {
        return "PhysicsShape";
    }

    public get type(): PhysicsShapeType {
        switch (this._lite._type) {
            case LitePhysicsShapeType.SPHERE:
                return PhysicsShapeType.SPHERE;
            case LitePhysicsShapeType.CAPSULE:
                return PhysicsShapeType.CAPSULE;
            case LitePhysicsShapeType.CYLINDER:
                return PhysicsShapeType.CYLINDER;
            case LitePhysicsShapeType.BOX:
                return PhysicsShapeType.BOX;
            case LitePhysicsShapeType.CONVEX_HULL:
                return PhysicsShapeType.CONVEX_HULL;
            case LitePhysicsShapeType.CONTAINER:
                return PhysicsShapeType.CONTAINER;
            case LitePhysicsShapeType.MESH:
                return PhysicsShapeType.MESH;
            case LitePhysicsShapeType.HEIGHTFIELD:
                return PhysicsShapeType.HEIGHTFIELD;
            default:
                throw new Error(`Invalid Lite PhysicsShapeType value: ${this._lite._type}`);
        }
    }

    public set filterMembershipMask(value: number) {
        this._membershipMask = value;
        setPhysicsShapeFilterMembershipMask(this._world, this._lite, value);
    }
    public get filterMembershipMask(): number {
        return this._membershipMask;
    }

    public set filterCollideMask(value: number) {
        this._collideMask = value;
        setPhysicsShapeFilterCollideMask(this._world, this._lite, value);
    }
    public get filterCollideMask(): number {
        return this._collideMask;
    }

    public set material(value: PhysicsMaterial) {
        this._material = value;
        const friction = value.friction ?? 0.5;
        setPhysicsShapeMaterial(this._world, this._lite, friction, value.restitution ?? 0, value.staticFriction ?? friction);
    }
    public get material(): PhysicsMaterial {
        return this._material;
    }

    public set isTrigger(value: boolean) {
        this._isTrigger = value;
        setPhysicsShapeIsTrigger(this._world, this._lite, value);
    }
    public get isTrigger(): boolean {
        return this._isTrigger;
    }

    public dispose(): void {
        if (!this._disposed) {
            if (this._ownsLiteShape) {
                releasePhysicsShape(this._world, this._lite);
            }
            this._disposed = true;
        }
    }
}

/** Babylon.js-shaped rigid body backed by a Babylon Lite physics body. */
export class PhysicsBody {
    /** @internal */
    public readonly _lite: LitePhysicsBody;
    /** @internal */
    private readonly _world: PhysicsWorld;
    /** @internal */
    private _shape: PhysicsShape | null = null;
    /** @internal */
    private _disposed = false;
    /** @internal */
    private _nodeDisposeObserver: ObserverCallback<Node> | null = null;
    public readonly transformNode: TransformNode;
    private _disableSync = false;
    public readonly startAsleep: boolean;

    public constructor(transformNode: TransformNode, motionType: PhysicsMotionType, startsAsleep: boolean, scene: Scene) {
        assertPhysicsNodeSupported(transformNode);
        this.transformNode = transformNode;
        this.startAsleep = startsAsleep;
        this._world = requirePhysicsWorld(scene);
        this._lite = createPhysicsBody(this._world, transformNode._node, liteMotionType(motionType), startsAsleep);
        getPhysicsBodyWrappers().set(this._lite, this);
        setPhysicsBodyPrestepType(this._lite, LitePhysicsPrestepType.DISABLED);
        this._attachToNode();
    }

    /** @internal */
    public static _fromLite(body: LitePhysicsBody, transformNode: TransformNode, world: PhysicsWorld, startsAsleep = false): PhysicsBody {
        const wrapper = Object.create(PhysicsBody.prototype) as PhysicsBody;
        Object.defineProperties(wrapper, {
            _lite: { value: body, enumerable: true },
            _world: { value: world },
            _shape: { value: null, writable: true },
            _disposed: { value: false, writable: true },
            _nodeDisposeObserver: { value: null, writable: true },
            transformNode: { value: transformNode, enumerable: true },
            _disableSync: { value: false, writable: true },
            startAsleep: { value: startsAsleep, enumerable: true },
        });
        setPhysicsBodyPrestepType(wrapper._lite, LitePhysicsPrestepType.DISABLED);
        getPhysicsBodyWrappers().set(wrapper._lite, wrapper);
        wrapper._attachToNode();
        return wrapper;
    }

    public getClassName(): string {
        return "PhysicsBody";
    }

    public get disablePreStep(): boolean {
        return this._lite._prestepType === LitePhysicsPrestepType.DISABLED;
    }
    public set disablePreStep(value: boolean) {
        setPhysicsBodyPrestepType(this._lite, value ? LitePhysicsPrestepType.DISABLED : LitePhysicsPrestepType.TELEPORT);
    }

    public get disableSync(): boolean {
        return this._disableSync;
    }
    public set disableSync(value: boolean) {
        if (value) {
            unsupported(
                "PhysicsBody.disableSync",
                "Babylon Lite's shared physics step always synchronizes dynamic bodies; opting out would require changing that existing hot-path module and every physics scene bundle."
            );
        }
        this._disableSync = false;
    }

    public get motionType(): PhysicsMotionType {
        switch (this._lite.motionType) {
            case LitePhysicsMotionType.STATIC:
                return PhysicsMotionType.STATIC;
            case LitePhysicsMotionType.ANIMATED:
                return PhysicsMotionType.ANIMATED;
            case LitePhysicsMotionType.DYNAMIC:
                return PhysicsMotionType.DYNAMIC;
            default:
                throw new Error(`Invalid Lite PhysicsMotionType value: ${this._lite.motionType}`);
        }
    }

    public set shape(value: PhysicsShape | null) {
        if (!value) {
            unsupported("PhysicsBody.shape", "Babylon Lite cannot detach a shape from a live body; assign another PhysicsShape or dispose the body.");
        }
        this._shape = value;
        setPhysicsBodyShape(this._world, this._lite, value._lite);
    }
    public get shape(): PhysicsShape | null {
        return this._shape;
    }

    public setMotionType(value: PhysicsMotionType): void {
        setPhysicsBodyMotionType(this._world, this._lite, liteMotionType(value));
    }
    public getMotionType(): PhysicsMotionType {
        return this.motionType;
    }
    public setPrestepType(value: PhysicsPrestepType): void {
        setPhysicsBodyPrestepType(this._lite, litePrestepType(value));
    }
    public getPrestepType(): PhysicsPrestepType {
        switch (this._lite._prestepType) {
            case LitePhysicsPrestepType.DISABLED:
                return PhysicsPrestepType.DISABLED;
            case LitePhysicsPrestepType.TELEPORT:
                return PhysicsPrestepType.TELEPORT;
            case LitePhysicsPrestepType.ACTION:
                return PhysicsPrestepType.ACTION;
            default:
                throw new Error(`Invalid Lite PhysicsPrestepType value: ${this._lite._prestepType}`);
        }
    }
    public setMassProperties(properties: PhysicsMassProperties): void {
        setPhysicsBodyMassProperties(this._world, this._lite, properties);
    }
    public setLinearVelocity(value: Vec3Like): void {
        setPhysicsBodyLinearVelocity(this._world, this._lite, value);
    }
    public getLinearVelocity(): Vector3 {
        const value = getPhysicsBodyLinearVelocity(this._world, this._lite);
        return new Vector3(value.x, value.y, value.z);
    }
    public getLinearVelocityToRef(result: Vector3): void {
        const value = getPhysicsBodyLinearVelocity(this._world, this._lite);
        result.set(value.x, value.y, value.z);
    }
    public setAngularVelocity(value: Vec3Like): void {
        setPhysicsBodyAngularVelocity(this._world, this._lite, value);
    }
    public getAngularVelocity(): Vector3 {
        const value = getPhysicsBodyAngularVelocity(this._world, this._lite);
        return new Vector3(value.x, value.y, value.z);
    }
    public getAngularVelocityToRef(result: Vector3): void {
        const value = getPhysicsBodyAngularVelocity(this._world, this._lite);
        result.set(value.x, value.y, value.z);
    }
    public applyImpulse(impulse: Vec3Like, location: Vec3Like): void {
        applyPhysicsBodyImpulse(this._lite, impulse, location);
    }
    public applyForce(force: Vec3Like, location: Vec3Like): void {
        applyPhysicsBodyForce(this._world, this._lite, force, location);
    }
    public addConstraint(childBody: PhysicsBody, constraint: PhysicsConstraint): void {
        if (childBody._world !== this._world) {
            throw new Error("PhysicsBody.addConstraint requires both bodies to belong to the same scene");
        }
        constraint._bind(this._world, this._lite, childBody._lite);
    }

    public dispose(): void {
        if (!this._disposed) {
            this.transformNode.onDisposeObservable.remove(this._nodeDisposeObserver);
            this._nodeDisposeObserver = null;
            removePhysicsBody(this._world, this._lite);
            getPhysicsBodyWrappers().delete(this._lite);
            if (this.transformNode.physicsBody === this) {
                this.transformNode.physicsBody = null;
            }
            this._disposed = true;
        }
    }

    /** @internal */
    public _adoptShape(shape: PhysicsShape): void {
        this._shape = shape;
    }

    /** @internal */
    private _attachToNode(): void {
        this.transformNode.physicsBody = this;
        this._nodeDisposeObserver = this.transformNode.onDisposeObservable.add(() => this.dispose());
    }
}

/** Babylon.js-shaped Physics V2 constraint backed by Lite's native constraint factory. */
export class PhysicsConstraint {
    private readonly _lite: LitePhysicsConstraint[] = [];
    private readonly _world: PhysicsWorld;

    public constructor(
        public readonly type: PhysicsConstraintType,
        protected readonly _options: PhysicsConstraintParameters,
        protected readonly _scene: Scene,
        protected readonly _limits: readonly Physics6DoFLimit[] = []
    ) {
        this._world = requirePhysicsWorld(_scene);
    }

    public get options(): PhysicsConstraintParameters {
        return this._options;
    }

    public getClassName(): string {
        return "PhysicsConstraint";
    }

    /** @internal */
    public _bind(world: PhysicsWorld, bodyA: LitePhysicsBody, bodyB: LitePhysicsBody): void {
        if (this._world !== world) {
            throw new Error("PhysicsConstraint and PhysicsBody must belong to the same scene");
        }
        this._lite.push(
            createPhysicsConstraint(
                world,
                bodyA,
                bodyB,
                liteConstraintType(this.type),
                this._options,
                this._limits.map((limit) => ({ ...limit, axis: liteConstraintAxis(limit.axis) }))
            )
        );
    }

    public dispose(): void {
        if (this._lite.length > 0) {
            // Releasing the Havok world invalidates all of its constraint handles.
            if (this._scene.getPhysicsEngine()?.getPhysicsPlugin().world === this._world) {
                for (const constraint of this._lite) {
                    releasePhysicsConstraint(this._world, constraint);
                }
            }
            this._lite.length = 0;
        }
    }
}

/** Babylon.js `HingeConstraint` adapter. */
export class HingeConstraint extends PhysicsConstraint {
    public constructor(pivotA: Vector3, pivotB: Vector3, axisA: Vector3, axisB: Vector3, scene: Scene) {
        super(PhysicsConstraintType.HINGE, { pivotA, pivotB, axisA, axisB }, scene);
    }

    public override getClassName(): string {
        return "HingeConstraint";
    }
}

export class BallAndSocketConstraint extends PhysicsConstraint {
    public constructor(pivotA: Vector3, pivotB: Vector3, axisA: Vector3, axisB: Vector3, scene: Scene) {
        super(PhysicsConstraintType.BALL_AND_SOCKET, { pivotA, pivotB, axisA, axisB }, scene);
    }
}

export class DistanceConstraint extends PhysicsConstraint {
    public constructor(maxDistance: number, scene: Scene) {
        super(PhysicsConstraintType.DISTANCE, { maxDistance }, scene);
    }
}

export class SliderConstraint extends PhysicsConstraint {
    public constructor(pivotA: Vector3, pivotB: Vector3, axisA: Vector3, axisB: Vector3, scene: Scene) {
        super(PhysicsConstraintType.SLIDER, { pivotA, pivotB, axisA, axisB }, scene);
    }
}

export class LockConstraint extends PhysicsConstraint {
    public constructor(pivotA: Vector3, pivotB: Vector3, axisA: Vector3, axisB: Vector3, scene: Scene) {
        super(PhysicsConstraintType.LOCK, { pivotA, pivotB, axisA, axisB }, scene);
    }
}

export class PrismaticConstraint extends PhysicsConstraint {
    public constructor(pivotA: Vector3, pivotB: Vector3, axisA: Vector3, axisB: Vector3, scene: Scene) {
        super(PhysicsConstraintType.PRISMATIC, { pivotA, pivotB, axisA, axisB }, scene);
    }
}

export class Physics6DoFConstraint extends PhysicsConstraint {
    public constructor(
        constraintParams: PhysicsConstraintParameters,
        public readonly limits: Physics6DoFLimit[],
        scene: Scene
    ) {
        super(PhysicsConstraintType.SIX_DOF, constraintParams, scene, limits);
    }
}

export class SpringConstraint extends Physics6DoFConstraint {
    public constructor(
        pivotA: Vector3,
        pivotB: Vector3,
        axisA: Vector3,
        axisB: Vector3,
        minDistance: number,
        maxDistance: number,
        stiffness: number,
        damping: number,
        scene: Scene
    ) {
        super({ pivotA, pivotB, axisA, axisB }, [{ axis: PhysicsConstraintAxis.LINEAR_DISTANCE, minLimit: minDistance, maxLimit: maxDistance, stiffness, damping }], scene);
    }
}

function vectorFromLite(value: Vec3Like): Vector3 {
    return new Vector3(value.x, value.y, value.z);
}

function vectorFromLiteOwned(value: Vec3Like): Vector3 {
    if (!(value instanceof Vector3)) {
        Object.setPrototypeOf(value, Vector3.prototype);
    }
    return value as Vector3;
}

function surfaceInfoFromLite(value: LiteCharacterSurfaceInfo): CharacterSurfaceInfo {
    return {
        isSurfaceDynamic: value.isSurfaceDynamic,
        supportedState: Number(value.supportedState) as CharacterSupportedState,
        averageSurfaceNormal: vectorFromLite(value.averageSurfaceNormal),
        averageSurfaceVelocity: vectorFromLite(value.averageSurfaceVelocity),
        averageAngularSurfaceVelocity: vectorFromLite(value.averageAngularSurfaceVelocity),
    };
}

/**
 * Babylon.js-shaped character controller backed by Lite's native, tree-shakeable
 * Havok character controller.
 */
export class PhysicsCharacterController {
    /** @internal */
    public readonly _lite: LitePhysicsCharacterController;
    public readonly onTriggerCollisionObservable = new Observable<ICharacterControllerCollisionEvent>();
    private _shape: PhysicsShape;
    private _up: Vector3;
    private _maxStepHeight = 0;
    private _footOffset: number;
    private _disposed = false;

    public constructor(position: Vector3, characterShapeOptions: CharacterShapeOptions, scene: Scene) {
        if (characterShapeOptions.shape) {
            unsupported(
                "PhysicsCharacterController custom shapes",
                "Lite's controller owns and rebuilds a capsule internally; exposing caller-owned shape replacement requires an ownership/lifetime design in Lite."
            );
        }
        const world = requirePhysicsWorld(scene);
        this._lite = createPhysicsCharacterController(world, position, {
            capsuleHeight: characterShapeOptions.capsuleHeight ?? 1.8,
            capsuleRadius: characterShapeOptions.capsuleRadius ?? 0.6,
        });
        this._up = vectorFromLite(this._lite.up);
        this._lite.up = this._up;
        this._footOffset = (characterShapeOptions.capsuleHeight ?? 1.8) * 0.5;
        const liteShape = this._lite.getBody()._shape;
        if (!liteShape) {
            throw new Error("Babylon Lite character controller did not create a collision shape.");
        }
        this._shape = PhysicsShape._fromLite(liteShape, world, false);
        this._lite.onTriggerCollisionObservable.add((event) => this._notifyCollision(event));
    }

    public get shape(): PhysicsShape {
        return this._shape;
    }

    public set shape(_value: PhysicsShape) {
        unsupported("PhysicsCharacterController.shape", "Lite's controller owns its cast shape; replacing it requires an explicit Lite ownership/lifetime contract.");
    }

    public get shapeOptions(): CharacterShapeOptions {
        const { capsuleHeight, capsuleRadius } = this._lite.shapeOptions;
        return { capsuleHeight, capsuleRadius };
    }

    public setShapeOptions(options: CharacterShapeOptions, preserveFootPosition = true): void {
        if (options.shape) {
            this.shape = options.shape;
            return;
        }
        this._lite.setShapeOptions({ capsuleHeight: options.capsuleHeight ?? 1.8, capsuleRadius: options.capsuleRadius ?? 0.6 }, preserveFootPosition);
        const liteShape = this._lite.getBody()._shape;
        if (!liteShape) {
            throw new Error("Babylon Lite character controller did not rebuild its collision shape.");
        }
        this._shape._replaceLiteShape(liteShape);
        this._footOffset = (options.capsuleHeight ?? 1.8) * 0.5;
    }

    public getPosition(): Vector3 {
        return vectorFromLiteOwned(this._lite.getPosition());
    }

    public setPosition(position: Vector3): void {
        this._lite.setPosition(position);
    }

    public getVelocity(): Vector3 {
        return vectorFromLiteOwned(this._lite.getVelocity());
    }

    public setVelocity(velocity: Vector3): void {
        this._lite.setVelocity(velocity);
    }

    public moveWithCollisions(displacement: Vector3): void {
        this._lite.moveWithCollisions(displacement);
    }

    public integrate(deltaTime: number, surfaceInfo: CharacterSurfaceInfo, gravity: Vector3): void {
        this._lite.integrate(deltaTime, { ...surfaceInfo, supportedState: Number(surfaceInfo.supportedState) }, gravity);
    }

    public checkSupport(deltaTime: number, direction: Vector3): CharacterSurfaceInfo {
        return surfaceInfoFromLite(this._lite.checkSupport(deltaTime, direction));
    }

    public checkSupportToRef(deltaTime: number, direction: Vector3, result: CharacterSurfaceInfo): void {
        const value = this._lite.checkSupport(deltaTime, direction);
        result.isSurfaceDynamic = value.isSurfaceDynamic;
        result.supportedState = Number(value.supportedState) as CharacterSupportedState;
        result.averageSurfaceNormal.set(value.averageSurfaceNormal.x, value.averageSurfaceNormal.y, value.averageSurfaceNormal.z);
        result.averageSurfaceVelocity.set(value.averageSurfaceVelocity.x, value.averageSurfaceVelocity.y, value.averageSurfaceVelocity.z);
        result.averageAngularSurfaceVelocity.set(value.averageAngularSurfaceVelocity.x, value.averageAngularSurfaceVelocity.y, value.averageAngularSurfaceVelocity.z);
    }

    public calculateMovement(
        deltaTime: number,
        forwardWorld: Vector3,
        surfaceNormal: Vector3,
        currentVelocity: Vector3,
        surfaceVelocity: Vector3,
        desiredVelocity: Vector3,
        upWorld: Vector3
    ): Vector3 {
        return vectorFromLite(this._lite.calculateMovement(deltaTime, forwardWorld, surfaceNormal, currentVelocity, surfaceVelocity, desiredVelocity, upWorld));
    }

    public calculateMovementToRef(
        deltaTime: number,
        forwardWorld: Vector3,
        surfaceNormal: Vector3,
        currentVelocity: Vector3,
        surfaceVelocity: Vector3,
        desiredVelocity: Vector3,
        upWorld: Vector3,
        result: Vector3
    ): boolean {
        return calculatePhysicsCharacterMovementToRef(this._lite, deltaTime, forwardWorld, surfaceNormal, currentVelocity, surfaceVelocity, desiredVelocity, upWorld, result);
    }

    public dispose(): void {
        if (!this._disposed) {
            this._lite.dispose();
            this.onTriggerCollisionObservable.clear();
            this._disposed = true;
        }
    }

    public get up(): Vector3 {
        return this._up;
    }

    public set up(value: Vector3) {
        this._up = value;
        this._lite.up = value;
    }

    public get maxStepHeight(): number {
        return this._maxStepHeight;
    }

    public set maxStepHeight(value: number) {
        if (value !== 0) {
            unsupported(
                "PhysicsCharacterController.maxStepHeight",
                "Step-up needs a substantial additional sweep/manifold policy in Lite's controller and cannot be implemented as compat translation."
            );
        }
        this._maxStepHeight = 0;
    }

    public get footOffset(): number {
        return this._footOffset;
    }

    public set footOffset(value: number) {
        if (value !== this._footOffset) {
            unsupported(
                "PhysicsCharacterController.footOffset",
                "Lite derives the character foot from capsule height and does not expose the custom-shape foot-offset policy used by Babylon.js."
            );
        }
    }

    private _notifyCollision(event: LiteCharacterCollisionEvent): void {
        const collider = getPhysicsBodyWrappers().get(event.collider);
        if (!collider) {
            unsupported(
                "PhysicsCharacterController collision body mapping",
                "The contacted Lite body was not created through the compat physics API and has no Babylon.js TransformNode wrapper."
            );
        }
        this.onTriggerCollisionObservable.notifyObservers({
            collider,
            colliderIndex: 0,
            impulse: vectorFromLite(event.impulse),
            impulsePosition: vectorFromLite(event.impulsePosition),
        });
    }

    public get keepDistance(): number {
        return this._lite.keepDistance;
    }
    public set keepDistance(value: number) {
        this._lite.keepDistance = value;
    }
    public get keepContactTolerance(): number {
        return this._lite.keepContactTolerance;
    }
    public set keepContactTolerance(value: number) {
        this._lite.keepContactTolerance = value;
    }
    public get maxCastIterations(): number {
        return this._lite.maxCastIterations;
    }
    public set maxCastIterations(value: number) {
        this._lite.maxCastIterations = value;
    }
    public get penetrationRecoverySpeed(): number {
        return this._lite.penetrationRecoverySpeed;
    }
    public set penetrationRecoverySpeed(value: number) {
        this._lite.penetrationRecoverySpeed = value;
    }
    public get staticFriction(): number {
        return this._lite.staticFriction;
    }
    public set staticFriction(value: number) {
        this._lite.staticFriction = value;
    }
    public get dynamicFriction(): number {
        return this._lite.dynamicFriction;
    }
    public set dynamicFriction(value: number) {
        this._lite.dynamicFriction = value;
    }
    public get maxSlopeCosine(): number {
        return this._lite.maxSlopeCosine;
    }
    public set maxSlopeCosine(value: number) {
        this._lite.maxSlopeCosine = value;
    }
    public get maxCharacterSpeedForSolver(): number {
        return this._lite.maxCharacterSpeedForSolver;
    }
    public set maxCharacterSpeedForSolver(value: number) {
        this._lite.maxCharacterSpeedForSolver = value;
    }
    public get characterStrength(): number {
        return this._lite.characterStrength;
    }
    public set characterStrength(value: number) {
        this._lite.characterStrength = value;
    }
    public get acceleration(): number {
        return this._lite.acceleration;
    }
    public set acceleration(value: number) {
        this._lite.acceleration = value;
    }
    public get maxAcceleration(): number {
        return this._lite.maxAcceleration;
    }
    public set maxAcceleration(value: number) {
        this._lite.maxAcceleration = value;
    }
    public get characterMass(): number {
        return this._lite.characterMass;
    }
    public set characterMass(value: number) {
        this._lite.characterMass = value;
    }
}

/** Babylon.js aggregate convenience object backed by Lite's native aggregate factory. */
export class PhysicsAggregate {
    public readonly transformNode: TransformNode;
    public readonly type: PhysicsShapeType | PhysicsShape;
    public readonly body: PhysicsBody;
    public readonly shape: PhysicsShape;
    public readonly material: PhysicsMaterial;
    /** @internal */
    private _disposed = false;
    /** @internal */
    private readonly _disposeShapeWhenDisposed: boolean;
    /** @internal */
    private _nodeDisposeObserver: ObserverCallback<Node> | null = null;

    public constructor(transformNode: TransformNode, type: PhysicsShapeType | PhysicsShape, options: PhysicsAggregateParameters = { mass: 0 }, scene?: Scene) {
        assertPhysicsNodeSupported(transformNode);
        this.transformNode = transformNode;
        this.type = type;
        const resolvedScene = scene ?? transformNode.getScene();
        const world = requirePhysicsWorld(resolvedScene);
        const nativeType = type instanceof PhysicsShape ? type._lite._type : liteShapeType(type);
        let suppliedShape = type instanceof PhysicsShape ? type : undefined;
        this._disposeShapeWhenDisposed = !suppliedShape;
        if (!suppliedShape && (type === PhysicsShapeType.MESH || type === PhysicsShapeType.CONVEX_HULL)) {
            suppliedShape = PhysicsShape._fromLite(createPhysicsShape(world, { type: nativeType, mesh: (options.mesh ?? transformNode)._node }), world);
        }
        const aggregate = createPhysicsAggregate(world, transformNode._node as LiteMesh, nativeType, {
            ...options,
            shape: suppliedShape?._lite,
        });
        this.material = {
            friction: options.friction ?? 0.2,
            staticFriction: options.staticFriction,
            restitution: options.restitution ?? 0.2,
        };
        this.shape = suppliedShape ?? PhysicsShape._fromLite(aggregate.shape, world);
        this.shape.material = this.material;
        if (options.isTriggerShape !== undefined) {
            this.shape.isTrigger = options.isTriggerShape;
        }
        this.body = PhysicsBody._fromLite(aggregate.body, transformNode, world, options.startAsleep);
        this.body._adoptShape(this.shape);
        this._nodeDisposeObserver = transformNode.onDisposeObservable.add(() => this.dispose());
    }

    public dispose(): void {
        if (!this._disposed) {
            this.transformNode.onDisposeObservable.remove(this._nodeDisposeObserver);
            this._nodeDisposeObserver = null;
            this.body.dispose();
            if (this._disposeShapeWhenDisposed) {
                this.shape.dispose();
            }

            this._disposed = true;
        }
    }
}

function assertPhysicsNodeSupported(transformNode: TransformNode): void {
    if (transformNode.physicsBody) {
        unsupported("PhysicsBody", "Babylon Lite synchronizes one physics body per scene node; dispose the existing TransformNode.physicsBody before attaching another.");
    }
    if (transformNode.parent || transformNode._node.parent) {
        unsupported("PhysicsBody", "Babylon Lite physics bodies currently consume local transforms, so parented TransformNodes cannot be synchronized in Babylon.js world space.");
    }
    const mesh = transformNode._node as Partial<LiteMesh>;
    if (mesh.thinInstances?.count) {
        unsupported("PhysicsBody", "Babylon Lite exposes one physics body per scene node and has no per-thin-instance body representation.");
    }
}

// ─── HavokPlugin ─────────────────────────────────────────────────────

/**
 * Babylon.js-shaped Havok V2 physics plugin, backed by Babylon Lite's native
 * `createHavokWorld` API.
 *
 * Construct it exactly as in Babylon.js and pass it to {@link Scene.enablePhysics}:
 * ```ts
 *   const hknp = await HavokPhysics();
 *   scene.enablePhysics(new Vector3(0, -9.81, 0), new HavokPlugin(true, hknp));
 * ```
 *
 * The first constructor argument, `useDeltaForWorldStep` (default `true`,
 * matching Babylon.js), selects delta-driven stepping: the world advances by the
 * elapsed real time each frame, so the simulation runs at the same real-time
 * speed regardless of the display refresh rate (issue #332). Pass `false` for the
 * legacy fixed `1/60`-per-frame behaviour.
 *
 * Bodies are still created with the native `createPhysicsAggregate` /
 * `createPhysicsBody` API against {@link world}; the Babylon.js `PhysicsAggregate`
 * class is not wrapped.
 */
export class HavokPlugin {
    /** Name of the plugin. */
    public readonly name: string = "HavokPlugin";

    /** @internal Reference to the Havok WASM module (`@babylonjs/havok`). */
    public _hknp: unknown;

    /** The native Lite physics world, created when the plugin is attached to a scene. */
    public world: PhysicsWorld | null = null;

    /** @internal Fixed timestep used when delta stepping is disabled, and by force scaling. */
    private _fixedTimeStep: number = 1 / 60;

    /** @internal Whether to advance the world by the elapsed frame time (vs a fixed `1/60`). */
    private readonly _useDeltaForWorldStep: boolean;

    /** @internal Whether the injected Havok module looks usable. */
    private readonly _supported: boolean;

    public constructor(useDeltaForWorldStep: boolean = true, hpInjection?: unknown) {
        this._useDeltaForWorldStep = useDeltaForWorldStep;
        this._hknp = hpInjection;
        // Babylon.js treats a still-pending `HavokPhysics()` promise factory (a
        // function) as "not ready". Mirror that: a function injection is unusable.
        this._supported = hpInjection != null && typeof hpInjection !== "function";
    }

    /** Whether the plugin has a usable Havok module. */
    public isSupported(): boolean {
        return this._supported;
    }

    /** Babylon.js physics plugin version (Havok is V2). */
    public getPluginVersion(): number {
        return 2;
    }

    /** Set the fixed timestep used when delta stepping is disabled. Matches Babylon.js. */
    public setTimeStep(timeStep: number): void {
        this._fixedTimeStep = timeStep;
        // Only a fixed-step world tracks this value on the native side. In delta mode Lite steps by
        // the live frame delta, so pushing a fixed step here would disable that — leave the world be.
        if (this.world && !this._useDeltaForWorldStep) {
            setPhysicsTimestep(this.world, timeStep);
        }
    }

    /** Get the fixed timestep. Matches Babylon.js. */
    public getTimeStep(): number {
        return this._fixedTimeStep;
    }

    /** Set the world gravity. */
    public setGravity(gravity: Vec3Like, worldPosition?: Vec3Like): void {
        if (this.world) {
            setPhysicsGravity(this.world, gravity, worldPosition);
        }
    }

    /**
     * Manual single-step entry point. Babylon Lite drives world stepping
     * internally (once per rendered frame, via the scene's before-render hook),
     * so calling this directly is unsupported — use {@link Scene.enablePhysics}.
     */
    public executeStep(): never {
        return unsupported("HavokPlugin.executeStep", "Babylon Lite advances the world internally each frame; manual stepping is not supported.");
    }

    /** Release the native physics world. */
    public dispose(): void {
        if (this.world) {
            disposePhysics(this.world);
            this.world = null;
        }
    }

    /**
     * @internal Create the native Lite world for `liteScene` and select the step mode.
     *
     * Lite's native physics already steps a world by the live per-frame delta when it has no fixed
     * step (`createHavokWorld` leaves `_fixedDeltaMs === 0`), clamping to a tunnelling ceiling — which
     * is exactly Babylon.js's `useDeltaForWorldStep` behaviour. So delta stepping needs nothing extra
     * here; only the legacy fixed-step mode pins the world to {@link _fixedTimeStep}. The step is
     * driven from inside the world's own per-frame callback, so it is torn down together with the
     * world in {@link dispose} — nothing lingers on the scene after disposal.
     */
    public _attachToLiteScene(liteScene: SceneContext, gravity?: Vec3Like): void {
        if (!this._supported) {
            return unsupported("HavokPlugin", "The Havok module is not ready. `await HavokPhysics()` before constructing the plugin.");
        }
        this.world = createHavokWorld(liteScene, this._hknp, gravity);
        if (!this._useDeltaForWorldStep) {
            setPhysicsTimestep(this.world, this._fixedTimeStep);
        }
    }
}

// ─── PhysicsEngine (V2) ──────────────────────────────────────────────

/**
 * Babylon.js-shaped Physics V2 engine wrapper returned by
 * {@link Scene.getPhysicsEngine}. Holds the active {@link HavokPlugin} and the
 * world gravity, exposing the common Babylon.js `IPhysicsEngine` surface.
 */
export class PhysicsEngine {
    /** @internal */
    private readonly _plugin: HavokPlugin;

    /** Current world gravity. */
    public gravity: Vec3Like;

    public constructor(plugin: HavokPlugin, gravity: Vec3Like) {
        this._plugin = plugin;
        this.gravity = gravity;
    }

    /** The underlying physics plugin. */
    public getPhysicsPlugin(): HavokPlugin {
        return this._plugin;
    }

    /** Physics engine plugin version (Havok is V2). */
    public getPluginVersion(): number {
        return this._plugin.getPluginVersion();
    }

    /** Set the world gravity. */
    public setGravity(gravity: Vec3Like): void {
        this.gravity = gravity;
        this._plugin.setGravity(gravity);
    }

    /** Set the fixed timestep. */
    public setTimeStep(newTimeStep: number): void {
        this._plugin.setTimeStep(newTimeStep);
    }

    /** Get the fixed timestep. */
    public getTimeStep(): number {
        return this._plugin.getTimeStep();
    }

    /** Release the underlying physics world. */
    public dispose(): void {
        this._plugin.dispose();
    }
}
