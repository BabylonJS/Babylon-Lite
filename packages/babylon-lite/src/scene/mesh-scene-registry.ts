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
let _meshRetained: ((mesh: Mesh, engine?: SceneContext["surface"]["engine"]) => boolean) | undefined;
let _retainMaterial: ((mesh: Mesh, material: Mesh["material"]) => void) | undefined;

/** @internal Opt-in ownership seam; absent when mesh retention is tree-shaken. */
export function installMeshRetention(retained: NonNullable<typeof _meshRetained>, material: NonNullable<typeof _retainMaterial>): void {
    _meshRetained = retained;
    _retainMaterial = material;
}

/** @internal Whether no scene or explicit retention owns this mesh. */
export function isMeshUnowned(mesh: Mesh): boolean {
    return !_meshScenes?.get(mesh)?.size && !_meshRetained?.(mesh);
}

/** @internal Whether an explicit owner still pins the mesh's resource claim. */
export function hasMeshRetention(mesh: Mesh): boolean {
    return !!_meshRetained?.(mesh);
}

/** @internal Constant-time per-scene mesh membership. */
export function hasMeshScene(scene: SceneContext, mesh: Mesh): boolean {
    return !!_meshScenes?.get(mesh)?.has(scene);
}

/** @internal Existing scene engine, for retention ownership validation. */
export function meshSceneEngine(mesh: Mesh): SceneContext["surface"]["engine"] | undefined {
    let engine: SceneContext["surface"]["engine"] | undefined;
    for (const scene of _meshScenes?.get(mesh) ?? []) {
        if (engine && engine !== scene.surface.engine) {
            throw new Error(`Mesh "${mesh.name}" belongs to scenes on different engines and cannot be retained.`);
        }
        engine = scene.surface.engine;
    }
    return engine;
}

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

/** Queue a mesh's renderable for rebuild in every scene that owns it.
 *  Use after changing renderable-affecting mesh state that is not observable through
 *  the material setter, such as primitive topology or replaced GPU geometry buffers. */
export function markMeshRenderableDirty(mesh: Mesh): void {
    const scenes = _meshScenes?.get(mesh);
    if (!scenes) {
        return;
    }
    for (const scene of scenes) {
        enqueueMaterialSwap(scene, mesh);
    }
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
                _retainMaterial?.(mesh, v);
                _mat = v;
                // Registration creates the record before this setter; live mesh records are never deleted.
                for (const scene of _meshScenes!.get(mesh)!) {
                    enqueueMaterialSwap(scene, mesh);
                    scene._meshMaterialChange?.(mesh, v);
                }
            }
        },
        configurable: true,
        enumerable: true,
    });
}

/** @internal Observe material reassignment even before the first scene admission. */
export function observeMeshMaterial(mesh: Mesh): Set<SceneContext> {
    const map = (_meshScenes ??= new WeakMap());
    let scenes = map.get(mesh);
    if (!scenes) {
        map.set(mesh, (scenes = new Set()));
        installMaterialSetter(mesh);
    }
    return scenes;
}

/** @internal Register `scene` as an owner of `mesh`. Installs the material setter on the mesh's
 *  first registration only (re-adds just grow the subscriber set, reusing the one setter).
 *
 *  Throws when the mesh was already disposed — leaving its last scene (or disposing that scene)
 *  releases every claim it held on its shared GPU resources, destroying the ones it was the last
 *  owner of. Lite never resurrects them, so a re-add would draw with dead handles (sole owner) or
 *  release a claim it no longer holds and free buffers a sibling still uses (shared owner). Both
 *  are silent corruption, so the failure is made loud here. */
export function registerMeshScene(scene: SceneContext, mesh: Mesh): void {
    if (mesh._disposed) {
        throw new Error(`Mesh "${mesh.name}" cannot be added: it was disposed. Create a new mesh instead.`);
    }
    _meshRetained?.(mesh, scene.surface.engine);
    _retainMaterial?.(mesh, mesh.material);
    // Keep ordinary admission inline so optional pre-admission observation adds no bundle cost.
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
        return !_meshRetained?.(mesh);
    }
    scenes.delete(scene);
    return scenes.size === 0 && !_meshRetained?.(mesh);
}
