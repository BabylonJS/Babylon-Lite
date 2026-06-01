import { addAnimationTask, createAnimationManager, createAnimationTask, removeAnimationTask, startAnimationManager, stopAnimationManager } from "../animation/animation-manager.js";
import type { AnimationManager, AnimationTask } from "../animation/animation-manager.js";
import type { SpriteAnimationBinding, SpriteAnimationManager } from "./sprite-animation.js";
import { updateSpriteAnimationManager } from "./sprite-animation.js";

interface SpriteAnimationTaskManagerInternal extends SpriteAnimationManager {
    readonly onUpdate?: (deltaMs: number) => void;
    _binding?: SpriteAnimationBinding;
    _animationTask?: AnimationTask;
    _animationManager?: AnimationManager;
    _loopManager?: AnimationManager;
}

function asSpriteAnimationTaskManagerInternal(manager: SpriteAnimationManager): SpriteAnimationTaskManagerInternal {
    return manager as SpriteAnimationTaskManagerInternal;
}

function getSpriteAnimationTask(manager: SpriteAnimationManager): AnimationTask {
    const managerInternal = asSpriteAnimationTaskManagerInternal(manager);
    if (!managerInternal._animationTask) {
        managerInternal._animationTask = createAnimationTask(
            (_animationManager, deltaMs) => {
                updateSpriteAnimationManager(manager, deltaMs);
            },
            {
                dispose: (animationManager) => {
                    if (managerInternal._animationManager === animationManager) {
                        managerInternal._animationManager = undefined;
                    }
                    if (managerInternal._loopManager === animationManager) {
                        manager.running = false;
                    }
                },
            }
        );
    }
    return managerInternal._animationTask;
}

export function addSpriteAnimationManager(manager: AnimationManager, spriteManager: SpriteAnimationManager): void {
    const spriteManagerInternal = asSpriteAnimationTaskManagerInternal(spriteManager);
    if (spriteManagerInternal._animationManager === manager) {
        return;
    }
    assertCanAttachToAnimationManager(spriteManager);
    addAnimationTask(manager, getSpriteAnimationTask(spriteManager));
    spriteManagerInternal._animationManager = manager;
}

export function removeSpriteAnimationManager(manager: AnimationManager, spriteManager: SpriteAnimationManager): void {
    const task = asSpriteAnimationTaskManagerInternal(spriteManager)._animationTask;
    if (task) {
        removeAnimationTask(manager, task);
    }
}

export function startSpriteAnimationManager(manager: SpriteAnimationManager): void {
    if (manager.running) {
        return;
    }
    assertNoActiveBinding(manager);
    const managerInternal = asSpriteAnimationTaskManagerInternal(manager);
    let loopManager = managerInternal._loopManager;
    if (!loopManager) {
        loopManager = createAnimationManager({ fixedDeltaMs: manager.fixedDeltaMs, onUpdate: managerInternal.onUpdate });
        managerInternal._loopManager = loopManager;
    }
    loopManager.fixedDeltaMs = manager.fixedDeltaMs;
    if (managerInternal._animationManager !== loopManager) {
        addAnimationTask(loopManager, getSpriteAnimationTask(manager));
        managerInternal._animationManager = loopManager;
    }
    startAnimationManager(loopManager);
    manager.running = loopManager.running;
}

export function stopSpriteAnimationManager(manager: SpriteAnimationManager): void {
    const managerInternal = asSpriteAnimationTaskManagerInternal(manager);
    const loopManager = managerInternal._loopManager;
    if (!loopManager) {
        manager.running = false;
        return;
    }
    stopAnimationManager(loopManager);
    const task = managerInternal._animationTask;
    if (task) {
        removeAnimationTask(loopManager, task);
    }
    manager.running = false;
}

function assertNoActiveBinding(manager: SpriteAnimationManager): void {
    const managerInternal = asSpriteAnimationTaskManagerInternal(manager);
    if (managerInternal._binding?.active) {
        throw new Error("SpriteAnimationManager is already attached to a render loop.");
    }
    if (managerInternal._animationManager && managerInternal._animationManager !== managerInternal._loopManager) {
        throw new Error("SpriteAnimationManager is already attached to an AnimationManager.");
    }
}

function assertCanAttachToAnimationManager(manager: SpriteAnimationManager): void {
    const managerInternal = asSpriteAnimationTaskManagerInternal(manager);
    if (managerInternal.running) {
        throw new Error("SpriteAnimationManager is already running autonomously.");
    }
    if (managerInternal._binding?.active) {
        throw new Error("SpriteAnimationManager is already attached to a render loop.");
    }
    if (managerInternal._animationManager) {
        throw new Error("SpriteAnimationManager is already attached to an AnimationManager.");
    }
}
