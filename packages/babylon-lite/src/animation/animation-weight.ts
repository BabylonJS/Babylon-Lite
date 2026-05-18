import type { AnimationGroup } from "./animation-group.js";
import { getAnimationGroupOwner } from "./animation-manager-core.js";
import type { AnimationManager } from "./animation-manager-core.js";
import {
    attachWeightedAnimationMixer,
    crossFadeAnimationGroups as crossFadeAnimationGroupsCore,
    fadeAnimationWeight as fadeAnimationWeightCore,
} from "./weighted-pointer-mixer.js";
import type { CrossFadeAnimationGroupsOptions, FadeAnimationWeightOptions } from "./weighted-pointer-mixer.js";

/** Set the weighted contribution for an animation group and enable manager-side mixing. */
export function setAnimationWeight(group: AnimationGroup, weight: number): void {
    if (!Number.isFinite(weight) || weight < 0 || weight > 1) {
        throw new Error(`Animation weight must be a finite number between 0 and 1, got ${weight}`);
    }
    group.weight = weight;

    const owner = getAnimationGroupOwner(group);
    if (owner) {
        attachWeightedAnimationMixer(owner);
    }
}

/** Fade one animation group's weight to a target value over a deterministic duration. */
export function fadeAnimationWeight(manager: AnimationManager, group: AnimationGroup, options: FadeAnimationWeightOptions): void {
    fadeAnimationWeightCore(manager, group, options);
}

/** Cross-fade two animation groups by fading the source out and destination in. */
export function crossFadeAnimationGroups(manager: AnimationManager, fromGroup: AnimationGroup, toGroup: AnimationGroup, options: CrossFadeAnimationGroupsOptions): void {
    crossFadeAnimationGroupsCore(manager, fromGroup, toGroup, options);
}

export type { CrossFadeAnimationGroupsOptions, FadeAnimationWeightOptions } from "./weighted-pointer-mixer.js";
