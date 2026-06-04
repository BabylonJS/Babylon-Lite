import type { AnimationGroup } from "./animation-group.js";

/** Set the weighted contribution for an animation group. Feature-specific mixers remain explicit opt-ins. */
export function setAnimationWeight(group: AnimationGroup, weight: number): void {
    if (!Number.isFinite(weight) || weight < 0 || weight > 1) {
        throw new Error(`Animation weight must be a finite number between 0 and 1, got ${weight}`);
    }
    group.weight = weight;
}
