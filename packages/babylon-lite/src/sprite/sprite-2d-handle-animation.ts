/**
 * Optional Sprite2D stable-handle frame animation helper.
 * Imports handle tracking only when callers opt into this entry point.
 */
import { playSpriteTargetAnimation } from "./sprite-animation.js";
import type { PlaySpriteAnimationOptions, SpriteAnimationManager, SpriteFrameAnimation } from "./sprite-animation.js";
import type { Sprite2DHandle } from "./sprite-2d-handle.js";
import { isSprite2DHandleAlive, removeSprite2D, setSprite2DFrame } from "./sprite-2d-handle.js";

export function playSprite2DAnimation(
    manager: SpriteAnimationManager,
    handle: Sprite2DHandle,
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
                setSprite2DFrame(handle, frame);
            },
            remove(): void {
                removeSprite2D(handle);
            },
            isAlive(): boolean {
                return isSprite2DHandleAlive(handle);
            },
        },
        from,
        to,
        loop,
        delayMs,
        options
    );
}
