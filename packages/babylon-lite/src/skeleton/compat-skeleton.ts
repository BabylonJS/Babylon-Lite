import type { Skeleton } from "./bone-control.js";

/** Clear all authored bone overrides and upload the skeleton's rest pose once. */
export function resetSkeletonToRest(skeleton: Skeleton): void {
    for (const bone of skeleton.bones) {
        skeleton._overrides.delete(bone._nodeIndex);
        skeleton._worldOverrides.delete(bone._nodeIndex);
    }
    skeleton._bake();
}
