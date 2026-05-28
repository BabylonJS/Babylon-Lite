import type { EngineContextInternal } from "../engine/engine.js";
import type { MatrixAllocator } from "../math/_matrix-allocator.js";
import type { SceneContextOptions } from "./scene-core.js";

/** @internal Per-scene captured matrix-precision policy.
 *  In M0 this is a pure mirror of the engine policy. M1 will extend the
 *  resolver to enforce `useFloatingOrigin → useHighPrecisionMatrix` coupling
 *  without restructuring the call sites. */
export interface ScenePrecisionPolicy {
    readonly useHighPrecisionMatrix: boolean;
    readonly storageKind: "f32" | "f64";
    /** @internal Allocator inherited from the engine — shared across all scenes on the same engine. */
    readonly allocator: MatrixAllocator;
}

/** @internal Resolve a scene's matrix policy from its owning engine.
 *  M0: pure mirror. The structural seam exists so M1 can layer floating-origin
 *  validation here without touching `createSceneContext`. */
export function resolveScenePrecisionPolicy(engine: EngineContextInternal, _sceneOptions: SceneContextOptions): ScenePrecisionPolicy {
    const allocator = engine._matrixPolicy;
    return {
        useHighPrecisionMatrix: allocator.storageKind === "f64",
        storageKind: allocator.storageKind,
        allocator,
    };
}
