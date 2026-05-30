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
    if (fns) {
        for (const fn of fns) {
            fn();
        }
        sc._meshDisposables.delete(mesh);
    }
    const mi2 = scene.meshes.indexOf(mesh);
    if (mi2 >= 0) {
        scene.meshes.splice(mi2, 1);
    }
    const i = sc._renderables.findIndex((r) => r.mesh === mesh);
    if (i >= 0) {
        sc._renderables.splice(i, 1);
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
