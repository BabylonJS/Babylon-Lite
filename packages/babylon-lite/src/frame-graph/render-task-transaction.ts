import { retireGpuResources } from "../engine/gpu-resource-retirement.js";
import { resolveMeshRebuild } from "../material/resolve-mesh-rebuild.js";
import type { Mesh } from "../mesh/mesh.js";
import type { DrawUpdateBatch, Renderable } from "../render/renderable.js";
import type { SceneContext } from "../scene/scene-core.js";
import type { RenderTask } from "./render-task.js";

/** @internal One task's auxiliary renderable and its two resource lifetimes. */
export interface TaskMeshEntry {
    readonly mesh: Mesh;
    renderable?: Renderable;
    owner?: RenderTask;
    lifetimeDisposers: (() => void)[];
    bindingDisposers: (() => void)[];
}

/** @internal Build into a candidate task, never the scene's ownership maps. */
export function appendTaskMesh(candidate: RenderTask, mesh: Mesh, material = mesh.material): TaskMeshEntry {
    const entry: TaskMeshEntry = { mesh, lifetimeDisposers: [], bindingDisposers: [] };
    (candidate._meshEntries ??= []).push(entry);
    if (!material) {
        return entry;
    }
    const scene = candidate.scene;
    const rebuild = resolveMeshRebuild(scene, material._buildGroup);
    if (!rebuild) {
        throw new Error("Material group has not completed its initial build in this scene.");
    }
    const renderable = captureDisposers(scene, entry, entry.lifetimeDisposers, () => rebuild(scene, mesh, material));
    entry.renderable = renderable;
    renderable._lifetimeDisposers = entry.lifetimeDisposers;
    const bind = renderable.bind.bind(renderable);
    renderable.bind = (engine, signature) => captureDisposers(scene, entry, entry.bindingDisposers, () => bind(engine, signature));
    if (!candidate._renderables.includes(renderable)) {
        candidate._renderables.push(renderable);
    }
    return entry;
}

function captureDisposers<T>(scene: SceneContext, entry: TaskMeshEntry, disposers: (() => void)[], build: () => T): T {
    const main = scene._meshDisposables;
    const aux = scene._meshAuxDisposables;
    const previousMain = main.get(entry.mesh);
    const previousAux = aux.get(entry.mesh);
    const captured: (() => void)[] = [];
    main.set(entry.mesh, captured);
    aux.set(entry.mesh, captured);
    try {
        return build();
    } finally {
        for (const list of [captured, main.get(entry.mesh), aux.get(entry.mesh)]) {
            for (const dispose of list ?? []) {
                if (!disposers.includes(dispose) && (disposers === entry.lifetimeDisposers || !entry.lifetimeDisposers.includes(dispose))) {
                    disposers.push(dispose);
                }
            }
        }
        if (previousMain) {
            main.set(entry.mesh, previousMain);
        } else {
            main.delete(entry.mesh);
        }
        if (previousAux) {
            aux.set(entry.mesh, previousAux);
        } else {
            aux.delete(entry.mesh);
        }
    }
}

function taskState(task: RenderTask) {
    return {
        _renderables: task._renderables,
        _meshEntries: task._meshEntries,
        _opaqueBindings: task._opaqueBindings,
        _directBindings: task._directBindings,
        _transparentBindings: task._transparentBindings,
        _updateBatches: task._updateBatches,
        _ob: task._ob,
        _lastVersion: task._lastVersion,
        _lastVis: task._lastVis,
        _pendingMeshes: task._pendingMeshes,
        _recorded: task._recorded,
        _af: task._af,
        _sceneBG: task._sceneBG,
        _lightsUBO: task._lightsUBO,
        _colorAttachment: task._colorAttachment,
        _renderPassDescriptor: task._renderPassDescriptor,
    };
}

function beginTaskTransaction(task: RenderTask) {
    const candidate: RenderTask = {
        ...task,
        _renderables: task._renderables.slice(),
        _meshEntries: task._meshEntries?.slice(),
        _opaqueBindings: task._opaqueBindings.slice(),
        _directBindings: task._directBindings.slice(),
        _transparentBindings: task._transparentBindings.slice(),
        _updateBatches: task._updateBatches.slice(),
        _ob: task._ob.slice(),
        _pendingMeshes: task._pendingMeshes.slice(),
        _colorAttachment: { ...task._colorAttachment },
        _renderPassDescriptor: { ...task._renderPassDescriptor },
    };
    const bindings = new Map<TaskMeshEntry, (() => void)[]>();
    return { task, previous: taskState(task), candidate, bindings };
}

type TaskTransaction = ReturnType<typeof beginTaskTransaction>;

