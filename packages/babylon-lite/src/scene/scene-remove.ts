import type { SceneContext, SceneContextInternal } from "./scene-core.js";
import type { Mesh } from "../mesh/mesh.js";
import { disposeMeshGpu } from "../mesh/mesh-dispose.js";
import { removeMeshFromTask } from "../frame-graph/render-pass-task.js";
import type { RenderPassTask } from "../frame-graph/render-pass-task.js";

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
    // Frame-graph eviction: the scene always has a frame graph (created in
    // createSceneContext). Walk its render-pass tasks and drop any binding whose
    // source mesh matches. Tasks identified by having a `_config` field
    // (RenderPassTask shape).
    for (const task of sc._frameGraph._tasks) {
        if ("_config" in (task as object)) {
            removeMeshFromTask(task as RenderPassTask, mesh);
        }
    }
    disposeMeshGpu(mesh);
}
