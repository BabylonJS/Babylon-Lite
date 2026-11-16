import type { RenderTask } from "../frame-graph/render-task.js";
import type { Mesh } from "../mesh/mesh.js";

/** @internal Drop internal shadow-task meshes with one stable compaction and batch re-selection.
 *  These tasks never install `enableRenderTaskMeshRefresh`, so their `_removeMesh` hook is not called. */
export function _dropTaskMeshes(task: RenderTask, drop: ReadonlySet<Mesh | undefined>): void {
    let removed = false;
    const prune = <T>(list: T[], meshOf: (entry: T) => Mesh | undefined, onDrop?: (entry: T) => void): void => {
        let kept = 0;
        for (const entry of list) {
            if (drop.has(meshOf(entry))) {
                onDrop?.(entry);
                removed = true;
            } else {
                list[kept++] = entry;
            }
        }
        list.length = kept;
    };
    prune(task._pendingMeshes ?? [], (request) => request.mesh);
    // A frame still in flight may reference the dropped packet.
    prune(
        task._renderables,
        (renderable) => renderable.mesh,
        (renderable) => task._retireRenderable?.(task.engine, renderable)
    );
    for (const bindings of [task._opaqueBindings, task._directBindings, task._transparentBindings]) {
        prune(bindings, (binding) => binding.renderable.mesh);
    }
    if (removed) {
        const previous = task._batchState;
        task._batchState = previous?._select([task._opaqueBindings, task._directBindings, task._transparentBindings]);
        previous?._release(task.engine, [task._batchState]);
        task._ob.length = 0;
        task._lastVersion = -1;
    }
}
