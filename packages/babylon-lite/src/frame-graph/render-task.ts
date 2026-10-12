import type { EngineContext } from "../engine/engine.js";
import { retireGpuResourceBatch } from "../engine/gpu-resource-retirement.js";
import type { Material } from "../material/material.js";
import type { Mesh } from "../mesh/mesh.js";
import type { SceneContext } from "../scene/scene-core.js";
import type { Renderable } from "../render/renderable.js";
import { _buildBindings, _createAutomaticRenderTask, _removeMeshFromRenderTask, type RenderTask, type RenderTaskConfig } from "./render-task-base.js";
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

/** Remove a mesh and its task-owned resources from this task. Idempotent. */
export function removeMeshFromTask(task: RenderTask, mesh: object): void {
    const pending = task._pendingMeshes;
    if (pending) {
        for (let index = pending.length - 1; index >= 0; index--) {
            if (pending[index]!.mesh === mesh) {
                pending.splice(index, 1);
            }
        }
    }
    _removeMeshFromRenderTask(task, mesh);
}

/** @internal Rebind an explicit task without rebuilding its render targets. */
export function _rebindRenderTask(task: RenderTask): void {
    transactRenderTask(task);
}