function bindTaskTransaction(transaction: TaskTransaction, bind: (candidate: RenderTask) => void): void {
    for (const entry of transaction.candidate._meshEntries ?? []) {
        if (entry.owner) {
            transaction.bindings.set(entry, entry.bindingDisposers);
            entry.bindingDisposers = [];
        }
    }
    bind(transaction.candidate);
}

function rollbackTaskTransaction(transaction: TaskTransaction, liveBatches: readonly DrawUpdateBatch[]): void {
    for (const entry of transaction.candidate._meshEntries ?? []) {
        if (!entry.owner) {
            disposeTaskMesh(entry);
        }
    }
    disposeTaskCallbacks(transaction.candidate._updateBatches.filter((batch) => !liveBatches.includes(batch)).map((batch) => () => batch.destroy()));
    for (const [entry, old] of transaction.bindings) {
        disposeTaskCallbacks(entry.bindingDisposers);
        entry.bindingDisposers = old;
    }
}

function publishTaskTransaction(transaction: TaskTransaction): void {
    const { task, candidate } = transaction;
    Object.assign(task, taskState(candidate));
    for (const entry of candidate._meshEntries ?? []) {
        entry.owner = task;
    }
}

function retireTaskTransaction(transaction: TaskTransaction, liveBatches: readonly DrawUpdateBatch[]): void {
    const { task, previous, bindings } = transaction;
    for (const [entry, old] of bindings) {
        retireTaskCallbacks(entry.owner!, old);
    }
    for (const entry of previous._meshEntries ?? []) {
        if (entry.owner === task && !task._meshEntries?.includes(entry)) {
            retireTaskMesh(task, entry);
        }
    }
    retireTaskBatches(
        task,
        previous._updateBatches.filter((batch) => !liveBatches.includes(batch))
    );
}

/** @internal Single-task form of the shared generation transaction. */
export function transactRenderTask(task: RenderTask, prepare: (candidate: RenderTask) => void, bind: (candidate: RenderTask) => void): void {
    const transaction = beginTaskTransaction(task);
    try {
        prepare(transaction.candidate);
        bindTaskTransaction(transaction, bind);
    } catch (error) {
        rollbackTaskTransaction(transaction, transaction.previous._updateBatches);
        throw error;
    }
    publishTaskTransaction(transaction);
    retireTaskTransaction(transaction, task._updateBatches);
}

/** @internal Coordinate transfers without retaining multi-task scheduling in ordinary task bundles. */
export function transactRenderTasks(
    tasks: readonly RenderTask[],
    prepare: (candidates: RenderTask[]) => void,
    bind: (candidate: RenderTask) => void,
    rebind: readonly RenderTask[] = tasks
): void {
    const transactions = tasks.map(beginTaskTransaction);
    try {
        prepare(transactions.map((transaction) => transaction.candidate));
        for (const transaction of transactions) {
            if (rebind.includes(transaction.task)) {
                bindTaskTransaction(transaction, bind);
            }
        }
    } catch (error) {
        const liveBatches = transactions.flatMap((transaction) => transaction.previous._updateBatches);
        for (const transaction of transactions) {
            rollbackTaskTransaction(transaction, liveBatches);
        }
        throw error;
    }
    for (const transaction of transactions) {
        publishTaskTransaction(transaction);
    }
    const liveBatches = transactions.flatMap((transaction) => transaction.candidate._updateBatches);
    for (const transaction of transactions) {
        retireTaskTransaction(transaction, liveBatches);
    }
}

/** @internal Release resources from an unpublished auxiliary renderable. */
export function disposeTaskMesh(entry: TaskMeshEntry): void {
    disposeTaskCallbacks(entry.bindingDisposers);
    disposeTaskCallbacks(entry.lifetimeDisposers);
}

/** @internal Release an owned renderable only after its previous draws drain. */
export function retireTaskMesh(task: RenderTask, entry: TaskMeshEntry): void {
    retireTaskCallbacks(task, entry.bindingDisposers);
    retireTaskCallbacks(task, entry.lifetimeDisposers);
    entry.owner = undefined;
}

/** @internal Retire task-local update batches that no binding uses anymore. */
export function retireTaskBatches(task: RenderTask, batches: readonly DrawUpdateBatch[]): void {
    retireTaskCallbacks(
        task,
        batches.map((batch) => () => batch.destroy())
    );
}

/** @internal Retire an obsolete resource generation. */
export function retireTaskCallbacks(task: RenderTask, disposers: readonly (() => void)[]): void {
    if (disposers.length) {
        retireGpuResources(task.engine, () => disposeTaskCallbacks(disposers));
    }
}

/** @internal Attempt every release while preserving the original construction error. */
export function disposeTaskCallbacks(disposers: readonly (() => void)[]): void {
    for (const dispose of disposers) {
        try {
            dispose();
        } catch (error) {
            console.error("RenderTask: failed to dispose render resources.", error);
        }
    }
}
