/** Optional Babylon.js-style frame animation core for sprite families. */
import type { SceneContext } from "../scene/scene-core.js";
import type { SpriteRenderer } from "./sprite-renderer.js";

/** Abstracts the sprite a frame animation drives, decoupling the animation core from each sprite family. */
export interface SpriteAnimationTarget {
    /** Sets the target's current atlas frame. */
    readonly setFrame: (frame: number) => void;
    /** Optional. Removes the target from its system, used when `removeWhenFinished` is set. */
    readonly remove?: () => void;
    /** Optional. Returns `false` when the target no longer exists, stopping the animation. */
    readonly isAlive?: () => boolean;
}

/** Optional callbacks and behaviour applied when starting a sprite frame animation. */
export interface PlaySpriteAnimationOptions {
    /** Optional. Called once when a non-looping animation reaches its last frame. */
    readonly onEnd?: () => void;
    readonly removeWhenFinished?: boolean;
}

/** A single frame-range animation playing on a {@link SpriteAnimationTarget}. */
export interface SpriteFrameAnimation {
    /** @internal */
    readonly _entityType: "sprite-frame-animation";
    readonly target: SpriteAnimationTarget;
    from: number;
    to: number;
    current: number;
    loop: boolean;
    delayMs: number;
    accumulatedMs: number;
    animationStarted: boolean;
    /** Optional. Called once when a non-looping animation reaches its last frame. */
    onEnd?: () => void;
    removeWhenFinished: boolean;
}

/** Optional configuration for a sprite animation manager. */
export interface SpriteAnimationManagerOptions {
    readonly fixedDeltaMs?: number;
    /** Optional. Called each tick of the manager's autonomous loop with the elapsed milliseconds. */
    readonly onUpdate?: (deltaMs: number) => void;
}

/** Owns a set of sprite frame animations and advances them in lockstep. */
export interface SpriteAnimationManager {
    /** @internal */
    readonly _entityType: "sprite-animation-manager";
    animations: SpriteFrameAnimation[];
    fixedDeltaMs: number;
    running: boolean;
    /** @internal */
    readonly _onUpdate?: (deltaMs: number) => void;
    /** @internal */
    _binding?: SpriteAnimationBinding;
    /** @internal */
    _animationManager?: import("../animation/animation-manager.js").AnimationManager;
    /** @internal */
    _loopManager?: import("../animation/animation-manager.js").AnimationManager;
    /** @internal Animation task created by sprite-animation-task. */
    _animationTask?: import("../animation/animation-manager.js").AnimationTask;
}

/** Handle to a sprite animation manager attached to a scene or renderer; dispose it to detach. */
export interface SpriteAnimationBinding {
    /** @internal */
    readonly _entityType: "sprite-animation-binding";
    active: boolean;
    /** @internal */
    _dispose: () => void;
}

let spriteAnimationOwners: WeakMap<SpriteFrameAnimation, SpriteAnimationManager> | undefined;

function getSpriteAnimationOwners(): WeakMap<SpriteFrameAnimation, SpriteAnimationManager> {
    if (!spriteAnimationOwners) {
        spriteAnimationOwners = new WeakMap();
    }
    return spriteAnimationOwners;
}

function getSpriteAnimationOwner(animation: SpriteFrameAnimation): SpriteAnimationManager | undefined {
    return spriteAnimationOwners?.get(animation);
}

function setSpriteAnimationOwner(animation: SpriteFrameAnimation, manager: SpriteAnimationManager): void {
    getSpriteAnimationOwners().set(animation, manager);
}

function clearSpriteAnimationOwner(animation: SpriteFrameAnimation): void {
    spriteAnimationOwners?.delete(animation);
}

function normalizeDelay(delayMs: number): number {
    return Number.isFinite(delayMs) && delayMs > 1 ? delayMs : 1;
}

/**
 * Creates an empty sprite animation manager.
 * @param options - Optional fixed time step and per-tick update callback.
 * @returns The new manager.
 */
export function createSpriteAnimationManager(options?: SpriteAnimationManagerOptions): SpriteAnimationManager {
    const manager: SpriteAnimationManager = {
        _entityType: "sprite-animation-manager",
        animations: [],
        fixedDeltaMs: options?.fixedDeltaMs ?? 0,
        running: false,
        _onUpdate: options?.onUpdate,
    };
    return manager;
}

/**
 * Creates a sprite frame animation and immediately shows its first frame.
 * @param target - Sprite the animation drives.
 * @param from - First frame index of the range.
 * @param to - Last frame index of the range; may be less than `from` to play in reverse.
 * @param loop - When `true`, the animation restarts after reaching `to`.
 * @param delayMs - Delay in milliseconds between frame steps.
 * @param options - Optional end callback and removal behaviour.
 * @returns The new animation, not yet attached to any manager.
 * @throws If `from` or `to` is not finite.
 */
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
    };
    target.setFrame(fromFrame);
    return animation;
}

