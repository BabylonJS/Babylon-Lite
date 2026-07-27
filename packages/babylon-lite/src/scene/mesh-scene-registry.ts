import type { Mesh } from "../mesh/mesh.js";
import { retainMeshGpu } from "../mesh/mesh-dispose.js";
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
 *  in several scenes at once. The queue is drained synchronously each frame by the render loop
 *  (`processMaterialSwaps`), so the rebuilt renderable is present the SAME frame the old one is
 *  removed — no one-frame missing-mesh flash on the first swap (e.g. re-tinting a wall). */
export function enqueueMaterialSwap(scene: SceneContext, mesh: Mesh): void {
    if (scene._materialSwapQueue.includes(mesh)) {
        return;
    }
    scene._materialSwapQueue.push(mesh);
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
    // A mesh that already released its claim is being added back. Take a fresh one: a mesh registered
    // in any scene must always own its shared GPU resources, or a sibling clone's removal would see
    // itself as the last owner and destroy buffers this mesh is still rendering with.
    if (_meshGpuFreed?.delete(mesh)) {
        retainMeshGpu(mesh);
    }
}

/** Per-mesh disposal-claim generation. Each claim mints the next value, so only the most recent
 *  claim can still redeem. Lazily allocated, kept off the `Mesh` object like `_meshScenes`
 *  (pillar 4b). */
let _meshDisposeGen: WeakMap<Mesh, number> | null = null;

/** Meshes that have released their claim on the shared GPU resources. A `Mesh` owns exactly ONE
 *  claim while it belongs to at least one scene — taken when it is created, by `retain` when it is
 *  cloned, and re-taken by `registerMeshScene` if it is added back after a removal (see
 *  `resource/ref-count.ts`). Tracking the released state keeps the release one-shot per claim, so a
 *  repeat `removeFromScene` cannot decrement a second time and destroy buffers a sibling clone is
 *  still rendering with. */
let _meshGpuFreed: WeakSet<Mesh> | null = null;

/** @internal Deregister `scene` from `mesh` and, when that leaves the mesh orphaned, claim the right
 *  to free its shared GPU buffers. Returns a non-zero token to hand to {@link consumeMeshGpuDisposal},
 *  or `0` when the mesh still belongs to another scene.
 *
 *  A claim rather than a plain "is it orphaned?" boolean, because the free is retired to after the
 *  next frame submit. Between the claim and the retirement the mesh may be removed again, re-added,
 *  or the whole scene disposed; a boolean cannot tell those apart and would free the same buffers
 *  twice (`release` in `resource/ref-count.ts` reports "last owner" on every call once the count is
 *  undefined or 1, so a double free is silent and destroys buffers a sibling clone still renders
 *  with). Each claim SUPERSEDES the previous one rather than being refused, so an unredeemed claim —
 *  e.g. one whose retirement was dropped by `discardGpuResourceRetirements` during device-lost
 *  recovery — cannot wedge the mesh and block every later free. An untracked mesh (never registered)
 *  still yields a claim, so its buffers are released as before. */
export function claimMeshGpuDisposal(scene: SceneContext, mesh: Mesh): number {
    const scenes = _meshScenes?.get(mesh);
    if (scenes) {
        scenes.delete(scene);
        if (scenes.size > 0) {
            return 0;
        }
    }
    // Already released by an earlier removal — `removeFromScene` is idempotent, and freeing twice
    // would drop a clone-shared resource's ref count to zero and destroy live buffers.
    if (_meshGpuFreed?.has(mesh)) {
        return 0;
    }
    const gens = (_meshDisposeGen ??= new WeakMap());
    const token = (gens.get(mesh) ?? 0) + 1;
    gens.set(mesh, token);
    return token;
}

/** @internal Redeem a token from {@link claimMeshGpuDisposal}: `true` means "free the mesh's shared
 *  GPU buffers now". Only the most recent claim qualifies, so when several removals race a single
 *  drain exactly one of them frees. And only while the mesh is STILL orphaned — it may have been
 *  re-added since the claim, in which case the buffers are live again and must not be freed. */
export function consumeMeshGpuDisposal(mesh: Mesh, token: number): boolean {
    if (_meshDisposeGen?.get(mesh) !== token || _meshScenes?.get(mesh)?.size) {
        return false;
    }
    (_meshGpuFreed ??= new WeakSet()).add(mesh);
    return true;
}
