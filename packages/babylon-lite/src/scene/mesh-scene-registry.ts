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

/** @internal Queue a mesh for renderable (re)build on the next frame's material-swap drain.
 *  Shared by the material setter (runtime material change) and addToScene (runtime mesh add).
 *  Dedup is per-(scene, mesh) via swap-queue membership — a single shared mesh may be queued
 *  in several scenes at once.
 *
 *  Enqueuing also INSTALLS the drain (`scene._drainSwaps`) the first time a scene needs one, so
 *  `scene-core` carries no static import of the swap machinery: a scene that never re-materials a
 *  mesh after adding it — the common case — leaves `scene-material-swap.js` out of its bundle
 *  entirely. The very first drain awaits a dynamic import and therefore lands on the next frame;
 *  every later one is the same synchronous call as before, because the loaded implementation
 *  replaces the seam. That first frame still draws the mesh with its PREVIOUS renderable (the old
 *  one is only removed by the drain itself), so there is no missing-mesh flash. */
export function enqueueMaterialSwap(scene: SceneContext, mesh: Mesh): void {
    if (scene._materialSwapQueue.includes(mesh)) {
        return;
    }
    scene._materialSwapQueue.push(mesh);
    scene._drainSwaps ??= loadDrain;
}

/** First-drain seam: fetch the real implementation, put it in place of this stub so subsequent
 *  frames drain synchronously, then run it.
 *
 *  The render loop calls the seam on every frame the queue is non-empty, so the in-flight import is
 *  latched: without it a slow fetch would start a fresh import per frame. A failed import (offline,
 *  chunk 404) clears the latch and leaves the seam installed, so the next frame retries instead of
 *  wedging the scene — and the rejection is handled here rather than escaping the `void` call in
 *  `_update`. */
let _pending: WeakMap<SceneContext, Promise<void>> | null = null;

function loadDrain(scene: SceneContext): Promise<void> {
    const pending = (_pending ??= new WeakMap()).get(scene);
    if (pending) {
        return pending;
    }
    const load = import("./scene-material-swap.js").then(
        async ({ processMaterialSwaps }) => {
            _pending?.delete(scene);
            scene._drainSwaps = processMaterialSwaps;
            await processMaterialSwaps(scene);
        },
        (error: unknown) => {
            _pending?.delete(scene);
            throw error;
        }
    );
    _pending.set(scene, load);
    return load;
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
