/**
 * Optional billboard raw-index frame animation helper.
 * Keeps zero-handle slot animation separate from stable-handle tracking.
 */
import { playSpriteTargetAnimation } from "./sprite-animation.js";
import type { PlaySpriteAnimationOptions, SpriteAnimationManager, SpriteFrameAnimation } from "./sprite-animation.js";
import type { BillboardSpriteSystem } from "./billboard-sprite.js";
import { removeBillboardSpriteIndex, setBillboardSpriteFrameIndex } from "./billboard-sprite.js";

/**
 * Play a frame animation against a raw billboard sprite slot index.
 *
 * This is the zero-handle, slot-based path for structurally stable systems.
 * If the slot is swap-removed externally, the animation follows whatever
 * sprite later occupies the same index. Use `playBillboardSpriteAnimation`
 * with a handle when animation must track a stable sprite identity across removals.
 */
export function playBillboardSpriteIndexAnimation(
    manager: SpriteAnimationManager,
    system: BillboardSpriteSystem,
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
                setBillboardSpriteFrameIndex(system, index, frame);
            },
            remove(): void {
                removeBillboardSpriteIndex(system, index);
            },
            isAlive(): boolean {
                return index >= 0 && index < system.count;
            },
        },
        from,
        to,
        loop,
        delayMs,
        options
    );
}
