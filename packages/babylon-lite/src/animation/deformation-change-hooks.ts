import type { MorphTargetData, SkeletonData } from "./types.js";

/**
 * Optional bridge from deformation writers to shadow invalidation. Animation code imports
 * only this small module; the lazily loaded deformable-bounds chunk installs the callback,
 * so applications without deformable shadow casters keep the hook null and avoid the
 * shadow tracking implementation entirely.
 *
 * `source` plus `poseToken` lets the installed tracker deduplicate shared deformation data
 * reached repeatedly by the same animation controller at the same pose.
 *
 * @internal
 */
export type DeformationChangeNotifier = (data: SkeletonData | MorphTargetData | undefined, source?: object, poseToken?: number) => void;

/** @internal Shadow-owned deformation notifier. Null until deformable shadow casters are enabled. */
export let _deformationChangeNotifier: DeformationChangeNotifier | null = null;

/** @internal Install the shadow-owned deformation notifier. */
export function _installDeformationChangeNotifier(notifier: DeformationChangeNotifier): void {
    _deformationChangeNotifier = notifier;
}
