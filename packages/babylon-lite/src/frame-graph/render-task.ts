import type { EngineContext } from "../engine/engine.js";
import { retireGpuResourceBatch } from "../engine/gpu-resource-retirement.js";
import type { Material } from "../material/material.js";
import type { Mesh } from "../mesh/mesh.js";
import type { SceneContext } from "../scene/scene-core.js";
import type { Renderable } from "../render/renderable.js";
import { _buildBindings, _createAutomaticRenderTask, _removeMeshesFromRenderTask, type RenderTask, type RenderTaskConfig } from "./render-task-base.js";
import { transactRenderTask } from "./render-task-transaction.js";

export type { RenderTask, RenderTaskConfig } from "./render-task-base.js";
export { _buildBindings, _writePassSceneUBO, drawList } from "./render-task-base.js";
export { resolvePendingTaskMeshes as _resolvePendingMeshes } from "./render-task-transaction.js";

/** Create a render task, auto-mirroring the scene unless disabled or populated with `addMeshToTask`. */
export function createRenderTask(config: RenderTaskConfig, engine: EngineContext, scene: SceneContext): RenderTask {
    return _createAutomaticRenderTask(config, engine, scene) as RenderTask;
}

/** Add a mesh with an optional per-pass material override. Before the first recording the add is
 *  queued; afterwards it builds and binds synchronously, preserving the live generation on failure. */
export function addMeshToTask(task: RenderTask, mesh: Mesh, opts?: { material?: Material }): void {
    _enableTaskMeshPopulation(task);
    task._addMesh!(mesh, opts);
}

/** Add meshes in order, binding at most once on a live task. A failed batch retains no new requests. */
export function addMeshesToTask(task: RenderTask, meshes: readonly Mesh[], opts?: { material?: Material }): void {
    if (task._disposed) {
        throw new Error("RenderTask has been disposed.");
    }
    if (!meshes.length) {
        return;
    }
    const pending = task._pendingMeshes;
    const addMesh = task._addMesh;
    const record = task._recordExplicit;
    const retire = task._retireRenderable;
    _enableTaskMeshPopulation(task);
    try {
        if (task._addMeshes) {
            task._addMeshes(meshes, opts);
        } else {
            _queueTaskMeshes(task, meshes, opts);
        }
    } catch (error) {
        task._pendingMeshes = pending;
        task._addMesh = addMesh;
        task._recordExplicit = record;
        task._retireRenderable = retire;
        throw error;
    }
}

/** @internal Install explicit population without retaining it in createRenderTask-only bundles. */
export function _enableTaskMeshPopulation(task: RenderTask): void {
    if (task._addMesh) {
        return;
    }
    task._pendingMeshes ??= [];
    task._addMesh = queueMesh;
    task._recordExplicit = transactRenderTask;
    task._retireRenderable = retireRenderable;
}

function retireRenderable(engine: EngineContext, renderable: Renderable): void {
    if (renderable._lifetimeDisposers) {
        retireGpuResourceBatch(engine, renderable._lifetimeDisposers);
    }
}

function queueMesh(this: RenderTask, mesh: Mesh, opts?: { material?: Material }): void {
    if (this._disposed) {
        throw new Error("RenderTask has been disposed.");
    }
    const material = opts?.material ?? mesh.material;
    if (!material) {
        return;
    }
    this._pendingMeshes!.push({ mesh, material });
    if (this._sceneBG) {
        _rebindRenderTask(this);
    }
}

/** @internal Default atomic batch strategy; refresh wrappers use it for material overrides. */
export function _queueTaskMeshes(task: RenderTask, meshes: readonly Mesh[], opts?: { material?: Material }): void {
    const pending = task._pendingMeshes!;
    const length = pending.length;
    try {
        for (const mesh of meshes) {
            const material = opts?.material ?? mesh.material;
            if (material) {
                pending.push({ mesh, material });
            }
        }
        if (pending.length !== length && task._sceneBG) {
            _rebindRenderTask(task);
        }
    } catch (error) {
        pending.length = length;
        throw error;
    }
}

/** Remove a mesh and its task-owned resources from this task. Idempotent. */
export function removeMeshFromTask(task: RenderTask, mesh: object): void {
    removeTaskMeshes(task, [mesh]);
}

/** Remove meshes and their task-owned resources in one pass. Idempotent. */
export function removeMeshesFromTask(task: RenderTask, meshes: readonly object[]): void {
    if (task._disposed) {
        throw new Error("RenderTask has been disposed.");
    }
    if (!meshes.length) {
        return;
    }
    removeTaskMeshes(task, meshes);
}

function removeTaskMeshes(task: RenderTask, meshes: readonly object[]): void {
    const members = new Set(meshes);
    const pending = task._pendingMeshes;
    if (pending) {
        let kept = 0;
        for (const request of pending) {
            if (!members.has(request.mesh)) {
                pending[kept++] = request;
            }
        }
        pending.length = kept;
    }
    _removeMeshesFromRenderTask(task, meshes, members);
}

/** @internal Rebind an explicit task without rebuilding its render targets. */
export function _rebindRenderTask(task: RenderTask): void {
    transactRenderTask(task);
}
