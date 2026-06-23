import type { Mesh } from "../mesh/mesh.js";
import type { SceneContext } from "./scene-core.js";

/** Per-mesh set of scenes the mesh currently belongs to. Kept OFF the `Mesh` data object
 *  (pillar 4b: a mesh never references the scene) in a lazily-allocated WeakMap (pillar 4:
 *  no module-level side effects). A single `Mesh` instance may live in several scenes (e.g.
 *  multi-canvas `SurfaceContext` rendering), so this set is the one source of truth for both:
 *    1. material-swap notification — the `mesh.material` setter rebuilds the renderable in
 *       EVERY subscribed scene, not just the one it was first added to; and
 *    2. GPU-buffer ref-counting — `disposeMeshGpu` (which frees the mesh's SHARED geometry/
 *       skeleton/morph/thin-instance buffers) only runs on the LAST scene removal.
 *
 *  This is a small cohesive module owning the registry so both `scene-core` (register on add)
 *  and `scene-remove` (unregister + ref-count on remove) import it directly, rather than
 *  `scene-remove` reaching back into `scene-core`. (This is organizational only — the package
 *  is side-effect-free, so symbol-level tree-shaking applies regardless of file boundaries.) */
let _meshScenes: WeakMap<Mesh, Set<SceneContext>> | null = null;

/** @internal Kick the lazy load of the material-swap processor (a separate, always-shipped
 *  chunk) so `scene._processSwaps` is set before the per-frame drain needs it. The import is
 *  async, so the FIRST swap in a scene's life would otherwise be dropped for one frame — the
 *  drain (`ctx._processSwaps?.(ctx)`) is a no-op until the chunk resolves, while a paired
 *  synchronous `removeFromScene` of the old mesh has already taken effect. That one-frame gap
 *  is the "first edit makes the mesh blink out" bug. Warmed eagerly at scene build (boot), it
 *  has resolved long before any runtime add/material-swap, so the drain runs synchronously. */
export function warmMaterialSwaps(scene: SceneContext): void {
    if (scene._processSwaps) {
        return;
    }
    void import("./scene-material-swap.js").then((m) => {
        scene._processSwaps = m.processMaterialSwaps;
    });
}

/** @internal Queue a mesh for renderable (re)build on the next frame's material-swap drain.
 *  Shared by the material setter (runtime material change) and addToScene (runtime mesh add).
 *  Dedup is per-(scene, mesh) via swap-queue membership — a single shared mesh may be queued
 *  in several scenes at once. The processor is normally warmed at scene build; warm again here
 *  as a fallback for the (rare) first mutation on a scene that skipped the build warm-up. */
export function enqueueMaterialSwap(scene: SceneContext, mesh: Mesh): void {
    if (scene._materialSwapQueue.indexOf(mesh) >= 0) {
        return;
    }
    scene._materialSwapQueue.push(mesh);
    warmMaterialSwaps(scene);
}

/** Install a property setter on `mesh.material` that, on reassignment, enqueues a renderable
 *  rebuild in EVERY scene the mesh currently belongs to. Installed exactly once per mesh. The
 *  setter looks the subscriber set up from `_meshScenes` on each write rather than capturing
 *  it, so the mesh's stored property descriptor never closes over any `SceneContext` — keeping
 *  scene references truly off-mesh and avoiding retention of a stale set. */
function installMaterialSetter(mesh: Mesh): void {
    let _mat = mesh.material;
    Object.defineProperty(mesh, "material", {
        get() {
            return _mat;
        },
        set(v) {
            if (v !== _mat) {
                _mat = v;
                const scenes = _meshScenes?.get(mesh);
                if (scenes) {
                    for (const scene of scenes) {
                        enqueueMaterialSwap(scene, mesh);
                    }
                }
            }
        },
        configurable: true,
        enumerable: true,
    });
}

/** @internal Register `scene` as an owner of `mesh`. Installs the material setter on the mesh's
 *  first registration only (re-adds just grow the subscriber set, reusing the one setter). */
export function registerMeshScene(scene: SceneContext, mesh: Mesh): void {
    const map = (_meshScenes ??= new WeakMap());
    let scenes = map.get(mesh);
    if (!scenes) {
        map.set(mesh, (scenes = new Set()));
        installMaterialSetter(mesh);
    }
    scenes.add(scene);
}

/** @internal Deregister `scene` from `mesh`. Returns `true` when the mesh now belongs to NO
 *  scene — the signal that the caller may free the mesh's shared GPU buffers (`disposeMeshGpu`).
 *  An untracked mesh (never registered) also returns `true` so its buffers are still released. */
export function unregisterMeshScene(scene: SceneContext, mesh: Mesh): boolean {
    const scenes = _meshScenes?.get(mesh);
    if (!scenes) {
        return true;
    }
    scenes.delete(scene);
    return scenes.size === 0;
}
