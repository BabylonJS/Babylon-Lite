import type { SpriteAnimationManager } from "babylon-lite";
import { updateSpriteAnimationManager } from "babylon-lite";
import { getPlayerSpriteSeekStepCount, PLAYER_SPRITE_SEEK_STEP_MS } from "./player-sprite";

export function seekSpriteAnimationManager(manager: SpriteAnimationManager, seekTimeSeconds: number): void {
    const stepCount = getPlayerSpriteSeekStepCount(seekTimeSeconds);
    for (let stepIndex = 0; stepIndex < stepCount; stepIndex++) {
        updateSpriteAnimationManager(manager, PLAYER_SPRITE_SEEK_STEP_MS);
    }
}
