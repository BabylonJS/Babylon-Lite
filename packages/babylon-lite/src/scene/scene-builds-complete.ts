import type { SceneContext } from "./scene-core.js";
import { processMaterialSwaps } from "./scene-material-swap.js";

/**
 * Resolves once the scene has no runtime builds left.
 *
 * Meshes added, or given a material, after `registerScene()` are built asynchronously when they
 * need a material group or pipeline variant the scene has not built yet, and appear in a later
 * frame. A scene that renders on demand can await this and then render again (or take a
 * screenshot) so those meshes are not missing.
 *
 * Meshes still queued for the next frame are handed to the build here, so no frame has to be
 * rendered first. Builds started while waiting are waited for too. A failed build does not reject:
 * as with continuous rendering, its error is thrown from the next rendered frame.
 *
 * Before the scene is registered there are no runtime builds and this resolves immediately; await
 * `registerScene()` for the initial build.
 */
export async function whenSceneBuildsComplete(scene: SceneContext): Promise<void> {
    let drain: Promise<void> | undefined;
    for (;;) {
        if (scene._z) {
            return;
        }
        if (scene._built && scene._materialSwapQueue.length) {
            // Returns early (leaving the queue) while an exclusive build is running; the next pass retries.
            void processMaterialSwaps(scene);
        }
        const next = scene._swapDrain;
        const inFlight = scene._runtimeBuilds?.inFlight() ?? [];
        if (next === drain && !inFlight.length) {
            return;
        }
        drain = next;
        await Promise.allSettled([next, ...inFlight]);
    }
}
