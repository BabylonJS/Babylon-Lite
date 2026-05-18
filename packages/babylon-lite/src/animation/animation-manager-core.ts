import type { EngineContext } from "../engine/engine.js";
import { tickAnimation } from "./animation-group.js";
import type { AnimationGroup } from "./animation-group.js";

export interface AnimationManagerOptions {
    readonly engine?: EngineContext;
    readonly fixedDeltaMs?: number;
    readonly onUpdate?: (deltaMs: number) => void;
}

export interface AnimationManager {
    animationGroups: AnimationGroup[];
    fixedDeltaMs: number;
    running: boolean;
    readonly engine?: EngineContext;
    readonly onUpdate?: (deltaMs: number) => void;
    /** @internal Optional feature updater installed by weighted animation helpers. */
    _wu?: (manager: AnimationManager, deltaMs: number) => boolean;
    _rafId: number;
    _lastTime: number;
}

const _animationGroupOwners = new WeakMap<AnimationGroup, AnimationManager>();

export function getAnimationGroupOwner(group: AnimationGroup): AnimationManager | undefined {
    return _animationGroupOwners.get(group);
}

export function createAnimationManager(options?: AnimationManagerOptions): AnimationManager {
    return {
        animationGroups: [],
        fixedDeltaMs: options?.fixedDeltaMs ?? 0,
        running: false,
        engine: options?.engine,
        onUpdate: options?.onUpdate,
        _rafId: 0,
        _lastTime: 0,
    };
}

export function addAnimationGroup(manager: AnimationManager, group: AnimationGroup): void {
    const owner = _animationGroupOwners.get(group);
    if (owner && owner !== manager) {
        throw new Error(`AnimationGroup "${group.name}" is already attached to another AnimationManager`);
    }
    if (manager.animationGroups.indexOf(group) === -1) {
        manager.animationGroups.push(group);
        _animationGroupOwners.set(group, manager);
    }
}

export function addAnimationGroups(manager: AnimationManager, groups: readonly AnimationGroup[]): void {
    for (const group of groups) {
        addAnimationGroup(manager, group);
    }
}

export function removeAnimationGroup(manager: AnimationManager, group: AnimationGroup): void {
    const idx = manager.animationGroups.indexOf(group);
    if (idx !== -1) {
        manager.animationGroups.splice(idx, 1);
    }
    if (_animationGroupOwners.get(group) === manager) {
        _animationGroupOwners.delete(group);
    }
}

export function clearAnimationManager(manager: AnimationManager): void {
    while (manager.animationGroups.length > 0) {
        removeAnimationGroup(manager, manager.animationGroups[manager.animationGroups.length - 1]!);
    }
}

export function updateAnimationManager(manager: AnimationManager, deltaMs: number): void {
    const step = manager.fixedDeltaMs > 0 ? manager.fixedDeltaMs : deltaMs;
    if (manager._wu?.(manager, step) === true) {
        return;
    }
    for (const group of manager.animationGroups) {
        tickAnimation(group, step, manager.engine);
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
        updateAnimationManager(manager, deltaMs);
        manager.onUpdate?.(manager.fixedDeltaMs > 0 ? manager.fixedDeltaMs : deltaMs);
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
