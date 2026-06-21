// AnimationGroupMask — include/exclude animation targets by name.
// Mirrors Babylon.js AnimationGroupMask / AnimationGroupMaskMode: a mask is
// attached to an AnimationGroup (group.mask) and filters which targets animate.
// Pure state — no methods; behaviour lives in standalone functions.
//
// Fully opt-in: the first call to `createAnimationGroupMask` installs the resolver
// the animation controller uses to skip masked targets. Animated scenes that never
// create a mask don't pull this module, so the controller's masking branch folds
// away — they stay byte-identical.

import { _installAnimationMaskResolver } from "../skeleton/skeleton-updater.js";

/** Mode controlling how an {@link AnimationGroupMask} filters targets. */
export enum AnimationGroupMaskMode {
    /** Only the listed target names animate; every other target stays at its bind/rest pose. */
    Include = 0,
    /** Every target animates except the listed names (which stay at their bind/rest pose). */
    Exclude = 1,
}

/**
 * Filter applied to an {@link AnimationGroup} (via `group.mask`) that restricts which
 * targets the group animates, matched by target name.
 *
 * A target is identified by its name (the glTF node / bone name). The same mask can be
 * reused across animation groups whose targets are named the same way. Matching is exact
 * and case-sensitive. Masked-out targets are left untouched and therefore stay at their
 * bind/rest pose (matching Babylon.js, which pauses those targets).
 *
 * Pure state: create with {@link createAnimationGroupMask} and read membership with
 * {@link animationGroupMaskRetainsTarget}. To change an active mask, toggle `mode` or
 * `disabled`, or replace the `names` array (assign a new array, or push/pop): the
 * controller re-resolves whenever `mode`, `disabled`, the `names` array reference, or
 * its length changes. Editing `names` in place at the same length (e.g. `names[0] = …`
 * or reordering) is NOT detected — assign a new `names` array, or reassign `group.mask`,
 * to apply such a change.
 */
export interface AnimationGroupMask {
    /** How `names` is interpreted (Include vs Exclude). */
    mode: AnimationGroupMaskMode;
    /** Target (node/bone) names listed by the mask. */
    names: string[];
    /** When true the mask is ignored and every target animates (default false). */
    disabled: boolean;
}

/**
 * Whether the mask retains (keeps animating) the given target name.
 *
 * Mirrors Babylon.js `AnimationGroupMask.retainsTarget`: in Include mode a name is
 * retained when it is listed; in Exclude mode a name is retained when it is NOT listed.
 * A disabled mask retains every name.
 * @param mask - The mask to query.
 * @param name - The target (node/bone) name to test.
 * @returns True if a target with this name should animate, false if it is masked out.
 */
export function animationGroupMaskRetainsTarget(mask: AnimationGroupMask, name: string): boolean {
    if (mask.disabled) {
        return true;
    }
    return (mask.names.indexOf(name) !== -1) === (mask.mode === AnimationGroupMaskMode.Include);
}

/** Resolver installed into the animation controller: fills `out[i]=1` for every node
 *  index `i` whose channels must be skipped (masked out), `0` for retained nodes. */
function resolveAnimationMask(mask: AnimationGroupMask, nodeNames: readonly (string | undefined)[], out: Uint8Array, numNodes: number): void {
    for (let i = 0; i < numNodes; i++) {
        out[i] = animationGroupMaskRetainsTarget(mask, nodeNames[i] ?? "") ? 0 : 1;
    }
}

/**
 * Create an {@link AnimationGroupMask}.
 * @param names - Target names listed by the mask (copied). Defaults to empty.
 * @param mode - Include (only listed names animate) or Exclude (all but listed names animate).
 *               Defaults to {@link AnimationGroupMaskMode.Include}.
 * @returns A new mask. Assign it to `animationGroup.mask`.
 */
export function createAnimationGroupMask(names: string[] = [], mode: AnimationGroupMaskMode = AnimationGroupMaskMode.Include): AnimationGroupMask {
    // Activate the controller's masking path the first time any mask is created. Scenes
    // that never call this keep the resolver null, so the masking branch tree-shakes.
    _installAnimationMaskResolver(resolveAnimationMask);
    return { mode, names: names.slice(), disabled: false };
}
