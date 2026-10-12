import type { Mesh } from "../mesh/mesh.js";
import { retireGpuResourceBatch } from "../engine/gpu-resource-retirement.js";
import { _enableTaskMeshPopulation, _rebindRenderTask, type RenderTask } from "./render-task.js";
import type { Renderable } from "../render/renderable.js";

/** Opt an `autoMirror: false` render task into following runtime geometry and material rebuilds
 *  for scene-owned meshes added without a per-task material override. Must be enabled before
 *  recording. Auxiliary ownership and failure atomicity use the base task's transaction. */
export function enableRenderTaskMeshRefresh(task: RenderTask): void {
    if (task._prepareTaskMeshes) {
        return;
    }
    if (task._sceneBG) {
        throw new Error("enableRenderTaskMeshRefresh must be called before the render task is recorded.");
    }
    if (task._config.autoMirror !== false) {
        throw new Error("enableRenderTaskMeshRefresh requires an explicit render task with autoMirror: false.");
    }
    _enableTaskMeshPopulation(task);
    const tracked: Mesh[] = [];
    const owned = new WeakSet<Renderable>();
    const addMesh = task._addMesh!.bind(task);
    const record = task.record.bind(task);
    const execute = task.execute?.bind(task);
    const removeMesh = task._removeMesh?.bind(task);
    const dispose = task.dispose.bind(task);
    let dirty = task._pendingMeshes!.length > 0;
    let replacedRenderables: Renderable[] = [];
    let trackedEntryStart = 0;
    let trackedEntryCount = 0;

    task._prepareTaskMeshes = (candidate, commit): void => {
        const replaced = candidate._renderables.filter((renderable) => owned.has(renderable));
        if (commit) {
            replacedRenderables = replaced;
        }
        candidate._renderables = candidate._renderables.filter((renderable) => !owned.has(renderable));
        const requests = tracked.flatMap((mesh) => (mesh.material ? [{ mesh, material: mesh.material }] : []));
        if (commit) {
            trackedEntryStart = candidate._renderables.length;
            trackedEntryCount = requests.length;
        }
        candidate._pendingMeshes.unshift(...requests);
    };
    const finishReplacements = (): void => {
        for (let index = trackedEntryStart; index < trackedEntryStart + trackedEntryCount; index++) {
            owned.add(task._renderables[index]!);
        }
        for (const renderable of replacedRenderables) {
            retireGpuResourceBatch(task.engine, renderable._lifetimeDisposers!);
        }
        replacedRenderables = [];
        trackedEntryCount = 0;
    };
    task._addMesh = (mesh, options): void => {
        if (task._disposed) {
            throw new Error("RenderTask has been disposed.");
        }
        if (options?.material) {
            dirty = true;
            try {
                addMesh(mesh, options);
            } catch (error) {
                replacedRenderables = [];
                trackedEntryCount = 0;
                throw error;
            }
            finishReplacements();
        } else {
            if (!mesh.material || tracked.includes(mesh)) {
                return;
            }
            tracked.push(mesh);
            dirty = true;
            if (task._sceneBG) {
                try {
                    _rebindRenderTask(task);
                } catch (error) {
                    replacedRenderables = [];
                    trackedEntryCount = 0;
                    throw error;
                }
                finishReplacements();
            }
        }
        if (task._sceneBG) {
            dirty = false;
        }
    };
    task.record = (): void => {
        try {
            record();
        } catch (error) {
            replacedRenderables = [];
            trackedEntryCount = 0;
            throw error;
        }
        finishReplacements();
        dirty = false;
    };
    if (execute) {
        task.execute = (): number => {
            if (dirty || (task._lastVersion !== task.scene._renderableVersion && (tracked.length || task._renderables.some((renderable) => !!renderable._lifetimeDisposers)))) {
                try {
                    _rebindRenderTask(task);
                } catch (error) {
                    replacedRenderables = [];
                    trackedEntryCount = 0;
                    throw error;
                }
                finishReplacements();
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
