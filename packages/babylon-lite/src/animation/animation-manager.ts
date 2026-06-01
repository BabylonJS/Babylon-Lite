import type { EngineContext } from "../engine/engine.js";

/** A unit of per-frame animation work owned by an {@link AnimationManager}. */
export interface AnimationTask {
    readonly _entityType: "animation-task";
    active: boolean;
}

/** Callback invoked each tick to advance a single {@link AnimationTask} by `deltaMs` milliseconds. */
export type AnimationTaskUpdate = (manager: AnimationManager, deltaMs: number, task: AnimationTask) => void;
/** Handler that drives all tasks of a given category in one pass; returns true if it handled that category this tick. */
export type AnimationTaskCategoryHandler = (manager: AnimationManager, deltaMs: number) => boolean;

/** Options for {@link createAnimationTask}. */
export interface AnimationTaskOptions {
    readonly category?: string;
    /** Called when the task is removed from its manager, allowing it to release any owned resources. */
    readonly dispose?: (manager: AnimationManager) => void;
}

interface AnimationTaskInternal extends AnimationTask {
    _update: AnimationTaskUpdate;
    _dispose?: (manager: AnimationManager) => void;
    _category?: string;
    _owner?: AnimationManager;
}

/** Options for {@link createAnimationManager}. */
export interface AnimationManagerOptions {
    readonly engine?: EngineContext;
    readonly fixedDeltaMs?: number;
    /** Called after each autonomous tick with the step (in ms) that was applied. */
    readonly onUpdate?: (deltaMs: number) => void;
}

/** Owns a set of {@link AnimationTask}s and ticks them, either manually or via its own requestAnimationFrame loop. */
export interface AnimationManager {
    animations: AnimationTask[];
    fixedDeltaMs: number;
    running: boolean;
    readonly engine?: EngineContext;
    /** Called after each autonomous tick with the step (in ms) that was applied. */
    readonly onUpdate?: (deltaMs: number) => void;
    /** @internal Optional feature updaters installed by category-specific adapters. */
    _taskCategory?: string;
    _taskCategoryHandler?: AnimationTaskCategoryHandler;
    _rafId: number;
    _lastTime: number;
}

/** Creates an animation task that invokes `update` each tick.
 *  @param update - Callback that advances the task by the frame delta.
 *  @param options - Optional category and dispose hook.
 *  @returns The new, active animation task. */
export function createAnimationTask(update: AnimationTaskUpdate, options?: AnimationTaskOptions): AnimationTask {
    return {
        _entityType: "animation-task",
        active: true,
        _update: update,
        _category: options?.category,
        _dispose: options?.dispose,
    } as AnimationTaskInternal;
}

/** Creates an animation manager with no tasks attached.
 *  @param options - Optional engine, fixed timestep, and update callback.
 *  @returns The new manager. */
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

/** Registers a single category `handler` on `manager` that drives every task tagged with `category` in one pass.
 *  @throws If `category` is empty. */
export function setAnimationTaskCategoryHandler(manager: AnimationManager, category: string, handler: AnimationTaskCategoryHandler): void {
    if (!category) {
        throw new Error("Animation task category is required.");
    }
    manager._taskCategory = category;
    manager._taskCategoryHandler = handler;
}

/** Attaches `task` to `manager` and marks it active.
 *  @throws If the task is already attached to a different manager. */
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

/** Detaches `task` from `manager`, marking it inactive and running its dispose hook if it was attached. */
export function removeAnimationTask(manager: AnimationManager, task: AnimationTask): void {
    const index = manager.animations.indexOf(task);
    if (index !== -1) {
        removeAnimationTaskAt(manager, index);
    } else if ((task as AnimationTaskInternal)._owner === manager) {
        (task as AnimationTaskInternal)._owner = undefined;
        task.active = false;
    }
}

/** Removes and disposes every task attached to `manager`. */
export function clearAnimationManager(manager: AnimationManager): void {
    while (manager.animations.length > 0) {
        removeAnimationTaskAt(manager, manager.animations.length - 1);
    }
}

/** Advances every active task by `deltaMs` (or by `fixedDeltaMs` when set), running the category handler first.
 *  Ignores non-finite or negative steps. */
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

/** Starts the manager's autonomous requestAnimationFrame loop. No-op if already running.
 *  @throws If `requestAnimationFrame` is unavailable in the host environment. */
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

/** Stops the manager's autonomous requestAnimationFrame loop. No-op if not running. */
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
