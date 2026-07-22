/** PBR wrapper around the material-agnostic shared skeleton fragment. */

import { createSkeletonFragment } from "../../../shader/fragments/skeleton-fragment.js";
export { createSkeletonFragment };

import type { PbrExt } from "../pbr-flags.js";
import { MSH_HAS_SKELETON, MSH_HAS_SKELETON_8 } from "../../mesh-features.js";

export const pbrExt: PbrExt = {
    id: "skeleton",
    phase: "vertex",
    frag(ctx) {
        if (!(ctx._meshFeatures & MSH_HAS_SKELETON)) {
            return null;
        }
        return createSkeletonFragment((ctx._meshFeatures & MSH_HAS_SKELETON_8) !== 0);
    },
    bind(ctx, entries, b) {
        const mesh = ctx._mesh as { skeleton?: { boneTexture: GPUTexture } } | undefined;
        if (!(ctx._meshFeatures & MSH_HAS_SKELETON) || !mesh?.skeleton) {
            return b;
        }
        entries.push({ binding: b++, resource: mesh.skeleton.boneTexture.createView() });
        return b;
    },
};