/** Add an animation to a manager, transferring ownership if it already belongs to another manager. */
export function addSpriteAnimation(manager: SpriteAnimationManager, animation: SpriteFrameAnimation): void {
    const owner = getSpriteAnimationOwner(animation);
    if (owner === manager) {
        return;
    }
    if (owner) {
        removeSpriteAnimation(owner, animation);
    }
    setSpriteAnimationOwner(animation, manager);
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

/**
 * Removes an animation from a manager and clears its ownership if the manager owns it.
 * @param manager - Manager to remove the animation from.
 * @param animation - Animation to remove.
 */
export function removeSpriteAnimation(manager: SpriteAnimationManager, animation: SpriteFrameAnimation): void {
    const index = manager.animations.indexOf(animation);
    if (index !== -1) {
        manager.animations.splice(index, 1);
    }
    if (getSpriteAnimationOwner(animation) === manager) {
        clearSpriteAnimationOwner(animation);
    }
}

/**
 * Removes every animation owned by the manager, leaving it empty.
 * @param manager - Manager to clear.
 */
export function clearSpriteAnimations(manager: SpriteAnimationManager): void {
    for (const animation of manager.animations) {
        if (getSpriteAnimationOwner(animation) === manager) {
            clearSpriteAnimationOwner(animation);
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
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
        throw new Error("Sprite frame animation requires finite from/to frame indices.");
    }
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
    animation.target.setFrame(fromFrame);
}

/**
 * Pauses an animation without removing it; it can be resumed with `playSpriteFrameAnimation`.
 * @param animation - Animation to stop.
 */
export function stopSpriteAnimation(animation: SpriteFrameAnimation): void {
    animation.animationStarted = false;
}

/**
 * Advances every animation in the manager by one time step, removing those that have finished.
 * Uses the manager's `fixedDeltaMs` when set, otherwise `deltaMs`.
 * @param manager - Manager to update.
 * @param deltaMs - Elapsed time in milliseconds since the last update.
 */
export function updateSpriteAnimationManager(manager: SpriteAnimationManager, deltaMs: number): void {
    const stepMs = manager.fixedDeltaMs > 0 ? manager.fixedDeltaMs : deltaMs;
    if (!Number.isFinite(stepMs) || stepMs < 0) {
        return;
    }
    // Snapshot the list so onEnd callbacks (invoked from advanceSpriteAnimation)
    // can safely clear or remove animations from the same manager without
    // corrupting iteration, and remove finished animations by identity rather
    // than by a possibly-stale index.
    const animations = manager.animations.slice();
    for (const animation of animations) {
        if (!advanceSpriteAnimation(animation, stepMs)) {
            removeSpriteAnimation(manager, animation);
        }
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
    const direction = animation.from > animation.to ? -1 : 1;
    const next = animation.current + direction;
    const passedEnd = direction > 0 ? next > animation.to : next < animation.to;
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

/**
 * Attaches a manager to a scene's before-render hooks so its animations advance each frame.
 * @param scene - Scene whose render loop drives the manager.
 * @param manager - Sprite animation manager to attach.
 * @returns A binding that detaches the manager when disposed.
 * @throws If the manager is already running or attached elsewhere.
 */
export function attachSpriteAnimationsToScene(scene: SceneContext, manager: SpriteAnimationManager): SpriteAnimationBinding {
    assertCanAttachToRenderLoop(manager);
    const hook = (deltaMs: number): void => {
        updateSpriteAnimationManager(manager, deltaMs);
    };
    // Run before hooks currently registered on the scene; later onBeforeRender calls can still prepend ahead of it.
    scene._beforeRender.unshift(hook);

    const binding: SpriteAnimationBinding = {
        _entityType: "sprite-animation-binding",
        active: true,
        _dispose: () => {
            const index = scene._beforeRender.indexOf(hook);
            if (index !== -1) {
                scene._beforeRender.splice(index, 1);
            }
            if (manager._binding === binding) {
                manager._binding = undefined;
            }
        },
    };
    manager._binding = binding;
    scene._disposables.push(() => disposeSpriteAnimationBinding(binding));
    return binding;
}

/**
 * Attaches a manager to a sprite renderer's update hooks so its animations advance each frame.
 * @param renderer - Sprite renderer whose update loop drives the manager.
 * @param manager - Sprite animation manager to attach.
 * @returns A binding that detaches the manager when disposed.
 * @throws If the manager is already running or attached elsewhere.
 */
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
            const disposeIndex = renderer._disposeCallbacks.indexOf(disposeWithRenderer);
            if (disposeIndex !== -1) {
                renderer._disposeCallbacks.splice(disposeIndex, 1);
            }
            if (manager._binding === binding) {
                manager._binding = undefined;
            }
        },
    };
    function disposeWithRenderer(): void {
        disposeSpriteAnimationBinding(binding);
    }
    manager._binding = binding;
    renderer._disposeCallbacks.push(disposeWithRenderer);
    return binding;
}

/**
 * Detaches a binding created by {@link attachSpriteAnimationsToScene} or
 * {@link attachSpriteAnimationsToRenderer}. Safe to call more than once.
 * @param binding - Binding to dispose.
 */
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
    if (manager._animationManager && manager._animationManager !== manager._loopManager) {
        throw new Error("SpriteAnimationManager is already attached to an AnimationManager.");
    }
}

function assertCanAttachToRenderLoop(manager: SpriteAnimationManager): void {
    if (manager.running) {
        throw new Error("SpriteAnimationManager is already running autonomously.");
    }
    assertNoActiveBinding(manager);
}
