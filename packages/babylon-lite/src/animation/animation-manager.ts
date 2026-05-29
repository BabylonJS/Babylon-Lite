import type { EngineContext } from "../engine/engine.js";

export interface AnimationTask {
    readonly _entityType: "animation-task";
    active: boolean;
}

export type AnimationTaskUpdate = (manager: AnimationManager, deltaMs: number, task: AnimationTask) => void;
export type AnimationTaskCategoryHandler = (manager: AnimationManager, deltaMs: number) => boolean;

export interface AnimationTaskOptions {
    readonly category?: string;
    readonly dispose?: (manager: AnimationManager) => void;
}

interface AnimationTaskInternal extends AnimationTask {
    _update: AnimationTaskUpdate;
    _dispose?: (manager: AnimationManager) => void;
    _category?: string;
    _owner?: AnimationManager;
}

export interface AnimationManagerOptions {
    readonly engine?: EngineContext;
    readonly fixedDeltaMs?: number;
    readonly onUpdate?: (deltaMs: number) => void;
}

export interface AnimationManager {
    animations: AnimationTask[];
    fixedDeltaMs: number;
    running: boolean;
    readonly engine?: EngineContext;
    readonly onUpdate?: (deltaMs: number) => void;
    /** @internal Optional feature updaters installed by category-specific adapters. */
    _taskCategory?: string;
    _taskCategoryHandler?: AnimationTaskCategoryHandler;
    _rafId: number;
    _lastTime: number;
}

export function createAnimationTask(update: AnimationTaskUpdate, options?: AnimationTaskOptions): AnimationTask {
    return {
        _entityType: "animation-task",
        active: true,
        _update: update,
        _category: options?.category,
        _dispose: options?.dispose,
    } as AnimationTaskInternal;
}

export function createAnimationManager(options?: AnimationManagerOptions): AnimationManager {
    return {
        animations: [],
        fixedDeltaMs: options?.fixedDeltaMs ?? 0,
        running: false,
        engine: options?.engine,
        onUpdate: options?.onUpdate,
        _rafId: 0,
        _lastTime: 0,
    };
}

export function setAnimationTaskCategoryHandler(manager: AnimationManager, category: string, handler: AnimationTaskCategoryHandler): void {
    if (!category) {
        throw new Error("Animation task category is required.");
    }
    manager._taskCategory = category;
    manager._taskCategoryHandler = handler;
}

export function addAnimationTask(manager: AnimationManager, task: AnimationTask): void {
    const internal = task as AnimationTaskInternal;
    const owner = internal._owner;
    if (owner === manager) {
        return;
    }
    if (owner) {
        throw new Error("AnimationTask is already attached to another AnimationManager");
    }
    task.active = true;
    internal._owner = manager;
    manager.animations.push(internal);
}

export function removeAnimationTask(manager: AnimationManager, task: AnimationTask): void {
    const index = manager.animations.indexOf(task);
    if (index !== -1) {
        removeAnimationTaskAt(manager, index);
    } else if ((task as AnimationTaskInternal)._owner === manager) {
        (task as AnimationTaskInternal)._owner = undefined;
        task.active = false;
    }
}

export function clearAnimationManager(manager: AnimationManager): void {
    while (manager.animations.length > 0) {
        removeAnimationTaskAt(manager, manager.animations.length - 1);
    }
}

export function updateAnimationManager(manager: AnimationManager, deltaMs: number): void {
    const step = manager.fixedDeltaMs > 0 ? manager.fixedDeltaMs : deltaMs;
    if (!Number.isFinite(step) || step < 0) {
        return;
    }
    const handledCategory = manager._taskCategoryHandler?.(manager, step) ? manager._taskCategory : undefined;
    // Snapshot the list so a task's _update callback can remove itself or other
    // tasks (via removeAnimationTask) without shifting unvisited tasks out of the
    // iteration. Removed tasks are marked inactive and skipped below.
    const tasks = manager.animations.slice();
    for (let index = 0; index < tasks.length; index++) {
        const task = tasks[index]! as AnimationTaskInternal;
        if (!task.active || (task._category && task._category === handledCategory)) {
            continue;
        }
        task._update(manager, step, task);
    }
}

export function startAnimationManager(manager: AnimationManager): void {
    if (manager.running) {
        return;
    }
    if (typeof requestAnimationFrame !== "function" || typeof cancelAnimationFrame !== "function") {
        throw new Error("AnimationManager autonomous mode requires requestAnimationFrame");
    }
    manager.running = true;
    manager._lastTime = 0;
    const tick = (now: number): void => {
        if (!manager.running) {
            return;
        }
        const deltaMs = manager._lastTime > 0 ? now - manager._lastTime : 0;
        manager._lastTime = now;
        const step = manager.fixedDeltaMs > 0 ? manager.fixedDeltaMs : deltaMs;
        updateAnimationManager(manager, deltaMs);
        manager.onUpdate?.(step);
        manager._rafId = requestAnimationFrame(tick);
    };
    manager._rafId = requestAnimationFrame(tick);
}

export function stopAnimationManager(manager: AnimationManager): void {
    if (!manager.running) {
        return;
    }
    cancelAnimationFrame(manager._rafId);
    manager._rafId = 0;
    manager._lastTime = 0;
    manager.running = false;
}

function removeAnimationTaskAt(manager: AnimationManager, index: number): void {
    const task = manager.animations[index]! as AnimationTaskInternal;
    manager.animations.splice(index, 1);
    if (task._owner === manager) {
        task._owner = undefined;
    }
    task.active = false;
    task._dispose?.(manager);
}
