/** Optional Babylon.js-style frame animation core for sprite families. */
import { startAnimationLoop, stopAnimationLoop } from "../animation/animation-loop.js";
import type { SceneContextInternal } from "../scene/scene-core.js";
import type { SceneContext } from "../scene/scene.js";
import type { SpriteRenderer } from "./sprite-renderer.js";

export interface SpriteAnimationTarget {
    readonly setFrame: (frame: number) => void;
    readonly remove?: () => void;
    readonly isAlive?: () => boolean;
}

export interface PlaySpriteAnimationOptions {
    readonly onEnd?: () => void;
    readonly removeWhenFinished?: boolean;
}

export interface SpriteFrameAnimation {
    readonly _entityType: "sprite-frame-animation";
    readonly target: SpriteAnimationTarget;
    from: number;
    to: number;
    current: number;
    loop: boolean;
    delayMs: number;
    accumulatedMs: number;
    animationStarted: boolean;
    onEnd?: () => void;
    removeWhenFinished: boolean;
    _owner?: SpriteAnimationManager;
    _direction: 1 | -1;
}

export interface SpriteAnimationManagerOptions {
    readonly fixedDeltaMs?: number;
    readonly onUpdate?: (deltaMs: number) => void;
}

export interface SpriteAnimationManager {
    readonly _entityType: "sprite-animation-manager";
    animations: SpriteFrameAnimation[];
    fixedDeltaMs: number;
    running: boolean;
    readonly onUpdate?: (deltaMs: number) => void;
    _rafId: number;
    _lastTime: number;
    _binding?: SpriteAnimationBinding;
}

export interface SpriteAnimationBinding {
    readonly _entityType: "sprite-animation-binding";
    active: boolean;
    _dispose: () => void;
}

function normalizeDelay(delayMs: number): number {
    return Number.isFinite(delayMs) && delayMs > 1 ? delayMs : 1;
}

export function createSpriteAnimationManager(options?: SpriteAnimationManagerOptions): SpriteAnimationManager {
    return {
        _entityType: "sprite-animation-manager",
        animations: [],
        fixedDeltaMs: options?.fixedDeltaMs ?? 0,
        running: false,
        onUpdate: options?.onUpdate,
        _rafId: 0,
        _lastTime: 0,
    };
}

export function createSpriteFrameAnimation(
    target: SpriteAnimationTarget,
    from: number,
    to: number,
    loop: boolean,
    delayMs: number,
    options?: PlaySpriteAnimationOptions
): SpriteFrameAnimation {
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
        throw new Error("Sprite frame animation requires finite from/to frame indices.");
    }
    const fromFrame = Math.trunc(from);
    const toFrame = Math.trunc(to);
    const animation: SpriteFrameAnimation = {
        _entityType: "sprite-frame-animation",
        target,
        from: fromFrame,
        to: toFrame,
        current: fromFrame,
        loop,
        delayMs: normalizeDelay(delayMs),
        accumulatedMs: 0,
        animationStarted: true,
        onEnd: options?.onEnd,
        removeWhenFinished: options?.removeWhenFinished === true,
        _direction: fromFrame > toFrame ? -1 : 1,
    };
    target.setFrame(fromFrame);
    return animation;
}

/** Add an animation to a manager, transferring ownership if it already belongs to another manager. */
export function addSpriteAnimation(manager: SpriteAnimationManager, animation: SpriteFrameAnimation): void {
    if (animation._owner === manager) {
        return;
    }
    if (animation._owner) {
        removeSpriteAnimation(animation._owner, animation);
    }
    animation._owner = manager;
    manager.animations.push(animation);
}

export function playSpriteTargetAnimation(
    manager: SpriteAnimationManager,
    target: SpriteAnimationTarget,
    from: number,
    to: number,
    loop: boolean,
    delayMs: number,
    options?: PlaySpriteAnimationOptions
): SpriteFrameAnimation {
    const animation = createSpriteFrameAnimation(target, from, to, loop, delayMs, options);
    addSpriteAnimation(manager, animation);
    return animation;
}

export function removeSpriteAnimation(manager: SpriteAnimationManager, animation: SpriteFrameAnimation): void {
    const index = manager.animations.indexOf(animation);
    if (index !== -1) {
        manager.animations.splice(index, 1);
    }
    if (animation._owner === manager) {
        animation._owner = undefined;
    }
}

export function clearSpriteAnimations(manager: SpriteAnimationManager): void {
    for (const animation of manager.animations) {
        if (animation._owner === manager) {
            animation._owner = undefined;
        }
    }
    manager.animations.length = 0;
}

/** Replay an animation; omit options to keep callbacks/removal, pass options to overwrite them, or `{}` to clear them. */
export function playSpriteFrameAnimation(
    animation: SpriteFrameAnimation,
    from = animation.from,
    to = animation.to,
    loop = animation.loop,
    delayMs = animation.delayMs,
    options?: PlaySpriteAnimationOptions
): void {
    const fromFrame = Math.trunc(from);
    const toFrame = Math.trunc(to);
    animation.from = fromFrame;
    animation.to = toFrame;
    animation.current = fromFrame;
    animation.loop = loop;
    animation.delayMs = normalizeDelay(delayMs);
    animation.accumulatedMs = 0;
    animation.animationStarted = true;
    if (options !== undefined) {
        animation.onEnd = options.onEnd;
        animation.removeWhenFinished = options.removeWhenFinished === true;
    }
    animation._direction = fromFrame > toFrame ? -1 : 1;
    animation.target.setFrame(fromFrame);
}

