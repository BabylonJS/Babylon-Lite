import { runGpuResourceCallbacks } from "../engine/gpu-resource-retirement.js";
import { resolveMeshRebuild } from "../material/resolve-mesh-rebuild.js";
import type { MeshRebuildResources, Renderable } from "../render/renderable.js";
import type { RenderTask } from "./render-task.js";
import { _buildBindings, type RenderTaskPopulation } from "./render-task-base.js";

/** @internal Resolve queued auxiliary meshes only within a candidate generation. */
export function resolvePendingTaskMeshes(candidate: RenderTaskPopulation, created: MeshRebuildResources[] = []): MeshRebuildResources[] {
    for (const { mesh, material } of candidate._pendingMeshes) {
        if (!material) {
            continue;
        }
        const resources: MeshRebuildResources = { _lifetimeDisposers: [] };
        const rebuild = resolveMeshRebuild(candidate.scene, material._buildGroup);
        if (!rebuild) {
            throw new Error("Material group has not completed its initial build in this scene.");
        }
        created.push(resources);
        const renderable = rebuild(candidate.scene, mesh, material, resources);
        renderable._lifetimeDisposers = resources._lifetimeDisposers;
        candidate._renderables.push(renderable);
    }
    candidate._pendingMeshes.length = 0;
    return created;
}

/** @internal Scoped auxiliary construction for opt-in asynchronous pipeline preparation. */
export function prepareTaskRenderables(task: RenderTask): { renderables: readonly Renderable[]; dispose: () => void } {
    const created: MeshRebuildResources[] = [];
    const candidate: RenderTaskPopulation = {
        scene: task.scene,
        _renderables: task._renderables.slice(),
        _pendingMeshes: task._pendingMeshes!.slice(),
    };
    const dispose = (): void => {
        for (const resources of created) {
            runGpuResourceCallbacks(resources._lifetimeDisposers);
        }
        created.length = 0;
    };
    try {
        task._prepareTaskMeshes?.(candidate);
        resolvePendingTaskMeshes(candidate, created);
    } catch (error) {
        dispose();
        throw error;
    }
    return { renderables: candidate._renderables, dispose };
}

/** @internal Build and publish one explicit task generation. */
export function transactRenderTask(task: RenderTask, record = false): void {
    if (task._disposed) {
        throw new Error("RenderTask has been disposed.");
    }
    const previousBatchState = task._batchState;
    const created: MeshRebuildResources[] = [];
    const pending = task._pendingMeshes!.length > 0;
    const autoMirror = task._config.autoMirror !== false;
    const candidate: RenderTaskPopulation = {
        scene: task.scene,
        _renderables: autoMirror ? (pending ? [] : task.scene._renderables.slice()) : task._renderables.slice(),
        _pendingMeshes: task._pendingMeshes!.slice(),
    };
    let generation: ReturnType<typeof _buildBindings>;
    try {
        task._prepareTaskMeshes?.(candidate, true);
        resolvePendingTaskMeshes(candidate, created);
        generation = _buildBindings(task, candidate._renderables, record, false);
    } catch (error) {
        for (const resources of created) {
            runGpuResourceCallbacks(resources._lifetimeDisposers);
        }
        throw error;
    }
    if (pending) {
        task._config.autoMirror = false;
    }
    task._pendingMeshes = candidate._pendingMeshes;
    Object.assign(task, generation);
    previousBatchState?._release(task.engine, [generation._batchState]);
}
