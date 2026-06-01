/**
 * Optional Sprite2D raw-index frame animation helper.
 * Keeps zero-handle slot animation separate from stable-handle tracking.
 */
import { playSpriteTargetAnimation } from "./sprite-animation.js";
import type { PlaySpriteAnimationOptions, SpriteAnimationManager, SpriteFrameAnimation } from "./sprite-animation.js";
import type { Sprite2DLayer } from "./sprite-2d.js";
import { removeSprite2DIndex, setSprite2DFrameIndex } from "./sprite-2d.js";

/**
 * Play a frame animation against a raw Sprite2D slot index.
 *
 * This is the zero-handle, slot-based path for structurally stable layers.
 * If the slot is swap-removed externally, the animation follows whatever
 * sprite later occupies the same index. Use `playSprite2DAnimation` with a
 * handle when animation must track a stable sprite identity across removals.
 */
export function playSprite2DIndexAnimation(
    manager: SpriteAnimationManager,
    layer: Sprite2DLayer,
    index: number,
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
                setSprite2DFrameIndex(layer, index, frame);
            },
            remove(): void {
                removeSprite2DIndex(layer, index);
            },
            isAlive(): boolean {
                return index >= 0 && index < layer.count;
            },
        },
        from,
        to,
        loop,
        delayMs,
        options
    );
}
