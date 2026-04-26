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
    const innerMap = sc._meshRenderable.get(mesh);
    if (innerMap) {
        for (const r of innerMap.values()) {
            const idx = sc._renderables.indexOf(r);
            if (idx >= 0) {
                sc._renderables.splice(idx, 1);
            }
        }
    }
    sc._meshRenderable.delete(mesh);
    for (const task of sc._frameGraph._tasks) {
        if ("renderTarget" in task) {
            removeMeshFromTask(task as RenderPassTask, mesh);
        }
    }
    disposeMeshGpu(mesh);
}
