/** Optional Babylon.js-style frame animation core for sprite families. */
import type { SceneContextInternal } from "../scene/scene-core.js";
import type { SceneContext } from "../scene/scene.js";
import type { SpriteRenderer } from "./sprite-renderer.js";

interface SpriteAnimationRendererInternal extends SpriteRenderer {
    _beforeUpdate: ((deltaMs: number) => void)[];
    _disposeCallbacks: (() => void)[];
}

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
}

export interface SpriteAnimationBinding {
    readonly _entityType: "sprite-animation-binding";
    active: boolean;
}

interface SpriteAnimationManagerInternal extends SpriteAnimationManager {
    readonly onUpdate?: (deltaMs: number) => void;
    _binding?: SpriteAnimationBindingInternal;
    _animationManager?: unknown;
    _loopManager?: unknown;
}

interface SpriteAnimationBindingInternal extends SpriteAnimationBinding {
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

function asSpriteAnimationManagerInternal(manager: SpriteAnimationManager): SpriteAnimationManagerInternal {
    return manager as SpriteAnimationManagerInternal;
}

function normalizeDelay(delayMs: number): number {
    return Number.isFinite(delayMs) && delayMs > 1 ? delayMs : 1;
}

export function createSpriteAnimationManager(options?: SpriteAnimationManagerOptions): SpriteAnimationManager {
    const manager: SpriteAnimationManagerInternal = {
        _entityType: "sprite-animation-manager",
        animations: [],
        fixedDeltaMs: options?.fixedDeltaMs ?? 0,
        running: false,
        onUpdate: options?.onUpdate,
    };
    return manager;
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

export function removeSpriteAnimation(manager: SpriteAnimationManager, animation: SpriteFrameAnimation): void {
    const index = manager.animations.indexOf(animation);
    if (index !== -1) {
        manager.animations.splice(index, 1);
    }
    if (getSpriteAnimationOwner(animation) === manager) {
        clearSpriteAnimationOwner(animation);
    }
}

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

export function stopSpriteAnimation(animation: SpriteFrameAnimation): void {
    animation.animationStarted = false;
}

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

export function attachSpriteAnimationsToScene(scene: SceneContext, manager: SpriteAnimationManager): SpriteAnimationBinding {
    assertCanAttachToRenderLoop(manager);
    const managerInternal = asSpriteAnimationManagerInternal(manager);
    const sceneInternal = scene as SceneContextInternal;
    const hook = (deltaMs: number): void => {
        updateSpriteAnimationManager(manager, deltaMs);
    };
    // Run before hooks currently registered on the scene; later onBeforeRender calls can still prepend ahead of it.
    sceneInternal._beforeRender.unshift(hook);

    const binding: SpriteAnimationBindingInternal = {
        _entityType: "sprite-animation-binding",
        active: true,
        _dispose: () => {
            const index = sceneInternal._beforeRender.indexOf(hook);
            if (index !== -1) {
                sceneInternal._beforeRender.splice(index, 1);
            }
            if (managerInternal._binding === binding) {
                managerInternal._binding = undefined;
            }
        },
    };
    managerInternal._binding = binding;
    sceneInternal._disposables.push(() => disposeSpriteAnimationBinding(binding));
    return binding;
}

export function attachSpriteAnimationsToRenderer(renderer: SpriteRenderer, manager: SpriteAnimationManager): SpriteAnimationBinding {
    assertCanAttachToRenderLoop(manager);
    const managerInternal = asSpriteAnimationManagerInternal(manager);
    const rendererInternal = renderer as SpriteAnimationRendererInternal;
    const hook = (deltaMs: number): void => {
        updateSpriteAnimationManager(manager, deltaMs);
    };
    rendererInternal._beforeUpdate.push(hook);

    const binding: SpriteAnimationBindingInternal = {
        _entityType: "sprite-animation-binding",
        active: true,
        _dispose: () => {
            const index = rendererInternal._beforeUpdate.indexOf(hook);
            if (index !== -1) {
                rendererInternal._beforeUpdate.splice(index, 1);
            }
            const disposeIndex = rendererInternal._disposeCallbacks.indexOf(disposeWithRenderer);
            if (disposeIndex !== -1) {
                rendererInternal._disposeCallbacks.splice(disposeIndex, 1);
            }
            if (managerInternal._binding === binding) {
                managerInternal._binding = undefined;
            }
        },
    };
    function disposeWithRenderer(): void {
        disposeSpriteAnimationBinding(binding);
    }
    managerInternal._binding = binding;
    rendererInternal._disposeCallbacks.push(disposeWithRenderer);
    return binding;
}

export function disposeSpriteAnimationBinding(binding: SpriteAnimationBinding): void {
    if (!binding.active) {
        return;
    }
    binding.active = false;
    (binding as Partial<SpriteAnimationBindingInternal>)._dispose?.();
}

function assertNoActiveBinding(manager: SpriteAnimationManager): void {
    const managerInternal = asSpriteAnimationManagerInternal(manager);
    if (managerInternal._binding?.active) {
        throw new Error("SpriteAnimationManager is already attached to a render loop.");
    }
    if (managerInternal._animationManager && managerInternal._animationManager !== managerInternal._loopManager) {
        throw new Error("SpriteAnimationManager is already attached to an AnimationManager.");
    }
}

function assertCanAttachToRenderLoop(manager: SpriteAnimationManager): void {
    if (asSpriteAnimationManagerInternal(manager).running) {
        throw new Error("SpriteAnimationManager is already running autonomously.");
    }
    assertNoActiveBinding(manager);
}
