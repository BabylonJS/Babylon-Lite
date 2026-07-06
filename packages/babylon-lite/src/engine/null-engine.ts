import type { EngineContext } from "./engine.js";
import type { SceneContext } from "../scene/scene-core.js";

/**
 * Options for {@link createNullEngine}.
 */
export interface NullEngineOptions {
    /**
     * Reserved for future headless-driver options (e.g. variable-timestep control). No options are
     * consumed today; the property exists only to keep the option-bag shape stable and forbids
     * passing unknown fields.
     */
    reserved?: never;
}

/**
 * Create a **null engine** — a device-less, surface-less {@link EngineContext} that runs the
 * simulation half of Babylon Lite (physics stepping, animation evaluation, `onBeforeRender`
 * callbacks, transform updates) **without any GPU device or canvas**.
 *
 * This is the Babylon Lite analogue of Babylon.js `NullEngine`: it lets a scene be driven
 * headlessly on a server (plain Node, Deno, a Web Worker, a CI job) so you can run e.g. a Havok
 * physics simulation and read back body transforms with zero rendering.
 *
 * ### What works
 * - `createSceneContext(engine, { defaultRenderTask: false })` — a scene with **no** frame-graph
 *   render task (so no swapchain / GPU resources are ever built).
 * - `onBeforeRender(scene, cb)` callbacks (physics `createHavokWorld` registers its step this way).
 * - `stepScene(engine, scene, deltaMs)` to advance one fixed step (replaces the browser
 *   `requestAnimationFrame` loop that `startEngine` uses).
 * - Physics with **primitive** collider shapes (box/sphere/capsule/cylinder) whose geometry is
 *   given explicitly or derived from `mesh.boundMin`/`boundMax`.
 *
 * ### What is NOT supported (throws or is undefined behaviour)
 * - Any rendering: `startEngine`, `renderFrame`, `captureScreenshot`, adding meshes **with
 *   materials** (their deferred GPU builders dereference the absent `_device`), surfaces, RTTs.
 * - Mesh/convex-hull colliders that require `node.worldMatrix` (needs the render-side world-matrix
 *   pass). This is a follow-up.
 * - High-precision / floating-origin matrices (they need the F64 allocator that `createEngine`
 *   installs). This is a follow-up.
 *
 * @remarks
 * The returned object is deliberately a **partial** {@link EngineContext}: only the fields the
 * device-less simulation/update path reads are populated (`_device` is intentionally absent). The
 * single localized cast below is the whole cost of not yet splitting `EngineContext` from its
 * mandatory `_device`/`SurfaceContext` members — a larger, separate refactor. Every rendering code
 * path is unreachable on a null engine, so the missing GPU fields are never dereferenced.
 *
 * @example
 * ```ts
 * import { createNullEngine, stepScene } from "babylon-lite";
 * import { createSceneContext, onBeforeRender } from "babylon-lite";
 *
 * const engine = createNullEngine();
 * const scene = createSceneContext(engine, { defaultRenderTask: false });
 *
 * // e.g. real Havok physics — createHavokWorld registers its step via onBeforeRender
 * // const world = createHavokWorld(scene, await HavokPhysics());
 *
 * const stepMs = 1000 / 60;
 * for (let i = 0; i < 180; i++) stepScene(engine, scene, stepMs); // 3s, no rendering
 * ```
 */
export function createNullEngine(_options?: NullEngineOptions): EngineContext {
    // Populate only the fields the device-less simulation + update loop reads. GPU/surface
    // members (`_device`, `_context`, `scRT`, `canvas`, `format`, …) are intentionally omitted:
    // the null engine never enters a rendering code path, so they are never dereferenced.
    const engine: Partial<EngineContext> = {
        useHighPrecisionMatrix: false,
        useFloatingOrigin: false,
        drawCallCount: 0,
        gpuFrameTimeMs: 0,
        _animFrameId: 0,
        _renderFn: null,
        _currentDelta: 0,
        _cbs: [],
    };
    // The engine IS its own primary surface (EngineContext extends SurfaceContext), matching the
    // real `createEngine` self-reference — scene binding reads `surface.engine`. `engine` and
    // `surfaces` are `readonly` on the public type, so we write them through a mutable view (the
    // same technique `createEngine` uses to seed the self-referential primary surface).
    (engine as { engine: EngineContext }).engine = engine as EngineContext;
    const surfaces = [engine as EngineContext] as [EngineContext];
    (engine as { surfaces: unknown }).surfaces = surfaces;
    engine._surfaces = surfaces;
    return engine as EngineContext;
}

/**
 * Advance one fixed simulation step of a headless scene created against a {@link createNullEngine}
 * engine. This is the server-side replacement for the `requestAnimationFrame` loop that
 * `startEngine` runs in the browser.
 *
 * It sets the frame delta and runs the scene's per-frame update, which fires all
 * `onBeforeRender(scene, …)` callbacks (physics step, animation evaluation, user logic). It does
 * **not** record or submit any GPU work.
 *
 * @param engine - A null engine from {@link createNullEngine}.
 * @param scene - A scene created with `createSceneContext(engine, { defaultRenderTask: false })`.
 * @param deltaMs - The fixed timestep for this step, in milliseconds (e.g. `1000 / 60`).
 */
export function stepScene(engine: EngineContext, scene: SceneContext, deltaMs: number): void {
    engine._currentDelta = deltaMs;
    scene._update();
}

/**
 * Convenience driver: advance a headless scene by a fixed number of steps at a fixed timestep.
 * Equivalent to calling {@link stepScene} `steps` times.
 *
 * @param engine - A null engine from {@link createNullEngine}.
 * @param scene - A scene created with `createSceneContext(engine, { defaultRenderTask: false })`.
 * @param steps - Number of fixed steps to advance.
 * @param deltaMs - The fixed timestep per step, in milliseconds (default `1000 / 60`).
 */
export function runHeadlessSteps(engine: EngineContext, scene: SceneContext, steps: number, deltaMs = 1000 / 60): void {
    for (let i = 0; i < steps; i++) {
        stepScene(engine, scene, deltaMs);
    }
}
