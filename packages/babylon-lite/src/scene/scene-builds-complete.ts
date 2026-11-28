import type { SceneContext } from "./scene-core.js";
import { processMaterialSwaps } from "./scene-material-swap.js";

/**
 * Resolves once the meshes added to the scene, or given a new material, after `registerScene()`
 * have been built.
 *
 * Such meshes are built asynchronously when they need a material group or pipeline variant the
 * scene has not built yet, and appear in a later frame. A scene that renders on demand can await
 * this and then render again (or take a screenshot) so those meshes are not missing.
 *
 * Meshes still queued for the next frame are handed to the build here, so no frame has to be
 * rendered first. Builds started while waiting are waited for too.
 *
 * Errors do not reject: as with continuous rendering, they are thrown from the next rendered frame.
 * That covers failed builds, a failed load of the runtime build code, and a rebuild that throws
 * while the queue is drained (the mesh then stays queued for the next frame).
 *
 * Explicit rebuild APIs such as `rebuildMaterial()` return their own promise; await it separately.
 * Before the scene is registered this resolves immediately; await `registerScene()` for the initial
 * build.
 */
export async function whenSceneBuildsComplete(scene: SceneContext): Promise<void> {
    let drain: Promise<void> | undefined;
    let drainQueue = true;
    for (;;) {
        if (scene._z) {
            return;
        }
        if (drainQueue && scene._built && scene._materialSwapQueue.length) {
            // Returns early (leaving the queue) while an exclusive build is running; the next pass retries.
            try {
                void processMaterialSwaps(scene);
            } catch {
                // A rebuild threw synchronously. The queue still holds the meshes, so the next frame's drain
                // throws the same error, as with continuous rendering. Draining again here would only repeat it.
                drainQueue = false;
            }
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
