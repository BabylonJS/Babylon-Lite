import { addAnimationTask, createAnimationManager, createAnimationTask, removeAnimationTask, startAnimationManager, stopAnimationManager } from "../animation/animation-manager.js";
import type { AnimationManager, AnimationTask } from "../animation/animation-manager.js";
import type { SpriteAnimationManager } from "./sprite-animation.js";
import { updateSpriteAnimationManager } from "./sprite-animation.js";

function getSpriteAnimationTask(manager: SpriteAnimationManager): AnimationTask {
    if (!manager._animationTask) {
        manager._animationTask = createAnimationTask(
            (_animationManager, deltaMs) => {
                updateSpriteAnimationManager(manager, deltaMs);
            },
            {
                dispose: (animationManager) => {
                    if (manager._animationManager === animationManager) {
                        manager._animationManager = undefined;
                    }
                    if (manager._loopManager === animationManager) {
                        manager.running = false;
                    }
                },
            }
        );
    }
    return manager._animationTask;
}

/**
 * Attaches a sprite animation manager to a shared animation manager so it ticks with it.
 * @param manager - Animation manager that will drive the sprite manager.
 * @param spriteManager - Sprite animation manager to attach.
 * @throws If the sprite manager is already running or attached elsewhere.
 */
export function addSpriteAnimationManager(manager: AnimationManager, spriteManager: SpriteAnimationManager): void {
    if (spriteManager._animationManager === manager) {
        return;
    }
    assertCanAttachToAnimationManager(spriteManager);
    addAnimationTask(manager, getSpriteAnimationTask(spriteManager));
    spriteManager._animationManager = manager;
}

/**
 * Detaches a sprite animation manager previously attached with {@link addSpriteAnimationManager}.
 * @param manager - Animation manager the sprite manager was attached to.
 * @param spriteManager - Sprite animation manager to detach.
 */
export function removeSpriteAnimationManager(manager: AnimationManager, spriteManager: SpriteAnimationManager): void {
    const task = spriteManager._animationTask;
    if (task) {
        removeAnimationTask(manager, task);
    }
}

/**
 * Starts a sprite animation manager on its own autonomous animation loop.
 * @param manager - Sprite animation manager to start.
 * @throws If the manager is already attached to a render loop or another manager.
 */
export function startSpriteAnimationManager(manager: SpriteAnimationManager): void {
    if (manager.running) {
        return;
    }
    assertNoActiveBinding(manager);
    let loopManager = manager._loopManager;
    if (!loopManager) {
        loopManager = createAnimationManager({ fixedDeltaMs: manager.fixedDeltaMs, onUpdate: manager._onUpdate });
        manager._loopManager = loopManager;
    }
    loopManager.fixedDeltaMs = manager.fixedDeltaMs;
    if (manager._animationManager !== loopManager) {
        addAnimationTask(loopManager, getSpriteAnimationTask(manager));
        manager._animationManager = loopManager;
    }
    startAnimationManager(loopManager);
    manager.running = loopManager.running;
}

/**
 * Stops a sprite animation manager started with {@link startSpriteAnimationManager}.
 * @param manager - Sprite animation manager to stop.
 */
export function stopSpriteAnimationManager(manager: SpriteAnimationManager): void {
    const loopManager = manager._loopManager;
    if (!loopManager) {
        manager.running = false;
        return;
    }
    stopAnimationManager(loopManager);
    const task = manager._animationTask;
    if (task) {
        removeAnimationTask(loopManager, task);
    }
    manager.running = false;
}

function assertNoActiveBinding(manager: SpriteAnimationManager): void {
    if (manager._binding?.active) {
        throw new Error("SpriteAnimationManager is already attached to a render loop.");
    }
    if (manager._animationManager && manager._animationManager !== manager._loopManager) {
        throw new Error("SpriteAnimationManager is already attached to an AnimationManager.");
    }
}

function assertCanAttachToAnimationManager(manager: SpriteAnimationManager): void {
    if (manager.running) {
        throw new Error("SpriteAnimationManager is already running autonomously.");
    }
    if (manager._binding?.active) {
        throw new Error("SpriteAnimationManager is already attached to a render loop.");
    }
    if (manager._animationManager) {
        throw new Error("SpriteAnimationManager is already attached to an AnimationManager.");
    }
}
