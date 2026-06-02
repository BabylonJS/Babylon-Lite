export const PLAYER_SPRITE_URL = "/textures/sprites/player.png";

export const PLAYER_SPRITE_INFO = {
    textureWidthPx: 1408,
    textureHeightPx: 192,
    frameWidthPx: 64,
    frameHeightPx: 64,
    columns: 22,
    rows: 3,
    frameCount: 66,
    runStartFrame: 0,
    runFrameCount: 11,
    runEndFrame: 10,
    delayMs: 90,
} as const;

export const PLAYER_SPRITE_SEEK_STEP_MS = 1000 / 60;

/**
 * BJS-reference copy of the Lite sprite frame timing rules.
 * Keep this in sync with `advanceSpriteAnimation` in the engine core.
 */

export interface ManualSpriteAnimationTarget {
    cellIndex: number;
    isVisible: boolean;
}

export interface ManualSpriteAnimation {
    target: ManualSpriteAnimationTarget;
    from: number;
    to: number;
    current: number;
    loop: boolean;
    delayMs: number;
    accumulatedMs: number;
    active: boolean;
    removeWhenFinished: boolean;
    direction: 1 | -1;
}

export function createManualSpriteAnimation(
    target: ManualSpriteAnimationTarget,
    from: number,
    to: number,
    loop: boolean,
    delayMs: number,
    removeWhenFinished = false
): ManualSpriteAnimation {
    const fromFrame = Math.trunc(from);
    const toFrame = Math.trunc(to);
    target.cellIndex = fromFrame;
    target.isVisible = true;
    return {
        target,
        from: fromFrame,
        to: toFrame,
        current: fromFrame,
        loop,
        delayMs,
        accumulatedMs: 0,
        active: true,
        removeWhenFinished,
        direction: fromFrame > toFrame ? -1 : 1,
    };
}

export function updateManualSpriteAnimations(animations: ManualSpriteAnimation[], deltaMs: number): void {
    if (!Number.isFinite(deltaMs) || deltaMs < 0) {
        return;
    }

    for (let index = animations.length - 1; index >= 0; index--) {
        if (!advanceManualSpriteAnimation(animations[index]!, deltaMs)) {
            animations.splice(index, 1);
        }
    }
}

export function seekManualSpriteAnimations(animations: ManualSpriteAnimation[], seekTimeSeconds: number): void {
    const stepCount = getPlayerSpriteSeekStepCount(seekTimeSeconds);
    for (let stepIndex = 0; stepIndex < stepCount; stepIndex++) {
        updateManualSpriteAnimations(animations, PLAYER_SPRITE_SEEK_STEP_MS);
    }
}

export function getPlayerSpriteSeekStepCount(seekTimeSeconds: number): number {
    if (!Number.isFinite(seekTimeSeconds) || seekTimeSeconds <= 0) {
        return 0;
    }
    return Math.floor(seekTimeSeconds * 60);
}

function advanceManualSpriteAnimation(animation: ManualSpriteAnimation, deltaMs: number): boolean {
    if (!animation.active) {
        return true;
    }

    animation.accumulatedMs += deltaMs;
    if (animation.accumulatedMs <= animation.delayMs) {
        return true;
    }

    animation.accumulatedMs = animation.accumulatedMs % animation.delayMs;
    const nextFrame = animation.current + animation.direction;
    const passedEnd = animation.direction > 0 ? nextFrame > animation.to : nextFrame < animation.to;
    if (!passedEnd) {
        animation.current = nextFrame;
        animation.target.cellIndex = nextFrame;
        return true;
    }

    if (animation.loop) {
        animation.current = animation.from;
        animation.target.cellIndex = animation.from;
        return true;
    }

    animation.current = animation.to;
    animation.target.cellIndex = animation.to;
    animation.active = false;
    if (animation.removeWhenFinished) {
        animation.target.isVisible = false;
    }
    return false;
}