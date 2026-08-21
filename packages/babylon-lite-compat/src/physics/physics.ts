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
    createHavokWorld,
    createPhysicsAggregate,
    createPhysicsBody,
    createPhysicsShape,
    disposePhysics,
    getPhysicsBodyAngularVelocity,
    getPhysicsBodyLinearVelocity,
    PhysicsMotionType as LitePhysicsMotionType,
    PhysicsPrestepType as LitePhysicsPrestepType,
    PhysicsShapeType as LitePhysicsShapeType,
    releasePhysicsShape,
    removePhysicsBody,
    setPhysicsBodyAngularVelocity,
    setPhysicsBodyLinearVelocity,
    setPhysicsBodyMassProperties,
    setPhysicsBodyMotionType,
    setPhysicsBodyPreStep,
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
    Mesh as LiteMesh,
    PhysicsBody as LitePhysicsBody,
    PhysicsMassProperties,
    PhysicsShape as LitePhysicsShape,
    PhysicsShapeParameters,
    PhysicsWorld,
    SceneContext,
} from "babylon-lite";

import { unsupported } from "../error.js";
import { Vector3 } from "../math/vector.js";
import type { Mesh, TransformNode } from "../meshes/meshes.js";
import type { Scene } from "../scene/scene.js";

/** Minimal `{x, y, z}` view shared by the compat `Vector3` and Lite's `Vec3`. */
interface Vec3Like {
    x: number;
    y: number;
    z: number;
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

/** Babylon.js-shaped collision shape backed by a Babylon Lite physics shape. */
export class PhysicsShape {
    /** @internal */
    public readonly _lite!: LitePhysicsShape;
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
    public static _fromLite(shape: LitePhysicsShape, world: PhysicsWorld): PhysicsShape {
        const wrapper = Object.create(PhysicsShape.prototype) as PhysicsShape;
        Object.defineProperties(wrapper, {
            _lite: { value: shape, enumerable: true },
            _world: { value: world },
            _material: { value: {}, writable: true },
            _membershipMask: { value: 0xffffffff, writable: true },
            _collideMask: { value: 0xffffffff, writable: true },
            _isTrigger: { value: false, writable: true },
            _disposed: { value: false, writable: true },
        });
        return wrapper;
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
        setPhysicsShapeMaterial(this._world, this._lite, value.friction ?? 0.2, value.restitution ?? 0.2);
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
            releasePhysicsShape(this._world, this._lite);
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
    public readonly transformNode: TransformNode;
    public disableSync = false;
    public readonly startAsleep: boolean;

    public constructor(transformNode: TransformNode, motionType: PhysicsMotionType, startsAsleep: boolean, scene: Scene) {
        this.transformNode = transformNode;
        this.startAsleep = startsAsleep;
        this._world = requirePhysicsWorld(scene);
        this._lite = createPhysicsBody(this._world, transformNode._node, liteMotionType(motionType), startsAsleep);
    }

    /** @internal */
    public static _fromLite(body: LitePhysicsBody, transformNode: TransformNode, world: PhysicsWorld, startsAsleep = false): PhysicsBody {
        const wrapper = Object.create(PhysicsBody.prototype) as PhysicsBody;
        Object.defineProperties(wrapper, {
            _lite: { value: body, enumerable: true },
            _world: { value: world },
            _shape: { value: null, writable: true },
            _disposed: { value: false, writable: true },
            transformNode: { value: transformNode, enumerable: true },
            disableSync: { value: false, writable: true, enumerable: true },
            startAsleep: { value: startsAsleep, enumerable: true },
        });
        return wrapper;
    }

    public getClassName(): string {
        return "PhysicsBody";
    }

    public get disablePreStep(): boolean {
        return !this._lite._preStep;
    }
    public set disablePreStep(value: boolean) {
        setPhysicsBodyPreStep(this._lite, !value);
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
        result.copyFrom(this.getLinearVelocity());
    }
    public setAngularVelocity(value: Vec3Like): void {
        setPhysicsBodyAngularVelocity(this._world, this._lite, value);
    }
    public getAngularVelocity(): Vector3 {
        const value = getPhysicsBodyAngularVelocity(this._world, this._lite);
        return new Vector3(value.x, value.y, value.z);
    }
    public getAngularVelocityToRef(result: Vector3): void {
        result.copyFrom(this.getAngularVelocity());
    }
    public applyImpulse(impulse: Vec3Like, location: Vec3Like): void {
        applyPhysicsBodyImpulse(this._lite, impulse, location);
    }
    public applyForce(force: Vec3Like, location: Vec3Like): void {
        applyPhysicsBodyForce(this._world, this._lite, force, location);
    }

    public dispose(): void {
        if (!this._disposed) {
            removePhysicsBody(this._world, this._lite);
            this._disposed = true;
        }
    }

    /** @internal */
    public _adoptShape(shape: PhysicsShape): void {
        this._shape = shape;
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

    public constructor(transformNode: TransformNode, type: PhysicsShapeType | PhysicsShape, options: PhysicsAggregateParameters = { mass: 0 }, scene?: Scene) {
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
        this.material = { friction: options.friction ?? 0.2, restitution: options.restitution ?? 0.2 };
        this.shape = suppliedShape ?? PhysicsShape._fromLite(aggregate.shape, world);
        this.shape.material = this.material;
        this.shape.isTrigger = options.isTriggerShape ?? false;
        this.body = PhysicsBody._fromLite(aggregate.body, transformNode, world, options.startAsleep);
        this.body._adoptShape(this.shape);
    }

    public dispose(): void {
        if (!this._disposed) {
            this.body.dispose();
            if (this._disposeShapeWhenDisposed) {
                this.shape.dispose();
            }
            this._disposed = true;
        }
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
