import type { Mesh } from "../mesh/mesh.js";
import { _rebindRenderTask, type RenderTask } from "./render-task.js";
import { appendTaskMesh, type TaskMeshEntry } from "./render-task-transaction.js";

/** Opt an `autoMirror: false` render task into following runtime geometry and material rebuilds
 *  for scene-owned meshes added without a per-task material override. Must be enabled before
 *  recording. Auxiliary ownership and failure atomicity use the base task's transaction. */
export function enableRenderTaskMeshRefresh(task: RenderTask): void {
    if (task._prepareTaskMeshes) {
        return;
    }
    if (task._recorded) {
        throw new Error("enableRenderTaskMeshRefresh must be called before the render task is recorded.");
    }
    if (task._config.autoMirror !== false) {
        throw new Error("enableRenderTaskMeshRefresh requires an explicit render task with autoMirror: false.");
    }
    const tracked: Mesh[] = [];
    const entries = new WeakSet<TaskMeshEntry>();
    const addMesh = task.addMesh.bind(task);
    const record = task.record.bind(task);
    const execute = task.execute?.bind(task);
    const removeMesh = task._removeMesh?.bind(task);
    const dispose = task.dispose.bind(task);
    let dirty = task._pendingMeshes.length > 0;

    task._prepareTaskMeshes = (candidate): void => {
        const replaced = new Set((candidate._meshEntries ?? []).filter((entry) => entries.has(entry)).map((entry) => entry.renderable));
        candidate._renderables = candidate._renderables.filter((renderable) => !replaced.has(renderable));
        candidate._meshEntries = candidate._meshEntries?.filter((entry) => !entries.has(entry));
        for (const mesh of tracked) {
            entries.add(appendTaskMesh(candidate, mesh));
        }
    };
    task.addMesh = (mesh, options): void => {
        if (task._disposed) {
            throw new Error("RenderTask has been disposed.");
        }
        if (options?.material) {
            dirty = true;
            addMesh(mesh, options);
        } else {
            if (!mesh.material || tracked.includes(mesh)) {
                return;
            }
            tracked.push(mesh);
            dirty = true;
            if (task._recorded) {
                _rebindRenderTask(task, true);
            }
        }
        if (task._recorded) {
            dirty = false;
        }
    };
    task.record = (): void => {
        record();
        dirty = false;
    };
    if (execute) {
        task.execute = (): number => {
            if (dirty || ((tracked.length || task._meshEntries?.length) && task._lastVersion !== task.scene._renderableVersion)) {
                _rebindRenderTask(task);
                dirty = false;
            }
            return execute();
        };
    }
    task._removeMesh = (mesh): void => {
        removeMesh?.(mesh);
        const index = tracked.indexOf(mesh as Mesh);
        if (index >= 0) {
            tracked.splice(index, 1);
        }
        dirty = true;
    };
    task.dispose = (): void => {
        tracked.length = 0;
        dirty = false;
        dispose();
    };
}
