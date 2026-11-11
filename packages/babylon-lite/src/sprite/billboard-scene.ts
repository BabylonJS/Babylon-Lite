import type { SceneContext } from "../scene/scene-core.js";
import type { EngineContext } from "../engine/engine.js";
import type { Renderable } from "../render/renderable.js";
import { _addSceneRenderable, _getSceneRenderables, _observeSceneRenderables, _removeSceneRenderable } from "../scene/scene-renderable-collection.js";
import type { SceneRenderableChangeListener } from "../scene/scene-renderable-collection.js";
import type { BillboardSpriteSystem } from "./billboard-sprite.js";
import type { buildBillboardRenderable } from "./billboard-renderable.js";
import { registerPickSource } from "../picking/pick-contributor.js";

/** @internal Builds a billboard system's scene renderable from the lazily imported base builder. */
export type BillboardRenderableBuilder = (engine: EngineContext, buildBase: typeof buildBillboardRenderable) => { renderable: Renderable; dispose: () => void };

/** @internal Add a billboard system to the scene's billboard collection, building its renderable with `build`.
 *  Lets feature variants (particle blend passes) share billboard membership, picking, removal and discovery. */
export function _addBillboardSystemToScene(scene: SceneContext, system: BillboardSpriteSystem, build: BillboardRenderableBuilder): void {
    const entry = _addSceneRenderable(scene, "billboard", system, async (engine) => {
        const { buildBillboardRenderable } = await import("./billboard-renderable.js");
        const built = build(engine, buildBillboardRenderable);
        return { _renderable: built.renderable, _detach: () => built.dispose };
    });
    if (entry) {
        // Pickability is pure data plus a dynamic-import thunk, so rendering pulls no pick-pipeline bytes; the
        // picker builds the contributor on the first pick.
        entry._unregister = registerPickSource(scene, system, () => import("../picking/billboard-pick-pipeline.js"));
    }
}

/**
 * Adds a billboard sprite system (camera-facing or axis-locked) to the scene so it is rendered each frame and
 * pickable. Adding a member again does nothing.
 */
export function addBillboardSystemToScene(scene: SceneContext, system: BillboardSpriteSystem): void {
    _addBillboardSystemToScene(scene, system, (engine, buildBase) => buildBase(engine, system));
}

/**
 * Removes a billboard sprite system from the scene. It stops drawing and being pickable immediately; its
 * scene-built GPU resources are released once in-flight frames finish. Returns `false` when the system was not
 * in the scene.
 */
export function removeBillboardSystemFromScene(scene: SceneContext, system: BillboardSpriteSystem): boolean {
    return _removeSceneRenderable(scene, "billboard", system);
}

/** Returns a snapshot of the scene's billboard sprite systems, in add order. */
export function getSceneBillboardSystems(scene: SceneContext): readonly BillboardSpriteSystem[] {
    return _getSceneRenderables(scene, "billboard");
}

/** Subscribes to the scene's billboard sprite system membership changes. The returned callback unsubscribes (idempotent). */
export function onSceneBillboardSystemsChanged(scene: SceneContext, listener: SceneRenderableChangeListener<BillboardSpriteSystem>): () => void {
    return _observeSceneRenderables(scene, "billboard", listener);
}
