import type { Skeleton } from "./bone-control.js";

/** Clear all authored bone overrides and upload the skeleton's rest pose once. */
export function resetSkeletonToRest(skeleton: Skeleton): void {
    skeleton._overrides.clear();
    skeleton._worldOverrides.clear();
    skeleton._bake();
}
