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

import { createHavokWorld, setPhysicsTimestep, setPhysicsGravity, disposePhysics } from "babylon-lite";
import type { PhysicsWorld, SceneContext } from "babylon-lite";

import { unsupported } from "../error.js";

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
