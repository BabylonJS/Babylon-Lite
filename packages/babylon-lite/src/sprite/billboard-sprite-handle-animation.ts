/**
 * Optional billboard stable-handle frame animation helper.
 * Imports handle tracking only when callers opt into this entry point.
 */
import { playSpriteTargetAnimation } from "./sprite-animation.js";
import type { PlaySpriteAnimationOptions, SpriteAnimationManager, SpriteFrameAnimation } from "./sprite-animation.js";
import type { BillboardSpriteHandle } from "./billboard-sprite-handle.js";
import { isBillboardSpriteHandleAlive, removeBillboardSprite, setBillboardSpriteFrame } from "./billboard-sprite-handle.js";

/**
 * Plays a frame animation on a billboard sprite addressed by its stable handle.
 * The handle is resolved each tick, so the animation survives swap-remove reindexing.
 * @param manager - Animation manager that drives the playback.
 * @param handle - Stable handle of the billboard sprite to animate.
 * @param from - First frame index of the range.
 * @param to - Last frame index of the range.
 * @param loop - When `true`, the animation restarts after reaching `to`.
 * @param delayMs - Delay in milliseconds between frame steps.
 * @param options - Optional end callback and removal behaviour.
 * @returns The created sprite frame animation.
 */
export function playBillboardSpriteAnimation(
    manager: SpriteAnimationManager,
    handle: BillboardSpriteHandle,
    from: number,
    to: number,
    loop: boolean,
    delayMs: number,
    options?: PlaySpriteAnimationOptions
): SpriteFrameAnimation {
    return playSpriteTargetAnimation(
        manager,
        {
            setFrame(frame): void {
                setBillboardSpriteFrame(handle, frame);
            },
            remove(): void {
                removeBillboardSprite(handle);
            },
            isAlive(): boolean {
                return isBillboardSpriteHandleAlive(handle);
            },
        },
        from,
        to,
        loop,
        delayMs,
        options
    );
}
