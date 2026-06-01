import type { SceneContext, SceneContextInternal } from "./scene-core.js";
import type { Mesh, MeshInternal } from "../mesh/mesh.js";
import { disposeMeshGpu } from "../mesh/mesh-dispose.js";
import { removeMeshFromTask } from "../frame-graph/render-task.js";
import type { RenderTask } from "../frame-graph/render-task.js";

/** Remove a mesh from the scene and destroy its GPU resources.
 *  Standalone function for tree-shaking — only included when actually used. */
export function removeFromScene(scene: SceneContext, mesh: Mesh): void {
    const sc = scene as SceneContextInternal;
    const fns = sc._meshDisposables.get(mesh);
    // Whether this call actually mutated scene state — used to gate the renderable
    // version bump so a no-op removal (mesh never registered) doesn't needlessly
    // invalidate the cached opaque bundle.
    let didMutate = false;
    if (fns) {
        didMutate = true;
        for (const fn of fns) {
            fn();
        }
        sc._meshDisposables.delete(mesh);
    }
    const mi2 = scene.meshes.indexOf(mesh);
    if (mi2 >= 0) {
        scene.meshes.splice(mi2, 1);
        didMutate = true;
    }
    const i = sc._renderables.findIndex((r) => r.mesh === mesh);
    if (i >= 0) {
        sc._renderables.splice(i, 1);
        didMutate = true;
    }
    // Invalidate any auto-mirroring render task so it rebuilds its binding lists +
    // cached opaque bundle without this mesh BEFORE its GPU buffers (vertex data +
    // per-packet system UBO) are touched again. Done whenever the mesh actually
    // belonged to the scene — NOT gated on owning a standalone renderable: meshes
    // sharing a material at the initial scene build are merged into one combined
    // renderable whose `mesh` is undefined, yet their now-destroyed buffers are
    // still referenced by that renderable's update()/draw() and the cached bundle.
    // Mirrors the version bump done on add (material-swap) and initial build.
    if (didMutate) {
        sc._renderableVersion++;
    }
    // Drop from the material group registry so a later full rebuild (e.g. device-lost
    // recovery) doesn't try to re-materialize a disposed mesh.
    const build = mesh.material?._buildGroup;
    const group = build ? sc._groups.get(build) : undefined;
    if (group) {
        const gi = group.indexOf(mesh);
        if (gi >= 0) {
            group.splice(gi, 1);
        }
    }
    // Drop any pending swap-queue entry (mesh added then removed before the drain).
    const qi = sc._materialSwapQueue.indexOf(mesh);
    if (qi >= 0) {
        sc._materialSwapQueue.splice(qi, 1);
    }
    (mesh as MeshInternal)._materialDirty = false;
    // Deregister from the world-matrix push registry so a long-lived parent stops
    // retaining/traversing this disposed child on every invalidation. (The parent→
    // child reference is new with the push model; reparent already deregisters, but
    // removal does not go through the parent setter otherwise.)
    mesh.parent = null;
    // Frame-graph eviction: the scene always has a frame graph (created in
    // createSceneContext). Walk its render-pass tasks and drop any binding whose
    // source mesh matches. Tasks identified by having a `_config` field
    // (RenderTask shape).
    for (const task of sc._frameGraph._tasks) {
        if ("_config" in (task as object)) {
            removeMeshFromTask(task as RenderTask, mesh);
        }
    }
    disposeMeshGpu(mesh);
}