export function stopSpriteAnimation(animation: SpriteFrameAnimation): void {
    animation.animationStarted = false;
}

export function updateSpriteAnimationManager(manager: SpriteAnimationManager, deltaMs: number): void {
    const stepMs = manager.fixedDeltaMs > 0 ? manager.fixedDeltaMs : deltaMs;
    if (!Number.isFinite(stepMs) || stepMs < 0) {
        return;
    }
    const animations = manager.animations;
    for (let index = animations.length - 1; index >= 0; index--) {
        const animation = animations[index]!;
        if (!advanceSpriteAnimation(animation, stepMs)) {
            removeSpriteAnimationAt(manager, index);
        }
    }
}

function removeSpriteAnimationAt(manager: SpriteAnimationManager, index: number): void {
    const animation = manager.animations[index]!;
    manager.animations.splice(index, 1);
    if (animation._owner === manager) {
        animation._owner = undefined;
    }
}

function advanceSpriteAnimation(animation: SpriteFrameAnimation, deltaMs: number): boolean {
    if (animation.target.isAlive?.() === false) {
        animation.animationStarted = false;
        return false;
    }
    if (!animation.animationStarted) {
        return true;
    }

    animation.accumulatedMs += deltaMs;
    // Match Babylon ThinSprite timing: exact delay does not step, and each update advances at most one frame.
    if (animation.accumulatedMs <= animation.delayMs) {
        return true;
    }

    animation.accumulatedMs = animation.accumulatedMs % animation.delayMs;
    const next = animation.current + animation._direction;
    const passedEnd = animation._direction > 0 ? next > animation.to : next < animation.to;
    if (!passedEnd) {
        animation.current = next;
        animation.target.setFrame(next);
        return true;
    }

    if (animation.loop) {
        animation.current = animation.from;
        animation.target.setFrame(animation.from);
        return true;
    }

    animation.current = animation.to;
    animation.target.setFrame(animation.to);
    animation.animationStarted = false;
    animation.onEnd?.();
    if (animation.removeWhenFinished) {
        animation.target.remove?.();
    }
    return false;
}

export function startSpriteAnimationManager(manager: SpriteAnimationManager): void {
    assertNoActiveBinding(manager);
    startAnimationLoop(manager, (deltaMs) => updateSpriteAnimationManager(manager, deltaMs), "SpriteAnimationManager autonomous mode requires requestAnimationFrame.");
}

export function stopSpriteAnimationManager(manager: SpriteAnimationManager): void {
    stopAnimationLoop(manager);
}

export function attachSpriteAnimationsToScene(scene: SceneContext, manager: SpriteAnimationManager): SpriteAnimationBinding {
    assertCanAttachToRenderLoop(manager);
    const sceneInternal = scene as SceneContextInternal;
    const hook = (deltaMs: number): void => {
        updateSpriteAnimationManager(manager, deltaMs);
    };
    // Run before user hooks so same-frame readers observe updated sprite frames.
    sceneInternal._beforeRender.unshift(hook);

    const binding: SpriteAnimationBinding = {
        _entityType: "sprite-animation-binding",
        active: true,
        _dispose: () => {
            const index = sceneInternal._beforeRender.indexOf(hook);
            if (index !== -1) {
                sceneInternal._beforeRender.splice(index, 1);
            }
            if (manager._binding === binding) {
                manager._binding = undefined;
            }
        },
    };
    manager._binding = binding;
    return binding;
}

export function attachSpriteAnimationsToRenderer(renderer: SpriteRenderer, manager: SpriteAnimationManager): SpriteAnimationBinding {
    assertCanAttachToRenderLoop(manager);
    const hook = (deltaMs: number): void => {
        updateSpriteAnimationManager(manager, deltaMs);
    };
    renderer._beforeUpdate.push(hook);

    const binding: SpriteAnimationBinding = {
        _entityType: "sprite-animation-binding",
        active: true,
        _dispose: () => {
            const index = renderer._beforeUpdate.indexOf(hook);
            if (index !== -1) {
                renderer._beforeUpdate.splice(index, 1);
            }
            if (manager._binding === binding) {
                manager._binding = undefined;
            }
        },
    };
    manager._binding = binding;
    return binding;
}

export function disposeSpriteAnimationBinding(binding: SpriteAnimationBinding): void {
    if (!binding.active) {
        return;
    }
    binding.active = false;
    binding._dispose();
}

function assertNoActiveBinding(manager: SpriteAnimationManager): void {
    if (manager._binding?.active) {
        throw new Error("SpriteAnimationManager is already attached to a render loop.");
    }
}

function assertCanAttachToRenderLoop(manager: SpriteAnimationManager): void {
    if (manager.running) {
        throw new Error("SpriteAnimationManager is already running autonomously.");
    }
    assertNoActiveBinding(manager);
}
