import { _installDeformationChangeNotifier } from "../animation/deformation-change-hooks.js";
import type { MorphTargetData, SkeletonData } from "../animation/types.js";

type DeformationData = SkeletonData | MorphTargetData;

function notifyShadowCasterChanged(data: DeformationData | undefined, source?: object, poseToken?: number): void {
    data?._onShadowCasterChanged?.(source, poseToken);
}

/** Install shadow-owned dirty tracking for one lazily enabled deformation source. */
export function enableDeformationCasterTracking(data: DeformationData | undefined): void {
    if (data && !data._onShadowCasterChanged) {
        let poseTokens: WeakMap<object, number> | undefined;
        data._shadowVersion = 0;
        data._onShadowCasterChanged = (source?: object, poseToken?: number): void => {
            // Shared deformation data can be reached through several bindings of one
            // controller. Deduplicate that controller/time pair, but clear the tokens for
            // unkeyed manual or masked updates because they may change a fixed-time pose.
            if (source && poseToken !== undefined) {
                const previous = poseTokens?.get(source);
                if (previous === poseToken) {
                    return;
                }
                (poseTokens ??= new WeakMap()).set(source, poseToken);
            } else {
                poseTokens = undefined;
            }
            data._shadowVersion = (data._shadowVersion ?? 0) + 1;
        };
    }
    // Animation writers call this null-by-default bridge. Installing it from the
    // optional chunks keeps shadow bookkeeping out of no-shadow animation bundles.
    _installDeformationChangeNotifier(notifyShadowCasterChanged);
}
